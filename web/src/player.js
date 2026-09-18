/* =====================================================================
   NEON STRIKE — 玩家 / 武器 / 第一人称控制
   ===================================================================== */
window.FPS = window.FPS || {};

(function () {
  'use strict';

  var P = FPS.Particles;
  var Sfx = FPS.Sfx;

  var EYE = 1.66;
  var RADIUS = 0.42;
  var HEIGHT = 1.8;
  var WALK = 6.0;
  var SPRINT = 9.0;
  var BACK = 4.4;
  var AIR_STEER = 2.4;     // 空中转向速率（保留动量，只允许有限转向）
  var AIR_DRAG = 0.4;      // 空中无输入时的空气阻力
  var ACCEL = 13;
  var GRAVITY = 21;
  var JUMP_V = 7.1;
  var JUMP_BUFFER = 0.15;  // 跳跃输入缓冲（秒）
  var ADS_ZOOM = 3.2;      // 举镜倍率（管式瞄准镜，视野 FOV 75 → ~23）
  var _tmpEuler = null, _tmpQuat = null, _tmpRoll = null, _axisZ = null;   // 每帧复用的临时对象
var INSPECT_TIME = 9.0;  // 检视枪械长动画时长（秒）：抬枪转身 → 拉远扫视 → 竖起 → 收回
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
/** 平滑 0→1（首尾速度为 0，避免分段线性那种顿挫） */
function smooth01(v) { v = clamp01(v); return v * v * (3 - 2 * v); }
/** p 在 a→b 之间平滑地从 0 到 1 */
function ease01(p, a, b) { return smooth01((p - a) / (b - a)); }
/** 三角包络：a..b 上升、b..c 保持 1、c..d 下降 */
function tri01(p, a, b, c, d) {
  if (p <= a) return 0;
  if (p < b) return smooth01((p - a) / (b - a));
  if (p <= c) return 1;
  if (p < d) return 1 - smooth01((p - c) / (d - c));
  return 0;
}
var ADS_MOVE = 1.0;         // 开镜不再降低移速（红点镜只放大视野）
  var ADS_LERP = 8;        // 举镜过渡速度（比原来慢一点，更有"抬枪贴腮"的感觉）
  var ADS_EYE_RELIEF = 0.055;  // 出瞳距离：目镜离眼睛多远

  var MAG_SIZE = 30;
  var FIRE_RATE = 0.092;
  var RELOAD_TIME = 1.55;
  var DAMAGE = 26;
  var RESERVE_START = 300;
  var MAX_RESERVE = 700;        // 备弹上限（过关补给提高到 200 后放宽）

  var _v = new THREE.Vector3();
  var _dir = new THREE.Vector3();
  var _right = new THREE.Vector3();
  var _up = new THREE.Vector3();
  var _muzzle = new THREE.Vector3();

  /* ---------------------------------------------------------------
     武器模型（在独立的 viewScene 中渲染，避免与场景穿插）
     ---------------------------------------------------------------
     以"炮塔式"细节级别用基础几何拼出来的一把模块化步枪：
       机匣（上下机匣 + 顶部导轨）、枪管 + 枪口制退器、护木（散热槽 + 下导轨）、
       弯弹匣、手枪握把、可调枪托、扳机与护圈、拉机柄、保险/弹匣卡榫，
       折叠机械瞄具（准星柱 + 照门），以及一支**管式瞄准镜**（物镜喇叭口、
       目镜、放大环、风偏/高低调节钮、镜环与底座、镀膜镜片）。
     坐标约定与旧模型一致：前方 = -Z，上方 = +Y，枪身原点在机匣中部附近。
     瞄准镜光轴中心的局部坐标通过 scopeEye 返回，举镜时用它把镜筒对到相机轴上。
     --------------------------------------------------------------- */
  function buildViewModel() {
    var g = new THREE.Group();          // 外层：所有姿态动画都作用在它身上
    var inner = new THREE.Group();      // 内层：程序化枪模 + 双手（可被下载的枪模整体替换）
    g.add(inner);
    var parts = [];

    // ---- 材质：枪灰金属 / 黑色聚合物 / 抛光钢 / 镜片 / 霓虹点缀 ----
    var gunmetal = new THREE.MeshStandardMaterial({ color: 0x2b3140, roughness: 0.44, metalness: 0.86 });
    var polymer = new THREE.MeshStandardMaterial({ color: 0x15191f, roughness: 0.82, metalness: 0.12 });
    var steel = new THREE.MeshStandardMaterial({ color: 0x525c6e, roughness: 0.26, metalness: 0.95 });
    var rubber = new THREE.MeshStandardMaterial({ color: 0x0d0f13, roughness: 0.95, metalness: 0.05 });
    var glass = new THREE.MeshPhysicalMaterial({
      color: 0x9fd8ff, roughness: 0.06, metalness: 0.0,
      transparent: true, opacity: 0.3, side: THREE.DoubleSide
    });
    var coating = new THREE.MeshBasicMaterial({
      color: 0x59e0c8, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var accent = new THREE.MeshBasicMaterial({ color: 0x38e8ff });
    var amber = new THREE.MeshBasicMaterial({ color: 0xffb347 });

    // ---- 建模小工具 ----
    function add(mesh) { mesh.userData.wpart = true; mesh.name = mesh.name || 'proc'; inner.add(mesh); parts.push(mesh); return mesh; }
    function box(w, h, d, x, y, z, mat, rx, ry, rz) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || gunmetal);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      if (rz) m.rotation.z = rz;
      return add(m);
    }
    /** 圆柱：axis = 'x' | 'y' | 'z'（默认沿 Z，用于枪管/镜筒） */
    function cyl(r1, r2, len, x, y, z, mat, axis, seg) {
      var geo = new THREE.CylinderGeometry(r1, r2, len, seg || 16, 1, false);
      var m = new THREE.Mesh(geo, mat || steel);
      if (axis === 'x') m.rotation.z = Math.PI / 2;
      else if (axis === 'y') m.rotation.x = 0;
      else m.rotation.x = Math.PI / 2;
      m.position.set(x, y, z);
      return add(m);
    }
    /** 车削体：points = [[r, y], ...]，用于瞄准镜喇叭口这类回转体 */
    function lathe(points, x, y, z, mat, seg) {
      var pts = [];
      for (var i = 0; i < points.length; i++) pts.push(new THREE.Vector2(points[i][0], points[i][1]));
      var m = new THREE.Mesh(new THREE.LatheGeometry(pts, seg || 20), mat || gunmetal);
      m.rotation.x = Math.PI / 2;      // 让回转轴指向 -Z
      m.position.set(x, y, z);
      return add(m);
    }
    function ring(r, tube, x, y, z, mat, rx, ry, rz) {
      var m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 20), mat || gunmetal);
      m.position.set(x, y, z);
      m.rotation.set(rx || 0, ry || 0, rz || 0);
      return add(m);
    }
    /** 挤出体：用 2D 剖面做机匣/握把/枪托这种非方盒轮廓 */
    function extrude(shapePts, depth, x, y, z, mat, rx, ry, rz) {
      var shape = new THREE.Shape();
      shape.moveTo(shapePts[0][0], shapePts[0][1]);
      for (var i = 1; i < shapePts.length; i++) shape.lineTo(shapePts[i][0], shapePts[i][1]);
      shape.closePath();
      var geo = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 1 });
      geo.translate(0, 0, -depth / 2);
      var m = new THREE.Mesh(geo, mat || gunmetal);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      if (rz) m.rotation.z = rz;
      return add(m);
    }
    /** 一排小螺钉/防滑纹 */
    function bolts(list, r, len, mat) {
      for (var i = 0; i < list.length; i++) cyl(r, r, len, list[i][0], list[i][1], list[i][2], mat || steel, 'x', 6);
    }

    /* ================= 下机匣 / 弹匣井 / 扳机 ================= */
    extrude([[-0.052, 0.03], [0.052, 0.03], [0.052, -0.032], [0.028, -0.055], [-0.03, -0.055], [-0.052, -0.03]],
      0.3, 0, -0.015, -0.1, gunmetal);
    // 扳机护圈
    box(0.026, 0.008, 0.075, 0, -0.062, -0.03, polymer);
    box(0.026, 0.03, 0.008, 0, -0.05, 0.005, polymer);
    // 扳机
    box(0.014, 0.032, 0.012, 0, -0.045, -0.03, steel, 0.18);
    // 保险选择杆 + 弹匣卡榫
    cyl(0.011, 0.011, 0.02, 0.055, -0.015, 0.03, steel, 'x', 10);
    box(0.03, 0.012, 0.02, 0.07, -0.015, 0.03, polymer);
    box(0.016, 0.016, 0.02, -0.055, -0.03, -0.02, polymer);

    /* ================= 上机匣 + 顶部导轨 ================= */
    extrude([[-0.05, 0.038], [0.05, 0.038], [0.05, -0.038], [-0.05, -0.038]], 0.34, 0, 0.028, -0.13, gunmetal);
    // 抛壳窗 + 拉机柄
    box(0.03, 0.028, 0.075, 0.052, 0.035, -0.08, polymer);
    box(0.055, 0.012, 0.018, 0.063, 0.04, 0.03, steel);
    cyl(0.014, 0.014, 0.022, 0.092, 0.04, 0.03, steel, 'x', 10);
    // 顶部皮卡汀尼导轨：底座 + 一排齿
    box(0.038, 0.008, 0.3, 0, 0.07, -0.13, gunmetal);
    for (var t = 0; t < 9; t++) box(0.042, 0.008, 0.014, 0, 0.079, -0.245 + t * 0.028, gunmetal);
    // 机匣侧面霓虹条 + 铭牌
    box(0.004, 0.012, 0.19, 0.057, 0.012, -0.11, accent);
    box(0.004, 0.012, 0.19, -0.057, 0.012, -0.11, accent);
    box(0.002, 0.02, 0.05, 0.058, 0.03, 0.01, amber);

    /* ================= 枪管 / 导气箍 / 枪口制退器 ================= */
    cyl(0.019, 0.019, 0.22, 0, 0.022, -0.41, steel, 'z', 18);      // 粗段
    cyl(0.013, 0.013, 0.36, 0, 0.022, -0.69, steel, 'z', 18);      // 细段
    cyl(0.017, 0.017, 0.05, 0, 0.022, -0.52, gunmetal, 'z', 14);   // 导气箍
    box(0.03, 0.02, 0.05, 0, 0.038, -0.52, gunmetal);
    // 枪口制退器：三段环 + 端盖
    cyl(0.021, 0.021, 0.075, 0, 0.022, -0.895, gunmetal, 'z', 16);
    ring(0.0225, 0.004, 0, 0.022, -0.868, steel, Math.PI / 2);
    ring(0.0225, 0.004, 0, 0.022, -0.895, steel, Math.PI / 2);
    ring(0.0225, 0.004, 0, 0.022, -0.922, steel, Math.PI / 2);
    cyl(0.008, 0.008, 0.006, 0, 0.022, -0.934, polymer, 'z', 12);  // 枪口内孔

    /* ================= 护木（散热槽 + 下导轨 + 手挡） ================= */
    extrude([[-0.036, 0.034], [0.036, 0.034], [0.045, 0.02], [0.045, -0.03], [0.03, -0.04], [-0.03, -0.04], [-0.045, -0.03], [-0.045, 0.02]],
      0.34, 0, 0.02, -0.5, polymer);
    for (var v = 0; v < 6; v++) {                                   // 散热槽
      box(0.1, 0.012, 0.02, 0, 0.046, -0.4 - v * 0.038, gunmetal);
      box(0.1, 0.012, 0.02, 0, -0.006, -0.4 - v * 0.038, gunmetal);
    }
    box(0.03, 0.008, 0.24, 0, -0.048, -0.5, gunmetal);              // 下导轨
    for (var t2 = 0; t2 < 7; t2++) box(0.034, 0.008, 0.012, 0, -0.056, -0.6 + t2 * 0.032, gunmetal);
    box(0.028, 0.05, 0.022, 0, -0.075, -0.62, polymer);             // 手挡

    /* ================= 折叠机械瞄具 ================= */
    box(0.03, 0.012, 0.05, 0, 0.088, -0.6, gunmetal);               // 准星座（倒伏）
    box(0.006, 0.03, 0.006, 0, 0.1, -0.605, steel);                 // 准星柱
    box(0.028, 0.024, 0.006, -0.013, 0.098, -0.6, gunmetal);        // 护翼
    box(0.028, 0.024, 0.006, 0.013, 0.098, -0.6, gunmetal);
    box(0.026, 0.012, 0.04, 0, 0.088, 0.02, gunmetal);              // 照门座（倒伏）
    ring(0.009, 0.003, 0, 0.104, 0.02, steel, 0, 0, Math.PI / 2);

    /* ================= 弹匣（三段弯曲） ================= */
    var magazine = new THREE.Group();
    (function () {
      var seg = [
        { w: 0.052, h: 0.075, d: 0.105, y: -0.09, z: -0.075, r: 0.0 },
        { w: 0.05, h: 0.07, d: 0.1, y: -0.155, z: -0.06, r: -0.14 },
        { w: 0.048, h: 0.06, d: 0.095, y: -0.21, z: -0.032, r: -0.3 }
      ];
      for (var i = 0; i < seg.length; i++) {
        var s = seg[i];
        var m = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), polymer);
        m.position.set(0, s.y, s.z);
        m.rotation.x = s.r;
        m.userData.wpart = true;
        magazine.add(m);
        var rib = new THREE.Mesh(new THREE.BoxGeometry(s.w + 0.006, 0.006, s.d + 0.006), gunmetal);
        rib.position.set(0, s.y + s.h * 0.3, s.z);
        rib.rotation.x = s.r;
        rib.userData.wpart = true;
        magazine.add(rib);
      }
      var floor = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.012, 0.1), gunmetal);
      floor.position.set(0, -0.246, -0.018);
      floor.rotation.x = -0.32;
      floor.userData.wpart = true;
      magazine.add(floor);
    })();
    inner.add(magazine);

    /* ================= 手枪握把 ================= */
    extrude([[-0.032, 0.05], [0.032, 0.05], [0.036, -0.03], [0.022, -0.1], [-0.024, -0.1], [-0.036, -0.03]],
      0.062, 0, -0.075, 0.075, polymer, -0.28);
    for (var gr = 0; gr < 4; gr++) box(0.058, 0.006, 0.008, 0, -0.11 - gr * 0.02, 0.098 + gr * 0.006, rubber, -0.28);

    /* ================= 可调枪托 ================= */
    box(0.036, 0.03, 0.16, 0, 0.03, 0.16, gunmetal);               // 缓冲管
    extrude([[-0.036, 0.055], [0.036, 0.055], [0.04, -0.02], [0.028, -0.075], [-0.028, -0.075], [-0.04, -0.02]],
      0.13, 0, 0.0, 0.225, polymer);
    box(0.1, 0.022, 0.03, 0, 0.058, 0.225, rubber);                 // 贴腮板
    box(0.11, 0.075, 0.018, 0, -0.012, 0.295, rubber);              // 后坐垫
    box(0.012, 0.04, 0.05, 0.045, -0.02, 0.2, gunmetal);            // 背带环
    cyl(0.01, 0.01, 0.014, 0.05, 0.005, 0.16, steel, 'x', 8);

    /* ================= 管式瞄准镜 ================= */
    var scopeY = 0.108, scopeZ = -0.14;
    // 底座 + 两个镜环（含紧固螺钉）
    box(0.05, 0.022, 0.19, 0, 0.082, scopeZ, gunmetal);
    box(0.044, 0.05, 0.018, 0, scopeY, scopeZ - 0.06, gunmetal);
    box(0.044, 0.05, 0.018, 0, scopeY, scopeZ + 0.07, gunmetal);
    ring(0.026, 0.005, 0, scopeY, scopeZ - 0.06, gunmetal, 0, 0, 0);
    ring(0.026, 0.005, 0, scopeY, scopeZ + 0.07, gunmetal, 0, 0, 0);
    bolts([[0.024, scopeY - 0.022, scopeZ - 0.06], [0.024, scopeY + 0.022, scopeZ - 0.06],
           [0.024, scopeY - 0.022, scopeZ + 0.07], [0.024, scopeY + 0.022, scopeZ + 0.07]], 0.004, 0.006);
    // 镜筒
    cyl(0.019, 0.019, 0.2, 0, scopeY, scopeZ, gunmetal, 'z', 20);
    // 物镜喇叭口（前）
    lathe([[0.019, 0], [0.024, 0.012], [0.031, 0.03], [0.032, 0.045], [0.031, 0.05]],
      0, scopeY, scopeZ - 0.1, gunmetal, 22);
    // 目镜（后）
    lathe([[0.019, 0], [0.023, -0.01], [0.027, -0.026], [0.027, -0.038]],
      0, scopeY, scopeZ + 0.1, gunmetal, 22);
    // 放大倍率环（带防滑纹）
    cyl(0.024, 0.024, 0.026, 0, scopeY, scopeZ + 0.062, polymer, 'z', 20);
    for (var k = 0; k < 10; k++) {
      var ang = k / 10 * Math.PI * 2;
      box(0.006, 0.006, 0.024, Math.sin(ang) * 0.024, scopeY + Math.cos(ang) * 0.024, scopeZ + 0.062, gunmetal);
    }
    // 风偏 / 高低调节钮
    cyl(0.012, 0.012, 0.022, 0, scopeY + 0.03, scopeZ - 0.01, polymer, 'y', 12);
    cyl(0.013, 0.013, 0.006, 0, scopeY + 0.043, scopeZ - 0.01, gunmetal, 'y', 12);
    cyl(0.011, 0.011, 0.02, 0.03, scopeY + 0.002, scopeZ - 0.01, polymer, 'x', 12);
    // 目镜防滑环 + 镜片（镀膜）
    ring(0.028, 0.004, 0, scopeY, scopeZ + 0.138, polymer, Math.PI / 2, 0, 0);
    cyl(0.026, 0.026, 0.002, 0, scopeY, scopeZ + 0.136, glass, 'z', 24);      // 目镜镜片
    cyl(0.03, 0.03, 0.002, 0, scopeY, scopeZ - 0.148, glass, 'z', 24);        // 物镜镜片
    cyl(0.0315, 0.0315, 0.0015, 0, scopeY, scopeZ - 0.1455, coating, 'z', 24); // 物镜镀膜反光
    // 镜筒上的小亮环（辨识度）
    ring(0.0195, 0.0025, 0, scopeY, scopeZ - 0.09, accent, Math.PI / 2, 0, 0);
    box(0.006, 0.004, 0.05, 0.02, scopeY + 0.014, scopeZ + 0.02, accent);

    /* =================================================================
       QBZ-191 突击步枪（程序化复刻）—— 上面那把旧枪模保留在代码里但整体隐藏。
       设计参考《三角洲行动》里的 QBZ-191 外形特征（AK 系常规布局）：
         长导轨护木 + 斜角前握把 + 大弧度弯弹匣 + 骨架式折叠枪托 + 顶部红点镜
       说明：这是按外形特征做的原创模型，不是提取的游戏资源。
       ================================================================= */
    var procStart = parts.length;
    for (var hideI = 0; hideI < procStart; hideI++) parts[hideI].visible = false;   // 隐藏旧枪模
    while (magazine.children.length) magazine.remove(magazine.children[0]);         // 弹匣组留给新枪模用

    // ---- 机匣（上下机匣 + 抛壳窗 + 拉机柄 + 保险）----
    extrude([[-0.038, 0.046], [0.038, 0.046], [0.038, -0.03], [0.026, -0.055], [-0.026, -0.055], [-0.038, -0.03]],
      0.44, 0, 0.012, 0.03, gunmetal);
    box(0.07, 0.05, 0.2, 0, -0.03, 0.12, gunmetal);                     // 下机匣
    box(0.03, 0.03, 0.1, 0.042, 0.03, 0.0, polymer);                    // 抛壳窗
    box(0.05, 0.012, 0.02, 0.05, 0.05, 0.1, steel);                     // 拉机柄座
    var boltMesh = box(0.022, 0.022, 0.06, 0.046, 0.032, 0.02, steel);  // 枪机（开火时后坐）
    box(0.014, 0.014, 0.03, 0.085, 0.05, 0.1, polymer);                 // 拉机柄
    box(0.01, 0.05, 0.16, 0.05, 0.03, 0.2, steel);                      // AK 式保险拨片
    box(0.02, 0.014, 0.024, 0.062, 0.03, 0.2, polymer);
    box(0.018, 0.012, 0.05, 0.0, -0.055, 0.05, steel);                  // 弹匣卡榫
    box(0.004, 0.01, 0.22, 0.04, 0.012, -0.05, accent);                 // 机匣侧面荧光条
    box(0.004, 0.01, 0.22, -0.04, 0.012, -0.05, accent);
    box(0.002, 0.016, 0.04, 0.041, 0.03, 0.18, amber);

    // ---- 扳机 / 护圈 / 握把 ----
    box(0.026, 0.008, 0.075, 0, -0.072, 0.075, polymer);
    box(0.026, 0.03, 0.008, 0, -0.06, 0.108, polymer);
    box(0.012, 0.03, 0.012, 0, -0.055, 0.078, steel, 0.2);
    extrude([[-0.03, 0.05], [0.03, 0.05], [0.034, -0.03], [0.022, -0.095], [-0.024, -0.095], [-0.034, -0.03]],
      0.058, 0, -0.085, 0.17, polymer, -0.3);
    for (var gr2 = 0; gr2 < 4; gr2++) box(0.054, 0.006, 0.008, 0, -0.12 - gr2 * 0.019, 0.192 + gr2 * 0.006, rubber, -0.3);

    // ---- 顶部全长导轨 ----
    box(0.036, 0.01, 0.66, 0, 0.076, -0.08, gunmetal);
    for (var t3 = 0; t3 < 16; t3++) box(0.04, 0.008, 0.014, 0, 0.085, -0.38 + t3 * 0.04, gunmetal);

    // ---- 护木（八边形 + 散热槽 + 下导轨 + 斜角前握把）----
    extrude([[-0.034, 0.032], [0.034, 0.032], [0.042, 0.014], [0.042, -0.028], [0.026, -0.04], [-0.026, -0.04], [-0.042, -0.028], [-0.042, 0.014]],
      0.42, 0, 0.01, -0.38, polymer);
    for (var v2 = 0; v2 < 5; v2++) {
      box(0.096, 0.011, 0.022, 0, 0.036, -0.2 - v2 * 0.075, gunmetal);
      box(0.096, 0.011, 0.022, 0, -0.012, -0.2 - v2 * 0.075, gunmetal);
    }
    box(0.03, 0.008, 0.3, 0, -0.048, -0.38, gunmetal);
    for (var t4 = 0; t4 < 8; t4++) box(0.034, 0.008, 0.012, 0, -0.056, -0.5 + t4 * 0.035, gunmetal);
    extrude([[-0.026, 0.06], [0.026, 0.06], [0.03, -0.02], [0.02, -0.075], [-0.02, -0.075], [-0.03, -0.02]],
      0.05, 0, -0.1, -0.3, polymer, 0.38);                              // 斜角前握把
    for (var fg = 0; fg < 3; fg++) box(0.046, 0.006, 0.008, 0, -0.135 + fg * 0.018, -0.33 - fg * 0.014, rubber, 0.38);

    // ---- 枪管 / 导气箍 / 带槽枪口制退器 ----
    cyl(0.016, 0.016, 0.24, 0, 0.014, -0.7, steel, 'z', 18);
    cyl(0.011, 0.011, 0.2, 0, 0.014, -0.9, steel, 'z', 18);
    cyl(0.019, 0.019, 0.06, 0, 0.014, -0.62, gunmetal, 'z', 14);        // 导气箍
    box(0.03, 0.024, 0.05, 0, 0.032, -0.62, gunmetal);
    cyl(0.019, 0.019, 0.09, 0, 0.014, -1.04, gunmetal, 'z', 16);        // 制退器
    ring(0.0205, 0.004, 0, 0.014, -1.008, steel, Math.PI / 2);
    ring(0.0205, 0.004, 0, 0.014, -1.04, steel, Math.PI / 2);
    ring(0.0205, 0.004, 0, 0.014, -1.072, steel, Math.PI / 2);
    box(0.042, 0.008, 0.03, 0, 0.03, -1.02, polymer);
    cyl(0.007, 0.007, 0.006, 0, 0.014, -1.086, polymer, 'z', 12);

    // ---- 折叠机械瞄具（备用）----
    box(0.026, 0.012, 0.045, 0, 0.094, -0.16, gunmetal);
    box(0.005, 0.026, 0.005, 0, 0.108, -0.165, steel);
    box(0.024, 0.02, 0.005, -0.011, 0.106, -0.16, gunmetal);
    box(0.024, 0.02, 0.005, 0.011, 0.106, -0.16, gunmetal);
    box(0.024, 0.012, 0.035, 0, 0.094, 0.28, gunmetal);
    ring(0.008, 0.0025, 0, 0.106, 0.28, steel, 0, 0, Math.PI / 2);

    // ---- 大弧度弯弹匣（独立分组：换弹时整组掉落/插回）----
    (function () {
      var seg = [
        { y: -0.085, z: -0.015, r: 0.0 },
        { y: -0.155, z: 0.012, r: -0.20 },
        { y: -0.222, z: 0.052, r: -0.42 },
        { y: -0.283, z: 0.104, r: -0.64 }
      ];
      for (var i = 0; i < seg.length; i++) {
        var s = seg[i];
        var m = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.072, 0.1), polymer);
        m.position.set(0, s.y, s.z);
        m.rotation.x = s.r;
        m.userData.wpart = true;
        magazine.add(m);
        var rib = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.008, 0.104), gunmetal);
        rib.position.set(0, s.y + 0.03, s.z);
        rib.rotation.x = s.r;
        rib.userData.wpart = true;
        magazine.add(rib);
      }
      var floor = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.012, 0.1), gunmetal);
      floor.position.set(0, -0.315, 0.122);
      floor.rotation.x = -0.64;
      floor.userData.wpart = true;
      magazine.add(floor);
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.01), amber);
      stripe.position.set(0, -0.2, -0.045);
      stripe.userData.wpart = true;
      magazine.add(stripe);
    })();
    inner.add(magazine);

    // ---- 骨架式折叠枪托 ----
    box(0.05, 0.05, 0.07, 0, 0.02, 0.28, gunmetal);                     // 铰链座
    cyl(0.008, 0.008, 0.06, 0, 0.02, 0.3, steel, 'x', 8);
    box(0.012, 0.03, 0.2, 0.028, 0.03, 0.4, gunmetal);                  // 两侧骨架
    box(0.012, 0.03, 0.2, -0.028, 0.03, 0.4, gunmetal);
    box(0.012, 0.028, 0.16, 0.028, -0.02, 0.38, gunmetal);
    box(0.012, 0.028, 0.16, -0.028, -0.02, 0.38, gunmetal);
    box(0.07, 0.13, 0.018, 0, 0.012, 0.5, rubber);                      // 后坐垫
    box(0.06, 0.022, 0.14, 0, 0.058, 0.4, rubber);                      // 贴腮板
    box(0.01, 0.04, 0.05, 0.038, -0.02, 0.36, gunmetal);                // 背带环
    cyl(0.009, 0.009, 0.014, 0.045, 0.005, 0.33, steel, 'x', 8);

    // ---- 红点镜（可透过镜片瞄准）----
    var dotY = 0.118, dotZ = -0.1;
    box(0.05, 0.022, 0.08, 0, 0.088, dotZ, gunmetal);                   // 底座
    box(0.044, 0.03, 0.014, 0, 0.1, dotZ - 0.028, gunmetal);
    box(0.044, 0.03, 0.014, 0, 0.1, dotZ + 0.028, gunmetal);
    bolts([[0.024, 0.1, dotZ - 0.028], [0.024, 0.1, dotZ + 0.028]], 0.004, 0.006);
    cyl(0.018, 0.018, 0.09, 0, dotY, dotZ, gunmetal, 'z', 20);          // 镜筒
    ring(0.019, 0.003, 0, dotY, dotZ - 0.045, steel, 0, 0, 0);
    ring(0.019, 0.003, 0, dotY, dotZ + 0.045, steel, 0, 0, 0);
    cyl(0.0165, 0.0165, 0.002, 0, dotY, dotZ - 0.044, glass, 'z', 20);  // 物镜镜片
    cyl(0.0165, 0.0165, 0.002, 0, dotY, dotZ + 0.044, glass, 'z', 20);  // 目镜镜片
    cyl(0.012, 0.012, 0.018, 0, dotY + 0.024, dotZ, polymer, 'y', 12);  // 亮度旋钮
    cyl(0.013, 0.013, 0.005, 0, dotY + 0.034, dotZ, gunmetal, 'y', 12);
    cyl(0.011, 0.011, 0.016, 0.026, dotY, dotZ, polymer, 'x', 12);      // 电池盖
    ring(0.0192, 0.002, 0, dotY, dotZ - 0.02, accent, Math.PI / 2, 0, 0);
    var redDot = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2b3c, toneMapped: false }));
    redDot.position.set(0, dotY, dotZ - 0.01);
    redDot.userData.wpart = true;
    inner.add(redDot);

    /* ================= 第一人称双手（战术手套 + 小臂） =================
       双手都挂在武器上，所以"双手持握"在所有姿态下自动成立；
       左臂另有独立枢轴（在画面外），换弹时可以把左手整条移出画面再拿弹匣回来。 */
    var glove = new THREE.MeshStandardMaterial({ color: 0x1c212b, roughness: 0.88, metalness: 0.08 });
    // MC 风格的"皮肤色"方块手：和深色袖子形成对比，一眼能看清手在哪
    var skin = new THREE.MeshStandardMaterial({ color: 0xc98f63, roughness: 0.82, metalness: 0.02 });
    var skinDark = new THREE.MeshStandardMaterial({ color: 0xa97247, roughness: 0.86, metalness: 0.02 });
    var glovePad = new THREE.MeshStandardMaterial({ color: 0x2b3342, roughness: 0.68, metalness: 0.24 });
    var gloveSeam = new THREE.MeshStandardMaterial({ color: 0x0f1319, roughness: 0.95, metalness: 0.05 });
    var sleeve = new THREE.MeshStandardMaterial({ color: 0x232a36, roughness: 0.92, metalness: 0.06 });
    var sleeveRib = new THREE.MeshStandardMaterial({ color: 0x2c3442, roughness: 0.85, metalness: 0.12 });

    /**
     * 一只手：Minecraft 风格 —— 就是**一个方块**（没有手指、没有拇指）。
     * userData.fingers / thumb 仍然保留成空结构，换弹的手指动画代码不会因此报错。
     */
    function makeHand(opts) {
      var side = (opts && opts.side) || 1;           // 1 = 右手，-1 = 左手
      var h = new THREE.Group();
      var fingerSets = [];

      function mesh(w, hh, d, x, y, z, mat, parent, rx, ry, rz) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat || glove);
        m.position.set(x * side, y, z);
        m.rotation.set(rx || 0, side < 0 ? -(ry || 0) : (ry || 0), side < 0 ? -(rz || 0) : (rz || 0));
        m.userData.wpart = true;
        m.name = 'armPart';
        (parent || h).add(m);
        return m;
      }

      // ---- 手：一整块方块（肤色），棱角分明 ----
      mesh(0.095, 0.115, 0.12, 0, 0, -0.008, skin);

      h.userData.fingers = fingerSets;               // 空数组（方块手没有手指）
      h.userData.thumb = { root: null, tip: null };
      h.userData.side = side;
      return h;
    }

    /** 设置一只手的手指蜷曲程度（0 = 张开，1 = 握紧）。方块手没有手指，这里直接跳过 */
    function setHandCurl(hand, curl, indexStraight) {
      var fs = hand.userData.fingers;
      if (!fs || !fs.length) return;
      for (var i = 0; i < fs.length; i++) {
        var c = (indexStraight && i === 0) ? curl * 0.35 : curl;   // 右手食指留在扳机上
        fs[i].root.rotation.x = -c * 0.95;
        fs[i].mid.rotation.x = -c * 1.15;
        fs[i].tip.rotation.x = -c * 0.75;
      }
      var th = hand.userData.thumb;
      if (th && th.root) {
        th.root.rotation.x = -curl * 0.5;
        if (th.tip) th.tip.rotation.x = -curl * 0.6;
      }
    }

    /** 一条手臂：枢轴在肩（画面外），小臂 = 两段圆柱（模拟袖子的褶皱）+ 袖口环 */
    function makeArm(shoulder, handPos, handRot, side, curl, indexStraight) {
      var a = new THREE.Group();
      a.position.copy(shoulder);
      a.userData.rest = shoulder.clone();
      var hand = makeHand({ side: side });
      hand.position.copy(handPos).sub(shoulder);
      hand.rotation.set(handRot[0], handRot[1], handRot[2]);
      setHandCurl(hand, curl, indexStraight);
      a.add(hand);
      var up = new THREE.Vector3(0, 1, 0);
      // 小臂用"单位长度方盒"建，再按 肩→手 的实际位置排布：
      // 方块造型（Minecraft 风），换枪/换姿势都能自动接上，不会悬空或错位
      function tubeUnit(r1, r2, mat, fracFrom, fracTo, nm) {
        var w = (r1 + r2) * 1.35;                       // 用两个半径推出方块边长
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, 1, w), mat);
        m.userData.wpart = true;
        m.name = nm || 'armBox';
        m.userData.fracFrom = fracFrom;
        m.userData.fracTo = fracTo;
        a.add(m);
        return m;
      }
      /* ---- Minecraft 式方块手臂：整条手臂就是一个长方体 ----
         用"单位长度方盒"建，再按 肩→手 的实际距离拉伸，所以换枪/换姿势都能自动接上，
         也永远不会像导入模型那样位置对不准。 */
      var t1 = tubeUnit(0.031, 0.03, sleeve, 0.0, 0.66, 'armBox1');    // 前段（细一点）
      var t2 = tubeUnit(0.035, 0.042, sleeve, 0.5, 1.0, 'armBox2');    // 后段（靠近肩，粗一点）
      var cuff = new THREE.Mesh(new THREE.BoxGeometry(0.098, 0.02, 0.098), accent);   // 袖口的荧光方块环
      cuff.userData.wpart = true;
      cuff.name = 'armCuff';
      a.add(cuff);
      a.userData.tubes = [t1, t2];
      a.userData.cuff = cuff;
      /** 按当前 hand.position 摆好两段"方块手臂"与袖口 */
      a.userData.layoutArm = function () {
        var hp = hand.position, L = hp.length() || 0.001;
        var d = hp.clone().normalize();
        var q = new THREE.Quaternion().setFromUnitVectors(up, d);
        a.userData.tubes.forEach(function (m) {
          var f0 = m.userData.fracFrom, f1 = m.userData.fracTo;
          m.scale.set(1, Math.max(0.001, (f1 - f0) * L), 1);
          m.position.copy(hp).multiplyScalar((f0 + f1) * 0.5);
          m.quaternion.copy(q);
        });
        cuff.position.copy(hp).multiplyScalar(0.72);
        cuff.quaternion.copy(q);
      };
      a.userData.hand = hand;
      a.userData.restRot = new THREE.Euler(0, 0, 0);
      a.userData.layoutArm();
      inner.add(a);
      return a;
    }

    // 右臂：手握住 QBZ-191 的手枪握把（食指留在扳机上）
    var armR = makeArm(new THREE.Vector3(0.26, -0.4, 0.34), new THREE.Vector3(0.012, -0.072, 0.175),
      [-0.5, 0.35, 0.15], 1, 0.9, true);
    // 左臂：手握斜角前握把（QBZ-191 的标志性握法）
    var armL = makeArm(new THREE.Vector3(-0.34, -0.48, 0.16), new THREE.Vector3(0.01, -0.128, -0.3),
      [-0.42, -0.22, -0.18], -1, 1.0, false);
    // 换弹时右手要离开握把去拉拉机柄，这里记下"握把姿势"与"拉机柄姿势"两个目标
    armR.userData.chargePos = armR.userData.rest.clone().add(new THREE.Vector3(-0.1, 0.16, -0.03));
    armR.userData.chargeRot = new THREE.Euler(-0.55, 0.3, 0.25);

    // 换弹时左手拿的"新弹匣"：平时隐藏，随手上下来回（凭空取出 → 插入）
    var magCarried = new THREE.Group();
    (function () {
      for (var i = 0; i < 2; i++) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.1), polymer);
        m.position.set(0, -0.02 - i * 0.062, 0.01 + i * 0.012);
        m.rotation.x = -0.12 * i;
        m.userData.wpart = true;
        magCarried.add(m);
      }
      var floor = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.01, 0.096), gunmetal);
      floor.position.set(0, -0.145, 0.028);
      floor.rotation.x = -0.26;
      floor.userData.wpart = true;
      magCarried.add(floor);
    })();
    magCarried.position.set(0, -0.02, -0.055);
    magCarried.rotation.set(0.9, 0, 0);
    magCarried.visible = false;
    armL.userData.hand.add(magCarried);

    /* ================= 枪口火光 ================= */
    var flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });
    var flash = new THREE.Group();
    var p1 = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.11), flashMat); p1.name = 'flashQuad';
    var p2 = p1.clone(); p2.rotation.z = Math.PI / 4; p2.name = 'flashQuad2';
    flash.add(p1, p2);
    flash.position.set(0, 0.022, -0.95);
    flash.visible = false;
    inner.add(flash);

    return {
      group: g,
      inner: inner,
      flash: flash,
      flashMat: flashMat,
      magazine: magazine,
      armL: armL,
      armR: armR,
      magCarried: magCarried,
      setHandCurl: setHandCurl,
      bolt: boltMesh,
      /** 红点镜的光学中心（举枪时把它对到相机光轴） */
      scopeEye: new THREE.Vector3(0, dotY, dotZ),
      /** 枪口位置（局部坐标），用于计算曳光弹与火光 */
      muzzle: new THREE.Vector3(0, 0.014, -1.09),
      partCount: parts.length + magazine.children.length + 24
    };
  }

  /* ---------------------------------------------------------------
     可选：用网络上下载的模型替换武器 / 双手 / 整个第一人称模型
     ---------------------------------------------------------------
     把模型放进 web/models/ 即可，按优先级自动挑一个：
       1) viewmodel.glb —— 整把枪 + 双手（多数 FPS 枪模自带手臂，推荐）
       2) weapon.glb    —— 只换枪（保留自带双手，可用 handsOffset 微调双手位置）
       3) hands.glb     —— 只换双手（保留自带枪模）
     另外可选 models/models.json 做精细调整，例如：
       {
         "viewmodel": { "file": "rifle.glb", "normalize": 1.1,
                        "position": [0,0,0], "rotation": [0,3.14159,0],
                        "clips": { "idle": "Idle", "aim": "Aim", "reload": "Reload", "fire": "Fire" } },
         "weapon":    { "file": "gun.glb", "handsOffset": [0,-0.02,0] },
         "hands":     { "file": "hands.glb", "normalize": 0.12 }
       }
     字段含义：normalize = 按包围盒把最长边缩放到该尺寸（米）；position/rotation 为附加微调；
     clips 用于手动指定动画剪辑名（不填则按 idle/aim/reload/fire 关键词自动匹配）。
     模型不存在时静默保留程序化模型，不会报错。
     --------------------------------------------------------------- */
  var MODEL_KINDS = [
    { key: 'viewmodel', file: 'models/viewmodel.glb', normalize: 1.1, hideGun: true, hideHands: true },
    { key: 'weapon', file: 'models/weapon.glb', normalize: 1.1, hideGun: true, hideHands: false },
    { key: 'hands', file: 'models/hands.glb', normalize: 0.12, hideGun: false, hideHands: true }
  ];

  function loadExternalModels(player) {
    player.externalModels = { config: null, loaded: [], failed: [] };

    function applyOne(kind, cfg, gltf) {
      if (true) {
        var root = gltf.scene;

        /* ---- 只换双手：把手挂到两条手臂上（左右各自的偏移/旋转/缩放/镜像）----
           同一个模型加载两次而不是克隆：带骨骼的模型克隆不会重新绑定骨骼，
           两次加载各自持有独立骨架，最省事也最可靠。 */
        if (kind.key === 'hands') {
          var per = cfg.perHand || {};
          // 先归一化：整只手的最长边缩放到 cfg.normalize（默认 0.22 m）并居中，
          // 否则下载模型的原始单位（可能是厘米甚至十几单位）会变成一只巨手糊满屏幕
          var fit = function (obj) {
            var target = cfg.normalize || 0.22;
            var bb = new THREE.Box3().setFromObject(obj);
            var sz = bb.getSize(new THREE.Vector3());
            var longest = Math.max(sz.x, sz.y, sz.z) || 1;
            obj.scale.multiplyScalar(target / longest);
            obj.updateMatrixWorld(true);
            bb.setFromObject(obj);
            obj.position.sub(bb.getCenter(new THREE.Vector3()));
          };
          var place = function (arm, c, mirror, src) {
            // 只收起程序化的"手套本体"（hand 组里的零件）；小臂/袖口保留，
            // 这样导入的手仍然连在小臂上，不会看起来悬空
            var h = arm.userData.hand;
            for (var i = 0; i < h.children.length; i++) h.children[i].visible = false;   // 隐藏程序化手
            var sc = c.scale == null ? 1 : c.scale;
            src.scale.multiplyScalar(sc);
            if (mirror) src.scale.x *= -1;
            var p = c.pos || [0, 0, 0], r = c.rot || [0, 0, 0];
            src.position.set(p[0], p[1], p[2]);
            src.rotation.set(r[0], r[1], r[2]);
            src.traverse(function (o) { if (o.isMesh) { o.userData.wpart = true; o.castShadow = false; } });
            h.add(src);
          };
          fit(root);
          place(player.armR, per.right || {}, false, root);
          new THREE.GLTFLoader().load(cfg.file, function (g2) {
            fit(g2.scene);
            place(player.armL, per.left || {}, (per.left && per.left.mirror) !== false, g2.scene);
            player.externalModels.loaded.push({ kind: 'hands', file: cfg.file, clips: [] });
            if (player.ctx.callbacks.onWeaponModel) player.ctx.callbacks.onWeaponModel(player.externalModels);
          }, undefined, function () { });
          player.handsImported = true;
          return;
        }

        root.traverse(function (o) { if (o.isMesh) { o.userData.wpart = true; o.castShadow = false; } });

        // 归一化：按包围盒缩放并居中
        var box = new THREE.Box3().setFromObject(root);
        var size = box.getSize(new THREE.Vector3());
        var longest = Math.max(size.x, size.y, size.z) || 1;
        var target = cfg.normalize || kind.normalize;
        root.scale.multiplyScalar(target / longest);
        root.updateMatrixWorld(true);
        box.setFromObject(root);
        root.position.sub(box.getCenter(new THREE.Vector3()));
        if (cfg.rotation) root.rotation.set(cfg.rotation[0] || 0, cfg.rotation[1] || 0, cfg.rotation[2] || 0, 'YXZ');
        if (cfg.position) root.position.add(new THREE.Vector3(cfg.position[0] || 0, cfg.position[1] || 0, cfg.position[2] || 0));

        if (kind.hideGun) {
          // 收起程序化枪身（保留双手或一并收起）
          for (var i = 0; i < player.weaponInner.children.length; i++) {
            var c = player.weaponInner.children[i];
            if (c !== player.armL && c !== player.armR) c.visible = false;
          }
          // 真枪有自己的弹匣节点，程序化的两个弹匣（枪上 + 手中）都不再使用
          player.useProceduralMag = false;
          player.magMesh.visible = false;
          player.magCarried.visible = false;
        }
        if (kind.hideHands) { player.armL.visible = false; player.armR.visible = false; }
        if (cfg.handsOffset && cfg.handsOffset.length === 3) {
          player.weaponInner.position.set(cfg.handsOffset[0] || 0, cfg.handsOffset[1] || 0, cfg.handsOffset[2] || 0);
        }
        player.weapon.add(root);
        // 关键：测量任何节点位置前，先把武器组的矩阵刷新（否则 worldToLocal 会用旧矩阵，
        // 算出来的握把/护木坐标全错，手臂位置就会飞出去）
        player.weapon.updateMatrixWorld(true);

        // ---- 真枪的部件节点：弹匣 / 枪机 / 扳机 / 护木 ----
        var parts = { mag: null, bolt: null, trigger: null, handguard: null };
        root.updateMatrixWorld(true);
        root.traverse(function (o) {
          var n = ((o.name || '') + ' ' + ((o.parent && o.parent.name) || '')).toLowerCase();
          if (!parts.mag && /(^|[^a-z])mag([^a-z]|$)|magazine/.test(n)) parts.mag = o;
          if (!parts.bolt && /bolt(?:\s*carrier)?/.test(n)) parts.bolt = o;
          if (!parts.trigger && /trigger/.test(n)) parts.trigger = o;
          if (!parts.handguard && /handguard|foregrip/.test(n)) parts.handguard = o;
        });
        // 记下弹匣/枪机的初始位置，用于程序化动画
        function localOf(obj) {
          if (!obj) return null;
          var p = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
          return player.weapon.worldToLocal(p);
        }
        parts.magRest = localOf(parts.mag);
        parts.boltRest = localOf(parts.bolt);
        // 弹匣脱落方向 / 枪机后坐方向：都换算到各自父级坐标系，兼容任意模型朝向
        var wq = player.weapon.getWorldQuaternion(new THREE.Quaternion());
        function dirInParent(obj, worldDir) {
          var parent = obj.parent || root;
          var a = obj.getWorldPosition(new THREE.Vector3());
          var b = a.clone().add(worldDir);
          parent.worldToLocal(a);
          parent.worldToLocal(b);
          var d = b.sub(a);
          return d.lengthSq() < 1e-9 ? new THREE.Vector3(0, -1, 0) : d.normalize();
        }
        if (parts.mag) {
          parts.magRestPos = parts.mag.position.clone();
          parts.magDropDir = dirInParent(parts.mag, new THREE.Vector3(0, -1, 0.35).normalize().applyQuaternion(wq));
          var mb = new THREE.Box3().setFromObject(parts.mag).getSize(new THREE.Vector3());
          parts.magDropDist = Math.max(0.08, mb.length() * 0.55);
        }
        if (parts.bolt) {
          parts.boltRestPos = parts.bolt.position.clone();
          parts.boltDir = dirInParent(parts.bolt, new THREE.Vector3(0, 0, 1).applyQuaternion(wq));
          parts.boltDist = 0.035;
        }
        // ---- 瞄准锚点：真枪有照门就按"机械瞄具"举枪，没有才套用程序化镜筒 ----


        player.extParts = parts;
        if (cfg.debug) {
          function fmt(v) { return v ? '(' + v.x.toFixed(3) + ',' + v.y.toFixed(3) + ',' + v.z.toFixed(3) + ')' : 'null'; }
          var bs = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
          console.info('[models] 尺寸 ' + bs.x.toFixed(3) + '/' + bs.y.toFixed(3) + '/' + bs.z.toFixed(3) +
            ' 扳机(武器局部)=' + fmt(localOf(parts.trigger)) +
            ' 护木=' + fmt(localOf(parts.handguard)) +
            ' 弹匣=' + fmt(localOf(parts.mag)) +
            ' 右手锚点=' + fmt(player.armR.userData.hand.position));
        }

        // ---- 自动定向：只有朝向明显不对（偏离正前方 60° 以上）才纠正 ----
        // 多数 Sketchfab 导出模型本身已经"上=+Y、枪口朝前"，乱转会把它转坏。
        if (cfg.autoOrient !== false && parts.trigger && parts.handguard) {
          var trigA = localOf(parts.trigger), hgA = localOf(parts.handguard);
          if (trigA && hgA) {
            var fwd = hgA.clone().sub(trigA);
            fwd.y = 0;
            if (fwd.lengthSq() > 1e-6) {
              fwd.normalize();
              var diff = Math.atan2(fwd.x, fwd.z) - Math.atan2(0, -1);
              while (diff > Math.PI) diff -= Math.PI * 2;
              while (diff < -Math.PI) diff += Math.PI * 2;
              if (Math.abs(diff) > Math.PI / 3) {
                root.rotation.y += diff;
                root.updateMatrixWorld(true);
                if (cfg.debug) console.info('[models] 自动纠正朝向 ' + (diff * 180 / Math.PI).toFixed(0) + '°');
              }
            }
          }
        }
        // ---- 对位：把真枪的扳机放到游戏里"右手握把"的锚点上（构图与姿势才对）----
        if (cfg.alignToGrip !== false && parts.trigger) {
          var trigB = localOf(parts.trigger);
          if (trigB) {
            // 注意：手的锚点是"肩部枢轴 + 手部偏移"，不是那个相对偏移本身
            var gripTarget = player.armR.userData.rest.clone().add(player.armR.userData.hand.position);
            root.position.sub(trigB.sub(gripTarget));
            root.updateMatrixWorld(true);
          }
        }

        // ---- 自动把双手对到真枪的握把 / 护木上 ----
        if (cfg.autoFitHands !== false && (parts.trigger || parts.handguard)) {
          var grip = localOf(parts.trigger);
          var hg = localOf(parts.handguard);
          if (grip) {
            // 握把在扳机略后下方
            var target = grip.clone().add(new THREE.Vector3(0, -0.012, 0.055));
            var offR = player.armR.userData.hand.position.clone();
            var restR = target.clone().sub(offR);
            player.armR.userData.rest.copy(restR);
            player.armR.position.copy(restR);
            player.armR.userData.chargePos = restR.clone().add(new THREE.Vector3(-0.06, 0.1, -0.02));
          }
          if (hg) {
            var targetL = hg.clone().add(new THREE.Vector3(0, -0.03, -0.02));
            var offL = player.armL.userData.hand.position.clone();
            var restL = targetL.clone().sub(offL);
            player.armL.userData.rest.copy(restL);
            player.armL.position.copy(restL);
          }
          player.handsAutoFitted = true;
          // 双手位置变了 → 让小臂重新接上（否则袖子会悬空）
          if (player.armR.userData.layoutArm) player.armR.userData.layoutArm();
          if (player.armL.userData.layoutArm) player.armL.userData.layoutArm();
        }

        // ---- 瞄具锚点：直接找"镜片"网格（材质名 lens_glass / 名字含 lens|glass|optic），
        //      用它自身的几何中心当锚点 —— 这样镜片中心一定落在准心上，不用任何手工换算。
        var lensObj = null;
        root.traverse(function (o) {
          if (lensObj || !o.material) return;
          var mn = (o.material.name || '') + ' ' + (o.name || '');
          if (/lens|glass/i.test(mn)) lensObj = o;
        });
        if (lensObj && lensObj.geometry) {
          // 关键：连同父级一起刷新世界矩阵，否则算出来的镜片世界坐标是旧姿势的（会整体偏移）
          player.weapon.updateWorldMatrix(true, true);
          root.updateWorldMatrix(true, true);
          var lg = lensObj.geometry;
          if (!lg.boundingBox) lg.computeBoundingBox();
          var lc = lg.boundingBox.getCenter(new THREE.Vector3());
          lensObj.localToWorld(lc);
          player.aimAnchor = player.weapon.worldToLocal(lc);
          // 镜片中心放一颗 3D 红点：尺寸与准星红点相当（举枪时它就是准心，HUD 准星会隐藏）
          if (player.redDotMesh) player.weapon.remove(player.redDotMesh);
          var dotMesh = new THREE.Mesh(new THREE.SphereGeometry(0.00085, 10, 8),
            new THREE.MeshBasicMaterial({ color: 0xff2b3c, toneMapped: false }));
          dotMesh.name = 'SightDot';
          dotMesh.userData.wpart = true;
          dotMesh.position.copy(player.aimAnchor);
          player.weapon.add(dotMesh);
          player.redDotMesh = dotMesh;
          player.hasSightDot = true;
          if (cfg.debug) console.info('[models] 镜片网格=' + (lensObj.name || '?') +
            ' 世界中心=(' + lc.x.toFixed(3) + ',' + lc.y.toFixed(3) + ',' + lc.z.toFixed(3) + ')' +
            ' → 锚点=(' + player.aimAnchor.x.toFixed(3) + ',' + player.aimAnchor.y.toFixed(3) + ',' +
            player.aimAnchor.z.toFixed(3) + ')');
        }
        // 没有镜片网格时，退回用锚点节点（Optic / Rearsight）
        var rear = lensObj ? null : null;
        if (!lensObj) {
          root.traverse(function (o) {
            var n = ((o.name || '') + ' ' + ((o.parent && o.parent.name) || '')).toLowerCase();
            if (!rear && /rearsight|rear_sight|rear sight|optic|scope|sight/.test(n)) rear = o;
          });
        }
        if (rear) {
          var rearLocal = localOf(rear);
          if (rearLocal) {
            // 瞄具锚点 = 瞄具自身的中心（镜片中心）。举枪时把这个点对到相机光轴上，
            // 相机就正好落在镜片后面，于是"透过镜片看敌人"而不是看枪身。
            player.aimAnchor = rearLocal.clone();
            player.aimZoom = 1.35;            // 红点/全息：适度放大
            player.hasScopeOverlay = false;   // 不用镜筒遮罩，保留普通准星
            if (cfg.debug) console.info('[models] 瞄具锚点(武器局部)=' +
              rearLocal.x.toFixed(3) + ',' + rearLocal.y.toFixed(3) + ',' + rearLocal.z.toFixed(3));
          }
        }
        // models.json 里可以直接指定锚点/倍率/贴腮距离（用于手动修正自动识别不准的情况）
        if (cfg.aimAnchor && cfg.aimAnchor.length === 3) {
          player.aimAnchor = new THREE.Vector3(cfg.aimAnchor[0], cfg.aimAnchor[1], cfg.aimAnchor[2]);
          player.hasScopeOverlay = cfg.aimScopeOverlay === true;
          if (cfg.debug) console.info('[models] 使用配置里的瞄具锚点 ' + cfg.aimAnchor.join(','));
        }
        // 镜内画面样式：'reddot' = 红点镜窗口（浅色镜窗 + 红点），默认倍镜分划板
        if (cfg.scopeStyle) player.scopeStyle = cfg.scopeStyle;
        if (cfg.aimScopeOverlay === true) player.scopeStyle = cfg.scopeStyle || 'reddot';
        if (cfg.aimZoom) { player.aimZoom = cfg.aimZoom; player.aimZoomLocked = true; }
        if (cfg.aimRelief) player.aimRelief = cfg.aimRelief;

        var anims = gltf.animations || [];
        var clipNames = cfg.clips || {};
        function find(kindName, re) {
          if (clipNames[kindName]) {
            for (var i = 0; i < anims.length; i++) if (anims[i].name === clipNames[kindName]) return anims[i];
          }
          for (var j = 0; j < anims.length; j++) if (re.test(anims[j].name)) return anims[j];
          return null;
        }
        if (anims.length) {
          player.extMixer = new THREE.AnimationMixer(root);
          player.extClips = {
            idle: find('idle', /idle|静置|待机/i),
            aim: find('aim', /aim|ads|镜/i),
            reload: find('reload', /reload|换弹|mag/i),
            fire: find('fire', /fire|shoot|射击/i)
          };
          player.extState = '';
        }
        player.externalModels.loaded.push({ kind: kind.key, file: cfg.file, clips: anims.map(function (a) { return a.name; }) });
        if (player.ctx.callbacks.onWeaponModel) player.ctx.callbacks.onWeaponModel(player.externalModels);
      }
    }

    function tryNext(idx, userCfg) {
      if (idx >= MODEL_KINDS.length) return;
      var kind = MODEL_KINDS[idx];
      var cfg = Object.assign({ file: kind.file }, userCfg && userCfg[kind.key] ? userCfg[kind.key] : {});
      if (!cfg.file) { tryNext(idx + 1, userCfg); return; }
      // models.json 里的 file 约定为"相对 models 目录"，这里补全路径
      if (!/^[a-z]+:/i.test(cfg.file) && cfg.file.indexOf('models/') !== 0) cfg.file = 'models/' + cfg.file;

      /* 预加载已经读过的枪：直接用注册表里的，不再重复请求
         （启动页那 10 个文件里已经把武器读进来了，见 world.js 的 PRELOAD） */
      if (kind.key === 'weapon') {
        var pre = (FPS.World && FPS.World.MODELS && FPS.World.MODELS.weapon) || null;
        var prePath = (FPS.World && FPS.World.WEAPON_FILE) || null;
        if (pre && pre.scene && (!prePath || prePath === cfg.file)) {
          applyOne(kind, cfg, { scene: pre.scene });
          tryNext(idx + 1, userCfg);      // weapon 与 hands 可以叠加
          return;
        }
      }

      // 其余情况：直接尝试加载（文件不存在时 loader 走 error 回调，静默换下一种）
      var probe = new THREE.GLTFLoader();
      probe.load(cfg.file, function (gltf) {
        applyOne(kind, cfg, gltf);
        // viewmodel 是"整枪+双手"，换完就结束；weapon 与 hands 可以叠加
        if (kind.key !== 'viewmodel') tryNext(idx + 1, userCfg);
      }, undefined, function () {
        tryNext(idx + 1, userCfg);
      });
    }

    if (!THREE.GLTFLoader) return;
    /* 配置在启动页已经预读（W.WEAPON_CONFIG）；没读到才自己再读一次。
       用 XHR 读（file:// 下 fetch 拿不到内容长度）。 */
    function startWithConfig(cfg) {
      player.externalModels.config = cfg;
      tryNext(0, cfg);
    }
    if (FPS.World && FPS.World.WEAPON_CONFIG !== undefined) {
      startWithConfig(FPS.World.WEAPON_CONFIG);
      return;
    }
    new THREE.FileLoader().load('models/models.json', function (txt) {
      var cfg = null;
      try { cfg = JSON.parse(txt); } catch (e) { cfg = null; }
      startWithConfig(cfg);
    }, undefined, function () {
      startWithConfig(null);
    });
  }

  /* ---------------------------------------------------------------
     Player
     --------------------------------------------------------------- */
  function Player(ctx) {
    this.ctx = ctx;                  // { world, callbacks }
    this.camera = ctx.camera;
    this.scene = ctx.scene;

    this.pos = ctx.world.playerStart.clone();
    this.vel = new THREE.Vector3();
    this.yaw = Math.PI;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.onGround = true;
    this.groundY = 0;
    this.jumpBuffer = 0;
    this.aiming = false;      // 本帧是否处于右键瞄准
    this.aimLerp = 0;         // 0→1 的瞄准过渡，用于视野/武器/散布插值
    this.aimZoom = 1.35;          // 程序化枪模是红点镜（适度放大、不遮视野）
    this.aimAnchor = null;        // 举枪时对齐到光轴的点（外部模型可覆盖）
    this.hasScopeOverlay = false; // 红点镜不是倍镜，不用镜筒遮罩

    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    this.sensitivity = 1;      // 鼠标灵敏度倍率（由设置界面控制）

    this.mag = MAG_SIZE;
    this.reserve = RESERVE_START;
    this.reloading = false;
    this.reloadT = 0;
    this.fireCd = 0;
    this.bloom = 0;
    this.shotsFired = 0;
    this.deniedCd = 0;

    this.walkPhase = 0;
    this.bob = 0;
    this.landDip = 0;
    this.stepTimer = 0;
    this.stepAlt = false;
    this.shake = 0;
    this.hurtT = 0;
    this.kickZ = 0;
    this.kickRot = 0;
    this.boltKick = 0;            // 外部枪模的枪机后坐量（1 → 0）
    this.inspectT = 0;            // 检视枪械剩余时间（按 F 触发，0→1→0 的抬枪转枪动作）
    this.swayX = 0;
    this.swayY = 0;
    this.sprintT = 0;

    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 220;

    // ---- 武器渲染层 ----
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 8);
    this.viewScene.add(new THREE.HemisphereLight(0xbfd8ff, 0x101822, 0.72));
    var vdir = new THREE.DirectionalLight(0xffffff, 0.62);
    vdir.position.set(0.6, 1.2, 0.8);
    this.viewScene.add(vdir);
    var vfill = new THREE.PointLight(0x38e8ff, 0.5, 3, 2);
    vfill.position.set(-0.8, -0.5, 0.4);
    this.viewScene.add(vfill);
    var vm = buildViewModel();
    this.weapon = vm.group;
    // 旋转顺序用 ZYX：这样 rotation.z 是"屏幕空间滚转"（检视时把枪竖起来用）。
    // 默认 XYZ 顺序下 rotation.z 是绕枪管自转，屏幕上看不出变化。
    this.weapon.rotation.order = 'ZYX';
    _tmpEuler = new THREE.Euler(); _tmpQuat = new THREE.Quaternion();
    _tmpRoll = new THREE.Quaternion(); _axisZ = new THREE.Vector3(0, 0, 1);
    this.weaponInner = vm.inner;             // 程序化枪模 + 双手（可被外部枪模替换）
    this.weapon.position.set(0.19, -0.17, -0.42);
    this.weapon.rotation.set(0, 0.06, 0);
    this.viewScene.add(this.weapon);
    this.flash = vm.flash;
    this.magMesh = vm.magazine;              // 换弹动画用（不再依赖 children 下标）
    this.procBolt = vm.bolt;                 // 程序化枪模的枪机（开火时后坐）
    this.armL = vm.armL;                     // 左臂（换弹时整条移到画面外再拿弹匣回来）
    this.armR = vm.armR;
    this.magCarried = vm.magCarried;
    this.setHandCurl = vm.setHandCurl;
    this.scopeEye = vm.scopeEye;             // 目镜中心（局部坐标），举镜时对齐相机
    this.muzzleLocal = vm.muzzle;
    this.weaponPartCount = vm.partCount;

    // ---- 可选：换成外部下载的模型（web/models/，见文件头注释）----
    this.externalModels = null;
    this.extMixer = null;
    this.extClips = null;
    this.extState = '';
    loadExternalModels(this);
    this.muzzleLight = new THREE.PointLight(0xffc46a, 0, 13, 2);
    this.muzzleLight.position.set(0.19, -0.16, -1.2);
    this.viewScene.add(this.muzzleLight);

    // ---- 曳光弹池 ----
    this.tracers = [];
    for (var i = 0; i < 6; i++) {
      var geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      var mat = new THREE.LineBasicMaterial({
        color: 0xffe6a8, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.scene.add(line);
      this.tracers.push({ line: line, life: 0 });
    }
    this.tracerIdx = 0;

    this._updateCamera(0);
  }

  Player.prototype = {
    constructor: Player,

    reset: function (pos) {
      this.pos.copy(pos || this.ctx.world.playerStart);
      this.vel.set(0, 0, 0);
      this.yaw = Math.PI;
      this.pitch = 0;
      this.recoilPitch = this.recoilYaw = 0;
      this.health = this.maxHealth;
      this.alive = true;
      this.mag = MAG_SIZE;
      this.reserve = RESERVE_START;
      this.reloading = false;
      this.fireCd = 0;
      this.bloom = 0;
      this.deniedCd = 0;
      this.jumpBuffer = 0;
      this.shake = 0;
      this.hurtT = 0;
      this.bob = 0;
      this.landDip = 0;
      this.kickZ = this.kickRot = 0;
      this.swayX = this.swayY = 0;
      this.flashT = 0;
      this.flash.visible = false;
      this.muzzleLight.intensity = 0;
      FPS.Particles.clear();
      for (var i = 0; i < this.tracers.length; i++) {
        this.tracers[i].life = 0;
        this.tracers[i].line.material.opacity = 0;
      }
      this._updateCamera(0);
    },

    /** 鼠标移动：dx/dy 为像素位移 */
    look: function (dx, dy) {
      if (!this.alive) return;
      // 开镜时按放大倍率等比例降低灵敏度，否则高倍镜下没法瞄
      var zoomMul = 1 / (1 + (ADS_ZOOM - 1) * this.aimLerp);
      var sens = 0.0022 * (this.sensitivity || 1) * zoomMul;
      this.yaw -= dx * sens;
      this.pitch -= dy * sens;
      var lim = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
      // 武器摆动（开镜时几乎不摆）
      var swayMul = 1 - this.aimLerp;
      this.swayX = Math.max(-0.06, Math.min(0.06, this.swayX - dx * 0.0016 * swayMul));
      this.swayY = Math.max(-0.05, Math.min(0.05, this.swayY - dy * 0.0014 * swayMul));
    },

    /** 当前散布（弧度）：瞄准时完全无扩散 */
    spread: function () {
      var move = Math.min(1, Math.hypot(this.vel.x, this.vel.z) / SPRINT);
      var s = 0.0022 + this.bloom + move * 0.014 + (this.onGround ? 0 : 0.022);
      return s * (1 - this.aimLerp);
    },

    muzzleWorld: function (out) {
      // 武器在 viewScene 中，其世界坐标即相机空间坐标，再转到主场景世界坐标
      var p = this.weapon.localToWorld((out || _muzzle).copy(this.muzzleLocal));
      return this.camera.localToWorld(p);
    },

    /**
     * 手动/自动换弹。
     * 只要弹匣没满、且还有备弹就允许换 —— 不做"剩余多少才准换"的限制，
     * 否则玩家在波次中途（弹匣还有大半）按 R 会被静默忽略，像是按键失灵。
     */
    /** 检视枪械（按 F）：抬枪并向内侧转一圈，亮出枪身侧面 */
    startInspect: function () {
      if (this.reloading || this.inspectT > 0) return false;
      this.inspectT = INSPECT_TIME;
      if (Sfx.magTap) Sfx.magTap(0.02);      // 轻微的一声，表示有动作
      return true;
    },
    reload: function (force) {
      if (!this.alive || this.reloading) return false;
      if (this.mag >= MAG_SIZE) return false;   // 弹匣已满
      if (this.reserve <= 0) return false;      // 没有备弹
      this.inspectT = 0;                        // 换弹是实战动作：立刻打断检视
      this.reloading = true;
      this.reloadT = RELOAD_TIME;
      Sfx.reloadOut();
      if (Sfx.magTap) Sfx.magTap(RELOAD_TIME * 0.66);      // 拍弹匣底
      Sfx.reloadIn(RELOAD_TIME * 0.78);                    // 拉机柄上膛
      if (this.ctx.callbacks.onReload) this.ctx.callbacks.onReload();
      return true;
    },

    /** 换弹请求被拒绝时的提示音（带冷却，避免连按刷音） */
    deniedFeedback: function () {
      if (this.deniedCd > 0) return;
      this.deniedCd = 0.4;
      Sfx.empty();
    },

    fire: function () {
      var cb = this.ctx.callbacks;
      if (!this.alive || this.reloading || this.fireCd > 0) return false;
      this.inspectT = 0;                        // 开火是实战动作：立刻打断检视

      // 训练场：子弹无限，不用换弹
      if (window.FPS.Training && FPS.Training.infiniteAmmo) {
        this.mag = MAG_SIZE;
        this.reserve = MAX_RESERVE;
      }

      if (this.mag <= 0) {
        this.fireCd = 0.28;
        Sfx.empty();
        if (this.reserve > 0) this.reload(true);
        return false;
      }

      this.mag--;
      this.fireCd = FIRE_RATE;
      this.shotsFired++;
      this.bloom = Math.min(0.055, this.bloom + 0.0095);
      this.boltKick = 1;                       // 外部枪模的枪机后坐（内部模型无此节点则无影响）
      this.kickZ = 0.055;
      this.kickRot = 0.15;
      this.recoilPitch += 0.0135 + Math.random() * 0.004;
      this.recoilYaw += (Math.random() * 2 - 1) * 0.005;

      Sfx.shot();

      /* ---------------- 射线判定 ---------------- */
      var spread = this.spread();
      this.raycaster.setFromCamera({ x: 0, y: 0 }, this.camera);
      var dir = _dir.copy(this.raycaster.ray.direction).normalize();
      _right.crossVectors(dir, this.camera.up).normalize();
      _up.crossVectors(_right, dir).normalize();
      var a = Math.random() * Math.PI * 2;
      var r = Math.sqrt(Math.random()) * spread;
      dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();

      var origin = this.camera.getWorldPosition(_v).clone();
      this.raycaster.set(origin, dir);
      this.raycaster.far = 220;

      var targets = this.ctx.callbacks.getTargets();
      var hits = this.raycaster.intersectObjects(targets, false);
      var end = origin.clone().addScaledVector(dir, 120);

      if (hits.length) {
        var hit = hits[0];
        end.copy(hit.point);
        var enemy = hit.object.userData.enemy;
        var normalDir = dir.clone();

        if (enemy && enemy.alive) {
          var res = enemy.damage(DAMAGE, hit.object.userData.part, hit.point, normalDir);
          if (cb.onEnemyHit) cb.onEnemyHit(enemy, hit.object.userData.part, res);
        } else {
          // 打在场景上：火星 + 弹尘
          P.burst(hit.point, { count: 7, color: 'spark', speed: 4.4, life: 0.3, size: 0.05, spread: 1, gravity: -14 });
          P.burst(hit.point, { count: 4, color: 'smoke', speed: 1.6, life: 0.5, size: 0.1, spread: 1, gravity: -0.6 });
          if (cb.onSurfaceHit) cb.onSurfaceHit(hit.point);
        }
      }

      // 曳光弹
      var mz = this.muzzleWorld(new THREE.Vector3());
      this.spawnTracer(mz, end);

      // 枪口火光（尺寸/亮度都收小，避免糊视野）
      this.flash.visible = true;
      this.flash.rotation.z = Math.random() * 3;
      this.flash.scale.setScalar(0.5 + Math.random() * 0.25);
      this.flashT = 0.032;
      this.muzzleLight.intensity = 1.0;

      if (cb.onShoot) cb.onShoot(this.pos);
      return true;
    },

    spawnTracer: function (from, to) {
      var t = this.tracers[this.tracerIdx];
      this.tracerIdx = (this.tracerIdx + 1) % this.tracers.length;
      var arr = t.line.geometry.attributes.position.array;
      arr[0] = from.x; arr[1] = from.y; arr[2] = from.z;
      arr[3] = to.x; arr[4] = to.y; arr[5] = to.z;
      t.line.geometry.attributes.position.needsUpdate = true;
      t.life = 0.055;
      t.line.material.opacity = 0.6;
    },

    takeDamage: function (amount, fromPos) {
      if (!this.alive) return;
      this.health -= amount;
      this.hurtT = 0.5;
      this.shake = Math.min(1, this.shake + 0.55);
      Sfx.hurt();
      if (fromPos) {
        // 被击退一点
        var dx = this.pos.x - fromPos.x, dz = this.pos.z - fromPos.z;
        var d = Math.hypot(dx, dz) || 1;
        this.vel.x += (dx / d) * 2.4;
        this.vel.z += (dz / d) * 2.4;
      }
      if (this.health <= 0) {
        this.health = 0;
        this.alive = false;
      }
    },

    heal: function (amount) {
      this.health = Math.min(this.maxHealth, this.health + amount);
    },

    addAmmo: function (amount) {
      this.reserve = Math.min(MAX_RESERVE, this.reserve + amount);
    },

    /* ---------------- 主更新 ---------------- */
    update: function (dt, input) {
      var world = this.ctx.world;

      // 外部枪模的动画状态（idle / aim / reload / fire）
      if (this.extMixer && this.extClips) {
        var want = this.reloading ? 'reload' : (this.aimLerp > 0.5 ? 'aim' : 'idle');
        var clip = this.extClips[want] || this.extClips.idle;
        if (clip && want !== this.extState) {
          var next = this.extMixer.clipAction(clip);
          if (this.extState) {
            var prev = this.extClips[this.extState] && this.extMixer.clipAction(this.extClips[this.extState]);
            if (prev) { next.reset(); next.crossFadeFrom(prev, 0.15, false); }
          }
          next.play();
          this.extState = want;
        }
        this.extMixer.update(dt);
      }

      // 举枪倍率：瞄具锚点模式下默认 1.9×（机械瞄具/红点），
      // 若 models.json 里显式给了 aimZoom 就尊重它（aimZoomLocked）
      if (!this.aimZoomLocked) this.aimZoom = this.aimAnchor ? 1.9 : 1.35;
      // 程序化枪模的枪机：开火时后坐一下
      if (this.procBolt) {
        var bk0 = this.boltKick;
        this.procBolt.position.z = 0.02 + bk0 * 0.028;
      }

      // 右键瞄准状态（长按/点击两种模式由 main.js 换算成 input.aim）
      this.aiming = !!(input.aim && this.alive);
      var aimTarget = this.aiming ? 1 : 0;
      this.aimLerp += (aimTarget - this.aimLerp) * Math.min(1, dt * ADS_LERP);
      if (this.aimLerp < 0.001) this.aimLerp = 0;
      if (this.aimLerp > 0.999) this.aimLerp = 1;
      // 武器层相机同步放大视野
      var viewFov = 58 / (1 + (ADS_ZOOM - 1) * this.aimLerp);
      if (Math.abs(this.viewCamera.fov - viewFov) > 0.01) {
        this.viewCamera.fov = viewFov;
        this.viewCamera.updateProjectionMatrix();
      }

      if (this.fireCd > 0) this.fireCd -= dt;
      if (this.flashT > 0) {
        this.flashT -= dt;
        if (this.flashT <= 0) {
          this.flash.visible = false;
          this.muzzleLight.intensity = 0;
        }
      }

      // 散布与后坐恢复
      this.bloom = Math.max(0, this.bloom - this.bloom * 6 * dt - 0.0015 * dt);
      this.recoilPitch *= Math.max(0, 1 - 9 * dt);
      this.recoilYaw *= Math.max(0, 1 - 9 * dt);
      this.swayX *= Math.max(0, 1 - 7 * dt);
      this.swayY *= Math.max(0, 1 - 7 * dt);
      this.kickZ *= Math.max(0, 1 - 13 * dt);
      this.kickRot *= Math.max(0, 1 - 13 * dt);
      if (this.boltKick > 0) this.boltKick = Math.max(0, this.boltKick - dt * 20);
      if (this.inspectT > 0) this.inspectT = Math.max(0, this.inspectT - dt);
      if (this.aiming && this.inspectT > 0) this.inspectT = 0;   // 开镜也是实战动作：打断检视
      if (this.hurtT > 0) this.hurtT -= dt;
      if (this.deniedCd > 0) this.deniedCd -= dt;
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.1);

      // 换弹
      if (this.reloading) {
        this.reloadT -= dt;
        if (this.reloadT <= 0) {
          var need = MAG_SIZE - this.mag;
          var take = Math.min(need, this.reserve);
          this.mag += take;
          this.reserve -= take;
          this.reloading = false;
          if (this.ctx.callbacks.onReloadEnd) this.ctx.callbacks.onReloadEnd();
        }
      }

      if (!this.alive) {
        // 死亡：镜头下坠
        this.pos.y = Math.max(0.35, this.pos.y - dt * 0.0);
        this.pitch = Math.max(-0.5, this.pitch - dt * 0.55);
        this.bob *= Math.max(0, 1 - 3 * dt);
        this._animateWeapon(dt, 0);
        this._updateCamera(dt);
        this._updateTracers(dt);
        return;
      }

      /* ---------------- 移动 ---------------- */
      var wishX = 0, wishZ = 0;
      if (input.forward) wishZ -= 1;
      if (input.back) wishZ += 1;
      if (input.left) wishX -= 1;
      if (input.right) wishX += 1;

      var len = Math.hypot(wishX, wishZ);
      if (len > 0) { wishX /= len; wishZ /= len; }

      var sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      // 相机朝向：yaw 绕 Y 轴，前方为 -Z
      var fx = -sin, fz = -cos;
      var rx = cos, rz = -sin;

      // 冲刺只看"是否按住 Shift + 向前 + 不在换弹"，不看是否在地面：
      // 否则一起跳冲刺就被取消，空中速度目标从 9 掉回 6，跑跳会被硬生生拽慢，
      // 而且"先按空格再按 Shift"和"先按 Shift 再按空格"的手感会完全不同。
      var sprintIntent = input.sprint && wishZ < 0 && !this.reloading && !this.aiming;
      var sprinting = sprintIntent && this.onGround;   // 仅用于镜头/武器动画
      var base = sprintIntent ? SPRINT : (wishZ > 0 ? BACK : WALK);
      if (this.aiming) base *= ADS_MOVE;               // 瞄准时移动大幅变慢
      var wantX = (fx * -wishZ + rx * wishX) * base;
      var wantZ = (fz * -wishZ + rz * wishX) * base;

      if (this.onGround) {
        var k = Math.min(1, ACCEL * dt);
        this.vel.x += (wantX - this.vel.x) * k;
        this.vel.z += (wantZ - this.vel.z) * k;
        if (len === 0) {
          var damp = Math.max(0, 1 - 11 * dt);
          this.vel.x *= damp;
          this.vel.z *= damp;
        }
      } else if (len > 0) {
        // 空中：保留起跳时的水平动量。目标速度取 max(当前速度, 目标速度)，
        // 所以冲刺跳不会掉速；只以有限的速率改变方向（可以轻微转向）。
        var curSpeed = Math.hypot(this.vel.x, this.vel.z);
        var targetSpeed = Math.max(curSpeed, base);
        var wl = Math.hypot(wantX, wantZ) || 1;
        var ax = wantX / wl * targetSpeed;
        var az = wantZ / wl * targetSpeed;
        var ka = Math.min(1, AIR_STEER * dt);
        this.vel.x += (ax - this.vel.x) * ka;
        this.vel.z += (az - this.vel.z) * ka;
      } else {
        // 空中且无方向输入：只有很小的空气阻力
        var ad = Math.max(0, 1 - AIR_DRAG * dt);
        this.vel.x *= ad;
        this.vel.z *= ad;
      }

      // 跳跃 / 重力（带 0.15s 输入缓冲：落地前稍早按空格也算数）
      // 开镜时也可以跳跃（不再有跳跃惩罚）
      if (input.jumpPressed) this.jumpBuffer = JUMP_BUFFER;
      if (this.jumpBuffer > 0) this.jumpBuffer -= dt;
      if ((input.jump || this.jumpBuffer > 0) && this.onGround) {
        this.vel.y = JUMP_V;
        this.onGround = false;
        this.jumpBuffer = 0;
      }
      this.vel.y -= GRAVITY * dt;

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y += this.vel.y * dt;

      var ground = world.resolve(this.pos, RADIUS, HEIGHT);

      if (this.pos.y <= ground + 0.001) {
        if (!this.onGround && this.vel.y < -4) {
          this.landDip = Math.min(0.14, -this.vel.y * 0.014);
          P.burst(new THREE.Vector3(this.pos.x, ground + 0.05, this.pos.z), {
            count: 5, color: 'smoke', speed: 1.2, life: 0.35, size: 0.07, spread: 1, gravity: -1
          });
        }
        this.pos.y = ground;
        this.vel.y = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
      this.groundY = ground;
      if (this.landDip > 0) this.landDip = Math.max(0, this.landDip - dt * 0.5);

      /* ---------------- 开火 / 换弹 ---------------- */
      if (input.firing) this.fire();
      if (input.reload) {
        // 正在换弹时不重复提示（避免按住 R 一直响）
        if (!this.reload(false) && !this.reloading) this.deniedFeedback();
      }

      /* ---------------- 动画 & 相机 ---------------- */
      var speedH = Math.hypot(this.vel.x, this.vel.z);
      var moving = this.onGround && speedH > 0.6;
      this.walkPhase += dt * (moving ? speedH * 1.55 : 0);
      if (moving) {
        this.bob += dt * speedH * 1.55;
        this.stepTimer -= dt * speedH;
        if (this.stepTimer <= 0) {
          this.stepTimer = 2.4;
          this.stepAlt = !this.stepAlt;
          Sfx.step(this.stepAlt);
        }
      }
      this.sprintT += ((sprinting ? 1 : 0) - this.sprintT) * Math.min(1, dt * 6);

      this._animateWeapon(dt, speedH);
      this._updateCamera(dt);
      this._updateTracers(dt);
    },

    _animateWeapon: function (dt, speedH) {
      var bobX = Math.sin(this.walkPhase) * 0.012 * this.sprintT;
      var bobY = Math.abs(Math.cos(this.walkPhase)) * 0.009 * this.sprintT;
      var idleY = Math.sin(performance.now() * 0.0013) * 0.0035;

      var reloadPose = 0;
      if (this.reloading) {
        var k = 1 - Math.abs(this.reloadT / RELOAD_TIME - 0.5) * 2; // 0→1→0
        reloadPose = k;
      }

      // 换弹：继续往上抬，但只轻轻往左挪一点点（左移太多会跑出视野）
      var rlPose = 0;
      if (this.reloading) rlPose = 1 - Math.abs(this.reloadT / RELOAD_TIME - 0.5) * 2;   // 0→1→0

      /* 检视枪械（按 F）—— 慢速长动画，三段：
         ① 转身横过枪身，随即开始扫视：画面中心从枪口一路掠过机匣、握把直到枪托
         ② 单手举枪：枪口朝上（这一段开始前隐藏右手，结束后恢复）
         ③ 收回枪械（回到正常持枪姿态）
         期间按开火 / 换弹 / 开镜会立刻打断检视，优先执行实战动作 */
      var inspTurn = 0, inspSweep = 0, inspUp = 0, inspLeft = 1;
      if (this.inspectT > 0) {
        var ip = 1 - this.inspectT / INSPECT_TIME;          // 0 → 1
        inspTurn = tri01(ip, 0.00, 0.08, 0.90, 1.00);       // 快速转身横过来
        inspSweep = ease01(ip, 0.06, 0.54);                 // 平滑扫视（首尾慢、中间快）
        inspUp = tri01(ip, 0.58, 0.72, 0.86, 0.97);         // 单手举枪
        // 左手在"即将竖起"时收起（单手举枪时左手是自由的那只，留着会穿帮），收尾后再露出来
        inspLeft = (ip > 0.52 && ip < 0.99) ? 0 : 1;
      }
      // 横向：从右侧起步（此时枪口正对画面中心），一路向左扫过 1.1 米，
      // 画面中心依次掠过 枪口 → 机匣 → 握把 → 枪托，保证枪托也能看到；
      // 扫视结束后，举枪阶段再把枪横向带回屏幕右侧，收尾落在右侧
      var inspX = 0.50 - inspSweep * 1.10 + inspUp * 0.62;

      // 左手按需隐藏（举枪阶段），其余时间正常显示；检视被打断时也会自动恢复
      this.armL.visible = inspLeft > 0.5;

      var tx = 0.19 + bobX + this.swayX - rlPose * 0.05 + inspTurn * inspX;
      // 检视整体抬高一些，别让枪沉到画面最下面看不见
      var ty = -0.17 + bobY + idleY + this.swayY + rlPose * 0.16 + inspTurn * 0.12 + inspUp * 0.06 - this.landDip * 0.4;
      // 检视：保持原来的视角距离（不拉远也不推近），只靠把枪往左移来看全整枪；举枪时稍微推远一点
      var tz = -0.42 + this.kickZ + rlPose * 0.06 - inspUp * 0.20;

      // 举镜：把瞄准镜的目镜中心对到相机光轴上（x=0, y=0），并留出出瞳距离。
      // 武器在 viewScene 里、相机在原点，武器旋转在举镜时收敛到 0，
      // 因此"目镜落到光轴上"等价于 weapon.position = -scopeEye（再前移一点）。
      var a = this.aimLerp;
      if (a > 0) {
        var anchor = this.aimAnchor || this.scopeEye;
        // 瞄具锚点模式下，相机放在瞄具后方 cfg.aimRelief（默认 13cm）处：既在镜片后面，又不会切进枪身
        var relief = this.aimAnchor ? (this.aimRelief || 0.13) : ADS_EYE_RELIEF;
        tx = tx * (1 - a) + (-anchor.x) * a;
        ty = ty * (1 - a) + (-anchor.y - reloadPose * 0.1) * a;
        tz = tz * (1 - a) + (-relief - anchor.z) * a;
      }
      // 只有"倍镜遮罩"模式才把枪身藏起来（镜内画面由 HUD 遮罩表现）；
      // 机械瞄具时枪必须看得见，否则变成对着空气瞄准
      this.weapon.visible = !(this.aimLerp >= 0.62 && this.hasScopeOverlay !== false);

      this.weapon.position.x += (tx - this.weapon.position.x) * Math.min(1, dt * 18);
      this.weapon.position.y += (ty - this.weapon.position.y) * Math.min(1, dt * 18);
      this.weapon.position.z += (tz - this.weapon.position.z) * Math.min(1, dt * 18);

      // 检视最后一段：不做花哨的滚转，直接"单手把枪举起来、枪口朝上"——
      // 就是加大俯仰角（握把留在下方，枪口抬到上方），最直观也最不容易出歧义。
      var rotX = this.kickRot * 0.9 + reloadPose * 0.85 - this.swayY * 1.1 + inspTurn * 0.06 + inspUp * 1.25;
      // 偏航：把枪横过来（检视时看到整条枪身侧面）
      var rotY = this.swayX * 1.3 + reloadPose * 0.22 + inspTurn * 0.95;
      var rotZ = -(1 - this.sprintT) * 0.03 + Math.sin(this.walkPhase) * 0.02 * this.sprintT;
      // 瞄准时把武器摆正
      var ai = this.aimLerp;
      rotX *= (1 - ai); rotY *= (1 - ai); rotZ *= (1 - ai);
      _tmpEuler.set(rotX, rotY, 0, 'YXZ');
      _tmpQuat.setFromEuler(_tmpEuler);
      _tmpQuat.premultiply(_tmpRoll.setFromAxisAngle(_axisZ, rotZ));   // 屏幕空间滚转 = 最后应用
      this.weapon.quaternion.slerp(_tmpQuat, Math.min(1, dt * 18));

      // ---- 换弹动画（四段）：左手离握取弹匣 → 插入 → 拍弹匣底 → 右手拉拉机柄 ----
      var rl = 0, down = 0, tap = 0, ch = 0;
      var rest = this.armL.userData.rest;
      var restR = this.armR.userData.rest;
      if (this.reloading) {
        rl = 1 - Math.max(0, this.reloadT) / RELOAD_TIME;          // 0 → 1
        // 左手：0~0.42 下探出画面，0.42~0.62 拿着弹匣回来，0.62~0.74 拍一下弹匣底，之后归位
        down = rl < 0.42 ? rl / 0.42 : (rl < 0.62 ? 1 : Math.max(0, 1 - (rl - 0.62) / 0.3));
        down = down * down * (3 - 2 * down);
        tap = (rl > 0.6 && rl < 0.74) ? Math.sin((rl - 0.6) / 0.14 * Math.PI) : 0;
        this.armL.position.set(rest.x - down * 0.12, rest.y - down * 0.62 + tap * 0.05, rest.z + down * 0.16);
        this.armL.rotation.set(-down * 0.85 + tap * 0.12, down * 0.25, down * 0.2);
        this.setHandCurl(this.armL.userData.hand, 0.55 + down * 0.4, false);
        if (this.useProceduralMag !== false) {
          this.magCarried.visible = down > 0.35 && rl < 0.64;
          this.magMesh.visible = !(rl > 0.3 && rl < 0.6);
          this.magMesh.position.y = -0.14 * Math.min(1, down * 1.6);
          this.magMesh.rotation.z = Math.min(0.5, down * 0.6);
        }
        // 右手：0.72~0.98 离开握把去拉机柄
        ch = (rl > 0.72 && rl < 0.98) ? Math.sin((rl - 0.72) / 0.26 * Math.PI) : 0;
        var cp = this.armR.userData.chargePos, cr = this.armR.userData.chargeRot;
        this.armR.position.set(
          restR.x + (cp.x - restR.x) * ch,
          restR.y + (cp.y - restR.y) * ch,
          restR.z + (cp.z - restR.z) * ch + ch * 0.03
        );
        this.armR.rotation.set(cr.x * ch, cr.y * ch, cr.z * ch);
        this.setHandCurl(this.armR.userData.hand, 0.9 - ch * 0.35, true);
      } else {
        this.armL.position.lerp(rest, Math.min(1, dt * 8));
        this.armL.rotation.x += (0 - this.armL.rotation.x) * Math.min(1, dt * 8);
        this.armL.rotation.y += (0 - this.armL.rotation.y) * Math.min(1, dt * 8);
        this.armL.rotation.z += (0 - this.armL.rotation.z) * Math.min(1, dt * 8);
        this.setHandCurl(this.armL.userData.hand, 1.0, false);
        this.armR.position.lerp(restR, Math.min(1, dt * 8));
        this.armR.rotation.x += (0 - this.armR.rotation.x) * Math.min(1, dt * 8);
        this.armR.rotation.y += (0 - this.armR.rotation.y) * Math.min(1, dt * 8);
        this.armR.rotation.z += (0 - this.armR.rotation.z) * Math.min(1, dt * 8);
        this.setHandCurl(this.armR.userData.hand, 0.9, true);
        // 真枪模式：程序化的两个弹匣（枪上 + 手中）一律隐藏，绝不显示
        if (this.useProceduralMag === false) {
          this.magCarried.visible = false;
          this.magMesh.visible = false;
        } else {
          this.magCarried.visible = false;
          this.magMesh.visible = true;
          this.magMesh.position.y += (0 - this.magMesh.position.y) * Math.min(1, dt * 10);
          this.magMesh.rotation.z += (0 - this.magMesh.rotation.z) * Math.min(1, dt * 10);
        }
      }

      // ---- 外部枪模自带的部件节点（真枪的弹匣 / 枪机）：做程序化动作 ----
      var ep = this.extParts;
      if (ep && ep.magRestPos && ep.mag) {
        var mdrop = this.reloading ? Math.min(1, down * 1.6) : 0;
        ep.mag.position.copy(ep.magRestPos).addScaledVector(ep.magDropDir, ep.magDropDist * mdrop);
        ep.mag.visible = !(this.reloading && rl > 0.3 && rl < 0.6);
      }
      if (ep && ep.boltRestPos && ep.bolt) {
        var bk = Math.max(this.boltKick, this.reloading ? ch : 0);
        ep.bolt.position.copy(ep.boltRestPos).addScaledVector(ep.boltDir, ep.boltDist * bk);
      }
    },

    _updateCamera: function (dt) {
      var bobY = Math.sin(this.walkPhase * 2) * 0.022 * this.sprintT;
      var bobX = Math.cos(this.walkPhase) * 0.03 * this.sprintT;

      this.camera.rotation.order = 'YXZ';
      var shakeA = this.shake * 0.035;
      this.camera.rotation.y = this.yaw + this.recoilYaw + (Math.random() * 2 - 1) * shakeA;
      this.camera.rotation.x = this.pitch + this.recoilPitch + (Math.random() * 2 - 1) * shakeA;
      // 侧移时的镜头倾斜
      this.camera.rotation.z = -this.vel.x * 0.004 + (Math.random() * 2 - 1) * shakeA * 0.6;

      // 高倍镜下加一点呼吸摆动（越贴镜越明显，但幅度很小，不影响命中判定）
      if (this.aimLerp > 0.02) {
        var bt = performance.now() * 0.001;
        var amp = this.aimLerp * 0.0011;
        this.camera.rotation.y += Math.sin(bt * 0.9) * amp;
        this.camera.rotation.x += Math.sin(bt * 1.37 + 1.1) * amp * 0.75;
      }

      var eyeY = EYE + bobY - this.landDip;
      if (!this.alive) eyeY = EYE * 0.4;

      this.camera.position.set(
        this.pos.x + bobX * 0.35,
        this.pos.y + eyeY,
        this.pos.z
      );
    },

    _updateTracers: function (dt) {
      for (var i = 0; i < this.tracers.length; i++) {
        var t = this.tracers[i];
        if (t.life > 0) {
          t.life -= dt;
          t.line.material.opacity = Math.max(0, t.life / 0.055) * 0.6;
        } else if (t.line.material.opacity !== 0) {
          t.line.material.opacity = 0;
        }
      }
    },

    /** 武器层渲染（在主场景之后调用，先清深度） */
    renderViewModel: function (renderer, aspect) {
      if (this.viewCamera.aspect !== aspect) {
        this.viewCamera.aspect = aspect;
        this.viewCamera.updateProjectionMatrix();
      }
      renderer.clearDepth();
      renderer.render(this.viewScene, this.viewCamera);
    },

    ammoText: function () {
      return { mag: this.mag, reserve: this.reserve, size: MAG_SIZE, reloading: this.reloading };
    }
  };

  FPS.Player = Player;
  FPS.Player.MAG_SIZE = MAG_SIZE;
})();
