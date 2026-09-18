/* =====================================================================
   NEON STRIKE — 场景 / 关卡
   全部贴图均由 canvas 程序化生成，不加载任何外部资源。
   ===================================================================== */
window.FPS = window.FPS || {};

(function () {
  'use strict';

  var W = (FPS.World = {});

  /* =====================================================================
     空间网格：把已放置的模型实例按格子分桶
     ---------------------------------------------------------------------
     背景：每个会动的单位（玩家 + 每个敌人）每帧都要跑 world.resolve()，
       而它以前是**遍历全部 798 个实例**做包围盒粗筛。敌人一多就线性变慢。
     做法：按 16 米一格把实例的包围盒塞进桶里，查询时只看周围 3×3 格。
     安全：已用 A/B 验证过"空间网格 vs 遍历全部"结果完全一致（同一批 300 个点都是 240 个被推开），
       即网格不会漏项。
     ===================================================================== */
  var GRID_CELL = 16;
  var _grid = null, _gridDirty = true;
  var _gridCand = [];          // 复用的候选数组（避免每帧新建）

  W.markSpatialDirty = function () { _gridDirty = true; };

  function buildSpatialGrid(items) {
    var g = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.worldBox) continue;
      var x0 = Math.floor(it.worldBox.min.x / GRID_CELL);
      var x1 = Math.floor(it.worldBox.max.x / GRID_CELL);
      var z0 = Math.floor(it.worldBox.min.z / GRID_CELL);
      var z1 = Math.floor(it.worldBox.max.z / GRID_CELL);
      for (var cx = x0; cx <= x1; cx++) {
        for (var cz = z0; cz <= z1; cz++) {
          var key = cx * 100000 + cz;
          if (!g[key]) g[key] = [];
          g[key].push(it);
        }
      }
    }
    _grid = g;
    _gridDirty = false;
  }

  /** 取 (x,z) 附近半径 r 内的候选实例（返回复用数组，调用方别存引用） */
  function spatialQuery(items, x, z, r) {
    if (W.useGrid === false) return items;      // 调试开关：退回遍历全部
    if (_gridDirty || !_grid) buildSpatialGrid(items);
    _gridCand.length = 0;
    var reach = Math.max(1, Math.ceil(r / GRID_CELL));
    var cx0 = Math.floor(x / GRID_CELL), cz0 = Math.floor(z / GRID_CELL);
    for (var cx = cx0 - reach; cx <= cx0 + reach; cx++) {
      for (var cz = cz0 - reach; cz <= cz0 + reach; cz++) {
        var bucket = _grid[cx * 100000 + cz];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          var it = bucket[i];
          if (_gridCand.indexOf(it) < 0) _gridCand.push(it);
        }
      }
    }
    return _gridCand;
  }

  /* ---------------------------------------------------------------
     两张地图：
       arena   —— 新竞技场：更大（124x124）、多层地形、四角建筑、天桥、集装箱区
       station —— 训练场：原来的太空站（80x80），敌人不会攻击，用来练枪
     --------------------------------------------------------------- */
  var MAPS = {
    // 竞技场：half 必须与 W.airWalls 的活动空间一致（边界中心 Z=15、70×70），
    // 否则地板/巡逻环/出生点还是按旧尺寸铺，和实际能走的范围对不上。
    // 高度由 airWalls.height 决定，这里的 wallH 只作兜底。
    // 画面预设（look）也是每张地图一份默认值，玩家可在「游戏设置 → 画面设置」里逐图改；
    // 竞技场 default = toy（玩具微缩/动漫缩景，缩景感最强）
    // 训练场 default = night（夜景）—— 训练场空旷，带"平涂色阶"的预设会留下细网点（见 FINDINGS #19）
    arena:   { half: 70, wallH: 26, wallT: 2.0 , look: 'toy' },
    station: { half: 40, wallH: 15, wallT: 1.5 , look: 'night' }
  };
  W.mapId = 'arena';

  /* 当前地图的画面风格名（由 postfx 的 LOOKS 提供） */
  W.look = function () { return (MAPS[W.mapId] || {}).look || 'toy'; };
  W.passiveEnemies = false;        // true = 训练场：敌人只走动、不攻击

  /* ---------------------------------------------------------------
     地图容器（每张地图的"专属空间"）
     -----------------------------------------------------------------
     关键约定：**凡是属于某张地图的东西，都必须挂在这个容器下面**
     （地图几何、灯光、以及开发者模式摆放的模型实例）。
     换地图时直接把这个容器清空，就不会出现"训练场里混进竞技场的
     建筑和樱花树"这种地图融合问题。
     踩过的坑：模型实例以前是 `scene.add(holder)` 直接挂在场景根上，
     world.group 被移除时它们留着不动，于是两张地图叠在一起。
     --------------------------------------------------------------- */
  var mapRoot = null;
  W.mapRoot = function () { return mapRoot; };
  /** 取（必要时创建）地图容器；已挂到场景下 */
  W.ensureMapRoot = function (scene) {
    if (!mapRoot) {
      mapRoot = new THREE.Group();
      mapRoot.name = 'mapRoot';
    }
    if (scene && mapRoot.parent !== scene) scene.add(mapRoot);
    return mapRoot;
  };

  /* 被开发者模式摆放的模型实例（holder）。清空地图时要跳过它们本身，
     否则会把还要复用的实例几何一起 dispose 掉。 */
  var MODEL_HOLDERS = [];
  W.trackModelHolder = function (h) { if (h && MODEL_HOLDERS.indexOf(h) < 0) MODEL_HOLDERS.push(h); };
  W.untrackModelHolder = function (h) {
    var i = MODEL_HOLDERS.indexOf(h);
    if (i >= 0) MODEL_HOLDERS.splice(i, 1);
  };

  /** 清空当前地图的全部内容（几何 + 材质 + 灯光 + 实例），为重建做准备 */
  W.clearMap = function () {
    _grid = null;
    _gridDirty = true;
    if (!mapRoot) return;
    var keep = {};
    for (var k = 0; k < MODEL_HOLDERS.length; k++) keep[MODEL_HOLDERS[k].id] = true;
    // 先摘下来（脱离场景与容器），再逐层释放资源
    var kids = mapRoot.children.slice();
    for (var i = 0; i < kids.length; i++) mapRoot.remove(kids[i]);
    kids.forEach(function (root) {
      root.traverse(function (o) {
        if (keep[o.id]) return;                    // 复用的模型实例不动
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : null;
        if (mats) {
          mats.forEach(function (m) {
            if (!m) return;
            Object.keys(m).forEach(function (key) {
              var v = m[key];
              if (v && v.isTexture && v.dispose) v.dispose();
            });
            if (m.dispose) m.dispose();
          });
        }
      });
    });
    mapRoot.clear();
  };

  // 影棚模式：微缩景观风格（干净浅白背景、无远山与湖），对齐参考图
  // 支持 ?nomodels=1 跳过模型加载（自动化测试用，避免 43MB 模型拖慢测试）
  W.loadMountModels = (typeof location === 'undefined') ? true : !/[?&]nomodels=1/.test(location.search);
  W.studioBackdrop = false;       // 影棚模式（浅白背景）默认关闭 —— 保留 AI 天空 / 远山 / 湖泊；改 true 可切换成白棚微缩
  W.setMap = function (id) {
    W.mapId = MAPS[id] ? id : 'arena';
    var m = MAPS[W.mapId];
    W.HALF = m.half;
    W.WALL_H = m.wallH;
    W.WALL_T = m.wallT;
    // 竞技场的实际边界以空气墙为准（开发者模式可实时改）；
    // 训练场没有空气墙，用它自己的尺寸，不能被同步覆盖掉。
    if (W.mapId !== 'station' && W.syncAirWallGlobals) W.syncAirWallGlobals();
    return W.mapId;
  };

  W.HALF = 70;        // 竞技场半边长兜底值（真正生效的是 W.airWalls，见下）
  W.WALL_H = 26;      // 外墙高度兜底值
  W.WALL_T = 2.0;     // 外墙厚度兜底值

  /* =====================================================================
     空气墙参数（开发者模式里可实时调：中心 / 半宽半深 / 高度 / 厚度）
     ---------------------------------------------------------------------
     这四道不可见的空气墙就是玩家的活动空间边界。默认按圆心在原点、半宽 115 米，
     正好把地图上那圈樱花树（密环半径约 95~115 米）圈在界内。
     开发者模式面板里改完会立即重建（不需要刷新 / 重建 exe）。
     ===================================================================== */
  W.airWalls = {
    cx: 0, cz: 15,          // 边界中心（世界坐标，XZ）
    half: 80,             // 半宽半深（米）：边界 = 中心 ± half（thin 时以 halfX/halfZ 为准）
    halfX: 70,            // thin 时的半宽（±X）
    halfZ: 70,            // thin 时的半深（±Z）
    height: 60,            // 空气墙高度（米）
    thickness: 2,        // 厚度（米）
    thin: true            // true = 半宽与半深分开设置
  };
  /** 把 airWalls 的当前值同步到 W.HALF / W.WALL_H / W.WALL_T（其它模块读的是这三个） */
  W.syncAirWallGlobals = function () {
    var a = W.airWalls;
    W.HALF = Math.max(a.thin ? a.halfX : a.half, a.thin ? a.halfZ : a.half);
    W.WALL_H = a.height;
    W.WALL_T = a.thickness;
  };

  /* ---------------------------------------------------------------
     程序化贴图
     --------------------------------------------------------------- */
  function cv(size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  function speckle(ctx, size, count, alpha) {
    for (var i = 0; i < count; i++) {
      var x = Math.random() * size, y = Math.random() * size;
      var s = Math.random() * 2 + 0.4;
      var v = Math.random() < 0.5 ? 0 : 255;
      ctx.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + (Math.random() * alpha) + ')';
      ctx.fillRect(x, y, s, s);
    }
  }

  function finish(canvas, repX, repY, aniso) {
    var tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repX || 1, repY || 1);
    tex.encoding = THREE.sRGBEncoding;
    if (aniso) tex.anisotropy = aniso;
    tex.needsUpdate = true;
    return tex;
  }

  /* 太空站配色：整体亮白 + 冷灰蓝缝线 + 橙色警示，敌人（深色机体）在白色场景里非常显眼 */
  function floorTexture(aniso) {
    var S = 512, c = cv(S), ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#e7edf3');
    g.addColorStop(0.5, '#dde4ec');
    g.addColorStop(1, '#d5dde6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    speckle(ctx, S, 2600, 0.06);
    // 地板拼缝（加深一点，增强阴影质感）
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(122,140,160,0.7)';
    for (var i = 0; i <= S; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke();
    }
    // 大块分割线更粗
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(96,116,138,0.7)';
    ctx.strokeRect(3, 3, S - 6, S - 6);
    // 蓝色导向条
    ctx.fillStyle = 'rgba(56,180,232,0.30)';
    ctx.fillRect(S * 0.5 - 5, 0, 10, S);
    ctx.fillRect(0, S * 0.5 - 5, S, 10);
    // 中央警示框
    ctx.strokeStyle = 'rgba(255,157,60,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(S * 0.25, S * 0.25, S * 0.5, S * 0.5);
    return finish(c, 20, 20, aniso);
  }

  function wallTexture(aniso) {
    var S = 512, c = cv(S), ctx = c.getContext('2d');
    ctx.fillStyle = '#e8eef4';
    ctx.fillRect(0, 0, S, S);
    var rows = 4, cols = 4, pw = S / cols, ph = S / rows;
    for (var r = 0; r < rows; r++) {
      for (var col = 0; col < cols; col++) {
        var x = col * pw, y = r * ph;
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillRect(x + 5, y + 5, pw - 10, ph - 10);
        ctx.strokeStyle = 'rgba(140,158,176,0.75)';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 5, y + 5, pw - 10, ph - 10);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 8, y + 8, pw - 16, ph - 16);
        // 铆钉
        ctx.fillStyle = 'rgba(140,158,176,0.6)';
        [[x + 14, y + 14], [x + pw - 18, y + 14], [x + 14, y + ph - 18], [x + pw - 18, y + ph - 18]]
          .forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 6.284); ctx.fill(); });
      }
    }
    // 中部功能带
    ctx.fillStyle = 'rgba(176,190,204,0.55)';
    ctx.fillRect(0, S * 0.47, S, S * 0.06);
    ctx.fillStyle = 'rgba(255,157,60,0.35)';
    ctx.fillRect(0, S * 0.465, S, 5);
    speckle(ctx, S, 1200, 0.04);
    return finish(c, 8, 1.6, aniso);
  }

  function crateTexture(aniso) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    ctx.fillStyle = '#dde5ec';
    ctx.fillRect(0, 0, S, S);
    speckle(ctx, S, 900, 0.05);
    ctx.strokeStyle = 'rgba(150,166,182,0.9)';
    ctx.lineWidth = 12;
    ctx.strokeRect(12, 12, S - 24, S - 24);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 3;
    ctx.strokeRect(24, 24, S - 48, S - 48);
    // 斜向加强筋
    ctx.strokeStyle = 'rgba(160,176,192,0.5)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(28, 28); ctx.lineTo(S - 28, S - 28);
    ctx.moveTo(S - 28, 28); ctx.lineTo(28, S - 28);
    ctx.stroke();
    // 橙色警示条
    ctx.fillStyle = 'rgba(255,157,60,0.8)';
    ctx.fillRect(0, S * 0.46, S, 10);
    ctx.fillStyle = 'rgba(60,72,86,0.75)';
    ctx.font = 'bold 34px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('C-' + (1 + Math.floor(Math.random() * 9)), S / 2, S * 0.26);
    return finish(c, 1, 1, aniso);
  }

  function concreteTexture(aniso) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    ctx.fillStyle = '#e4eaf0';
    ctx.fillRect(0, 0, S, S);
    speckle(ctx, S, 2000, 0.05);
    ctx.strokeStyle = 'rgba(150,166,182,0.5)';
    ctx.lineWidth = 2;
    for (var i = 0; i < 5; i++) {
      var y = Math.random() * S;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(S * 0.3, y + 18, S * 0.6, y - 18, S, y + 6);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,157,60,0.55)';
    ctx.fillRect(0, S * 0.46, S, 10);
    return finish(c, 1, 1, aniso);
  }

  function skyTexture() {
    var W = 1024, H = 512;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var ctx = c.getContext('2d');
    // 上一版的深色星空（舱室上方敞开，能看到星空）
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, '#01020a');
    g.addColorStop(0.22, '#050c1c');
    g.addColorStop(0.38, '#0c1c33');
    g.addColorStop(0.47, '#173250');
    g.addColorStop(0.50, '#20415f');
    g.addColorStop(0.54, '#0d1b2b');
    g.addColorStop(0.70, '#060b14');
    g.addColorStop(1.00, '#02040a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var glow = ctx.createRadialGradient(W * 0.5, H * 0.5, 10, W * 0.5, H * 0.5, W * 0.44);
    glow.addColorStop(0, 'rgba(70,150,210,0.30)');
    glow.addColorStop(0.5, 'rgba(40,90,150,0.12)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    for (var i = 0; i < 520; i++) {
      var x = Math.random() * W;
      var y = Math.pow(Math.random(), 0.85) * H * 0.47;
      var a = Math.random() * 0.75 + 0.15;
      var s = Math.random() < 0.12 ? 2 : 1;
      ctx.fillStyle = 'rgba(' + (200 + Math.random() * 55 | 0) + ',' + (225 + Math.random() * 30 | 0) + ',255,' + a.toFixed(2) + ')';
      ctx.fillRect(x, y, s, s);
    }
    for (var j = 0; j < 26; j++) {
      var hx = Math.random() * W, hy = Math.random() * H * 0.42;
      var rg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 6);
      rg.addColorStop(0, 'rgba(255,255,255,0.9)');
      rg.addColorStop(1, 'rgba(160,210,255,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(hx - 6, hy - 6, 12, 12);
    }

    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  /* ---------------------------------------------------------------
     训练场布局（原来的太空站）
     type: crate(1.1) / block(2.4) / pillar(6) / barrier(1.7)
     --------------------------------------------------------------- */
  var LAYOUT_STATION = [
    // 中央平台结构
    { t: 'block', x: 0, z: 0, w: 7, d: 7, h: 1.1 },
    { t: 'pillar', x: -5.2, z: -5.2, w: 1.6, d: 1.6, h: 6 },
    { t: 'pillar', x: 5.2, z: -5.2, w: 1.6, d: 1.6, h: 6 },
    { t: 'pillar', x: -5.2, z: 5.2, w: 1.6, d: 1.6, h: 6 },
    { t: 'pillar', x: 5.2, z: 5.2, w: 1.6, d: 1.6, h: 6 },

    // 西北仓库区
    { t: 'crate', x: -18, z: -16, w: 1.7, d: 1.7, h: 1.1 },
    { t: 'crate', x: -16.2, z: -16.4, w: 1.7, d: 1.7, h: 1.1, y: 1.1 },
    { t: 'crate', x: -18.2, z: -14.2, w: 1.7, d: 1.7, h: 1.1 },
    { t: 'crate', x: -25, z: -22, w: 1.8, d: 1.8, h: 1.1 },
    { t: 'crate', x: -25.2, z: -20, w: 1.8, d: 1.8, h: 1.1 },
    { t: 'barrier', x: -22, z: -27, w: 9, d: 1.2, h: 1.7 },

    // 东北掩体
    { t: 'barrier', x: 20, z: -20, w: 1.2, d: 10, h: 1.7 },
    { t: 'crate', x: 26, z: -15, w: 1.8, d: 1.8, h: 1.1 },
    { t: 'crate', x: 27.9, z: -15.3, w: 1.8, d: 1.8, h: 1.1 },
    { t: 'block', x: 30, z: -28, w: 5, d: 5, h: 2.4 },
    { t: 'crate', x: 30, z: -28, w: 1.6, d: 1.6, h: 1.1, y: 2.4 },

    // 西南高台与散件
    { t: 'block', x: -28, z: 24, w: 6, d: 6, h: 1.1 },
    { t: 'crate', x: -28, z: 24, w: 1.6, d: 1.6, h: 1.1, y: 1.1 },
    { t: 'barrier', x: -30, z: 14, w: 1.2, d: 9, h: 1.7 },
    { t: 'crate', x: -14, z: 28, w: 1.7, d: 1.7, h: 1.1 },
    { t: 'crate', x: -12.2, z: 28.3, w: 1.7, d: 1.7, h: 1.1 },

    // 东南
    { t: 'barrier', x: 16, z: 22, w: 10, d: 1.2, h: 1.7 },
    { t: 'pillar', x: 27, z: 27, w: 1.8, d: 1.8, h: 6 },
    { t: 'crate', x: 24, z: 15, w: 1.7, d: 1.7, h: 1.1 },
    { t: 'block', x: 33, z: 8, w: 4, d: 6, h: 2.4 },

    // 南北通道
    { t: 'block', x: 0, z: -30, w: 10, d: 3, h: 2.4 },
    { t: 'block', x: 0, z: 30, w: 10, d: 3, h: 2.4 },
    { t: 'crate', x: 12, z: 4, w: 1.7, d: 1.7, h: 1.1 },
    { t: 'crate', x: -12, z: -3, w: 1.7, d: 1.7, h: 1.1 },
    { t: 'crate', x: -13.8, z: -3.4, w: 1.7, d: 1.7, h: 1.1, y: 1.1 },
    { t: 'crate', x: 3, z: 17, w: 1.7, d: 1.7, h: 1.1 },
    { t: 'crate', x: -6, z: -19, w: 1.7, d: 1.7, h: 1.1 }
  ];

  /* ---------------------------------------------------------------
     彩色户外贴图（竞技场用）：草地 / 泥土 / 砖墙 / 抹灰墙 / 集装箱 / 岩石 / 树叶 / 蓝天
     全部程序化生成，但带真实配色，不再是白格子
     --------------------------------------------------------------- */
  function noiseFill(ctx, size, base, spots, alpha) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    for (var i = 0; i < spots; i++) {
      var x = Math.random() * size, y = Math.random() * size;
      var r = Math.random() * 3 + 0.6;
      ctx.fillStyle = 'rgba(0,0,0,' + (Math.random() * alpha) + ')';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,' + (Math.random() * alpha * 0.7) + ')';
      ctx.beginPath(); ctx.arc(size - x, size - y, r * 0.8, 0, Math.PI * 2); ctx.fill();
    }
  }

  function grassTexture(aniso) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, '#3f7a3a', 1400, 0.32);
    for (var i = 0; i < 900; i++) {
      var x = Math.random() * S, y = Math.random() * S;
      ctx.strokeStyle = 'rgba(' + (60 + Math.random() * 60 | 0) + ',' + (110 + Math.random() * 90 | 0) + ',60,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (Math.random() * 3 - 1.5), y - 2 - Math.random() * 3); ctx.stroke();
    }
    return finish(c, 26, 26, aniso);
  }

  function dirtTexture(aniso) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, '#8a6a45', 1600, 0.4);
    speckle(ctx, S, 900, 0.3);
    return finish(c, 12, 12, aniso);
  }

  function brickTexture(aniso, col, mortar) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    ctx.fillStyle = mortar || '#d9cfc2';
    ctx.fillRect(0, 0, S, S);
    var bh = 16, bw = 42;
    for (var row = 0; row * bh < S; row++) {
      for (var bx = -bw; bx < S + bw; bx += bw) {
        var x = bx + (row % 2 ? bw / 2 : 0);
        ctx.fillStyle = col;
        ctx.fillRect(x + 2, row * bh + 2, bw - 4, bh - 4);
        ctx.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.12) + ')';
        ctx.fillRect(x + 2, row * bh + 2, bw - 4, bh - 4);
      }
    }
    speckle(ctx, S, 500, 0.18);
    return finish(c, 3, 2, aniso);
  }

  function plasterTexture(aniso, col) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, col, 700, 0.16);
    for (var i = 0; i < 26; i++) {
      ctx.fillStyle = 'rgba(60,50,40,' + (Math.random() * 0.10) + ')';
      ctx.fillRect(Math.random() * S, 0, 2 + Math.random() * 6, S);
    }
    return finish(c, 3, 2, aniso);
  }

  function containerTexture(aniso, col) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, col, 500, 0.14);
    for (var x = 0; x < S; x += 16) {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x, 0, 5, S);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x + 8, 0, 3, S);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, S - 6, S - 6);
    return finish(c, 1, 1, aniso);
  }

  function rockTexture(aniso) {
    var S = 128, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, '#8d8f92', 1200, 0.34);
    speckle(ctx, S, 400, 0.25);
    return finish(c, 2, 2, aniso);
  }

  function leafTexture(aniso, col) {
    var S = 128, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, col, 900, 0.36);
    return finish(c, 3, 3, aniso);
  }

  /** 蓝天 + 云（竞技场天空） */
  function skyDayTexture() {
    var W2 = 1024, H2 = 512, c = document.createElement('canvas');
    c.width = W2; c.height = H2;
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 0, H2);
    g.addColorStop(0, '#1d4f9a');
    g.addColorStop(0.55, '#63a4e0');
    g.addColorStop(0.82, '#bcd9f2');
    g.addColorStop(1, '#e8f1f8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W2, H2);
    for (var i = 0; i < 90; i++) {
      var x = Math.random() * W2, y = Math.random() * H2 * 0.62;
      var r = 20 + Math.random() * 60;
      var cg = ctx.createRadialGradient(x, y, 0, x, y, r);
      cg.addColorStop(0, 'rgba(255,255,255,' + (0.25 + Math.random() * 0.45) + ')');
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    var tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  /* ---------------------------------------------------------------
     日式动漫风贴图（新竞技场用）
     和风抹灰墙（木梁 + 障子窗）/ 瓦屋顶 / 樱花 / 石板路 / 摊位遮阳布 / 木头
     --------------------------------------------------------------- */
  function jpWallTexture(aniso) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, '#efe6d2', 600, 0.12);
    ctx.fillStyle = '#5a4030';                                    // 木梁：外框 + 横梁 + 立柱
    ctx.fillRect(0, 0, S, 14); ctx.fillRect(0, S - 16, S, 16);
    ctx.fillRect(0, 118, S, 12);
    ctx.fillRect(0, 0, 16, S); ctx.fillRect(S - 16, 0, 16, S);
    ctx.fillRect(120, 0, 12, S);
    for (var wy = 0; wy < 2; wy++) {                              // 障子窗：木格 + 透光纸
      for (var wx = 0; wx < 2; wx++) {
        var x0 = 26 + wx * 118, y0 = 26 + wy * 62, ww = 84, wh = 34;
        ctx.fillStyle = '#fbf3dc';
        ctx.fillRect(x0, y0, ww, wh);
        ctx.strokeStyle = '#6b4f38';
        ctx.lineWidth = 3;
        for (var gx = 1; gx < 4; gx++) {
          ctx.beginPath(); ctx.moveTo(x0 + ww * gx / 4, y0); ctx.lineTo(x0 + ww * gx / 4, y0 + wh); ctx.stroke();
        }
        ctx.beginPath(); ctx.moveTo(x0, y0 + wh / 2); ctx.lineTo(x0 + ww, y0 + wh / 2); ctx.stroke();
      }
    }
    speckle(ctx, S, 300, 0.10);
    return finish(c, 3, 2, aniso);
  }

  function jpRoofTexture(aniso) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, '#3d4a5c', 400, 0.16);
    for (var y = 8; y < S; y += 22) {
      ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(0, y, S, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(0, y + 5, S, 3);
      for (var x = 0; x < S; x += 20) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(x, y + 8, 8, 12);
      }
    }
    ctx.fillStyle = '#8fa4bd'; ctx.fillRect(0, 0, S, 7);
    return finish(c, 2, 2, aniso);
  }

  function sakuraTexture(aniso) {
    var S = 128, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, '#f3b9cd', 900, 0.26);
    for (var i = 0; i < 160; i++) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.25 + Math.random() * 0.5) + ')';
      ctx.beginPath();
      ctx.arc(Math.random() * S, Math.random() * S, 1.2 + Math.random() * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    return finish(c, 3, 3, aniso);
  }

  function stonePathTexture(aniso) {
    var S = 256, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, '#b9b2a4', 900, 0.22);
    ctx.strokeStyle = 'rgba(90,84,74,0.55)';
    ctx.lineWidth = 3;
    for (var y = 0; y < S; y += 42) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke();
      var offs = (y / 42) % 2 ? 32 : 0;
      for (var x = offs; x < S; x += 64) {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 42); ctx.stroke();
      }
    }
    return finish(c, 8, 8, aniso);
  }

  function awningTexture(aniso) {
    var S = 128, c = cv(S), ctx = c.getContext('2d');
    for (var i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#f4f1e6' : '#c8402f';
      ctx.fillRect(i * (S / 8), 0, S / 8, S);
    }
    return finish(c, 2, 1, aniso);
  }

  function woodTexture(aniso, col) {
    var S = 128, c = cv(S), ctx = c.getContext('2d');
    noiseFill(ctx, S, col || '#8a5a34', 500, 0.2);
    for (var y = 0; y < S; y += 10) {
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.fillRect(0, y, S, 2);
    }
    return finish(c, 2, 2, aniso);
  }

  /* ---------------------------------------------------------------
     竞技场布局：日本平房式村落（192 x 192 米）
       · 路网：南北主路 + 两条横街 + 湖畔路 + 神社参道 + 若干巷道
       · 平房（单层民居）沿街成排布置，宅地有板塀围合、留出入口，朝向错落
       · 稻田成片分布在四角外围，田埂用土色矮墙
       · 东侧神社：参道 + 鸟居 + 社殿 + 石灯笼
       · 主路北端接湖畔路与石砌护岸
       · 空气墙（±96）以外：远景房舍剪影 + 大城市模块/大寺庙/公寓的挂载位
       · mount 是占位方块：下载好的模型放到同名挂载点上即可（见 模型/投放说明.txt）
     --------------------------------------------------------------- */
  /* 方案 B 开关：?nobvh=1 时退回旧的 AABB 盒子碰撞（排查用） */
  try {
    var _q = new URLSearchParams(location.search);
    if (_q.get('nobvh') === '1') W.useBVH = false;         // 完全退回旧的盒子碰撞
    if (_q.get('boxes') === '1') window.FPS_BVH_ONLY = false;   // 保留盒子（调试用）
  } catch (e) { }

  /* 方案 B：已放置建筑的三角形碰撞列表（闭包变量，避免 this 身份不一致导致的注册丢失） */
  var BVH_ITEMS = [];

  function buildArenaLayout() {
    /* 空白画布：地图内不放任何建筑与树木，全部交给游戏内开发者模式添加。
       只保留路网（作为街道骨架）与空气墙外的远景村舍（当背景景深）。 */
    var L = [];
    var i;
    function add(t, x, z, w, d, h, y) {
      L.push({ t: t, x: x, z: z, w: w, d: d, h: h || 1.1, y: y || 0 });
    }
    function road(w2, d2, x, z) { add('road', x, z, w2, d2, 0.05); }

    // 路网（保留：主路 + 两条横街 + 湖畔路 + 神社参道 + 五条巷道）
    road(9, 150, 0, 8);
    road(150, 7, 0, -34);
    road(150, 7, 0, 34);
    road(170, 8, 0, -80);
    road(58, 5, 32, 12);
    road(5, 56, -18, 0);
    road(5, 40, 18, -6);
    road(5, 52, -50, 6);
    road(5, 44, 50, -14);
    road(60, 5, 0, 62);

    // 空气墙外的远景村舍（纯背景，玩家到不了）
    for (i = 0; i < 78; i++) {
      var a3 = (i / 78) * Math.PI * 2 + 0.1;
      var rr = 108 + (i % 4) * 9;
      add('bgHouse', Math.cos(a3) * rr, Math.sin(a3) * rr, 9 + (i % 3) * 3, 8 + (i % 2) * 3, 4.5);
    }
    for (i = 0; i < 34; i++) {
      var a4 = (i / 34) * Math.PI * 2 + 0.6;
      var rr4 = 150 + (i % 3) * 12;
      add('bgHouse', Math.cos(a4) * rr4, Math.sin(a4) * rr4, 12 + (i % 3) * 4, 10 + (i % 2) * 4, 6);
    }

    return L;
  }


  // 当前生效的布局（由 W.setMap 决定）
  var LAYOUT = LAYOUT_STATION;

  /* ---------------------------------------------------------------
     构建
     --------------------------------------------------------------- */
  W.build = function (scene, renderer) {
    // 按当前地图挑布局：竞技场用程序化生成的大地图，训练场用原来的太空站
    LAYOUT = W.mapId === 'station' ? LAYOUT_STATION : buildArenaLayout();
    var aniso = renderer && renderer.capabilities ? renderer.capabilities.getMaxAnisotropy() : 1;
    aniso = Math.min(aniso, 8);

    var root = W.ensureMapRoot(scene);      // 这张地图的专属容器
    var group = new THREE.Group();
    group.name = 'world';
    root.add(group);                        // 注意：不是 scene.add（换图要能一起清掉）

    var colliders = [];   // THREE.Box3 数组
    var mountPoints = [];  // 模型挂载点（下载好的 GLB 替换到这里）
    var shootables = [];  // 射线检测用的静态网格
    // 换地图时 colliders 是新建的，但 BVH_ITEMS 是跨地图共享的闭包变量：
    // 旧地图的实例必须在这里清掉，否则新地图会被旧地图的碰撞挡住。
    BVH_ITEMS.length = 0;

    var texFloor = floorTexture(aniso);
    var texWall = wallTexture(aniso);
    var texCrate = crateTexture(aniso);
    var texConcrete = concreteTexture(aniso);

    var matFloor = new THREE.MeshStandardMaterial({ map: texFloor, roughness: 0.55, metalness: 0.12 });
    var matWall = new THREE.MeshStandardMaterial({ map: texWall, roughness: 0.62, metalness: 0.14 });
    var matCrate = new THREE.MeshStandardMaterial({ map: texCrate, roughness: 0.48, metalness: 0.3 });
    var matBlock = new THREE.MeshStandardMaterial({ map: texConcrete, roughness: 0.75, metalness: 0.08 });
    var matPillar = new THREE.MeshStandardMaterial({ map: texWall, color: 0xf2f6fa, roughness: 0.5, metalness: 0.25 });
    var matGlowCyan = new THREE.MeshBasicMaterial({ color: 0x38e8ff, toneMapped: false });
    var matGlowAmber = new THREE.MeshBasicMaterial({ color: 0xffb347, toneMapped: false });

    var MATS = { crate: matCrate, block: matBlock, pillar: matPillar, barrier: matCrate };

    /* 竞技场：日式动漫风材质（石板路 / 和风墙 / 瓦屋顶 / 樱花 / 纸灯笼 / 木料） */
    var skyTex, matLeafA, matLeafB, matTrunk, matRock, matSakura, matRoof, matWood, matAwning, matLantern, CONTAINERS = null;
    if (W.mapId !== 'station') {
      skyTex = skyDayTexture();
      matFloor = new THREE.MeshStandardMaterial({ map: stonePathTexture(aniso), roughness: 0.9, metalness: 0.02 });
      matWall = new THREE.MeshStandardMaterial({ map: jpWallTexture(aniso), roughness: 0.82, metalness: 0.03 });
      matBlock = new THREE.MeshStandardMaterial({ map: woodTexture(aniso, '#9a6b42'), roughness: 0.9, metalness: 0.0 });
      matPillar = new THREE.MeshStandardMaterial({ map: woodTexture(aniso, '#7a4f2e'), roughness: 0.92, metalness: 0.0 });
      matCrate = new THREE.MeshStandardMaterial({ map: woodTexture(aniso, '#b07a45'), roughness: 0.85, metalness: 0.0 });
      matRock = new THREE.MeshStandardMaterial({ map: rockTexture(aniso), roughness: 0.95, metalness: 0.02 });
      matLeafA = new THREE.MeshStandardMaterial({ map: leafTexture(aniso, '#3f8b3a'), roughness: 0.9, metalness: 0.0 });
      matLeafB = new THREE.MeshStandardMaterial({ map: leafTexture(aniso, '#5aa84a'), roughness: 0.9, metalness: 0.0 });
      matSakura = new THREE.MeshStandardMaterial({ map: sakuraTexture(aniso), roughness: 0.85, metalness: 0.0 });
      matRoof = new THREE.MeshStandardMaterial({ map: jpRoofTexture(aniso), roughness: 0.7, metalness: 0.12 });
      matWood = new THREE.MeshStandardMaterial({ map: woodTexture(aniso, '#8a5a34'), roughness: 0.9, metalness: 0.0 });
      matAwning = new THREE.MeshStandardMaterial({ map: awningTexture(aniso), roughness: 0.8, metalness: 0.0, side: THREE.DoubleSide });
      matLantern = new THREE.MeshStandardMaterial({ color: 0xffe0a8, emissive: 0xffb861, emissiveIntensity: 0.7, roughness: 0.6 });
      CONTAINERS = null;
      MATS.wall = matWall;
      MATS.block = matWood;
      MATS.pillar = matWood;
      MATS.crate = matWood;
      MATS.barrier = matWood;
      MATS.fence = matWood;
      MATS.roof = matRoof;
      MATS.stall = matWood;
      MATS.torii = new THREE.MeshStandardMaterial({ map: woodTexture(aniso, '#b5442f'), roughness: 0.8, metalness: 0.0 });
    }

    /* ---------------------------------------------------------------
       竞技场美术：用参考照片生成的贴图（tools/gen-textures2.ps1 产出）
         sky.jpg   天空盒（天顶深蓝 + 大团积云）
         far.png   环形远山（顶部渐隐）
         grass.jpg / stone.jpg / water.jpg  地面与湖面（镜像重复即可无缝）
       --------------------------------------------------------------- */
    var TL = new THREE.TextureLoader();
    function loadPhotoTex(file, rx, ry) {
      var t = TL.load(file);
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.repeat.set(rx || 1, ry || 1);
      t.anisotropy = aniso;
      t.encoding = THREE.sRGBEncoding;
      return t;
    }
    // 法线/粗糙度这类数据贴图必须是线性空间，不能标 sRGB
    function loadDataTex(file, rx, ry) {
      var t = TL.load(file);
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.repeat.set(rx || 1, ry || 1);
      t.anisotropy = aniso;
      return t;
    }
    var skyTex2 = null, farTex = null, waterTex = null;
    var sakuraTex = null, poleTex = null;
    if (W.mapId !== 'station') {
      skyTex2 = loadPhotoTex('textures/sky.jpg');
      farTex = TL.load('textures/far.png');
      waterTex = loadPhotoTex('textures/water.jpg', 18, 18);
      // 草地：颜色 + 法线 + 粗糙度（法线让地面不再是一张平贴纸）
      matFloor = new THREE.MeshStandardMaterial({
        map: loadPhotoTex('textures/grass.jpg', 260, 260),
        normalMap: loadDataTex('textures/grass_n.jpg', 260, 260),
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: loadDataTex('textures/grass_r.jpg', 260, 260),
        roughness: 1.0, metalness: 0.0
      });
      // 樱花树 / 电线杆：白底抠图（含 alpha）做广告牌
      sakuraTex = loadPhotoTex('textures/sakura.png');
      poleTex = loadPhotoTex('textures/pole.png');
    }

    // 天空穹顶
    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 20),
      new THREE.MeshBasicMaterial({ map: skyTex2 || skyTex || skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false })
    );
    sky.name = 'sky';
    group.add(sky);

    /* 图像光照（IBL）：用天空盒生成环境贴图 —— 金属/粗糙度才有正确的环境反射 */
    if (skyTex2 && renderer && THREE.PMREMGenerator) {
      skyTex2.onLoad = function () {
        try {
          var pmrem = new THREE.PMREMGenerator(renderer);
          pmrem.compileEquirectangularShader();
          var envRT = pmrem.fromEquirectangular(skyTex2);
          scene.environment = envRT.texture;
          pmrem.dispose();
        } catch (e) { /* 环境贴图失败不影响游戏运行 */ }
      };
    }

    /* 影棚模式：像参考图那样在干净浅白背景里"拍模型"
       —— 关掉远山与湖、天空换成浅白、雾也换成浅白，画面立刻"变小" */
    // ★ 注意：这个标志必须在这里就定好并声明，后面远山/湖/空气墙都要用它。
    //   （原代码把它声明在"空气墙"那一段，而远山/湖在前面就读它 —— var 提升导致
    //    读到时是 undefined，"影棚模式下隐藏远山"的逻辑一直是反的。）
    var studioOverride = !!(W.studioBackdrop && W.mapId !== 'station');
    if (W.mapId !== 'station' && W.studioBackdrop) {
      sky.material.map = null;
      sky.material.color.set(0xeff2f6);
      sky.material.needsUpdate = true;
      scene.background = new THREE.Color(0xeff2f6);
      scene.fog = new THREE.Fog(0xeff2f6, 70, 330);
    }

    // 地板：竞技场用一张很大的地面，配合雾气做出"一望无际"的感觉
    var floorSize = W.mapId === 'station' ? W.HALF * 2 + 8 : 900;
    var floor = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize), matFloor);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    group.add(floor);
    shootables.push(floor);

    /* ---------------- 竞技场专属：环形远山 + 湖泊 + 石板路 + 电线杆 ---------------- */
    var lakeCenter = new THREE.Vector3(0, 0, -161);
    if (W.mapId !== 'station') {
      // 环形远山：一圈开口圆柱，内侧朝向玩家，顶部用贴图自带的 alpha 渐隐进天空
      var ridge = new THREE.Mesh(
        new THREE.CylinderGeometry(190, 190, 46, 72, 1, true),
        new THREE.MeshBasicMaterial({
          map: farTex, color: 0xbfd0dd, opacity: 0.9, side: THREE.BackSide, transparent: true,
          depthWrite: false, fog: true, toneMapped: false
        })
      );
      ridge.position.y = 15;           // 底边贴地，山脊落在视平线上方
      ridge.name = 'farRidge';
      ridge.visible = !studioOverride;
      group.add(ridge);

      // 湖泊：一大片水面（贴图里自带阳光光带），放在北侧，配一道石砌护岸
      var lake = new THREE.Mesh(
        new THREE.PlaneGeometry(460, 150),
        new THREE.MeshStandardMaterial({
          map: waterTex, roughness: 0.18, metalness: 0.25,
          transparent: true, opacity: 0.96
        })
      );
      lake.rotation.x = -Math.PI / 2;
      lake.position.set(lakeCenter.x, 0.60, lakeCenter.z);
      lake.name = 'lake';
      lake.visible = !studioOverride;
      group.add(lake);
      shootables.push(lake);

      // 石砌护岸（湖岸线）：挡在活动空间北界之外，玩家走不到水面上。
      // 位置跟着 W.airWalls 的北界走（默认北界 z=-115 → 护岸放 -116）。
      var quayMat = new THREE.MeshStandardMaterial({ map: loadPhotoTex('textures/stone.jpg', 42, 1), roughness: 0.9, metalness: 0.03 });
      var quayZ = (W.airWalls.cz - (W.airWalls.thin ? W.airWalls.halfZ : W.airWalls.half)) - 1;
      var quay = new THREE.Mesh(new THREE.BoxGeometry(560, 1.2, 2.4), quayMat);
      quay.position.set(W.airWalls.cx, 0.7, quayZ);
      quay.castShadow = true; quay.receiveShadow = true;
      group.add(quay);
      shootables.push(quay);
      colliders.push(new THREE.Box3().setFromObject(quay));


      // 电线杆已按要求移除（改由开发者模式手动摆放）
    }

    // 外墙 + 发光灯带（竞技场里改成**看不见的空气墙**，只拦人不挡视线）
    var invisibleWalls = W.mapId !== 'station';

    /* 空气墙（边界）：工具函数放在这里定义，实际由 world.rebuildAirWalls() 调用。
       这样开发者模式可以随时改 W.airWalls 再重建，不需要刷新页面。 */
    var airGroup = new THREE.Group();
    airGroup.name = 'airWalls';
    if (W.mapId !== 'station') group.add(airGroup);
    var airMeshes = [];

    function wallSpecsNow() {
      var a = W.airWalls;
      var hx = a.thin ? a.halfX : a.half;
      var hz = a.thin ? a.halfZ : a.half;
      return [
        { x: a.cx, z: a.cz - hz, w: (hx + a.thickness) * 2, d: a.thickness },   // 北
        { x: a.cx, z: a.cz + hz, w: (hx + a.thickness) * 2, d: a.thickness },   // 南
        { x: a.cx - hx, z: a.cz, w: a.thickness, d: (hz + a.thickness) * 2 },   // 西
        { x: a.cx + hx, z: a.cz, w: a.thickness, d: (hz + a.thickness) * 2 }    // 东
      ];
    }

    function buildAirWalls() {
      var a = W.airWalls;
      // 清掉旧的（几何 + 碰撞体）
      airMeshes.forEach(function (m) {
        if (m.parent) m.parent.remove(m);
        if (m.userData.strip && m.userData.strip.parent) m.userData.strip.parent.remove(m.userData.strip);
        if (m.geometry) m.geometry.dispose();
        var ci = colliders.indexOf(m.userData.box);
        if (ci >= 0) colliders.splice(ci, 1);
      });
      airMeshes = [];
      wallSpecsNow().forEach(function (s, idx) {
        var geo = new THREE.BoxGeometry(s.w, a.height, s.d);
        var m = new THREE.Mesh(geo, matWall);
        m.position.set(s.x, a.height / 2, s.z);
        m.name = 'wall' + idx;
        if (invisibleWalls) {
          // 不可见的空气墙：仍然放进 colliders（撞得到），但不画出来、也不吃射线
          m.visible = false;
        } else {
          m.castShadow = true;
          m.receiveShadow = true;
          airGroup.add(m);
          shootables.push(m);
        }
        m.updateMatrixWorld(true);
        var box = new THREE.Box3().setFromObject(m);
        m.userData.box = box;
        colliders.push(box);
        airMeshes.push(m);

        // 墙面发光条（上下各一条）—— 只有可见外墙才画
        if (!invisibleWalls) {
          var horizontal = s.w > s.d;
          [4.4, 11.2].forEach(function (hy, k) {
            var strip = new THREE.Mesh(
              new THREE.BoxGeometry(horizontal ? s.w * 0.94 : 0.14, 0.14, horizontal ? 0.14 : s.d * 0.94),
              (idx + k) % 2 === 0 ? matGlowCyan : matGlowAmber
            );
            if (horizontal) strip.position.set(s.x, hy, s.z + (s.z > a.cz ? -a.thickness / 2 - 0.12 : a.thickness / 2 + 0.12));
            else strip.position.set(s.x + (s.x > a.cx ? -a.thickness / 2 - 0.12 : a.thickness / 2 + 0.12), hy, s.z);
            airGroup.add(strip);
            m.userData.strip = strip;
          });
        }
      });
        W.syncAirWallGlobals();
      }

    // 障碍物
    LAYOUT.forEach(function (o, i) {
      var h = o.h || 1.1;
      var y = (o.y || 0) + h / 2;

      // 道路：石板贴图的水平面片
      if (o.t === 'road') {
        var rTex = loadPhotoTex('textures/stone.jpg', Math.max(1, o.w / 3.5), Math.max(1, o.d / 3.5));
        var rMesh = new THREE.Mesh(new THREE.PlaneGeometry(o.w, o.d),
          new THREE.MeshStandardMaterial({ map: rTex, roughness: 0.92, metalness: 0.02 }));
        rMesh.rotation.x = -Math.PI / 2;
        rMesh.position.set(o.x, 0.05 + (i % 12) * 0.004, o.z);
        rMesh.receiveShadow = true;
        group.add(rMesh);
        shootables.push(rMesh);
        return;
      }
      // 板塀：木色围栏
      if (o.t === 'plank') {
        var fm = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d),
          new THREE.MeshStandardMaterial({ map: woodTexture(aniso, '#8a5f3c'), roughness: 0.9, metalness: 0.0 }));
        fm.position.set(o.x, (o.y || 0) + o.h / 2, o.z);
        fm.castShadow = true; fm.receiveShadow = true;
        group.add(fm); shootables.push(fm);
        colliders.push(new THREE.Box3().setFromObject(fm));
        return;
      }
      // 远景村舍剪影（空气墙外，不进碰撞）—— 上粉彩，避免"一堆白模"
      if (o.t === 'bgHouse') {
        var BG_WALL = [0xf3d9c9, 0xe8dcc8, 0xd9e6dc, 0xe6d9e8, 0xf0e2c8, 0xdce4ef];
        var BG_ROOF = [0x8a6f5c, 0x6f7a86, 0x7d6a75, 0x6d7f6a, 0x8a7a5c, 0x6a7383];
        var bgWall = new THREE.MeshStandardMaterial({ color: BG_WALL[i % BG_WALL.length], roughness: 0.92, metalness: 0 });
        var bgRoof = new THREE.MeshStandardMaterial({ color: BG_ROOF[i % BG_ROOF.length], roughness: 0.85, metalness: 0 });
        var bh = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), bgWall);
        bh.position.set(o.x, o.h / 2, o.z);
        group.add(bh);
        var br = new THREE.Mesh(new THREE.BoxGeometry(o.w * 1.12, 0.6, o.d * 1.12), bgRoof);
        br.position.set(o.x, o.h + 0.3, o.z);
        group.add(br);
        return;
      }
      // 门帘
      if (o.t === 'awning') {
        var aw = new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.12, o.d),
          new THREE.MeshStandardMaterial({ map: awningTexture(aniso), roughness: 0.85, side: THREE.DoubleSide }));
        aw.position.set(o.x, (o.y || 0) + o.h, o.z);
        group.add(aw);
        return;
      }
      // 挂载点占位：半透明方块，之后用下载好的模型替换
      if (o.t === 'mount') {
        var mm2 = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d),
          new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.18, depthWrite: false }));
        mm2.position.set(o.x, (o.y || 0) + o.h / 2, o.z);
        mm2.name = 'mount_' + o.tag;
        group.add(mm2);
        mountPoints.push({ tag: o.tag, pos: new THREE.Vector3(o.x, o.y || 0, o.z), size: new THREE.Vector3(o.w, o.h, o.d) });
        return;
      }

      // 树木 / 樱花 / 岩石 / 灌木 / 灯笼 / 鸟居 / 摊位（日式小镇的装饰与地标）
      if (o.t === 'tree' || o.t === 'sakura' || o.t === 'rock' || o.t === 'bush' ||
          o.t === 'lantern' || o.t === 'torii' || o.t === 'stall') {
        var prop = new THREE.Group();
        prop.position.set(o.x, o.y || 0, o.z);
        var k2, leaf2;
        if ((o.t === 'tree' || o.t === 'sakura') && sakuraTex) {
          // 有抠图贴图时用广告牌（比程序化锥体自然得多）
          var spMat = new THREE.SpriteMaterial({ map: sakuraTex, transparent: true, alphaTest: 0.52, fog: true });
          var sp = new THREE.Sprite(spMat);
          var sc = o.t === 'sakura' ? 12 : 9;
          sp.scale.set(sc, sc, 1);
          sp.position.y = sc * 0.46;
          prop.add(sp);
        } else if (o.t === 'tree' || o.t === 'sakura') {
          var tr = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 3.4, 8), matTrunk || matWood);
          tr.position.y = 1.7; tr.castShadow = true; prop.add(tr);
          var crown = o.t === 'sakura' ? matSakura : matLeafA;
          for (k2 = 0; k2 < 3; k2++) {
            leaf2 = new THREE.Mesh(new THREE.ConeGeometry(2.6 - k2 * 0.6, 2.6, 9),
              k2 % 2 ? crown : (o.t === 'sakura' ? matSakura : matLeafB));
            leaf2.position.y = 3.4 + k2 * 1.2;
            leaf2.castShadow = true;
            prop.add(leaf2);
          }
          // 说明：樱花树是用户摆放的**模型实例**（devmode 注册），不在程序化 LAYOUT 里，
          // 所以这里不需要为它做批量绘制处理。
        } else if (o.t === 'rock') {
          var rk = new THREE.Mesh(new THREE.DodecahedronGeometry(o.w * 0.5, 0), matRock);
          rk.position.y = o.w * 0.32;
          rk.rotation.set(Math.random(), Math.random() * 3, Math.random() * 0.4);
          rk.scale.set(1, 0.72, 1);
          rk.castShadow = true; rk.receiveShadow = true;
          prop.add(rk);
        } else if (o.t === 'bush') {
          var bush = new THREE.Mesh(new THREE.SphereGeometry(o.w * 0.5, 8, 6), matLeafA);
          bush.position.y = o.w * 0.4;
          bush.scale.set(1, 0.7, 1);
          bush.castShadow = true;
          prop.add(bush);
        } else if (o.t === 'lantern') {
          // 石灯笼：底座 + 柱 + 灯箱（自发光）+ 顶盖
          var base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.9), matRock);
          base.position.y = 0.12; prop.add(base);
          var post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.5, 8), matRock);
          post.position.y = 0.95; prop.add(post);
          var box = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.6, 0.62), matLantern);
          box.position.y = 2.0; prop.add(box);
          var cap = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.36, 4), matRock);
          cap.position.y = 2.48; cap.rotation.y = Math.PI / 4; prop.add(cap);
          var lit = new THREE.PointLight(0xffb861, 0.5, 9, 2);
          lit.position.y = 2.0; prop.add(lit);
        } else if (o.t === 'torii') {
          // 鸟居：两根朱红立柱 + 上下两道横梁
          [-1, 1].forEach(function (s) {
            var pole = new THREE.Mesh(new THREE.BoxGeometry(0.5, o.h, 0.5), MATS.torii);
            pole.position.set(s * (o.w / 2 - 0.6), o.h / 2, 0);
            pole.castShadow = true; prop.add(pole);
          });
          var beam1 = new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.45, 0.55), MATS.torii);
          beam1.position.y = o.h - 0.5; beam1.castShadow = true; prop.add(beam1);
          var beam2 = new THREE.Mesh(new THREE.BoxGeometry(o.w - 1.6, 0.32, 0.42), MATS.torii);
          beam2.position.y = o.h - 1.5; prop.add(beam2);
        } else {
          // 摊位：桌台 + 四根柱子 + 红白遮阳布
          var table = new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.85, o.d * 0.6), matWood);
          table.position.y = 0.45; prop.add(table);
          [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (c2) {
            var post2 = new THREE.Mesh(new THREE.BoxGeometry(0.16, o.h, 0.16), matWood);
            post2.position.set(c2[0] * (o.w / 2 - 0.2), o.h / 2, c2[1] * (o.d / 2 - 0.2));
            prop.add(post2);
          });
          var aw = new THREE.Mesh(new THREE.BoxGeometry(o.w + 0.6, 0.12, o.d + 0.4), matAwning);
          aw.position.y = o.h + 0.1; aw.rotation.z = 0.06; prop.add(aw);
        }
        prop.name = o.t + '_' + i;
        group.add(prop);
        prop.traverse(function (mm) { if (mm.isMesh) { mm.castShadow = true; shootables.push(mm); } });
        if (o.t !== 'bush' && o.t !== 'lantern') {
          var pb = new THREE.Box3().setFromObject(prop);
          pb.expandByScalar(-0.12);
          colliders.push(pb);
        }
        return;
      }

      var geo = new THREE.BoxGeometry(o.w, h, o.d);
      var mat = MATS[o.t] || matBlock;
      if (CONTAINERS && (o.t === 'crate')) mat = CONTAINERS[i % CONTAINERS.length];
      var mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(o.x, y, o.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = o.t + '_' + i;
      group.add(mesh);
      shootables.push(mesh);
      colliders.push(new THREE.Box3().setFromObject(mesh));

      // 方块顶部的警示描边
      if (o.t === 'block' || o.t === 'crate') {
        var edge = new THREE.Mesh(
          new THREE.BoxGeometry(o.w * 0.98, 0.06, o.d * 0.98),
          new THREE.MeshBasicMaterial({
            color: o.t === 'block' ? 0xffb347 : 0x38e8ff,
            transparent: true, opacity: 0.4, toneMapped: false
          })
        );
        edge.position.set(o.x, (o.y || 0) + h + 0.02, o.z);
        group.add(edge);
      }
    });

    /* 说明：这张地图的樱花树是**用户摆放的模型实例**（由开发者模式注册），
       不是程序化 LAYOUT 里的东西，所以它们的批量绘制在 devmode 里处理，
       这里不用管。 */
    // 角落旋转警示灯（贴着活动空间的四角放，别挡住玩家的活动区域）
    var beacons = [];
    var BCx = bcx + (bx - 3), BCz = bcz + (bz - 3);
    [[bcx - (bx - 3), bcz - (bz - 3)], [BCx, bcz - (bz - 3)], [bcx - (bx - 3), BCz], [BCx, BCz]].forEach(function (p, i) {
      // 注意：CylinderGeometry 的第 3 个参数是"高度"，材质必须放在 Mesh 的第二个参数。
      // 以前把 matPillar 写进了高度位（new CylinderGeometry(..., 4.2, 8, matPillar)），
      // 几何顶点全变 NaN → setFromObject 得到 NaN 碰撞盒 → resolve 里把 pos.z 污染成 NaN，
      // 再被空气墙的"盒内"分支夹到北墙上，于是整张地图的人都会被瞬移到 z≈-53.6。
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 4.2, 8), matPillar);
      pole.position.set(p[0], 2.1, p[1]);
      pole.castShadow = true;
      group.add(pole);
      colliders.push(new THREE.Box3().setFromObject(pole));
      shootables.push(pole);

      var head = new THREE.Mesh(
        new THREE.BoxGeometry(1.1, 0.34, 0.34),
        new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff5a5a : 0x38e8ff })
      );
      head.position.set(p[0], 4.4, p[1]);
      group.add(head);
      beacons.push({ mesh: head, speed: i % 2 ? 1.6 : -1.3 });

      var light = new THREE.PointLight(i % 2 ? 0xff6a6a : 0x66e6ff, 0.28, 24, 2);
      light.position.set(p[0], 4.4, p[1]);
      group.add(light);
    });

    // 顶部补光（压低强度，避免把阴影冲平）—— 跟着活动空间铺，别铺到界外浪费
    var LGx = Math.max(10, (aw ? bx : W.HALF) - 22);
    var LGz = Math.max(10, (aw ? bz : W.HALF) - 22);
    for (var cxp = -LGx; cxp <= LGx; cxp += LGx) {
      for (var czp = -LGz; czp <= LGz; czp += LGz) {
        var cl = new THREE.PointLight(0xffffff, 0.16, 46, 1.6);
        cl.position.set(bcx + cxp, W.WALL_H - 1.6, bcz + czp);
        group.add(cl);
      }
    }

    /* 中央平台顶部灯环（装饰）—— **只有太空站有中央平台**，
       所以只在训练场创建。以前不分地图都加，结果这个半透明白圈
       飘在竞技场出生点前面的街道上空（用户反馈"出生点附近有个白圈"）。 */
    var ring = null;
    if (W.mapId === 'station') {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.1, 0.06, 6, 40),
        new THREE.MeshBasicMaterial({ color: 0x9ff4ff, transparent: true, opacity: 0.6 })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 1.22, 0);
      group.add(ring);
    }

    /* ---------------- 灯光（明亮舱室 + 明确阴影） ---------------- */
    var hemi = new THREE.HemisphereLight(0xffffff, 0x9fb6cc, 0.85);
    root.add(hemi);                          // 跟地图走：换图时自动一起清掉

    var dir = new THREE.DirectionalLight(0xfff3e0, 0.78);
    dir.position.set(26, 42, 18);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 140;
    var S = 52;
    dir.shadow.camera.left = -S;
    dir.shadow.camera.right = S;
    dir.shadow.camera.top = S;
    dir.shadow.camera.bottom = -S;
    dir.shadow.bias = -0.0007;
    dir.shadow.normalBias = 0.03;
    dir.shadow.radius = 4;        // 玩具感：更柔的阴影边缘
    root.add(dir);
    root.add(dir.target);

    if (W.mapId === 'station') scene.fog = new THREE.Fog(0xd7e2ed, 34, 145);
    else scene.fog = new THREE.Fog(0xc2d6ea, 150, 700);
    scene.background = new THREE.Color(W.mapId === 'station' ? 0x05080e : 0x8fb6d8);

    /* ---------------- 巡逻点 / 出生点 ----------------
       两个数组都必须按**活动空间（空气墙）那个矩形**来铺，不能用 W.HALF 当半径：
       边界有中心偏移（cx, cz），而且竞技场已收窄到 70×70 —— 老写法把出生点放在
       (±(HALF-6), 0, ±(HALF-6))，会直接落到空气墙外面，敌人一出生就被卡在界外。 */
    var aw = W.airWalls;
    var bx = aw ? (aw.thin ? aw.halfX : aw.half) : W.HALF;   // 边界半宽
    var bz = aw ? (aw.thin ? aw.halfZ : aw.half) : W.HALF;   // 边界半深
    var bcx = aw ? aw.cx : 0;
    var bcz = aw ? aw.cz : 0;

    var patrolPoints = [];
    var PATROL_N = W.mapId === 'station' ? 12 : 26;   // 大地图巡逻点加密
    for (var a = 0; a < PATROL_N; a++) {
      var ang = (a / PATROL_N) * Math.PI * 2;
      // 0.82 系数 + 矩形缩放：巡逻环整个缩进边界内，且吃得下中心偏移
      patrolPoints.push(new THREE.Vector3(
        bcx + Math.cos(ang) * bx * 0.82,
        0,
        bcz + Math.sin(ang) * bz * 0.82
      ));
    }
    patrolPoints.push(new THREE.Vector3(bcx, 0, bcz - 22));
    patrolPoints.push(new THREE.Vector3(bcx, 0, bcz + 22));
    patrolPoints.push(new THREE.Vector3(bcx - 22, 0, bcz));
    patrolPoints.push(new THREE.Vector3(bcx + 22, 0, bcz));
    patrolPoints.push(new THREE.Vector3(bcx + 16, 0, bcz - 16));
    patrolPoints.push(new THREE.Vector3(bcx - 16, 0, bcz + 16));

    // 出生点候选：沿边界矩形铺一张格子网（留 6 米安全边），比手写十几个点可靠得多。
    // 手写点在这张密林地图里几乎全被建筑/树占掉，过滤完只剩下北边一排，
    // 结果 15 个敌人全挤在一条线上。格子网 + 过滤 + 挑散布点才能真的铺开。
    var sp = 6;
    var spanX = Math.max(1, (bx - sp) * 2);
    var spanZ = Math.max(1, (bz - sp) * 2);
    var STEP = 4;                                     // 格子间距（米）
    var NX = Math.max(3, Math.round(spanX / STEP) + 1);
    var NZ = Math.max(3, Math.round(spanZ / STEP) + 1);
    var spawnPoints = [];
    for (var gx = 0; gx < NX; gx++) {
      for (var gz = 0; gz < NZ; gz++) {
        spawnPoints.push(new THREE.Vector3(
          bcx - (bx - sp) + (spanX * gx) / (NX - 1),
          0,
          bcz - (bz - sp) + (spanZ * gz) / (NZ - 1)
        ));
      }
    }

    /* ---------------- 出生点合法性校验 ----------------
       大地图里障碍物很多，硬编码的点很容易落在墙里/箱子里。
       这里统一过一遍：落在碰撞体里的点会被剔除，全被剔除时退回场地中心的空位。 */
    function insideCollider(p, pad) {
      var pd = pad == null ? 1.3 : pad;
      for (var k = 0; k < colliders.length; k++) {
        var b = colliders[k];
        if (b.max.y < 1.4) continue;                    // 很矮的东西（路沿等）不算
        if (p.x > b.min.x - pd && p.x < b.max.x + pd &&
            p.z > b.min.z - pd && p.z < b.max.z + pd) return true;
      }
      return false;
    }
    /* 出生点必须站在**地面**上。
       敌人不会自己走进墙里，卡在建筑里只可能是"出生点落在建筑上"——
       建筑是空心表面碰撞，落点压在屋顶/楼体上时脚底高度不是 0，
       之后它被自己的移动逻辑顶住，看起来就是"卡在建筑里"。
       这里先只做几何过滤，脚底高度检查放到 world 建好之后（见下方 spawnPoints 二次过滤）。 */
    spawnPoints = spawnPoints.filter(function (p) { return !insideCollider(p); });
    if (!spawnPoints.length) {
      spawnPoints.push(new THREE.Vector3(bcx, 0, bcz + (bz - 14)));
      spawnPoints.push(new THREE.Vector3(bcx, 0, bcz - (bz - 14)));
    }
    // 训练场（旧太空站）布局本来就稀疏且验证过，不做过滤，避免把巡逻点删太多
    if (W.mapId !== 'station') {
      patrolPoints = patrolPoints.filter(function (p) { return !insideCollider(p, 2.0); });
      if (!patrolPoints.length) patrolPoints.push(new THREE.Vector3(bcx, 0, bcz));
    }

    // 玩家出生点：竞技场放在活动空间中央偏南的空地，训练场保持原位置；不安全就自动找空位
    var start = W.mapId === 'station' ? new THREE.Vector3(0, 0, 12) : new THREE.Vector3(bcx, 0, 34);
    if (insideCollider(start, 1.8)) {
      var maxR = Math.min(bx, bz) - 6;
      for (var rr2 = 4; rr2 <= maxR; rr2 += 3) {
        var found = false;
        for (var aa = 0; aa < 16; aa++) {
          var an2 = (aa / 16) * Math.PI * 2;
          var cand = new THREE.Vector3(bcx + Math.cos(an2) * rr2, 0, bcz + Math.sin(an2) * rr2);
          if (!insideCollider(cand, 1.8)) { start = cand; found = true; break; }
        }
        if (found) break;
      }
    }

    /* 玩具质感：全场景材质调成哑光塑料
       写实贴图 + 写实光照会掉进恐怖谷；把金属度压掉、粗糙度拉高，
       表面就从"真实金属/石材"变成"塑料件"，配合移轴模糊立刻是微缩模型。 */
    if (W.mapId !== 'station') {
      group.traverse(function (o) {
        if (!o.material) return;
        var list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(function (m) {
          if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
            if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.05);
            if (m.roughness !== undefined) m.roughness = Math.max(m.roughness, 0.74);
            m.envMapIntensity = 0.85;      // 环境反射收一点，避免"真实感"
          }
        });
      });
    }

    /* 兜底清理：把非有限的碰撞盒踢出列表（正常一条都不该有，
       真出现了说明某个物体的几何/变换坏了，这里顺手报出来免得又变成"瞬移"bug）。 */
    (function dropBadColliders() {
      var dropped = [];
      for (var i = colliders.length - 1; i >= 0; i--) {
        var b = colliders[i];
        if (!isFinite(b.min.x + b.min.y + b.min.z + b.max.x + b.max.y + b.max.z)) {
          dropped.push(i);
          colliders.splice(i, 1);
        }
      }
      if (dropped.length) {
        console.warn('[world] 丢弃了 ' + dropped.length + ' 个非法碰撞盒（几何或变换含 NaN），下标 ' + dropped.join(','));
      }
    })();

    /* 空气墙必须在这里建一次。
       踩过的坑：以前只在开发者模式调参数时才 rebuildAirWalls()，
       于是不开开发者模式时边界根本没有碰撞体（能一直走出地图），
       而自动化测试恰好都走开发者模式，一直没暴露。 */
    if (W.mapId !== 'station') buildAirWalls();

    var time = 0;
    var world = {
      group: group,
      colliders: colliders,
      mountPoints: mountPoints,
      shootables: shootables,
      patrolPoints: patrolPoints,
      spawnPoints: spawnPoints,
      playerStart: start,
      hemiLight: hemi,
      dirLight: dir,

      /** 按 W.airWalls 重建边界（开发者模式调完参数后调用；不影响其它碰撞体） */
      rebuildAirWalls: function () {
        buildAirWalls();
        return { half: W.HALF, height: W.WALL_H, thickness: W.WALL_T, colliders: colliders.length };
      },
      /** 当前空气墙的 4 个包围盒（调试/显示用） */
      airWallBoxes: function () {
        return airMeshes.map(function (m) { return m.userData.box; });
      },

      update: function (dt) {
        time += dt;
        for (var i = 0; i < beacons.length; i++) {
          beacons[i].mesh.rotation.y += beacons[i].speed * dt;
        }
        if (ring) ring.rotation.z += dt * 0.35;
        var pulse = 0.5 + 0.5 * Math.sin(time * 2.2);
        matGlowCyan.color.setRGB(0.10 + pulse * 0.16, 0.72 + pulse * 0.26, 0.86 + pulse * 0.14);
      },

      /* ---------------- 开始页背景：只留星空 ----------------
         开始页把舱室几何全部隐藏，只渲染深色星空穹顶，
         这样主页面背景就是上一版的深色星空，而不是被灯光照亮的白色舱室。 */
      setBackdropOnly: function (on) {
        for (var i = 0; i < group.children.length; i++) {
          var o = group.children[i];
          if (o === sky) continue;
          o.visible = !on;
        }
      },

      /* ---------------- 碰撞：圆 vs AABB ---------------- */
      /**
       * 把一个高 height、半径 radius 的圆柱体（pos 为脚底位置）推出所有障碍。
       * 返回着地高度 ground（脚底可站立的最高面）。
       */
      /* 方案 B：已放置建筑的三角形级碰撞列表（闭包变量） */
      get bvhItems() { return BVH_ITEMS; },

      registerBvhItem: function (it) {
        if (!it || !it.bvh || !it.instRef) return;
        // 只登记"属于当前地图"的实例：换地图后旧地图的模型不应该再参与碰撞
        if (it.mapOrigin && it.mapOrigin !== W.mapId) return;
        if (it.worldBox) it.worldBox = new THREE.Box3().setFromObject(it.instRef);
        if (BVH_ITEMS.indexOf(it) < 0) {
          BVH_ITEMS.push(it);
          W.markSpatialDirty();
        }
      },
      unregisterBvhItem: function (it) {
        var i = BVH_ITEMS.indexOf(it);
        if (i >= 0) { BVH_ITEMS.splice(i, 1); W.markSpatialDirty(); }
      },

      resolve: function (pos, radius, height) {
        var i, box, min, max;
        var ground = 0;

        /* ===== 方案 B：BVH 三角形级推出（精确贴合模型表面，无盒子）=====
           做法：把玩家球心变换到实例的局部空间，用 BVH 查最近的竖直三角面，
                 沿该面法线（已朝向球心）推出。只取一个最大推出量，绝不累加。 */
        var _items = (window.FPS && FPS.BVH_ITEMS && FPS.BVH_ITEMS.length) ? FPS.BVH_ITEMS : BVH_ITEMS;
        if (_items.length && FPS.BVH && FPS.BVH.closestPoint && W.useBVH !== false) {
          /* 先按空间网格筛出"可能碰到"的实例（从 798 个降到十几个）。 */
          var _cand = spatialQuery(_items, pos.x, pos.z, radius + height * 0.5);
          var _inv = this._invM || (this._invM = new THREE.Matrix4());
          var _lp = this._lv || (this._lv = new THREE.Vector3());
          var _ln = this._ln2 || (this._ln2 = new THREE.Vector3());
          var _hit = this._lhit || (this._lhit = {});
          var _maxLen = 0, _mx = 0, _mz = 0;
          for (var bi = 0; bi < _cand.length; bi++) {
            var it = _cand[bi];
            if (!it.instRef || !it.bvh || !it.bvh.ok) continue;
            // 实例级粗筛：世界包围盒 vs 玩家球
            if (it.worldBox) {
              var bxx = pos.x < it.worldBox.min.x ? it.worldBox.min.x - pos.x : (pos.x > it.worldBox.max.x ? pos.x - it.worldBox.max.x : 0);
              var bzz = pos.z < it.worldBox.min.z ? it.worldBox.min.z - pos.z : (pos.z > it.worldBox.max.z ? pos.z - it.worldBox.max.z : 0);
              if (bxx * bxx + bzz * bzz > radius * radius) continue;
            }
            var worldScale = it.instRef.matrixWorld.getMaxScaleOnAxis() || 1;
            var rLocal = radius / worldScale;
            _inv.copy(it.instRef.matrixWorld).invert();
            _lp.set(pos.x, pos.y + height * 0.5, pos.z).applyMatrix4(_inv);
            var hit = FPS.BVH.closestPoint(it.bvh, _lp.x, _lp.y, _lp.z, rLocal, 1, _hit);
            if (!hit || hit.dist >= rLocal) continue;
            // 法线变换回世界（只取水平分量 → 天然的"侧向挡人"）
            _ln.set(hit.nx, 0, hit.nz).transformDirection(it.instRef.matrixWorld);
            var nl = Math.sqrt(_ln.x * _ln.x + _ln.z * _ln.z);
            if (nl < 1e-4) continue;
            var push = (rLocal - hit.dist) * worldScale;
            var px2 = (_ln.x / nl) * push, pz2 = (_ln.z / nl) * push;
            if (Math.sqrt(px2 * px2 + pz2 * pz2) > _maxLen) { _maxLen = Math.sqrt(px2 * px2 + pz2 * pz2); _mx = px2; _mz = pz2; }
          }
          if (_maxLen > 0) {
            if (_maxLen > 0.6) { _mx = _mx / _maxLen * 0.6; _mz = _mz / _maxLen * 0.6; }   // 单帧上限，保险丝
            pos.x += _mx; pos.z += _mz;
          }

          /* 站在三角形上 + 自动迈步（走楼梯/台阶）：查脚下的水平三角面 */
          var _hit2 = this._lhit2 || (this._lhit2 = {});
          var _wq = this._lwq || (this._lwq = new THREE.Vector3());
          var _cand2 = spatialQuery(_items, pos.x, pos.z, 1.6);   // 脚下这一圈
          for (var gi = 0; gi < _cand2.length; gi++) {
            var git = _cand2[gi];
            if (!git.instRef || !git.bvh || !git.bvh.ok) continue;
            if (git.worldBox) {
              var gxx = pos.x < git.worldBox.min.x - 0.6 ? git.worldBox.min.x - 0.6 - pos.x
                      : (pos.x > git.worldBox.max.x + 0.6 ? pos.x - git.worldBox.max.x - 0.6 : 0);
              var gzz = pos.z < git.worldBox.min.z - 0.6 ? git.worldBox.min.z - 0.6 - pos.z
                      : (pos.z > git.worldBox.max.z + 0.6 ? pos.z - git.worldBox.max.z - 0.6 : 0);
              if (gxx * gxx + gzz * gzz > 0.36) continue;
            }
            var gws = git.instRef.matrixWorld.getMaxScaleOnAxis() || 1;
            _inv.copy(git.instRef.matrixWorld).invert();
            // 从脚底略下方往上找最近的水平面
            _lp.set(pos.x, pos.y + 0.35, pos.z).applyMatrix4(_inv);
            var hg = FPS.BVH.closestPoint(git.bvh, _lp.x, _lp.y, _lp.z, (0.9 + 0.35) / gws, 2, _hit2);
            if (!hg) continue;
            _wq.set(hg.qx, hg.qy, hg.qz).applyMatrix4(git.instRef.matrixWorld);
            var gy = _wq.y;
            // 只接受"脚边到膝盖之间"的面（可站上去的高度）
            if (gy <= pos.y + 0.45 && gy > ground) ground = gy;
          }
        }

        // 水平推出（迭代两次处理夹缝）
        for (var pass = 0; pass < 2; pass++) {
          for (i = 0; i < colliders.length; i++) {
            box = colliders[i];
            // 退化/非有限包围盒必须跳过：NaN 会污染 pos，再被空气墙夹到墙上，
            // 表现为"整张地图的人被瞬移到边界"（踩过一次，别再踩）
            if (!isFinite(box.min.x + box.min.y + box.min.z + box.max.x + box.max.y + box.max.z)) continue;
            if (pos.y >= box.max.y - 0.06) continue;            // 站在其上方
            if (pos.y + height <= box.min.y) continue;          // 从下方通过
            var cx = Math.max(box.min.x, Math.min(pos.x, box.max.x));
            var cz = Math.max(box.min.z, Math.min(pos.z, box.max.z));
            var dx = pos.x - cx, dz = pos.z - cz;
            var d2 = dx * dx + dz * dz;
            if (d2 >= radius * radius) continue;
            if (d2 > 1e-8) {
              var d = Math.sqrt(d2);
              pos.x = cx + (dx / d) * radius;
              pos.z = cz + (dz / d) * radius;
            } else {
              // 圆心在盒内：沿最浅穿透方向弹出
              var pxl = pos.x - box.min.x, pxr = box.max.x - pos.x;
              var pzl = pos.z - box.min.z, pzr = box.max.z - pos.z;
              var m = Math.min(pxl, pxr, pzl, pzr);
              if (m === pxl) pos.x = box.min.x - radius;
              else if (m === pxr) pos.x = box.max.x + radius;
              else if (m === pzl) pos.z = box.min.z - radius;
              else pos.z = box.max.z + radius;
            }
          }
        }

        // 地面 / 可站立平台
        for (i = 0; i < colliders.length; i++) {
          box = colliders[i];
          if (!isFinite(box.max.y)) continue;
          if (box.max.y > pos.y + 0.42) continue;               // 太高，脚底够不到
          var qx = Math.max(box.min.x, Math.min(pos.x, box.max.x)) - pos.x;
          var qz = Math.max(box.min.z, Math.min(pos.z, box.max.z)) - pos.z;
          if (qx * qx + qz * qz < radius * radius * 0.9) {
            if (box.max.y > ground) ground = box.max.y;
          }
        }
        return ground;
      },

      // 视线检测：两点之间是否有静态遮挡
      blocked: function (from, to) {
        ray.set(from, _dir.subVectors(to, from).normalize());
        ray.far = from.distanceTo(to) - 0.35;
        var hits = ray.intersectObjects(shootables, false);
        ray.far = Infinity;
        return hits.length > 0;
      },

      /** 从 from 沿 dir 打出 maxDist，返回第一处静态遮挡的距离（没有则 null）—— 激光束用 */
      rayDist: function (from, dir, maxDist) {
        ray.set(from, dir);
        ray.far = maxDist;
        var hits = ray.intersectObjects(shootables, false);
        ray.far = Infinity;
        var best = hits.length ? hits[0].distance : null;
        // 玩家摆放的模型不在 shootables 里，必须单独做一次三角形级射线检测，
        // 否则激光会直接穿过建筑（用户反馈"激光能穿墙"）。
        var m = modelRayDist(from, dir, maxDist);
        if (m !== null && (best === null || m < best)) best = m;
        return best;
      }
    };

    /* ---------------- 模型实例的射线遮挡（激光用） ----------------
       玩家摆放的建筑不在 shootables 里，所以要单独查它们的 BVH。
       返回最近交点的距离，没有则 null。 */
    var _rdInv = new THREE.Matrix4(), _rdO = new THREE.Vector3(), _rdD = new THREE.Vector3();
    var _rdCross = new Float32Array(64);
    function modelRayDist(from, dir, maxDist) {
      var items = (window.FPS && FPS.BVH_ITEMS && FPS.BVH_ITEMS.length) ? FPS.BVH_ITEMS : BVH_ITEMS;
      if (!items.length || !FPS.BVH || !FPS.BVH.rayCrossings) return null;
      var best = null;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || !it.instRef || !it.bvh || !it.bvh.ok) continue;
        var b = it.worldBox;
        if (b) {                                   // 包围盒快速剔除（slab 法）
          var t1 = (b.min.x - from.x) / (dir.x || 1e-9), t2 = (b.max.x - from.x) / (dir.x || 1e-9);
          var tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
          t1 = (b.min.y - from.y) / (dir.y || 1e-9); t2 = (b.max.y - from.y) / (dir.y || 1e-9);
          tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
          t1 = (b.min.z - from.z) / (dir.z || 1e-9); t2 = (b.max.z - from.z) / (dir.z || 1e-9);
          tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
          if (tmax < 0 || tmin > tmax || tmin > maxDist) continue;
        }
        var worldScale = it.instRef.matrixWorld.getMaxScaleOnAxis() || 1;
        var localMax = maxDist / worldScale;
        _rdInv.copy(it.instRef.matrixWorld).invert();
        _rdO.copy(from).applyMatrix4(_rdInv);
        _rdD.copy(dir).transformDirection(_rdInv);
        var n = FPS.BVH.rayCrossings(it.bvh, _rdO.x, _rdO.y, _rdO.z, _rdD.x, _rdD.y, _rdD.z, localMax, _rdCross);
        if (!n) continue;
        var d = _rdCross[0] * worldScale;
        if (best === null || d < best) best = d;
      }
      return best;
    }

    var ray = new THREE.Raycaster();
    var _dir = new THREE.Vector3();

    /* 出生点过滤：落点不能落在任何建筑/树的包围盒里。
       敌人不会自己走进墙里 —— 卡在建筑里就是**出生时就在建筑里**。
       （试过用 resolve 的"脚下高度"判断，没用：建筑是空心表面碰撞，
         横面判定看不到屋顶，在建筑内部反而返回 0。所以直接用包围盒。）
       模型实例是在本函数返回之后由开发者模式登记的，所以这里只做一次，
       真正的过滤放在 main.js 的 buildSpawnSlots / findSpawnPoint 里（那时 BVH_ITEMS 已就绪），
       共用下面这个 W.insideModelBox 判定。 */
    W.insideModelBox = function (x, z, pad) {
      var items = (window.FPS && FPS.BVH_ITEMS) || [];
      var pd = pad == null ? 0.6 : pad;
      for (var i = 0; i < items.length; i++) {
        var b = items[i].worldBox;
        if (!b) continue;
        if (x > b.min.x - pd && x < b.max.x + pd && z > b.min.z - pd && z < b.max.z + pd) return true;
      }
      return false;
    };

    /* ================= 放置下载来的高模（按挂载点） =================
       模型已经在离线阶段处理过：贴图全部换成"中位数代表色"（平涂单色）、
       超重网格抽稀、无用 UV 删除。这里只负责摆位、玩具化与碰撞。 */
    /* 每个模型的"目标高度"（米）—— 模型单位五花八门（鸟居原始 871 米！），
       统一按高度归一化才合理 */
    /* 目标高度（米）—— 模型包围盒已修正（删掉了把整体拉长的背景立板），
       所以这里用真实建筑尺度即可 */
    var TARGET_H = {
      street: 8.0,          // 街道：一层~两层町屋
      villageHouse: 11.0,   // 宅地用公寓模型（本体就是 26 米）
      temple: 22.0,         // 五重塔
      interior: 3.4,        // 室内房间
      shoji: 2.2,           // 障子屏风
      traffic: 8.0,         // 电杆/售货机/路牌
      sakura: 7.0,          // 樱花树
      apartment: 11.0,
      city: 40.0
    };
    /* 每个 tag 最多实例化几个（模型太重，必须限流，否则三角面爆炸） */
    var MAX_INST = {
      street: 3, villageHouse: 20, temple: 2, interior: 2,
      shoji: 10, traffic: 1, apartment: 1
    };
    var MODEL_MAP = {
      street:       'models/map-stylized_little_japanese_town_street.glb',
      villageHouse: 'models/map-grey_japanease_apartment.glb',   // 宅地用公寓模型（仅 1.2k 面，可大量重复）
      temple:       'models/map-japanese_temple.glb',
      interior:     'models/map-anime_stylized_room_free.glb',
      shoji:        'models/map-shoji_screen.glb',
      traffic:      'models/map-japanese_traffic_assets.glb',
      sakura:       'models/map-sakura_tree_01_-_low_poly_model.glb',   // 樱花树
      apartment:    'models/map-grey_japanease_apartment.glb'
    };
    /* 每个模型文件的字节数（**进度条的分母**）。
       为什么要写死：`file://` 下 `GLTFLoader` 用 fetch，响应没有 `Content-Length`，
       进度事件里 `total` 恒为 0（实测 r150 只有 loaded 在涨）——
       所以"当前文件百分比"只能靠这张表。文件随游戏发布，大小是确定的。
       若某个模型改了/换新模型，更新这里对应数字即可（写 0 = 该文件退化成不确定态）。 */
    var MODEL_SIZE = {
      street:       38150781,
      villageHouse:   967894,
      temple:        4377016,
      interior:     33247744,
      shoji:          906236,
      traffic:      27474789,
      sakura:        2232952,
      apartment:      967894,
      weapon:        8413448,     // 玩家手上的枪 QBZ-191（原来由 player.js 单独加载，现在一起预载）
      modelsjson:          120    // models.json 配置（极小，几十字节）
    };
    /* 需要预加载的**全部**文件（地图模型 + 武器 + 配置）。
       这一轮的加载条按这个列表走：一个读完接下一个，"第 N / 共 10"。 */
    var PRELOAD = Object.keys(MODEL_MAP).concat(['weapon', 'modelsjson']);
    /* 模型只预加载进注册表，不自动摆放 —— 由游戏内开发者模式手动添加。
       加载时机：进入开发者模式时才触发（W.loadModels），并对外暴露真实进度。 */
    W.MODELS = {};
    /* 进度字段：
         done/total   —— 已完成 / 总数（个数）
         index        —— 正在加载第几个（0 起；全部完成时 = total）
         fileLoaded/fileTotal —— **当前这个文件**读了 / 共多少字节（file:// 下可能为 0，则退化）
         bytes/bytesTotal —— 全程累计（诊断用，界面不再依赖它）
       加载方式：**串行**，一个加载完再发下一个 —— 这样界面可以做成
       "一条进度条从 0 走到 100%，走完接下一个"，而不是把 10 份进度叠在一起。
       注意：`total` 是**文件个数**，别拿它当字节总数（我第一版就写错了）。 */
    W.MODEL_STATE = {
      started: false, done: 0, total: PRELOAD.length, index: 0,
      fileLoaded: 0, fileTotal: 0, bytes: 0, bytesTotal: 0
    };
    /** 某个预载项的路径（武器从 models.json 读，读不到就用默认） */
    function preloadPath(tag) {
      if (tag === 'modelsjson') return 'models/models.json';
      if (tag === 'weapon') return W.WEAPON_FILE || 'models/qbz191.glb';
      return MODEL_MAP[tag];
    }
    W.loadModels = function () {
      var st = W.MODEL_STATE;
      if (st.started) return st;
      st.started = true;
      st.total = PRELOAD.length;
      st.done = 0; st.index = 0; st.fileLoaded = 0; st.fileTotal = 0; st.bytes = 0; st.bytesTotal = 0;
      if (W.loadMountModels === false || !THREE.GLTFLoader) {
        st.done = st.total; st.index = st.total;
        return st;
      }
      var loader = new THREE.GLTFLoader();
      var tags = PRELOAD;

      /* 一个文件加载完就立刻发下一个（串行）。 */
      function loadNext(i) {
        if (i >= tags.length) { st.index = tags.length; return; }
        var tag = tags[i];
        var path = preloadPath(tag);
        st.index = i;
        st.fileLoaded = 0;
        st.fileTotal = MODEL_SIZE[tag] || 0;   // 分母：写死的大小（file:// 下事件里拿不到 total）
        /* 累计字节（诊断用，界面不依赖）：进入本文件前已经读掉的量 */
        var bytesBefore = st.bytes;

        var finished = false;
        function settle() {                 // 成功/失败只结算一次（否则 done 会多算）
          if (finished) return;
          finished = true;
          st.fileLoaded = st.fileTotal || 1;   // 界面上这一格必须精确落到 100%
          st.done++;
          setTimeout(function () { loadNext(i + 1); }, 0);
        }

        /* -------- models.json：纯文本配置，只读进来解析 -------- */
        if (tag === 'modelsjson') {
          new THREE.FileLoader().load(path, function (txt) {
            var cfg = null;
            try { cfg = JSON.parse(txt); } catch (e) { cfg = null; }
            W.WEAPON_CONFIG = cfg;                       // player.js 直接用它，不再自己再读一遍
            if (cfg && cfg.weapon && cfg.weapon.file) {
              W.WEAPON_FILE = /^[a-z]+:/i.test(cfg.weapon.file) || cfg.weapon.file.indexOf('models/') === 0
                ? cfg.weapon.file : 'models/' + cfg.weapon.file;
            }
            st.fileLoaded = st.fileTotal || 1;
            settle();
          }, function (ev) {
            if (!ev) return;
            if (ev.total) st.fileTotal = ev.total;
            st.fileLoaded = ev.loaded || 0;
          }, function () { st.fileLoaded = st.fileTotal || 1; settle(); });
          return;
        }

        loader.load(path, function (gltf) {
          /* -------- 武器：只放进注册表供 player.js 直接取用（不进建筑列表） -------- */
          if (tag === 'weapon') {
            var ws = gltf.scene || (gltf.scenes && gltf.scenes[0]);
            if (ws) W.MODELS[tag] = { scene: ws, bbox: new THREE.Box3().setFromObject(ws), weapon: true };
            settle();
            return;
          }
          var src = gltf.scene || (gltf.scenes && gltf.scenes[0]);
          if (src) {
            // 玩具化：低多边形块面 + 哑光塑料
            src.traverse(function (o) {
              if (!o.isMesh) return;
              var list = Array.isArray(o.material) ? o.material : [o.material];
              list.forEach(function (m3) {
                if (!m3) return;
                if (m3.metalness !== undefined) m3.metalness = 0;
                if (m3.roughness !== undefined) m3.roughness = Math.min(m3.roughness, 0.9);
                m3.flatShading = true;
                m3.envMapIntensity = 0.6;
                m3.needsUpdate = true;
              });
            });
            /* 静态合并：把"碎网格"模型按材质合成"每材质一个 Mesh"。
               例：公寓 135 个网格却只有 1232 个三角面，放 58 个 = 上千次 draw call；
               合并后 ≤10 次，画面完全不变（见 web/src/merge-static.js）。
               有骨骼动画的模型（武器等）由 byMaterial 自动跳过。 */
            if (FPS.Merge && FPS.Merge.byMaterial && W.mergeStatic !== false) {
              try { src = FPS.Merge.byMaterial(src); } catch (e) { console.warn('[静态合并失败] ' + tag + ': ' + e.message); }
            }
            var bb = new THREE.Box3().setFromObject(src);
            var size3 = bb.getSize(new THREE.Vector3());
            W.MODELS[tag] = { scene: src, bbox: bb, size: size3, targetH: TARGET_H[tag] || 6 };
            // 方案 B：建三角形级 BVH（模型局部空间）。大模型建树较慢，但只在加载时做一次。
            if (FPS.BVH && W.useBVH !== false) {
              try {
                src.updateMatrixWorld(true);
                W.MODELS[tag].bvh = FPS.BVH.buildFromSource(src);
              } catch (e) {
                W.MODELS[tag].bvh = null;
                console.warn('[BVH建树失败] ' + tag + ': ' + e.message);
              }
            }
            // 体素模板由开发者模式提供（贴着建筑表面的碰撞外壳）
            if (FPS.DevMode && FPS.DevMode.buildVoxels) {
              try {
                W.MODELS[tag].voxels = FPS.DevMode.buildVoxels(src, size3);
              } catch (e) {
                W.MODELS[tag].voxels = null;
                console.warn('[体素化失败] ' + tag + ': ' + e.message);   // 不再静默吞掉
              }
            }
          }
          settle();
        }, function (ev) {
          /* 进度事件：file:// 下 total 恒为 0，只有 loaded 可信 → 用写死的大小当分母。
             万一以后换成 HTTP（有 total），就优先用服务端给的值。 */
          if (!ev) return;
          if (ev.total) st.fileTotal = ev.total;
          st.fileLoaded = ev.loaded || 0;
          st.bytes = bytesBefore + st.fileLoaded;                              // 累计（诊断）
          st.bytesTotal = Math.max(st.bytesTotal, bytesBefore + (st.fileTotal || st.fileLoaded));
        }, function () {
          settle();      // 加载失败也计数，避免进度卡住
        });
      }

      loadNext(0);
      return st;
    };

    return world;
  };
})();

/* =====================================================================
   NEON STRIKE — 场景 / 关卡
   全部贴图均由 canvas 程序化生成，不加载任何外部资源。
   ===================================================================== */
window.FPS = window.FPS || {};
