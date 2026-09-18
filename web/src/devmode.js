/* =====================================================================
   地图摆放模块（玩家版）
   ---------------------------------------------------------------------
   这个文件同时承担两件事：
     1) 开发者模式（摆放物体、导出 JSON、活动空间面板）—— 本版本**已由页面开关关闭**：
        index.html 里设了 window.__DEV_MODE_DISABLED = true，所以不建任何开发者界面、
        F3 与 ?dev=1 都无效。
     2) **内置地图的摆放与碰撞体的建立** —— 正常运行，竞技场那 798 个物体就是这里放上去的。
        所以这个文件不能删：删了地图会消失。
   ===================================================================== */
window.FPS = window.FPS || {};

(function () {
  'use strict';

  var D = (FPS.DevMode = {});
  /* 玩家版开关：由**页面**决定（index.html 里那一行 `window.__DEV_MODE_DISABLED`）。
     开发版不写这一行 → 一切照旧（F3 / ?dev=1 都能开开发者模式）；
     玩家版写 `= true`  → 不建 UI、F3 无效、?dev=1 无效，
     但**地图摆放逻辑照常工作**（内置地图载入 / 每帧同步 / 体素与碰撞体建立都走这条通路）。 */
  var DEV_HIDDEN = (window.__DEV_MODE_DISABLED === true);
  var ctx = null, ui = null;
  var items = [];                 // 已放置的实例 {type, holder, tag, scaleMul}
  var selected = null;
  var helpers = [];               // 碰撞体线框
  var wallPreview = [];           // 空气墙预览线框
  var outline = null;             // 选中描边
  var fly = false, showColliders = false, showStats = false;
  var flyPos = null, flyYaw = 0, flyPitch = 0;
  var keys = {};
  var placing = null;                                  // 正在用鼠标拖动放置的实例
  var lastMouse = { x: 0, y: 0 };                      // 最近一次鼠标屏幕坐标
  var groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);   // 贴地平面 y = 0
  var dirKeys = { left: false, right: false, fwd: false, back: false, rise: false, sink: false };
  var step = 0.25, stepFast = 1.0;

  var NAMES = {
    street: '日式小镇街道', villageHouse: '日式三层住宅', temple: '寺庙（五重塔）',
    torii: '鸟居', traffic: '交通道具包', interior: '动漫室内（平墙）',
    shoji: '障子屏风', apartment: '公寓', city: '城市模块',
    sakura_tree_01___low_poly_model: '樱花树', sakura: '樱花树'
  };
  function label(tag) { return NAMES[tag] || tag; }

  /* ---------------- UI ---------------- */
  function el(tagName, css, text) {
    var e = document.createElement(tagName);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  function buildUI() {
    ui = {};
    var bar = el('div',
      'position:fixed;left:0;right:0;top:0;z-index:9999;display:flex;gap:6px;align-items:center;' +
      'padding:6px 10px;background:rgba(12,18,28,.86);color:#dbe7f5;font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;' +
      'border-bottom:1px solid rgba(120,180,255,.25)');
    bar.id = 'devBar';
    bar.style.display = 'none';          // 默认隐藏：只有开启开发者模式才显示
    document.body.appendChild(bar);
    ui.bar = bar;

    function btn(text, fn, title) {
      var b = el('button', 'padding:4px 10px;border:1px solid rgba(130,190,255,.35);border-radius:6px;' +
        'background:rgba(40,70,110,.55);color:#e6f0fb;cursor:pointer;font-size:13px', text);
      if (title) b.title = title;
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    }

    bar.appendChild(el('span', 'font-weight:700;color:#8fd0ff;margin-right:6px', '开发者模式'));

    // 添加：自绘下拉（原生 <select> 在 Tauri/WebView2 全屏下弹不出选项）
    var dd = el('div', 'position:relative;display:inline-block');
    var ddBtn = el('button',
      'padding:4px 10px;border:1px solid rgba(130,190,255,.35);border-radius:6px;' +
      'background:rgba(40,70,110,.55);color:#e6f0fb;cursor:pointer;font-size:13px;min-width:190px;text-align:left',
      '选择模型 ▾');
    ddBtn.id = 'devModelBtn';
    var ddList = el('div',
      'position:absolute;top:calc(100% + 4px);left:0;min-width:260px;max-height:360px;overflow:auto;' +
      'background:rgba(10,16,26,.98);border:1px solid rgba(130,190,255,.4);border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.5);display:none;z-index:10001;padding:4px');
    ddList.id = 'devModelList';
    ddBtn.onclick = function (e) {
      e.stopPropagation();
      var open = ddList.style.display === 'block';
      if (!open) refreshModelList();
      ddList.style.display = open ? 'none' : 'block';
    };
    ddList.onclick = function (e) { e.stopPropagation(); };
    document.addEventListener('click', function () { if (ddList) ddList.style.display = 'none'; }, true);
    dd.appendChild(ddBtn);
    dd.appendChild(ddList);
    bar.appendChild(dd);
    ui.select = ddList;
    ui.selectBtn = ddBtn;

    /* 六向方向键盘：按住连续移动，单击走一小步（解决方向键在某些环境不生效的问题） */
    var pad = el('div',
      'position:fixed;right:14px;top:52px;z-index:9999;display:none;' +
      'grid-template-columns:repeat(3,46px);grid-template-rows:repeat(4,34px);gap:5px;' +
      'background:rgba(12,18,28,.88);border:1px solid rgba(130,190,255,.32);border-radius:10px;padding:8px;' +
      'font:12px system-ui,"Microsoft YaHei"');
    pad.id = 'devDirPad';
    function padBtn(text, dir, col, row) {
      var b = el('button',
        'border:1px solid rgba(130,190,255,.35);border-radius:6px;background:rgba(40,70,110,.55);' +
        'color:#e6f0fb;cursor:pointer;font-size:13px;grid-column:' + col + ';grid-row:' + row,
        text);
      b.onmousedown = function (e) { e.stopPropagation(); dirKeys[dir] = true; b.style.background = 'rgba(53,224,255,.42)'; };
      b.onmouseup = function (e) { e.stopPropagation(); dirKeys[dir] = false; b.style.background = 'rgba(40,70,110,.55)'; };
      b.onmouseleave = function () { dirKeys[dir] = false; b.style.background = 'rgba(40,70,110,.55)'; };
      pad.appendChild(b);
      return b;
    }
    padBtn('上 ↑', 'rise', 2, 1);
    padBtn('左 ←', 'left', 1, 2);
    padBtn('前 ↑', 'back', 2, 3 - 1);   // 前 = -Z
    padBtn('右 →', 'right', 3, 2);
    padBtn('后 ↓', 'fwd', 2, 3);
    padBtn('下 ↓', 'sink', 2, 4);
    document.body.appendChild(pad);
    ui.dirPad = pad;
    btn('添加', function () {
      var tag = currentTag() || Object.keys((FPS.World && FPS.World.MODELS) || {})[0];
      if (!tag) { toast('模型还没加载完，请稍等几秒'); return; }
      if (!placing) beginPlace(tag);
      toast('放置锁定：左键放下 · 连续放置 · 右键退出');
    }, '进入连续放置（也可直接按鼠标右键）');

    btn('删除', function () { removeSelected(); }, '删除选中物体（Delete 键）');
    btn('复制', function () { duplicateSelected(); }, '复制选中物体（Ctrl+D）');
    btn('缩放−', function () { scaleSel(1 / 1.15); }, '缩小（- 键）');
    btn('缩放+', function () { scaleSel(1.15); }, '放大（+ 键）');
    var rotBox = el('span', 'display:inline-flex;gap:4px;margin-left:6px');
    function rotBtn(text, deg, title) {
      var b = el('button', 'padding:4px 10px;border:1px solid rgba(130,190,255,.35);border-radius:6px;' +
        'background:rgba(40,70,110,.55);color:#e6f0fb;cursor:pointer;font-size:13px', text);
      b.title = title;
      b.onclick = function () { rotBy(deg); };
      rotBox.appendChild(b);
      return b;
    }
    rotBtn('旋转 ⟲', -22.5, '逆时针旋转 22.5°（Shift+R 同效）');
    rotBtn('旋转 ⟳', 22.5, '顺时针旋转 22.5°（R 键同效）');
    rotBtn('旋转 90°', 90, '顺时针旋转 90°（快速对齐街道）');
    bar.appendChild(rotBox);

    bar.appendChild(el('span', 'opacity:.35', '|'));
    // 画面风格切换（实时预览，便于给每张地图挑风格）
    var lookBtn = btn('画面风格', function () {
      if (!FPS.PostFX || !ctx.postfx) { toast('后处理未就绪'); return; }
      var names = Object.keys((ctx.postfx && ctx.postfx.LOOKS) || (FPS.PostFX && FPS.PostFX.LOOKS) || {});
      if (!names.length) { toast('风格列表不可用'); return; }
      var cur = names.indexOf(ctx.postfx.lookName);
      var next = names[(cur + 1) % names.length];
      ctx.postfx.applyLook(next);
      lookBtn.textContent = '画面:' + next;
      toast('画面风格 → ' + next);
    }, '循环切换画面风格（实时预览）');
    lookBtn.textContent = '画面:' + ((ctx && ctx.postfx && ctx.postfx.lookName) || 'toy');
    // 保存/导出之前的内容
    btn('保存', function () { save(); }, '保存当前布局到本机');
    btn('导出', function () { exportJSON(); }, '导出 JSON 文本（可复制给开发者写回代码）');
    btn('载入', function () { load(); }, '载入上次保存的布局');
    btn('清空', function () { clearAll(); }, '清空所有已放置物体');

    bar.appendChild(el('span', 'opacity:.35', '|'));
    ui.bColl = btn('碰撞体', function () { toggleColliders(); }, '显示/隐藏所有碰撞盒（F4）');
    ui.bFly = btn('飞行', function () { toggleFly(); }, '自由飞行穿墙（F5）');
    ui.bStats = btn('统计', function () { toggleStats(); }, '显示三角面与绘制调用（F6）');
    ui.bWalls = btn('边界', function () { toggleWallPanel(); }, '调整空气墙（活动空间）：位置 / 大小 / 高度 / 厚度');

    bar.appendChild(el('span', 'margin-left:auto', ''));
    var quitBtn = el('button', 'padding:4px 14px;border:1px solid rgba(255,140,140,.5);border-radius:6px;' +
      'background:rgba(120,40,40,.6);color:#ffe3e3;cursor:pointer;font-size:13px;font-weight:700', '退出 (F3)');
    quitBtn.onclick = function () { D.setActive(false); };
    bar.appendChild(quitBtn);
    ui.bQuit = quitBtn;
    bar.appendChild(el('span', 'margin-left:12px;opacity:.7;font-size:12px',
      '方向键移动 · PgUp/PgDn 上下 · +/- 缩放 · Shift 粗调 · Delete 删除'));

    // 左下信息面板
    ui.info = el('div',
      'position:fixed;left:10px;bottom:10px;z-index:9999;padding:8px 12px;border-radius:8px;' +
      'background:rgba(12,18,28,.86);color:#cfe2f5;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre;display:none');
    ui.info.id = 'devInfo';
    document.body.appendChild(ui.info);

    // 导出用文本框
    ui.dump = el('textarea',
      'position:fixed;left:10px;top:52px;width:520px;height:240px;z-index:9999;display:none;' +
      'background:rgba(8,14,22,.95);color:#d7e7f7;font:11px/1.5 ui-monospace,Consolas,monospace;' +
      'border:1px solid rgba(130,190,255,.4);border-radius:8px;padding:8px');
    // 模型加载进度条
    ui.progWrap = el('div',
      'position:fixed;left:50%;top:46px;transform:translateX(-50%);z-index:9999;width:420px;display:none;' +
      'background:rgba(12,18,28,.88);border:1px solid rgba(130,190,255,.35);border-radius:8px;padding:10px 14px;' +
      'color:#dbe7f5;font:13px system-ui,"Microsoft YaHei"');
    ui.progWrap.id = 'devProgress';
    ui.progText = el('div', 'margin-bottom:6px', '模型预加载…');
    ui.progBarBg = el('div', 'height:8px;background:rgba(255,255,255,.14);border-radius:4px;overflow:hidden');
    ui.progBar = el('div', 'height:100%;width:0%;background:linear-gradient(90deg,#35e0ff,#7ef0c0);transition:width .2s');
    ui.progBarBg.appendChild(ui.progBar);
    ui.progWrap.appendChild(ui.progText);
    ui.progWrap.appendChild(ui.progBarBg);
    document.body.appendChild(ui.progWrap);

    ui.dump.id = 'devDump';
    document.body.appendChild(ui.dump);

    buildWallPanel();
  }

  /* =====================================================================
     空气墙（活动空间边界）面板
     ---------------------------------------------------------------------
     四道不可见的空气墙就是玩家的活动空间边界。这里能实时改：
       中心 X / Z、半宽（±X）、半深（±Z）、高度、厚度
     改完立即重建碰撞体，不用刷新页面；参数存在本机（和布局分开存）。
     ===================================================================== */
  var WALL_KEY = 'fps.dev.airwalls.v1';

  function applyAirWalls(save2) {
    var W = FPS.World;
    if (!W || !W.airWalls) return null;
    var a = W.airWalls;
    var r = ctx && ctx.world && ctx.world.rebuildAirWalls ? ctx.world.rebuildAirWalls() : null;
    if (save2) {
      try { localStorage.setItem(WALL_KEY, JSON.stringify(a)); } catch (e) { }
    }
    return r;
  }

  function loadAirWalls() {
    var W = FPS.World;
    if (!W || !W.airWalls) return;
    try {
      var raw = localStorage.getItem(WALL_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      ['cx', 'cz', 'half', 'halfX', 'halfZ', 'height', 'thickness'].forEach(function (k) {
        if (typeof d[k] === 'number' && isFinite(d[k])) W.airWalls[k] = d[k];
      });
      if (typeof d.thin === 'boolean') W.airWalls.thin = d.thin;
    } catch (e) { }
  }

  function buildWallPanel() {
    var panel = el('div',
      'position:fixed;right:10px;top:52px;z-index:10000;display:none;width:268px;' +
      'background:rgba(10,16,26,.94);border:1px solid rgba(130,190,255,.4);border-radius:10px;' +
      'padding:10px 12px;color:#dbe7f5;font:12px/1.6 system-ui,"Microsoft YaHei"');
    panel.id = 'devWalls';
    panel.appendChild(el('div', 'font-weight:700;margin-bottom:6px', '活动空间（空气墙）'));
    panel.appendChild(el('div', 'opacity:.7;font-size:11px;margin-bottom:8px',
      '改完立即生效并自动保存。当前这圈樱花树半径约 95~115 米。'));

    var rows = [];
    function row(label, key, step, min, max) {
      var wrap = el('div', 'display:flex;align-items:center;gap:6px;margin:3px 0');
      wrap.appendChild(el('span', 'width:74px;opacity:.85', label));
      var inp = el('input',
        'flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(130,190,255,.3);border-radius:5px;' +
        'color:#eaf4ff;padding:3px 6px;font:12px ui-monospace,Consolas,monospace');
      inp.type = 'number';
      inp.step = step; inp.min = min; inp.max = max;
      wrap.appendChild(inp);
      panel.appendChild(wrap);
      rows.push({ key: key, inp: inp });
      return inp;
    }
    row('中心 X', 'cx', 1);
    row('中心 Z', 'cz', 1);
    row('半宽 ±X', 'halfX', 5, 1, 4000);
    row('半深 ±Z', 'halfZ', 5, 1, 4000);
    row('高度', 'height', 5, 1, 4000);
    row('厚度', 'thickness', 0.5, 0.2, 40);

    var linkBox = el('label', 'display:flex;align-items:center;gap:6px;margin:6px 0;cursor:pointer');
    var link = el('input'); link.type = 'checkbox';
    linkBox.appendChild(link);
    linkBox.appendChild(el('span', '', '宽深联动（正方形）'));
    panel.appendChild(linkBox);

    var btnRow = el('div', 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap');
    function pbtn(text, fn, title) {
      var b = el('button',
        'padding:4px 10px;border:1px solid rgba(130,190,255,.35);border-radius:6px;' +
        'background:rgba(40,70,110,.55);color:#e6f0fb;cursor:pointer;font-size:12px', text);
      b.title = title || '';
      b.onclick = fn;
      btnRow.appendChild(b);
      return b;
    }
    pbtn('预览边界', function () { toggleWallPreview(); }, '显示空气墙线框（绿色框）');
    function resetAirWalls() {
      var a = FPS.World.airWalls;
      a.cx = 0; a.cz = 0; a.thin = false;
      a.half = 115; a.halfX = 115; a.halfZ = 115;
      a.height = 60; a.thickness = 2;
      syncPanel(); applyAirWalls(true);
      return a;
    }
    D.resetAirWalls = resetAirWalls;
    pbtn('重置', function () { resetAirWalls(); toast('活动空间已重置为 ±115 米、高 60 米'); },
      '恢复默认（±115 米、高 60 米）');
    panel.appendChild(btnRow);

    var info = el('div', 'margin-top:8px;opacity:.8;font-size:11px;white-space:pre-line');
    panel.appendChild(info);
    ui.wallPanel = panel;
    ui.wallInfo = info;

    function syncPanel() {
      var a = FPS.World.airWalls;
      if (!a.thin) { a.halfX = a.half; a.halfZ = a.half; }   // 联动时两个半宽都跟随 half
      rows.forEach(function (r) { r.inp.value = a[r.key]; });
      link.checked = !a.thin;
      info.textContent = '边界范围：X ' + (a.cx - a.halfX).toFixed(0) + ' ~ ' + (a.cx + a.halfX).toFixed(0) +
        '   Z ' + (a.cz - a.halfZ).toFixed(0) + ' ~ ' + (a.cz + a.halfZ).toFixed(0) +
        '\n场地尺寸 ' + (a.halfX * 2).toFixed(0) + ' × ' + (a.halfZ * 2).toFixed(0) + ' 米，高 ' + a.height + ' 米';
    }
    D.wallPanelSync = syncPanel;

    rows.forEach(function (r) {
      r.inp.oninput = function () {
        var v = parseFloat(r.inp.value);
        if (!isFinite(v)) return;
        var a = FPS.World.airWalls;
        a[r.key] = v;
        // 联动：半宽/半深任意一个改动，另一个与 half 一起同步
        if (!a.thin && (r.key === 'halfX' || r.key === 'halfZ')) a.half = v;
        syncPanel();
        applyAirWalls(true);
      };
    });
    link.onchange = function () {
      var a = FPS.World.airWalls;
      a.thin = !link.checked;
      if (!a.thin) a.half = Math.max(a.halfX, a.halfZ);
      syncPanel(); applyAirWalls(true);
    };

    document.body.appendChild(panel);
    loadAirWalls();
    syncPanel();
    applyAirWalls(false);
  }

  function toggleWallPanel() {
    if (!ui || !ui.wallPanel) return;
    var show = ui.wallPanel.style.display !== 'block';
    ui.wallPanel.style.display = show ? 'block' : 'none';
    ui.bWalls.style.background = show ? 'rgba(53,224,255,.35)' : 'rgba(40,70,110,.55)';
    if (show && D.wallPanelSync) D.wallPanelSync();
  }

  /* 空气墙预览：把四道边界画成半透明盒（不改碰撞） */
  function toggleWallPreview() {
    if (!ctx || !ctx.world) return;
    if (wallPreview.length) {
      wallPreview.forEach(function (h) { if (h.parent) h.parent.remove(h); });
      wallPreview = [];
      toast('空气墙预览 关');
      return;
    }
    var root = mapRoot();
    (ctx.world.airWallBoxes ? ctx.world.airWallBoxes() : []).forEach(function (b) {
      var h = new THREE.Box3Helper(b, 0x66ff99);
      h.material.depthTest = false;
      h.material.transparent = true;
      h.material.opacity = 0.9;
      root.add(h);
      wallPreview.push(h);
    });
    toast('空气墙预览 开（绿色框就是活动空间边界）');
  }

  function refreshModelList() {
    var models = (FPS.World && FPS.World.MODELS) || {};
    var keys = Object.keys(models);
    var EXPECTED = (FPS.World && FPS.World.MODEL_COUNT) || keys.length || 1;
    var list = ui.select;
    if (!list) return;
    list.innerHTML = '';

    if (keys.length < EXPECTED) {
      var ph = el('div', 'padding:8px 10px;color:#8fb6d8;font-size:12px',
        '模型加载中… ' + keys.length + '/' + EXPECTED);
      list.appendChild(ph);
    }

    keys.forEach(function (tag) {
      var label2 = label(tag) + '（' + (models[tag].targetH ? models[tag].targetH.toFixed(0) + 'm' : '?') + '）';
      var item = el('div',
        'padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:#e6f0fb;white-space:nowrap',
        label2 + (ui.currentTag === tag ? '   ✓' : ''));
      item.onmouseenter = function () { item.style.background = 'rgba(53,224,255,.22)'; };
      item.onmouseleave = function () { item.style.background = ''; };
      item.onclick = function (e) {
        e.stopPropagation();
        ui.currentTag = tag;
        if (ui.selectBtn) ui.selectBtn.textContent = label(tag) + ' ▾';
        list.style.display = 'none';
      };
      list.appendChild(item);
    });

    if (!keys.length) {
      var none = el('div', 'padding:8px 10px;color:#c8a0a0;font-size:12px', '（模型尚未加载完…）');
      list.appendChild(none);
    }
    if (!ui.currentTag && keys.length) {
      ui.currentTag = keys[0];
      if (ui.selectBtn) ui.selectBtn.textContent = label(keys[0]) + ' ▾';
    }
  }

  /* ---------------- 放置 / 选择 ---------------- */
  function makeInstance(tag) {
    var M = (FPS.World.MODELS || {})[tag];
    if (!M) return null;
    var holder = new THREE.Group();
    var inst = M.scene.clone(true);
    // 模型在加载阶段已经被"居中 + 脚底落地"（world.buildBVHFor 里对 scene 本身
    // 做的位移），所以这里**绝对不能再加平移** —— instance 局部坐标必须与 BVH
    // 局部坐标完全一致，否则三角形碰撞和看到的模型会错开半个模型（会直接穿墙）。
    void inst;
    holder.userData.voxels = M.voxels || null;   // 体素模板（预加载时算好）
    holder.userData.bvh = M.bvh || null;         // 三角形 BVH（方案 B，预加载时建好）
    holder.userData.instRef = inst;              // ★关键：用于取逆矩阵把球心变换到模型局部空间
    holder.add(inst);
    holder.userData.devType = tag;
    holder.userData.baseScale = M.targetH / Math.max(0.001, M.size.y);
    holder.userData.minY = M.bbox.min.y;
    return holder;
  }

  function applyTransform(it) {
    var s = it.holder.userData.baseScale * it.scaleMul;
    it.holder.scale.setScalar(s);
    // 关键：x / y / z 三个都要写！之前只写了 y，导致物体永远停在原点、方向键看似无效
    it.holder.position.set(it.x, it.y - it.holder.userData.minY * s, it.z);
    it.holder.rotation.y = it.rotY;
    it.holder.updateMatrixWorld(true);
    syncCollider(it);
    // 方案 B 兜底注册：只要实例带 BVH 就登记进三角形碰撞列表（幂等）
    if (it.bvh && it.bvh.ok && window.FPS.BVH_ITEMS && window.FPS.BVH_ITEMS.indexOf(it) >= 0) {
      it.worldBox = new THREE.Box3().setFromObject(it.holder);
    }
  }

  /* ================= 体素化碰撞 =================
     把模型三角面投到网格上，占用的格子合并成小方块 —— 这就是"贴着表面的碰撞外壳"。
     AABB 引擎下这是最贴近模型形状的做法（墙是墙、屋顶是屋顶、楼与楼之间的空隙能走过去）。 */
  function voxelizeModel(src, cell, yLo, yHi, ceil) {
    var tris = [];
    src.updateWorldMatrix(true, true);
    src.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var g = o.geometry, pos = g.attributes.position;
      if (!pos) return;
      var idx = g.index, m = o.matrixWorld, v = new THREE.Vector3();
      var n = idx ? idx.count : pos.count;
      for (var i = 0; i + 2 < n; i += 3) {
        var pts = [];
        for (var k = 0; k < 3; k++) {
          var vi = idx ? idx.getX(i + k) : (i + k);
          v.fromBufferAttribute(pos, vi).applyMatrix4(m);
          pts.push(v.x, v.y, v.z);
        }
        // 只保留落在指定高度区间内的三角面（用于分层细分）
        var yMin = Math.min(pts[1], pts[4], pts[7]);
        var yMax = Math.max(pts[1], pts[4], pts[7]);
        if (yHi !== undefined && yMin > yHi) continue;
        if (yLo !== undefined && yMax < yLo) continue;
        for (var q = 0; q < 9; q++) tris.push(pts[q]);
      }
    });
    if (!tris.length) return [];

    var bbAll = new THREE.Box3().setFromObject(src);
    var bb = bbAll.clone();
    if (yLo !== undefined) bb.min.y = Math.max(bb.min.y, yLo);
    if (yHi !== undefined) bb.max.y = Math.min(bb.max.y, yHi);

    var MAX_CELLS = 250000;          // 硬上限：超过就放弃这次尝试（由上层放粗重试）
    var cells = new Set();
    var ox = bbAll.min.x, oz = bbAll.min.z;
    var nx = Math.ceil((bbAll.max.x - ox) / cell) + 2;
    var nz = Math.ceil((bbAll.max.z - oz) / cell) + 2;
    // 高度按"当前层"的起点算，保证每层都是整齐的格子
    var oy = (yLo !== undefined) ? yLo : bbAll.min.y;
    var ny = Math.ceil((bb.max.y - oy) / cell) + 2;

    for (var t = 0; t < tris.length; t += 9) {
      var x0 = Math.min(tris[t], tris[t + 3], tris[t + 6]), x1 = Math.max(tris[t], tris[t + 3], tris[t + 6]);
      var y0 = Math.min(tris[t + 1], tris[t + 4], tris[t + 7]), y1 = Math.max(tris[t + 1], tris[t + 4], tris[t + 7]);
      var z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8]), z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8]);
      var i0 = Math.max(0, Math.floor((x0 - ox) / cell)), i1 = Math.min(nx - 1, Math.floor((x1 - ox) / cell));
      var j0 = Math.max(0, Math.floor((y0 - oy) / cell)), j1 = Math.min(ny - 1, Math.floor((y1 - oy) / cell));
      var k0 = Math.max(0, Math.floor((z0 - oz) / cell)), k1 = Math.min(nz - 1, Math.floor((z1 - oz) / cell));
      for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) for (var k = k0; k <= k1; k++) {
        cells.add(i + ',' + j + ',' + k);
      }
      if (cells.size > MAX_CELLS) return null;   // 立刻放弃，交给上层放粗
    }

    /* ===== 封闭内部：屋顶下的空格填实（房子不可进入，过道保持通畅）=====
       用"天花板高度图"判定：某空格的 3x3 邻域上方若都被盖住 → 它在房子内部 → 填实。
       过道上方只有细电线之类的细构件，盖不满 9 个格子 → 保持通畅。 */
    if (ceil) {
      var add = [];
      var cx2, cz2, allCov;
      for (var ii = 0; ii < nx; ii++) {
        for (var kk = 0; kk < nz; kk++) {
          var gx = ii, gz = kk;
          for (var jj = 0; jj < ny; jj++) {
            if (cells.has(ii + ',' + jj + ',' + kk)) continue;
            var yWorld = oy + (jj + 0.5) * cell;
            var cov = 0;
            for (var di = -1; di <= 1; di++) {
              for (var dk = -1; dk <= 1; dk++) {
                var t2 = ceil[celKey(gx + di, gz + dk)];
                if (t2 !== undefined && t2 >= yWorld + cell * 0.5) cov++;
              }
            }
            // 9 列里至少 6 列上方有天花板 → 判定为房子内部（过道上方的细电线只有 1~2 列，不会被误封）
            if (cov >= 6) add.push(ii + ',' + jj + ',' + kk);
          }
        }
      }
      add.forEach(function (key) { cells.add(key); });
      voxelizeModel.lastFilled = add.length;
    }

    var byRow = {};
    cells.forEach(function (key) {
      var a = key.split(',');
      var row = a[1] + ',' + a[2];
      (byRow[row] = byRow[row] || []).push(+a[0]);
    });
    var boxes = [];
    Object.keys(byRow).forEach(function (row) {
      var a = row.split(','), j = +a[0], k = +a[1];
      var xs = byRow[row].sort(function (m, n) { return m - n; });
      var start = xs[0], prev = xs[0];
      for (var q = 1; q <= xs.length; q++) {
        if (q < xs.length && xs[q] === prev + 1) { prev = xs[q]; continue; }
        boxes.push({ min: [ox + start * cell, oy + j * cell, oz + k * cell],
                     max: [ox + (prev + 1) * cell, oy + (j + 1) * cell, oz + (k + 1) * cell] });
        if (q < xs.length) { start = xs[q]; prev = xs[q]; }
      }
    });
    return boxes;
  }

  var CEIL_CELL = 1.0;        // 天花板高度图的精度（米）
  function celKey(gx, gz) { return gx + ',' + gz; }

  /** 按全模型算"天花板高度图"：每个 1 米见方的列上方的最高点 */
  function buildCeilingGrid(src, bb) {
    var g = {};
    var nx = Math.ceil((bb.max.x - bb.min.x) / CEIL_CELL) + 3;
    var nz = Math.ceil((bb.max.z - bb.min.z) / CEIL_CELL) + 3;
    src.updateWorldMatrix(true, true);
    src.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var geo = o.geometry, pos = geo.attributes.position;
      if (!pos) return;
      var idx = geo.index, m = o.matrixWorld, v = new THREE.Vector3();
      var n = idx ? idx.count : pos.count;
      for (var i = 0; i + 2 < n; i += 3) {
        var yMax = -1e9, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (var k = 0; k < 3; k++) {
          var vi = idx ? idx.getX(i + k) : (i + k);
          v.fromBufferAttribute(pos, vi).applyMatrix4(m);
          if (v.y > yMax) yMax = v.y;
          if (v.x < x0) x0 = v.x; if (v.x > x1) x1 = v.x;
          if (v.z < z0) z0 = v.z; if (v.z > z1) z1 = v.z;
        }
        var i0 = Math.floor((x0 - bb.min.x) / CEIL_CELL) + 1, i1 = Math.floor((x1 - bb.min.x) / CEIL_CELL) + 1;
        var k0 = Math.floor((z0 - bb.min.z) / CEIL_CELL) + 1, k1 = Math.floor((z1 - bb.min.z) / CEIL_CELL) + 1;
        for (var a = i0; a <= i1; a++) for (var b = k0; b <= k1; b++) {
          var key = celKey(a, b);
          if (g[key] === undefined || yMax > g[key]) g[key] = yMax;
        }
      }
    });
    return g;
  }

  /** 给模型准备体素模板（自适应粗细：方块太多就放粗） */
  function buildVoxelTemplate(src) {
    var bb = new THREE.Box3().setFromObject(src);
    var h = bb.max.y - bb.min.y;
    var splitY = bb.min.y + Math.min(3.5, h * 0.45);   // 下半部分（玩家能接触到的高度）
    var ceil = buildCeilingGrid(src, bb);             // 天花板高度图（全模型，用于判断房子内部）

    // 格子大小按模型尺寸自适应：大模型（整条街）用大格，否则格子会爆炸导致失败
    var span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    var fine = Math.max(0.5, span / 110);               // 细格基准（尺寸自适应）
    var lower = null;
    for (var k1 = 0; k1 < 4 && !lower; k1++) {
      lower = voxelizeModel(src, fine * Math.pow(1.5, k1), undefined, splitY, ceil);
    }
    if (!lower) lower = voxelizeModel(src, Math.max(0.8, span / 70), undefined, splitY, ceil) || [];

    // 上半：自适应粗格（屋顶/塔尖不需要细，省碰撞体）
    var cell = Math.max(1.0, span / 60);
    var upper = null;
    for (var attempt = 0; attempt < 4 && !upper; attempt++) {
      upper = voxelizeModel(src, cell, splitY, undefined, ceil);
      if (upper && upper.length > 120) { cell *= 1.5; upper = null; }
    }
    return lower.concat(upper || []);
  }

  /* 碰撞体跟随物体（统一在这里做，避免各处遗漏）
     ★ 关于 VOXEL_PAD：以前是 0.35 米，等于**在模型外面又套了一层壳** ——
       玩家离墙还有 0.7 米就被顶住/弹开（"一靠近就被弹开"就是这个原因）。
       体素格子本来就是紧挨着的、不会有缝，所以这里只需要 1~2 厘米来吸收
       浮点误差。碰撞的"贴合"由 BVH 三角面负责，体素盒只负责把房子内部填实。 */
  var VOXEL_PAD = 0.02;        // 每个体素方块向外扩张的厚度（米）—— 仅用于消除接缝
  function syncCollider(it) {
    var holder = it.holder;
    // 方案 B 严格模式：只用一个三角形 BVH，完全不生成盒子（默认关闭，因为推出逻辑还需调通）
    if (it.bvh && it.bvh.ok && window.FPS_BVH_ONLY !== false) {
      if (it.colliders && it.colliders.length) {
        it.colliders.forEach(function (b) {
          var ci = ctx.world.colliders.indexOf(b);
          if (ci >= 0) ctx.world.colliders.splice(ci, 1);
        });
      }
      it.colliders = [];
      return;
    }
    // 空气墙外的远景物体不需要碰撞体（玩家永远走不到）
    // 注意：边界有中心偏移（cx/cz），不能拿 |x|、|z| 直接和半宽比。
    var aw = (FPS.World && FPS.World.airWalls) || null;
    var cx = aw ? aw.cx : 0, cz = aw ? aw.cz : 0;
    var hx = aw ? (aw.thin ? aw.halfX : aw.half) : 96;
    var hz = aw ? (aw.thin ? aw.halfZ : aw.half) : 96;
    if (Math.abs(it.x - cx) > hx || Math.abs(it.z - cz) > hz) {
      if (it.colliders && it.colliders.length) {
        it.colliders.forEach(function (b) {
          var ci = ctx.world.colliders.indexOf(b);
          if (ci >= 0) ctx.world.colliders.splice(ci, 1);
        });
      }
      it.colliders = [];
      if (FPS.World && FPS.World.bvhUnregister) FPS.World.bvhUnregister(holder);
      return;
    }
    var s = holder.userData.baseScale * it.scaleMul;
    var vox = holder.userData.voxels;
    var localMinY = holder.userData.minY;
    var bvh = holder.userData.bvh;
    var useBVH = !!(bvh && FPS.World && FPS.World.bvhRegister && FPS.World.useBVH);
    // 体素方块堆叠**默认不再参与碰撞**（见 world.js 的 W.useVoxels 注释）：
    // 盒子永远贴不合复杂模型 —— 留缝能钻、加粗就变成模型外面套壳，而且重叠方块
    // 逐个推出还会累加把人弹飞。碰撞统一交给 BVH 三角面。
    // ?voxels=1 才把体素盒加回来（仅用于对比排查）。
    var addVoxelBoxes = useBVH ? !!(FPS.World && FPS.World.useVoxels) : true;
    if (!addVoxelBoxes) { vox = null; holder.userData.voxels = null; }

    /* 碰撞登记：有 BVH 就登记进 FPS.World.bvhInstances，由 world.resolve() 直接
       对三角面求交（侧向、站立、台阶全靠它）。没有 BVH 的模型才退回包围盒兜底。 */
    if (useBVH) {
      FPS.World.bvhRegister(holder, bvh);
    } else if (FPS.World && FPS.World.bvhUnregister) {
      FPS.World.bvhUnregister(holder);       // 从有 BVH 变成没有（或搬出空气墙）
    }

    // 先清掉旧碰撞体
    if (it.colliders && it.colliders.length) {
      it.colliders.forEach(function (b) {
        var ci = ctx.world.colliders.indexOf(b);
        if (ci >= 0) ctx.world.colliders.splice(ci, 1);
      });
    }
    it.colliders = [];

    if (!vox || !vox.length) {
      // 没有体素模板（或已禁用）：有 BVH 就完全交给 BVH；否则退回包围盒兜底
      if (!useBVH) {
        var b0 = new THREE.Box3().setFromObject(holder);
        ctx.world.colliders.push(b0);
        it.colliders.push(b0);
      }
      return;
    }
    holder.updateMatrixWorld(true);
    it.worldBox = new THREE.Box3().setFromObject(holder);   // 粗筛包围盒（随实例变换刷新）
    var m = holder.matrixWorld;
    vox.forEach(function (v) {
      var box = new THREE.Box3(
        new THREE.Vector3(v.min[0], v.min[1], v.min[2]),
        new THREE.Vector3(v.max[0], v.max[1], v.max[2]));
      box.applyMatrix4(m);        // 跟着实例的缩放/旋转/位移走（旋转时自动取外接盒）
      box.expandByScalar(VOXEL_PAD);   // 加粗：确保完全覆盖表面、不留缝
      ctx.world.colliders.push(box);
      it.colliders.push(box);
    });
    // 体素盒子在（只有 ?voxels=1 时）→ 侧向阻挡交给体素，BVH 只管站立/屋顶
    if (FPS.World && FPS.World.bvhInstances) {
      for (var bi = FPS.World.bvhInstances.length - 1; bi >= 0; bi--) {
        if (FPS.World.bvhInstances[bi].holder === holder) {
          FPS.World.bvhInstances[bi].voxelWalls = true;
          break;
        }
      }
    }
  }

  /** 在相机前方 10 米处放置 */
  function addModel(tag, atPos) {
    var holder = makeInstance(tag);
    if (!holder) return null;
    var dir = new THREE.Vector3();
    ctx.camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    var p = atPos;
    var dragPlace = !atPos;      // 没指定位置 = 手动添加 → 进入拖动放置
    if (!p) {
      // 先落在鼠标当前的地面位置；鼠标没打到地面就暂放视野前方，之后跟随鼠标（y 恒为 0）
      var mp = mouseGroundPoint();
      p = mp || ctx.camera.position.clone().addScaledVector(dir, 10);
    }
    var it = { type: tag, holder: holder, scaleMul: 1, x: p.x, y: 0, z: p.z, rotY: 0,
               bvh: holder.userData.bvh, instRef: holder.userData.instRef,
               mapOrigin: FPS.World.mapId };     // 记住它属于哪张地图
    applyTransform(it);
    // 挂到"当前地图的容器"下面，而不是场景根上 —— 换地图时才能整张一起清掉
    var root = FPS.World.ensureMapRoot ? FPS.World.ensureMapRoot(ctx.scene) : ctx.scene;
    root.add(holder);
    if (FPS.World.trackModelHolder) FPS.World.trackModelHolder(holder);
    items.push(it);
    addColliderFor(it);
    // 方案 B：直接登记到全局三角形碰撞列表（绕开一切 this/ctx 身份问题）
    if (it.bvh && it.bvh.ok) {
      window.FPS.BVH_ITEMS = window.FPS.BVH_ITEMS || [];
      it.worldBox = new THREE.Box3().setFromObject(it.holder);
      if (window.FPS.BVH_ITEMS.indexOf(it) < 0) window.FPS.BVH_ITEMS.push(it);
      if (FPS.World.markSpatialDirty) FPS.World.markSpatialDirty();   // 碰撞空间网格失效
    }
    if (ctx.world.registerBvhItem && it.bvh) {
      it.worldBox = new THREE.Box3().setFromObject(it.holder);
      ctx.world.registerBvhItem(it);            // 方案B：注册进三角形碰撞
    }
    select(it);                     // ← 添加后自动选中
    if (dragPlace) {
      placing = it;                 // 进入拖动放置状态
      toast('移动鼠标选位置 · 左键放下 · 右键退出');
    }
    return it;
  }

  function addColliderFor(it) {
    it.collider = null;
    if (it.bvh && it.bvh.ok && window.FPS_BVH_ONLY !== false) {
      it.colliders = [];
      return;
    }
    syncCollider(it);               // 没有 BVH 的模型才退回体素外壳
  }

  /* 删除指定实例（含碰撞体与 BVH 登记） */
  function removeItem(it) {
    if (!it) return;
    var idx = items.indexOf(it);
    if (idx >= 0) items.splice(idx, 1);
    if (it.holder && it.holder.parent) it.holder.parent.remove(it.holder);
    if (FPS.World.untrackModelHolder) FPS.World.untrackModelHolder(it.holder);
    if (window.FPS.BVH_ITEMS) { var k = window.FPS.BVH_ITEMS.indexOf(it); if (k >= 0) window.FPS.BVH_ITEMS.splice(k, 1); }
    if (FPS.World.markSpatialDirty) FPS.World.markSpatialDirty();   // 碰撞空间网格失效
    (it.colliders || []).forEach(function (b) {
      var ci = ctx.world.colliders.indexOf(b);
      if (ci >= 0) ctx.world.colliders.splice(ci, 1);
    });
    if (selected === it) select(null);
  }

  function removeSelected() {
    if (!selected) return;
    var i = items.indexOf(selected);
    if (i >= 0) items.splice(i, 1);
    if (selected.holder && selected.holder.parent) selected.holder.parent.remove(selected.holder);
    if (FPS.World.untrackModelHolder) FPS.World.untrackModelHolder(selected.holder);
    if (FPS.World && FPS.World.bvhUnregister) FPS.World.bvhUnregister(selected.holder);
    (selected.colliders || []).forEach(function (b) {
      var ci = ctx.world.colliders.indexOf(b);
      if (ci >= 0) ctx.world.colliders.splice(ci, 1);
    });
    select(null);
  }

  function duplicateSelected() {
    if (!selected) return;
    var it = addModel(selected.type, new THREE.Vector3(
      selected.x + 6, 0, selected.z + 2));
    if (it) { it.scaleMul = selected.scaleMul; it.rotY = selected.rotY; applyTransform(it); }
  }

  /* 旋转选中物体 */
  function rotBy(deg) {
    if (!selected) { toast('先选中一个物体'); return; }
    selected.rotY += deg * Math.PI / 180;
    applyTransform(selected);
    updateInfo();
    toast((deg > 0 ? '顺时针 ' : '逆时针 ') + Math.abs(deg) + '°   当前 ' +
      (((selected.rotY * 180 / Math.PI) % 360 + 360) % 360).toFixed(0) + '°');
  }

  function scaleSel(k) {
    if (!selected) return;
    selected.scaleMul = Math.max(0.1, Math.min(12, selected.scaleMul * k));
    applyTransform(selected);
  }

  function select(it) {
    selected = it;
    if (outline) { if (outline.parent) outline.parent.remove(outline); outline = null; }
    if (it) {
      outline = new THREE.BoxHelper(it.holder, 0x35e0ff);
      outline.material.depthTest = false;
      mapRoot().add(outline);
    }
    updateInfo();
  }

  /* 编辑器自己的可视化辅助（选中框 / 碰撞盒线框 / 空气墙预览）也挂在地图容器下，
     这样换地图时它们跟地图一起清掉，不会残留在另一张地图上。
     （曾经它们挂在 scene 根上，换图后旧框还留在新地图里） */
  function mapRoot() {
    if (!ctx) return null;
    return (FPS.World && FPS.World.ensureMapRoot) ? FPS.World.ensureMapRoot(ctx.scene) : ctx.scene;
  }

  /* ---------------- 碰撞体显示 ---------------- */
  function rebuildColliderHelpers() {
    helpers.forEach(function (h) { if (h.parent) h.parent.remove(h); });
    helpers = [];
    if (!showColliders) return;
    var root = mapRoot();
    ctx.world.colliders.forEach(function (b) {
      var h = new THREE.Box3Helper(b, 0x35e0ff);
      h.material.depthTest = false;
      h.material.transparent = true;
      h.material.opacity = 0.55;
      root.add(h);
      helpers.push(h);
    });
  }

  function toggleColliders() {
    showColliders = !showColliders;
    rebuildColliderHelpers();
    ui.bColl.style.background = showColliders ? 'rgba(53,224,255,.35)' : 'rgba(40,70,110,.55)';
  }

  /* ---------------- 飞行 / 统计 ---------------- */
  function toggleFly() {
    fly = !fly;
    if (fly) {
      flyPos = ctx.camera.position.clone();
      flyPos.y = Math.max(flyPos.y, 1.5);   // 抬高一点，避免一进飞行就贴地穿模
      var e = new THREE.Euler().setFromQuaternion(ctx.camera.quaternion, 'YXZ');
      flyYaw = e.y; flyPitch = e.x;
    }
    ui.bFly.style.background = fly ? 'rgba(53,224,255,.35)' : 'rgba(40,70,110,.55)';
    setPointerLock(fly);                            // 飞行锁鼠标环视，退出飞行解锁
    toast(fly ? '飞行模式 开 —— WASD 平移 · Q/E 升降 · 鼠标转向 · 再按 F5 退出'
              : '飞行模式 关 —— 鼠标已解锁，可点菜单');
  }

  function toggleStats() {
    showStats = !showStats;
    ui.info.style.display = showStats ? 'block' : 'none';
    ui.bStats.style.background = showStats ? 'rgba(53,224,255,.35)' : 'rgba(40,70,110,.55)';
  }

  /* ---------------- 存档 ---------------- */
  var KEY = 'fps.dev.layout.v1';

  function serialize() {
    var W = FPS.World, a = (W && W.airWalls) || null;
    return {
      /* version 2：多了 airWalls（活动空间/空气墙）。
         导出后交给开发者即可**永久写进代码** —— 布局写回 web/src/layout-default.js、
         边界写回 world.js 的 W.airWalls 默认值。 */
      version: 2,
      airWalls: a ? {
        cx: +(+a.cx).toFixed(2), cz: +(+a.cz).toFixed(2),
        half: +(+a.half).toFixed(2), halfX: +(+a.halfX).toFixed(2), halfZ: +(+a.halfZ).toFixed(2),
        height: +(+a.height).toFixed(2), thickness: +(+a.thickness).toFixed(2),
        thin: !!a.thin
      } : null,
      items: items.map(function (it) {
        return { type: it.type, x: +it.x.toFixed(2), y: +it.y.toFixed(2), z: +it.z.toFixed(2),
                 rotY: +it.rotY.toFixed(3), scaleMul: +it.scaleMul.toFixed(3) };
      })
    };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(serialize()));
      toast('已保存 ' + items.length + ' 个物体 ✓');
    } catch (e) { toast('保存失败: ' + e.message); }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { }
    if (!raw) { toast('没有找到存档'); return; }
    try { deserialize(JSON.parse(raw)); toast('已载入 ' + items.length + ' 个物体 ✓'); }
    catch (e) { toast('存档损坏'); }
  }

  function deserialize(data) {
    clearAll();
    (data.items || []).forEach(function (d) {
      var it = addModel(d.type, new THREE.Vector3(d.x, 0, d.z));
      if (!it) return;
      it.y = d.y || 0; it.rotY = d.rotY || 0; it.scaleMul = d.scaleMul || 1;
      applyTransform(it);
      addColliderFor(it);
    });
    // 存档里带了边界参数 → 一并恢复（旧存档没有这一段，就保持当前值）
    if (data.airWalls && FPS.World && FPS.World.airWalls) {
      var a = FPS.World.airWalls, d2 = data.airWalls;
      ['cx', 'cz', 'half', 'halfX', 'halfZ', 'height', 'thickness'].forEach(function (k) {
        if (typeof d2[k] === 'number' && isFinite(d2[k])) a[k] = d2[k];
      });
      if (typeof d2.thin === 'boolean') a.thin = d2.thin;
      applyAirWalls(false);
      if (D.wallPanelSync) D.wallPanelSync();
    }
    select(null);
    rebuildColliderHelpers();
  }

  function clearAll() {
    items.slice().forEach(function (it) {
      if (it.holder && it.holder.parent) it.holder.parent.remove(it.holder);
      if (FPS.World.untrackModelHolder) FPS.World.untrackModelHolder(it.holder);
      if (FPS.World && FPS.World.bvhUnregister) FPS.World.bvhUnregister(it.holder);
      (it.colliders || []).forEach(function (b) {
        var ci = ctx.world.colliders.indexOf(b);
        if (ci >= 0) ctx.world.colliders.splice(ci, 1);
      });
    });
    items = [];
    if (window.FPS.BVH_ITEMS) window.FPS.BVH_ITEMS.length = 0;
    if (FPS.World.markSpatialDirty) FPS.World.markSpatialDirty();   // 碰撞空间网格失效
    select(null);
    rebuildColliderHelpers();
  }

  /* =====================================================================
     地图隔离：只让"属于当前地图"的实例显示并参与碰撞
     ---------------------------------------------------------------------
     摆放的每个实例都记着 mapOrigin。换地图后：
       · 别的地图的实例 → 隐藏 + 退出碰撞表（不再挡人、也不再出现在画面里）
       · 本地图的实例   → 显示 + 重新登记碰撞
     这样两只地图永远不会混在一起，而且实例数据还在，切回去仍然完好。
     ===================================================================== */
  D.syncMapItems = function () {
    if (!ctx || !FPS.World) return 0;
    var cur = FPS.World.mapId;
    var curWorld = ctx.world;
    var root = FPS.World.ensureMapRoot ? FPS.World.ensureMapRoot(ctx.scene) : ctx.scene;
    var live = [];
    items.forEach(function (it) {
      if (!it.mapOrigin) it.mapOrigin = cur;          // 老数据：默认算当前地图的
      var mine = (it.mapOrigin === cur);
      it.holder.visible = mine;
      if (mine) {
        if (it.holder.parent !== root) {
          if (it.holder.parent) it.holder.parent.remove(it.holder);
          root.add(it.holder);
        }
        if (it.bvh && it.bvh.ok) {
          it.worldBox = new THREE.Box3().setFromObject(it.holder);
          live.push(it);
        }
      }
      // 只是清掉可能存在的旧登记；本帧的碰撞表在下面按当前地图重建
      it.colliders = [];
    });
    // 只重建一次，而且只装"属于当前地图"的实例
    window.FPS.BVH_ITEMS = live.slice();
    if (curWorld) curWorld.bvhItems.length = 0;
    live.forEach(function (it) { if (curWorld && curWorld.registerBvhItem) curWorld.registerBvhItem(it); });
    if (FPS.World.markSpatialDirty) FPS.World.markSpatialDirty();   // 碰撞空间网格失效
    return live.length;
  };

  function exportJSON() {
    var data = serialize();
    ui.dump.value = JSON.stringify(data, null, 1);
    ui.dump.style.display = 'block';
    ui.dump.select();
    var a = data.airWalls;
    toast('已导出 ' + data.items.length + ' 个物体' +
      (a ? ' + 活动空间（±' + (a.thin ? a.halfX + '×' + a.halfZ : a.half) + ' 米，高 ' + a.height + '）' : '') +
      ' ✓ 已复制到剪贴板');
    try { document.execCommand('copy'); }
    catch (e) { /* 复制失败也没关系，框里能手动复制 */ }
  }

  var toastEl = null, toastT = 0;
  function toast(msg) {
    /* 玩家版：所有开发者提示都不显示。
       注意 toastEl 是自己**按需创建**的，所以光是不建 UI 挡不住它
       —— 载入内置地图时会弹一句"已载入默认地图（798 个物体）"，那是给开发者看的。 */
    if (DEV_HIDDEN) return;
    if (!toastEl) {
      toastEl = el('div', 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:10000;' +
        'padding:8px 16px;border-radius:8px;background:rgba(12,18,28,.92);color:#dbe7f5;' +
        'font:13px system-ui,"Microsoft YaHei";border:1px solid rgba(130,190,255,.35)');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    toastT = 2.2;
  }

  function updateInfo() {
    if (!ui || !ui.info) return;
    var lines = [];
    if (selected) {
      var it = selected;
      lines.push('已选中: ' + label(it.type));
      lines.push('位置   X ' + it.x.toFixed(2) + '   Y ' + it.y.toFixed(2) + '   Z ' + it.z.toFixed(2));
      lines.push('缩放   ' + (it.scaleMul * 100).toFixed(0) + '%   旋转 ' + (it.rotY * 57.3).toFixed(0) + '°');
    } else {
      lines.push('未选中物体（点「添加」或点击场景中的物体）');
    }
    lines.push('---');
    lines.push('物体总数 ' + items.length + '   碰撞体 ' + ctx.world.colliders.length);
    ui.info.textContent = lines.join('\n');
  }

  /* ---------------- 输入 ---------------- */
  function onKey(e) {
    var k = e.key;
    var isDown = e.type === 'keydown';        // 开关类只在"按下"时生效，抬手不触发

    if (k === 'F3') {
      e.preventDefault();
      e.stopPropagation();
      if (DEV_HIDDEN) return;                  // 玩家版：F3 不再是开发者模式开关
      if (isDown && !e.repeat) toggleActive();
      return;
    }

    if (D.active && k === 'Escape') {         // 开发者模式下 Esc 不交给游戏
      // 正在输入框里按 Esc：先退出输入（表单控件/浏览器默认行为），别吞掉
      if (isTypingTarget(e.target) && e.target.blur) { e.target.blur(); return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    if (!D.active) return;

    // 焦点在输入框（空气墙面板等）里：全部按键交还给输入控件，游戏一律不抢
    // （顺手清掉按住状态，免得打字时选中物还在凭旧键值乱飞）
    if (isTypingTarget(e.target)) { if (e.type === 'keydown') keys = {}; return; }

    if (k === 'F4') { e.preventDefault(); if (isDown) toggleColliders(); return; }
    if (k === 'F5') { e.preventDefault(); if (isDown) toggleFly(); return; }
    if (k === 'F6') { e.preventDefault(); if (isDown) toggleStats(); return; }

    keys[k] = isDown;
    if (isDown) {
      if (k === 'Delete' || k === 'Backspace') { removeSelected(); e.preventDefault(); }
      else if (k === 'd' && (e.ctrlKey || e.metaKey)) { duplicateSelected(); e.preventDefault(); }
      else if (k === '+' || k === '=') { scaleSel(1.15); e.preventDefault(); }
      else if (k === '-' || k === '_') { scaleSel(1 / 1.15); e.preventDefault(); }
      else if (k === 'r' || k === 'R') { rotBy(e.shiftKey ? -22.5 : 22.5); }
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].indexOf(k) >= 0) e.preventDefault();
  }

  var MOVE_SPEED = 6.0;        // 正常移动速度（米/秒）
  var MOVE_SPEED_FAST = 20.0;  // 按住 Shift 的高速档
  var MOVE_CLICK_STEP = 0.5;   // 方向键按钮"单击一下"走的固定距离（米）
  var VERT_SPEED_RATIO = 0.25; // 上下速度相对横向的比例（上下幅度更细腻）
  var VERT_CLICK_STEP = 0.2;   // 上下单击步进（米）

  function moveSelected(dt) {
    if (!selected) return;
    var spd = keys['Shift'] ? MOVE_SPEED_FAST : MOVE_SPEED;
    var st = spd * dt;                    // 横向步长
    var stV = st * VERT_SPEED_RATIO;      // 上下步长（更小，便于精细调整高度）
    var dx = 0, dy = 0, dz = 0;
    if (keys['ArrowLeft'] || dirKeys.left) dx -= st;
    if (keys['ArrowRight'] || dirKeys.right) dx += st;
    if (keys['ArrowUp'] || dirKeys.fwd) dz -= st;
    if (keys['ArrowDown'] || dirKeys.back) dz += st;
    if (keys['PageUp'] || dirKeys.rise) dy += stV;
    if (keys['PageDown'] || dirKeys.sink) dy -= stV;
    if (!dx && !dy && !dz) return;
    selected.x += dx; selected.y += dy; selected.z += dz;
    applyTransform(selected);
    updateInfo();
  }

  /* 方向键按钮单击：走固定一小步（方便精确摆放） */
  function nudge(dir) {
    if (!selected) { toast('先选中一个物体（点画面里的建筑，或先添加）'); return; }
    var s = MOVE_CLICK_STEP;
    if (dir === 'left') selected.x -= s;
    if (dir === 'right') selected.x += s;
    if (dir === 'fwd') selected.z -= s;
    if (dir === 'back') selected.z += s;
    if (dir === 'rise') selected.y += VERT_CLICK_STEP;
    if (dir === 'sink') selected.y -= VERT_CLICK_STEP;
    applyTransform(selected);
    updateInfo();
  }

  function updateFly(dt) {
    // 飞行时沿用游戏自己的鼠标视角转向，保证鼠标照常可用
    if (ctx.player) { flyYaw = ctx.player.yaw; flyPitch = ctx.player.pitch; }
    var sp = (keys['Shift'] ? 60 : 18) * dt;
    var f = new THREE.Vector3(), r = new THREE.Vector3();
    var e = new THREE.Euler(flyPitch, flyYaw, 0, 'YXZ');
    f.set(0, 0, -1).applyEuler(e);
    r.set(1, 0, 0).applyEuler(e);
    var up = new THREE.Vector3(0, 1, 0);
    if (keys['w'] || keys['W']) flyPos.addScaledVector(f, sp);
    if (keys['s'] || keys['S']) flyPos.addScaledVector(f, -sp);
    if (keys['a'] || keys['A']) flyPos.addScaledVector(r, -sp);
    if (keys['d'] || keys['D']) flyPos.addScaledVector(r, sp);
    if (keys['q'] || keys['Q']) flyPos.addScaledVector(up, -sp);
    if (keys['e'] || keys['E']) flyPos.addScaledVector(up, sp);
    ctx.camera.position.copy(flyPos);
    ctx.camera.quaternion.setFromEuler(new THREE.Euler(flyPitch, flyYaw, 0, 'YXZ'));
  }

  /* 从源头接管指针锁定：
     游戏只要发现鼠标没锁就会再锁回去，光拦按键没用 —— 这里在开发者模式（且非飞行）下
     直接把 requestPointerLock 变成空操作，鼠标才能真正交还给用户。 */
  var _origRequestLock = null;
  function installLockGuard() {
    if (_origRequestLock || !Element.prototype.requestPointerLock) return;
    _origRequestLock = Element.prototype.requestPointerLock;
    Element.prototype.requestPointerLock = function () {
      if (D.active && !fly) return;                 // 非飞行的开发者模式：拒绝游戏抢鼠标（飞行需要锁定才能环视）
      return _origRequestLock.apply(this, arguments);
    };
  }

  /* 鼠标锁定控制：开发者模式默认解锁（方便点菜单），飞行模式重新锁定（方便环视） */
  function setPointerLock(want) {
    try {
      if (want) {
        if (!document.pointerLockElement && ctx.renderer && ctx.renderer.domElement) {
          ctx.renderer.domElement.requestPointerLock();
        }
      } else if (document.pointerLockElement) {
        document.exitPointerLock();
      }
    } catch (e) { }
  }

  /* 开发者模式开启时，拦下画布上的点击：避免重新锁鼠标、避免误开枪 */
  /* 画布交互：按住拖动 = 转视角；松开时若几乎没动 = 单击拾取 */
  var drag = { active: false, x: 0, y: 0, moved: 0 };

  /* 开发者面板上的点击必须放行；其余位置一律视为"画面操作"（HUD 透明层会盖住画布，
     所以不能要求 e.target === canvas，否则拖动/拾取都会被忽略）
     注意：#devWalls（空气墙/活动空间面板）必须在名单里 —— 它是后来才加的，
     漏掉它的后果是这里在**捕获阶段**就把 mousedown 拦下并 preventDefault，
     输入框永远拿不到焦点，整个面板看上去就是"完全不可编辑"。 */
  function inDevUI(el) {
    return !!(el && el.closest && el.closest('#devBar, #devDirPad, #devInfo, #devDump, #devProgress, #devWalls'));
  }

  /* 焦点在输入类控件里时，游戏/开发者模式的全局按键都必须让路，
     否则数字、退格、方向键会被当成游戏操作吃掉或 preventDefault 掉。 */
  function isTypingTarget(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
  }

  function onCanvasClick(e) {
    if (!D.active) return;
    if (inDevUI(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'mousedown') {
      // 只认鼠标左键：右键会弹出上下文菜单并吞掉 mouseup，导致拖拽状态卡死（人物乱转）
      if (e.button !== 0) { drag.active = false; return; }
      drag.active = true; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0;
    }
  }

  function onContextMenu(e) {
    if (!D.active) return;
    if (inDevUI(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drag.active = false;
    if (placing) {
      endPlace();                 // 再点一次右键 → 退出锁定，鼠标上的待放物消失
    } else {
      beginPlace(currentTag());   // 右键 → 进入锁定，开始连续放置
      toast('放置锁定：左键放下 · 连续放置 · 右键退出');
    }
  }

  function endDrag() { drag.active = false; }

  function onDocMove(e) {
    lastMouse.x = e.clientX; lastMouse.y = e.clientY;
    if (D.active && placing) {
      // 拖动放置：跟随鼠标在地面上的投影，高度保持 0（不改高度）
      var mp = mouseGroundPoint();
      if (mp) { placing.x = mp.x; placing.z = mp.z; placing.y = 0; applyTransform(placing); updateInfo(); }
      return;
    }
    if (!D.active || !drag.active) return;
    if (e.buttons !== undefined && (e.buttons & 1) === 0) { drag.active = false; return; }   // 左键已松开
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (ctx.player) {                       // 直接改玩家视角：非飞行与飞行都生效
      ctx.player.yaw -= dx * 0.0035;
      ctx.player.pitch = Math.max(-1.45, Math.min(1.45, ctx.player.pitch - dy * 0.0035));
    }
  }

  function onDocUp(e) {
    if (D.active && placing && e.button === 0) {
      // 放下当前这个，并立刻生成同一个新的待放物（可继续连续放）
      var tag = placing.type;
      placing = null;
      beginPlace(tag);
      return;
    }
    if (!D.active || !drag.active) return;
    drag.active = false;
    if (drag.moved < 6) selectAt(e.clientX, e.clientY);   // 几乎没动 = 单击（拾取选中）
  }

  /* 当前要放置的类型：优先"场景里选中的那个实例"，否则用下拉框选的模型 */
  function currentTag() {
    if (selected && selected.type) return selected.type;
    return ui && ui.currentTag ? ui.currentTag : null;
  }

  /* 进入连续放置：在鼠标位置生成一个待放物体（跟随鼠标） */
  function beginPlace(tag) {
    if (!tag) { toast('先选一个模型'); return false; }
    var it = addModel(tag);
    if (!it) return false;
    return true;
  }

  /* 退出连续放置：删掉鼠标上还没放下的那个 */
  function endPlace(silent) {
    if (!placing) return;
    var pending = placing;
    placing = null;
    removeItem(pending);
    if (!silent) toast('已退出放置');
  }

  /* 把鼠标屏幕坐标投射到地面（y=0）—— 用于拖动放置（不改高度） */
  function mouseGroundPoint() {
    var canvas = ctx.renderer.domElement;
    var rect = canvas.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((lastMouse.x - rect.left) / rect.width) * 2 - 1,
      -((lastMouse.y - rect.top) / rect.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, ctx.camera);
    var out = new THREE.Vector3();
    if (!rc.ray.intersectPlane(groundPlane, out)) return null;
    return out;
  }

  /* 射线拾取：选中鼠标位置下的建筑 */
  function selectAt(cx, cy) {
    if (!items.length) return;
    var canvas = ctx.renderer.domElement;
    var rect = canvas.getBoundingClientRect();
    var ndc = new THREE.Vector2(
      ((cx - rect.left) / rect.width) * 2 - 1,
      -((cy - rect.top) / rect.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, ctx.camera);
    var roots = items.map(function (it) { return it.holder; });
    var hits = rc.intersectObjects(roots, true);
    if (!hits.length) { select(null); updateInfo(); return; }
    var o = hits[0].object, target = null;
    while (o) {
      for (var i = 0; i < items.length; i++) if (items[i].holder === o) { target = items[i]; break; }
      if (target) break;
      o = o.parent;
    }
    if (target) { select(target); toast('已选中 ' + label(target.type)); }
  }

  /* 进入开发者模式时触发模型预加载，并显示真实进度 */
  var _preloadTick = 0;        // 进度轮询令牌：只允许一个循环存活，避免多次进入时叠加闪烁
  function startPreload() {
    if (!FPS.World || !FPS.World.loadModels) return;
    var st = FPS.World.loadModels();
    if (st && st.done >= st.total) return;          // 已经加载完，不显示进度条
    if (ui && ui.progWrap) ui.progWrap.style.display = 'block';
    var myTick = ++_preloadTick;
    function tick() {
      if (!D.active || myTick !== _preloadTick) return;
      var st2 = FPS.World.MODEL_STATE || { done: 0, total: 1, fileLoaded: 0, fileTotal: 0 };
      /* 串行加载：优先用"当前这个文件"的字节；file:// 下拿不到大小就用完成个数兜底
         （别再拿累计 bytes/bytesTotal —— 串行时它会一开始就冲到 100%） */
      var byBytes = st2.fileTotal > 0;
      var ratio = byBytes ? Math.min(1, st2.fileLoaded / st2.fileTotal)
                          : (st2.total ? Math.min(1, st2.done / st2.total) : 0);
      if (ui && ui.progBar) ui.progBar.style.width = (ratio * 100).toFixed(1) + '%';
      if (ui && ui.progText) {
        ui.progText.textContent = '模型预加载  ' + Math.round(ratio * 100) + '%   (' +
          st2.done + '/' + st2.total + ')' +
          (byBytes ? '   ' + (st2.fileLoaded / 1048576).toFixed(1) + ' / ' + (st2.fileTotal / 1048576).toFixed(1) + ' MB' : '');
      }
      if (st2.done >= st2.total) {
        if (ui && ui.progText) ui.progText.textContent = '模型预加载完成 ✓ 共 ' + st2.done + ' 个，可以开始添加建筑';
        setTimeout(function () { if (ui && ui.progWrap) ui.progWrap.style.display = 'none'; }, 1200);
        refreshModelList();
        return;
      }
      setTimeout(tick, 150);
    }
    tick();
  }

  function toggleActive() {
    if (DEV_HIDDEN) return;                    // 玩家版：开发者模式彻底不可用
    D.active = !D.active;
    if (ui) ui.bar.style.display = D.active ? 'flex' : 'none';
    if (ui && ui.dirPad) ui.dirPad.style.display = D.active ? 'grid' : 'none';
    if (ui) ui.info.style.display = (D.active && showStats) ? 'block' : 'none';
    if (!D.active && ui) { ui.dump.style.display = 'none'; }
    if (!D.active) { endPlace(true); select(null); }
    if (D.active) {
      refreshModelList();
      startPreload();                              // 进入开发者模式才预加载模型（显示进度）
      if (ctx.resume) ctx.resume();                // 若正处在暂停/菜单，自动恢复对局
      setPointerLock(false);                       // 开启即解锁鼠标（并延迟再确认一次）
      setTimeout(function () { setPointerLock(false); }, 60);
      setTimeout(function () { setPointerLock(false); }, 300);
      document.addEventListener('mousedown', onCanvasClick, true);
      document.addEventListener('mousemove', onDocMove, true);
      document.addEventListener('contextmenu', onContextMenu, true);
      window.addEventListener('blur', endDrag, true);
      document.addEventListener('mouseleave', endDrag, true);
      document.addEventListener('mouseup', onDocUp, true);
      document.addEventListener('click', onCanvasClick, true);
    } else {
      document.removeEventListener('mousedown', onCanvasClick, true);
      document.removeEventListener('click', onCanvasClick, true);
      // 开发者模式关闭：主动把鼠标锁定交回游戏
      // （F3 按键或按钮点击都算用户手势，可以成功请求锁定），
      // 若被浏览器拒绝，游戏自己的 tryRelock 也会在下次点击时补上
      setPointerLock(true);
      setTimeout(function () { if (!fly) setPointerLock(true); }, 120);
    }
    toast(D.active ? '开发者模式 开 —— 按 F3 或点右上角「退出」关闭' : '开发者模式 已退出');
  }

  /* ---------------- 对外接口 ---------------- */
  D.active = false;
  D.isFly = function () { return D.active && fly; };
  D.setActive = function (v) { if (v !== D.active) toggleActive(); };
  /* 调试用：把拾取的内部信息暴露出来，便于定位"点不中"的问题 */
  D.buildVoxels = function (src, size) { return buildVoxelTemplate(src); };
  D.debugBox = function () {
    if (!selected) return { none: true };
    var b = new THREE.Box3().setFromObject(selected.holder);
    return { type: selected.type,
             min: b.min.toArray().map(function (v) { return +v.toFixed(2); }),
             max: b.max.toArray().map(function (v) { return +v.toFixed(2); }),
             data: [+selected.x.toFixed(2), +selected.y.toFixed(2), +selected.z.toFixed(2)],
             rotY: +selected.rotY.toFixed(3),
             holderRotY: +selected.holder.rotation.y.toFixed(3) };
  };

  D.debugPick = function (cx, cy) {
    var canvas = ctx.renderer.domElement;
    var rect = canvas.getBoundingClientRect();
    var ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, ctx.camera);
    var roots = items.map(function (it) { return it.holder; });
    var hits = rc.intersectObjects(roots, true);
    var boxInfo = items.map(function (it) {
      var b = new THREE.Box3().setFromObject(it.holder);
      return { type: it.type, vis: it.holder.visible, min: b.min.toArray().map(function (v) { return +v.toFixed(2); }),
               max: b.max.toArray().map(function (v) { return +v.toFixed(2); }) };
    });
    return {
      rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      ndc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3)],
      ray: { o: rc.ray.origin.toArray().map(function (v) { return +v.toFixed(2); }),
             d: rc.ray.direction.toArray().map(function (v) { return +v.toFixed(3); }) },
      cam: { p: ctx.camera.position.toArray().map(function (v) { return +v.toFixed(2); }),
             yaw: ctx.player ? +ctx.player.yaw.toFixed(3) : null, pitch: ctx.player ? +ctx.player.pitch.toFixed(3) : null },
      items: items.length, hits: hits.length, boxes: boxInfo
    };
  };

  /* 开机载入内置默认地图（用户建造的布局） */
  var _defaultLoaded = false;
  D.applyDefaultLayout = function (force) {
    if (_defaultLoaded && !force) return false;
    var L = (window.FPS && FPS.DEFAULT_LAYOUT) || null;
    if (!L || !L.items || !L.items.length) return false;
    var ms = (FPS.World && FPS.World.MODELS) || {};
    var ready = L.items.every(function (d2) { return !!ms[d2.type]; });
    if (!ready) return false;                       // 模型还没加载完，稍后再试
    _defaultLoaded = true;
    // 内置默认地图是"竞技场"的地图。用 deserialize 时会被打上当前地图的标记，
    // 但默认地图载入只发生在竞技场开局，所以强制标成 arena 更保险。
    var savedMap = FPS.World.mapId;
    FPS.World.mapId = 'arena';
    deserialize(L);
    FPS.World.mapId = savedMap;
    toast('已载入默认地图（' + items.length + ' 个物体）');   // 玩家版里 toast 自己会静默（DEV_HIDDEN）
    return true;
  };

  D.rotBy = rotBy;
  D.addModel = addModel;
  D.serialize = serialize;
  D.deserialize = deserialize;
  /* 测试用：查看实例按地图的归属与显隐情况 */
  D.debugItems = function () {
    var byMap = {};
    var shown = 0, hidden = 0;
    items.forEach(function (it) {
      var m = it.mapOrigin || '(未标记)';
      byMap[m] = (byMap[m] || 0) + 1;
      if (it.holder && it.holder.visible) shown++; else hidden++;
    });
    return { total: items.length, byMap: byMap, shown: shown, hidden: hidden };
  };

  D.init = function (context) {
    /* ⚠ ctx 必须**无条件**赋值：它不光是开发者模式用，摆放内置地图（applyDefaultLayout
       → deserialize → addModel）也要读 ctx.camera / ctx.world。
       踩过：把 `if (DEV_HIDDEN) return;` 写在 `ctx = context;` 之前，
       玩家版直接变成"竞技场 0 个物体"（异常还被外层 try/catch 吞了，很难查）。
       下面这些才是"开发者模式专属"的东西：UI、F3/鼠标事件、预加载面板。 */
    ctx = context;
    /* 玩家版：不建任何界面、不注册 F3/鼠标事件（摆放地图的代码照常工作）。 */
    if (DEV_HIDDEN) return;
    installLockGuard();
    buildUI();
    refreshModelList();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    var params = new URLSearchParams(location.search);
    if (params.get('dev') === '1') toggleActive();
    // 模型是异步加载的，稍后再刷新一次下拉列表
    setTimeout(refreshModelList, 3000);
    setTimeout(refreshModelList, 8000);
    // 自测：?dev=1&demo=1 时自动沿路摆放每个模型各一件，用来验证添加/选中/缩放
    if (params.get('demo') === '1') {
      setTimeout(function () {
        var tags = Object.keys(FPS.World.MODELS || {});
        tags.forEach(function (t, i) {
          var it = addModel(t, new THREE.Vector3(-14 + (i % 4) * 9, 0, -20 + Math.floor(i / 4) * 12));
          if (it) { it.rotY = 0.4; applyTransform(it); }
        });
        refreshModelList();
        toast('已添加 ' + tags.length + ' 个模型（自测）');
      }, 9000);
    }
  };

  D.update = function (dt) {
    if (toastT > 0) { toastT -= dt; if (toastT <= 0 && toastEl) toastEl.style.display = 'none'; }
    if (!D.active) return;
    refreshModelListOnce();
    if (fly) updateFly(dt);
    moveSelected(dt);
    if (outline) outline.update();
    if (showStats && ui && ui.info) {
      var r = ctx.renderer.info.render;
      var W2 = FPS.World || {};
      var bs = W2.bvhStats || { built: 0, tris: 0, ms: 0 };
      ui.info.textContent = '帧率 ' + (1 / Math.max(0.0001, dt)).toFixed(0) +
        '   三角面 ' + r.triangles.toLocaleString() + '   绘制调用 ' + r.calls +
        '\n物体 ' + items.length + '   碰撞体 ' + ctx.world.colliders.length +
        '\nBVH ' + (W2.useBVH ? '开' : '关') + '   实例 ' + (W2.bvhInstances || []).length +
        '   已建树 ' + bs.built + ' 个 / ' + (bs.tris / 1000).toFixed(0) + 'k 三角面' +
        '   建树 ' + bs.ms.toFixed(0) + 'ms' +
        (selected ? '\n已选中 ' + label(selected.type) + '  X' + selected.x.toFixed(1) +
          ' Y' + selected.y.toFixed(1) + ' Z' + selected.z.toFixed(1) +
          '  缩放' + (selected.scaleMul * 100).toFixed(0) + '%' : '\n（未选中）');
    }
  };

  var listRefreshed = 0;
  function refreshModelListOnce() {
    listRefreshed++;
    if (listRefreshed % 180 === 1) refreshModelList();
  }
})();
