/* =====================================================================
   NEON STRIKE — 自研后处理管线（零依赖，纯 GLSL）
   r150 的 UMD 版没有 examples/js，官方 EffectComposer 引不进来，所以自己实现。

   链路：
     场景(HDR 线性) → [亮部提取 → 多级高斯泛光] → [上帝光：朝太阳径向模糊]
                    → 合成：泛光 + ACES + 色彩分级 + 暗角 + 移轴模糊 + 色散 + FXAA + 抖动
                    → 屏幕

   玩具/微缩景观模式（api.toy = true，默认开）：
     高饱和低对比 + 更亮 + 强暗角 + 移轴景深（只有对焦带清晰）+ 边缘色散 + 泛光加成
     —— 这是"微缩模型摄影"的视觉配方，用来消除写实模型的恐怖谷效应。

   用法：
     var post = FPS.PostFX.create(renderer, scene, camera);
     post.render(function () { renderer.render(scene, camera); ... });
     post.setSize(w, h);
     post.quality = 'low' | 'medium' | 'high';
     post.toy = true; post.applyLook();
   ===================================================================== */
window.FPS = window.FPS || {};

(function () {
  'use strict';

  var PostFX = (FPS.PostFX = {});

  function hdrType(renderer) {
    try {
      if (renderer.capabilities && renderer.capabilities.isWebGL2) return THREE.HalfFloatType;
    } catch (e) { }
    return THREE.UnsignedByteType;
  }

  var QUAD_VS = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}'
  ].join('\n');

  function makeQuad(material) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 3, -1, 0, -1, 3, 0
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    var mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    var scn = new THREE.Scene();
    scn.add(mesh);
    var cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return { scene: scn, camera: cam, mesh: mesh, geo: geo };
  }

  function quadMat(fragment, uniforms) {
    return new THREE.ShaderMaterial({
      uniforms: uniforms || {},
      vertexShader: QUAD_VS,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false
    });
  }

  /* ---------------- 亮部提取（软阈值） ---------------- */
  var BRIGHT_FS = [
    'uniform sampler2D tDiffuse;',
    'uniform float uThreshold;',
    'uniform float uSoft;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  float k = smoothstep(uThreshold, uThreshold + uSoft, l);',
    '  gl_FragColor = vec4(c * k, 1.0);',
    '}'
  ].join('\n');

  /* ---------------- 可分离高斯模糊 ---------------- */
  var BLUR_FS = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uDir;',
    'varying vec2 vUv;',
    'void main() {',
    '  float w[5];',
    '  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.054054; w[4] = 0.016216;',
    '  vec3 sum = texture2D(tDiffuse, vUv).rgb * w[0];',
    '  for (int i = 1; i < 5; i++) {',
    '    vec2 o = uDir * float(i);',
    '    sum += texture2D(tDiffuse, vUv + o).rgb * w[i];',
    '    sum += texture2D(tDiffuse, vUv - o).rgb * w[i];',
    '  }',
    '  gl_FragColor = vec4(sum, 1.0);',
    '}'
  ].join('\n');

  /* ---------------- 上帝光 ---------------- */
  var RAYS_FS = [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 uSun;',
    'uniform float uDensity;',
    'uniform float uDecay;',
    'uniform float uWeight;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 delta = (vUv - uSun) * uDensity / 24.0;',
    '  vec2 uv = vUv;',
    '  vec3 acc = vec3(0.0);',
    '  float w = 1.0;',
    '  for (int i = 0; i < 24; i++) {',
    '    uv -= delta;',
    '    acc += texture2D(tDiffuse, uv).rgb * w;',
    '    w *= uDecay;',
    '  }',
    '  gl_FragColor = vec4(acc * uWeight / 24.0, 1.0);',
    '}'
  ].join('\n');

  /* ---------------- 合成 ---------------- */
  var COMPOSITE_FS = [
    'uniform sampler2D tScene;',
    'uniform sampler2D tBloom;',
    'uniform sampler2D tRays;',
    'uniform vec2 uTexel;',
    'uniform float uBloom;',
    'uniform float uRays;',
    'uniform float uExposure;',
    'uniform float uSaturation;',
    'uniform float uContrast;',
    'uniform vec3 uLift;',
    'uniform vec3 uGain;',
    'uniform float uVignette;',
    'uniform float uGrain;',
    'uniform float uTilt;',      // 移轴模糊强度
    'uniform float uFocusY;',    // 对焦带中心（屏幕 Y）
    'uniform float uFocusH;',    // 对焦带半高
    'uniform float uCA;',        // 色散强度
    'uniform float uFlat;',      // 贴图扁平化强度
    'uniform float uFlatLevels;',// 色阶数（越少越像平涂）
    'varying vec2 vUv;',
    'vec3 aces(vec3 x) {',
    '  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);',
    '}',
    'vec3 toSRGB(vec3 c) {',
    '  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));',
    '}',
    'vec3 fxaa(sampler2D tex, vec2 uv) {',
    '  vec3 rgbM = texture2D(tex, uv).rgb;',
    '  vec3 rgbNW = texture2D(tex, uv + vec2(-uTexel.x, -uTexel.y)).rgb;',
    '  vec3 rgbNE = texture2D(tex, uv + vec2( uTexel.x, -uTexel.y)).rgb;',
    '  vec3 rgbSW = texture2D(tex, uv + vec2(-uTexel.x,  uTexel.y)).rgb;',
    '  vec3 rgbSE = texture2D(tex, uv + vec2( uTexel.x,  uTexel.y)).rgb;',
    '  vec3 luma = vec3(0.299, 0.587, 0.114);',
    '  float lM = dot(rgbM, luma);',
    '  float lNW = dot(rgbNW, luma), lNE = dot(rgbNE, luma);',
    '  float lSW = dot(rgbSW, luma), lSE = dot(rgbSE, luma);',
    '  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));',
    '  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));',
    '  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));',
    '  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.03125, 1.0 / 128.0);',
    '  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);',
    '  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * uTexel;',
    '  vec3 rgbA = 0.5 * (texture2D(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);',
    '  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tex, uv + dir * -0.5).rgb + texture2D(tex, uv + dir * 0.5).rgb);',
    '  float lB = dot(rgbB, luma);',
    '  return (lB < lMin || lB > lMax) ? rgbA : rgbB;',
    '}',
    'vec3 flattenColor(vec3 c) {',
    '  if (uFlat < 0.001) return c;',
    '  // 量化前加抖动，否则天空这类平滑渐变会出现明显色带',
    '  float d = (fract(sin(dot(vUv, vec2(12.9898, 78.233)) + uGrain * 1.7) * 43758.5453) - 0.5) * 0.7 / uFlatLevels;',
    '  vec3 q = floor((c + d) * uFlatLevels + 0.5) / uFlatLevels;',
    '  return mix(c, q, uFlat);',
    '}',
    'vec3 tiltShift(sampler2D tex, vec2 uv) {',
    '  float dy = abs(uv.y - uFocusY);',
    '  float amt = smoothstep(uFocusH, uFocusH + 0.30, dy) * uTilt;',
    '  if (amt < 0.002) return fxaa(tex, uv);',
    '  vec3 acc = vec3(0.0);',
    '  float wsum = 0.0;',
    '  for (int i = -4; i <= 4; i++) {',
    '    float fi = float(i);',
    '    float w = 1.0 - abs(fi) / 5.0;',
    '    acc += texture2D(tex, uv + vec2(fi * amt * 0.0075, 0.0)).rgb * w;',
    '    acc += texture2D(tex, uv + vec2(0.0, fi * amt * 0.0045)).rgb * w;',
    '    wsum += w * 2.0;',
    '  }',
    '  return acc / wsum;',
    '}',
    'void main() {',
    '  vec2 cd = vUv - 0.5;',
    '  float ca = uCA * 0.0022 * dot(cd, cd) * 4.0;',
    '  vec3 c;',
    '  if (uCA > 0.001) {',
    '    c.r = tiltShift(tScene, vUv + cd * ca).r;',
    '    c.g = tiltShift(tScene, vUv).g;',
    '    c.b = tiltShift(tScene, vUv - cd * ca).b;',
    '  } else {',
    '    c = tiltShift(tScene, vUv);',
    '  }',
    '  c += texture2D(tBloom, vUv).rgb * uBloom;',
    '  c += texture2D(tRays, vUv).rgb * uRays;',
    '  c *= uExposure;',
    '  c = aces(c);',
    '  c = c * uGain + uLift * (1.0 - c);',
    '  c = (c - 0.5) * uContrast + 0.5;',
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(vec3(l), c, uSaturation);',
    '  c = flattenColor(c);',
    '  vec2 d = vUv - 0.5;',
    '  float vig = 1.0 - uVignette * dot(d, d) * 2.2;',
    '  c *= clamp(vig, 0.0, 1.0);',
    '  c = toSRGB(max(c, vec3(0.0)));',
    '  float n = fract(sin(dot(vUv, vec2(12.9898, 78.233)) + uGrain) * 43758.5453);',
    '  c += (n - 0.5) / 255.0;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  PostFX.create = function (renderer, scene, camera) {
    var type = hdrType(renderer);
    var rtOpts = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: type, depthBuffer: true, stencilBuffer: false
    };
    var bloomOpts = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: type, depthBuffer: false, stencilBuffer: false
    };

    var rtScene = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    if ('samples' in rtScene) rtScene.samples = 4;
    var rtBright = new THREE.WebGLRenderTarget(1, 1, bloomOpts);
    var rtA = new THREE.WebGLRenderTarget(1, 1, bloomOpts);
    var rtB = new THREE.WebGLRenderTarget(1, 1, bloomOpts);
    var rtRays = new THREE.WebGLRenderTarget(1, 1, bloomOpts);

    var mBright = quadMat(BRIGHT_FS, { tDiffuse: { value: null }, uThreshold: { value: 1.05 }, uSoft: { value: 0.6 } });
    var mBlur = quadMat(BLUR_FS, { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } });
    var mRays = quadMat(RAYS_FS, {
      tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.75) },
      uDensity: { value: 0.85 }, uDecay: { value: 0.94 }, uWeight: { value: 0.55 }
    });
    var mComp = quadMat(COMPOSITE_FS, {
      tScene: { value: null }, tBloom: { value: null }, tRays: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uBloom: { value: 0.85 }, uRays: { value: 0.5 }, uExposure: { value: 1.05 },
      uSaturation: { value: 1.12 }, uContrast: { value: 1.06 },
      uLift: { value: new THREE.Vector3(0.012, 0.020, 0.030) },
      uGain: { value: new THREE.Vector3(1.03, 1.00, 0.97) },
      uVignette: { value: 0.42 }, uGrain: { value: 0 },
      uTilt: { value: 0.0 }, uFocusY: { value: 0.46 }, uFocusH: { value: 0.20 }, uCA: { value: 0.0 }
    });

    var qBright = makeQuad(mBright);
    var qBlur = makeQuad(mBlur);
    var qRays = makeQuad(mRays);
    // 兜底：确保扁平化 uniform 一定存在（着色器里已声明，但 object literal 可能被改漏）
    if (!mComp.uniforms.uFlat) mComp.uniforms.uFlat = { value: 0.0 };
    if (!mComp.uniforms.uFlatLevels) mComp.uniforms.uFlatLevels = { value: 7.0 };

    var qComp = makeQuad(mComp);

    var size = new THREE.Vector2(1, 1);
    var api = {
      quality: 'high',
      sunScreen: new THREE.Vector2(0.5, 0.8),
      sunIntensity: 1.0,
      toy: true,
      bloomBoost: 1.0,
      raysBoost: 1.0
    };

    /* 玩具模式：一整套"微缩模型摄影"参数 */
    /* ================= 画面风格预设（按地图选择）=================
       每种风格独立控制：饱和度/对比/曝光/暗角/色调/移轴/色差/扁平化/泛光/光束
       新增风格：在这里加一项即可；地图通过 world.js 的 MAPS[x].look 指定。 */
    var LOOKS = {
      toy: {          // 玩具微缩模型（默认）：强移轴 + 强平涂 + 高饱和
        sat: 1.32, contrast: 0.98, exposure: 1.06, vignette: 0.46,
        lift: [0.020, 0.028, 0.036], gain: [1.05, 1.01, 0.96],
        tilt: 0.52, ca: 0.35, focusY: 0.46, focusH: 0.30, flat: 0.40, levels: 7,
        bloom: 1.45, rays: 0.5, dither: 0
      },
      clean: {        // 干净写实：几乎无后期，噪点来源全部关闭
        sat: 1.12, contrast: 1.04, exposure: 1.02, vignette: 0.30,
        lift: [0.008, 0.012, 0.018], gain: [1.02, 1.00, 0.98],
        tilt: 0.10, ca: 0.0, focusY: 0.46, focusH: 0.45, flat: 0.0, levels: 8,
        bloom: 0.85, rays: 0.35, dither: 0
      },
      cinematic: {    // 电影感：强暗角 + 暖高光冷阴影 + 轻微移轴
        // 注意 flat 必须为 0：色阶量化 + 抖动会在训练场这类空旷场景留下静态网点（看起来就是噪点）
        sat: 1.20, contrast: 1.08, exposure: 1.04, vignette: 0.58,
        lift: [0.018, 0.024, 0.034], gain: [1.06, 1.01, 0.94],
        tilt: 0.34, ca: 0.18, focusY: 0.44, focusH: 0.24, flat: 0.0, levels: 9,
        bloom: 1.15, rays: 0.75, dither: 0
      },
      night: {        // 夜景：偏冷、提亮、更强泛光
        sat: 1.10, contrast: 1.12, exposure: 1.18, vignette: 0.62,
        lift: [0.010, 0.016, 0.034], gain: [0.92, 0.98, 1.10],
        tilt: 0.28, ca: 0.22, focusY: 0.44, focusH: 0.28, flat: 0.0, levels: 9,
        bloom: 1.35, rays: 0.9, dither: 0
      },
      anime: {        // 动画平涂：色阶最少、饱和最高、泛光最强
        sat: 1.45, contrast: 1.02, exposure: 1.04, vignette: 0.34,
        lift: [0.024, 0.030, 0.040], gain: [1.04, 1.00, 0.98],
        tilt: 0.30, ca: 0.10, focusY: 0.46, focusH: 0.32, flat: 0.55, levels: 6,
        bloom: 1.55, rays: 0.6, dither: 0
      }
    };

    /* 可以在「画面设置」里调的全部参数（key 同时是 uniforms 的映射键） */
    var LOOK_KEYS = ['sat', 'contrast', 'exposure', 'vignette', 'tilt', 'focusH',
                     'ca', 'flat', 'levels', 'bloom', 'rays', 'dither'];

    api.LOOKS = LOOKS;
    api.LOOK_KEYS = LOOK_KEYS;
    api.lookName = 'toy';
    api.overrides = {};      // 用户在画面设置里调过的项（覆盖风格档，切换地图后依然生效）

    /** 把一套参数写进 uniforms（L = 可调项，base = 风格档原值，用于色调分级） */
    function pushLook(L, base) {
      var u = mComp.uniforms;
      u.uSaturation.value = L.sat;
      u.uContrast.value = L.contrast;
      u.uExposure.value = L.exposure;
      u.uVignette.value = L.vignette;
      u.uTilt.value = L.tilt;
      u.uFocusH.value = L.focusH;
      u.uCA.value = L.ca;
      u.uFlat.value = L.flat;
      u.uFlatLevels.value = L.levels;
      // 色调分级（不暴露滑杆，跟着风格档走）：阴影冷、高光暖
      if (base) {
        if (base.lift) u.uLift.value.set(base.lift[0], base.lift[1], base.lift[2]);
        if (base.gain) u.uGain.value.set(base.gain[0], base.gain[1], base.gain[2]);
        if (base.focusY !== undefined) u.uFocusY.value = base.focusY;
      }
      // uGrain 同时是"抖动强度"：默认 0 = 关闭。
      // 历史坑：这里以前每帧换随机种子，配合色阶量化会变成满屏闪烁噪点（FINDINGS #14）
      u.uGrain.value = L.dither || 0;
      api.bloomBoost = L.bloom;
      api.raysBoost = L.rays;
      api.toy = (api.lookName !== 'clean');
    }

    /** 应用画面风格；不传参数则沿用当前风格名（用户覆盖项始终叠加在最上面） */
    api.applyLook = function (name) {
      if (name && LOOKS[name]) api.lookName = name;
      var base = LOOKS[api.lookName] || LOOKS.toy;
      var L = {};
      LOOK_KEYS.forEach(function (k) { L[k] = base[k]; });
      LOOK_KEYS.forEach(function (k) { if (api.overrides[k] !== undefined) L[k] = api.overrides[k]; });
      api.current = L;
      api.currentBase = base;
      pushLook(L, base);
      return api.lookName;
    };

    /** 取当前生效的全部画面参数（供画面设置面板显示） */
    api.params = function () {
      if (!api.current) api.applyLook();
      return api.current;
    };

    /** 实时改一个画面参数（画面设置面板用） */
    api.setParam = function (k, v) {
      if (LOOK_KEYS.indexOf(k) < 0) return false;
      v = +v;
      if (!isFinite(v)) return false;
      api.overrides[k] = v;
      if (!api.current) api.applyLook();
      api.current[k] = v;
      pushLook(api.current, api.currentBase);
      return true;
    };

    /** 清空用户覆盖，回到风格档原值 */
    api.clearOverrides = function () {
      api.overrides = {};
      api.applyLook();
      return true;
    };

    api.applyLook();

    function setSize(w, h) {
      size.set(Math.max(1, w | 0), Math.max(1, h | 0));
      var dw = Math.max(1, (size.x / 2) | 0), dh = Math.max(1, (size.y / 2) | 0);
      rtScene.setSize(size.x, size.y);
      rtBright.setSize(dw, dh);
      rtA.setSize(dw, dh);
      rtB.setSize(dw, dh);
      rtRays.setSize(dw, dh);
      mComp.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    }
    api.setSize = setSize;

    function blit(mat, quad, target) {
      quad.mesh.material = mat;
      renderer.setRenderTarget(target || null);
      renderer.render(quad.scene, quad.camera);
    }

    var _dir = new THREE.Vector2();
    function blurPass(srcTex, dstA, dstB, radius) {
      _dir.set(radius / size.x * 2, 0);
      mBlur.uniforms.tDiffuse.value = srcTex;
      mBlur.uniforms.uDir.value.copy(_dir);
      blit(mBlur, qBlur, dstA);
      _dir.set(0, radius / size.y * 2);
      mBlur.uniforms.tDiffuse.value = dstA.texture;
      mBlur.uniforms.uDir.value.copy(_dir);
      blit(mBlur, qBlur, dstB);
      return dstB.texture;
    }

    /* draw() 由调用方提供：把世界与手上的枪械都画进当前 target */
    api.render = function (draw) {
      var q = api.quality;
      var usePost = q !== 'low';

      renderer.setRenderTarget(rtScene);
      renderer.clear();
      if (draw) draw(); else renderer.render(scene, camera);

      if (!usePost) {
        mComp.uniforms.tScene.value = rtScene.texture;
        mComp.uniforms.tBloom.value = rtScene.texture;
        mComp.uniforms.tRays.value = rtScene.texture;
        mComp.uniforms.uBloom.value = 0;
        mComp.uniforms.uRays.value = 0;
        mComp.uniforms.uGrain.value = 0;
        mComp.uniforms.uTilt.value = 0;
        mComp.uniforms.uCA.value = 0;
        blit(mComp, qComp, null);
        return;
      }

      mBright.uniforms.tDiffuse.value = rtScene.texture;
      blit(mBright, qBright, rtBright);

      var bloomTex = rtBright.texture;
      if (q === 'high') {
        var b1 = blurPass(rtBright.texture, rtA, rtB, 1.0);
        var b2 = blurPass(rtBright.texture, rtA, rtB, 2.6);
        mBlur.uniforms.tDiffuse.value = b1;
        mBlur.uniforms.uDir.value.set(0, 0);
        blit(mBlur, qBlur, rtA);
        mBlur.uniforms.tDiffuse.value = b2;
        blit(mBlur, qBlur, rtB);
        bloomTex = rtB.texture;
        mComp.uniforms.uBloom.value = 1.05 * api.bloomBoost;
      } else {
        bloomTex = blurPass(rtBright.texture, rtA, rtB, 1.8);
        mComp.uniforms.uBloom.value = 0.7 * api.bloomBoost;
      }

      if (q === 'high') {
        mRays.uniforms.tDiffuse.value = rtBright.texture;
        mRays.uniforms.uSun.value.copy(api.sunScreen);
        blit(mRays, qRays, rtRays);
        mComp.uniforms.tRays.value = rtRays.texture;
        mComp.uniforms.uRays.value = 0.45 * api.sunIntensity * api.raysBoost;
      } else {
        mComp.uniforms.tRays.value = rtBright.texture;
        mComp.uniforms.uRays.value = 0;
      }

      mComp.uniforms.tScene.value = rtScene.texture;
      mComp.uniforms.tBloom.value = bloomTex;
      // 抖动种子必须固定：以前每帧换种子，配合 flattenColor 的色阶量化会产生满屏闪烁噪点
  mComp.uniforms.uGrain.value = 0.0;
      blit(mComp, qComp, null);
    };

    // 关键：色调映射与输出编码只设置一次。
    // 它们会被编译进着色器，逐帧修改会导致每帧全体材质重编译（严重卡顿）。
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputEncoding = THREE.LinearEncoding;

    setSize(renderer.domElement.width || 1280, renderer.domElement.height || 720);
    return api;
  };
})();
