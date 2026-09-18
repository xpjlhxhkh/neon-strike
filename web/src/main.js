/* =====================================================================
   霓虹突袭 — 主程序
   ===================================================================== */
(function () {
  'use strict';

  var Sfx = FPS.Sfx;
  var P = FPS.Particles;

  /* ---------------- 配置 ---------------- */
  /* 开发版开关：打包玩家版时脚本会把这里改成 false。
     false 会让 `window.__FPS_GAME` 这套调试后门**根本不存在**（玩家版不留后门）。 */
  var DEV_BUILD = false;
  var WAVE_ENEMIES = 20;        // 每关敌人总数（特殊兵种也算在内）
  var SUPER_BASE = 2;           // 每种已解锁特殊兵种的基础数量
  var SUPER_CAP = 3;            // 每种特殊兵种的单关上限
  var TROOP_HEAR = 60;          // 枪声惊动半径（米）
  var SPAWN_MIN_GAP = 18;       // 敌人之间的最小间隔（米），保证大幅分散
  // 出生点距玩家的距离环：要"远"——场地半径约 70 米，取 60~95（外圈到边缘）。
  // 环不能太窄：太窄会导致可用点不够，算法只能复用同一批点，反而挤在一起。
  var SPAWN_NEAR_MIN = 60;      // 出生点距离玩家的近端（米）
  var SPAWN_NEAR_MAX = 95;      // 出生点距离玩家的远端（米）
  var MAX_ALIVE = 8;            // 同时在场上限（主线开局一次全放，所以只对训练场/补位生效）
  var TOTAL_WAVES = 8;          // 总关卡数
  var WAVE_HEAL = 50;           // 过关回血
  var WAVE_AMMO = 200;          // 过关后的备弹补给
  var SCORE_KILL = 100;
  var SCORE_HEADSHOT = 150;
  var WAVE_CLEAR_BONUS = 60;    // 每关清空奖励 = 60 × 关数
  var STREAK_WINDOW = 2.5;      // 连杀窗口：多久没击杀就断连（比之前缩短一半以上）
  var FOV = 75;

  /**
   * 连杀奖励：从第 1 杀就有奖励，之后每多一连杀 +50，封顶 400。
   * 1 连杀 +20 / 2 连杀 +50 / 3 连杀 +100 / 4 连杀 +150 ……
   */
  function streakBonus(n) {
    if (n <= 0) return 0;
    if (n === 1) return 20;
    return Math.min(400, 50 * (n - 1));
  }

  var DEFAULT_SETTINGS = { sens: 1.0, volume: 70, fullscreen: true, shadows: true };
  var STORAGE_KEY = 'neon-strike-settings';

  /* ---------------- DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    app: $('app'),
    hud: $('hud'),
    crosshair: $('crosshair'),
    scope: $('scope'),
    scopeZoom: $('scopeZoom'),
    hitmarker: $('hitmarker'),
    damage: $('damage'),
    lowhp: $('lowhp'),
    fps: $('fps'),
    healthValue: $('healthValue'),
    healthBar: $('healthBar'),
    scoreValue: $('scoreValue'),
    waveScoreValue: $('waveScoreValue'),
    killsValue: $('killsValue'),
    headshotValue: $('headshotValue'),
    waveValue: $('waveValue'),
    stageTotal: $('stageTotal'),
    stageBar: $('stageBar'),
    stageCleared: $('stageCleared'),
    keyHints: $('keyHints'),
    cDots: $('cDots'),
    trainMenu: $('trainMenu'),
    aliveValue: $('aliveValue'),
    ammoMag: $('ammoMag'),
    ammoReserve: $('ammoReserve'),
    reloadHint: $('reloadHint'),
    scorePopups: $('scorePopups'),
    streakPanel: $('streakPanel'),
    streakText: $('streakText'),
    streakBonus: $('streakBonus'),
    streakBar: $('streakBar'),
    roundCard: $('roundCard'),
    rcTitle: $('rcTitle'),
    rcScore: $('rcScore'),
    rcBonus: $('rcBonus'),
    rcHeal: $('rcHeal'),
    rcAmmo: $('rcAmmo'),
    rcNextText: $('rcNextText'),
    rcBar: $('rcBar'),
    banner: $('banner'),
    bannerTitle: $('bannerTitle'),
    bannerSub: $('bannerSub'),
    overlay: $('overlay'),
    overlayCard: $('overlayCard')
  };

  /* ---------------- 状态 ---------------- */
  var state = 'menu';           // menu | playing | paused | gameover | victory
  var currentMap = 'arena';     // 当前已构建的地图（换地图要重建世界）
  var postfx = null;            // 后处理管线
  var _sunV = new THREE.Vector3();
  var scene, camera, renderer, world, player;
  var enemies = [];
  var score = 0, kills = 0, headshots = 0, wave = 0;
  var streak = 0, streakTimer = 0, bestStreak = 0, streakScore = 0;
  var waveScore = 0, waveKilled = 0, waveSpawned = 0, waveTotal = 0;
  var shotsFired = 0, shotsHit = 0;
  var waveClearDelay = 0;
  var waveActive = false;
  var wavePending = 0;          // 本关还在等待出场的敌人数
  var waveQueue = [];           // 本关出场队列（可以超过同屏上限）
  var spawnSlots = null;        // 本关预先排好的出生点分配器（见 buildSpawnSlots）
  var spawnTimers = [];         // 出场定时器
  var gameToken = 0;            // 每局递增，用于丢弃上一局遗留的刷怪定时器
  var frameCount = 0;           // 主循环帧数（自动化测试用来判断循环是否还活着）
  var gameTime = 0;             // 累计游戏时间（秒），按实际 dt 累加
  var lastFrame = performance.now();
  var fpsAcc = 0, fpsFrames = 0, fpsTimer = 0;
  var crosshairCheckT = 0, enemyUnderCrosshair = false, crosshairAds = false;
  var hudT = 0;
  var HINT_IDLE_SEC = 8;                 // 玩家长时间不动 → 重新显示按键提示
  var lastInputAt = performance.now();
  var hintsShown = false;
  var raycaster = new THREE.Raycaster();

  /* ===============================================================
     训练场（无关卡模式）
     -----------------------------------------------------------------
     与主线完全分开的一套规则：
       · 无关卡、无波次推进
       · 子弹无限、不用换弹
       · 场上固定 5 个随机兵种；全部消失后自动再刷一轮
       · 左上角菜单可以：全体停止/移动、清空敌人、按兵种手动添加
       · Alt 呼出鼠标开菜单；鼠标解锁期间除菜单外一切操作都不响应
     =============================================================== */
  var training = false;         // 本局是不是训练场
  var trainHold = false;        // 全部停止
  var trainClearing = false;    // 正在执行"清空"（清完才恢复刷怪）
  var trainRound = 5;           // 一轮几个
  var trainSpawned = 0;         // 本局手动了多少次（测试用计数）
  var menuOpen = false;         // 鼠标已解锁（只有训练场会进这个状态）
  var trainBound = false;       // 菜单事件只绑一次

  /** 记录玩家操作时间（用于判断"长时间不动"） */
  function markActivity() { lastInputAt = performance.now(); }

  var input = {
    forward: false, back: false, left: false, right: false,
    jump: false, jumpPressed: false, sprint: false, firing: false, reload: false
  };

  /* ===============================================================
     设置
     =============================================================== */
  var settings = (function load() {
    var s = {};
    for (var k in DEFAULT_SETTINGS) s[k] = DEFAULT_SETTINGS[k];
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var k2 in DEFAULT_SETTINGS) {
          if (typeof saved[k2] === typeof DEFAULT_SETTINGS[k2]) s[k2] = saved[k2];
        }
      }
    } catch (e) { /* 隐私模式等，忽略 */ }
    return s;
  })();

  function saveSettings() {
    var txt = JSON.stringify(settings);
    try { window.localStorage.setItem(STORAGE_KEY, txt); } catch (e) {}
    // 权威副本：写进 <游戏目录>/saves/<key>.json（见 web/src/save.js）
    if (window.FPS && FPS.Save && FPS.Save.set) { try { FPS.Save.set(STORAGE_KEY, txt); } catch (e) {} }
  }

  /** 从本机缓存重新读取设置（开机时存档文件恢复完成后调用，就地覆盖字段） */
  function reloadSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var o = JSON.parse(raw);
      Object.keys(o).forEach(function (k) { settings[k] = o[k]; });
      return true;
    } catch (e) { return false; }
  }

  function applyShadows() {
    if (!renderer) return;
    renderer.shadowMap.enabled = settings.shadows;
    if (world && world.dirLight) world.dirLight.castShadow = settings.shadows;
    // 运行时切换 shadowMap 需要让材质重新编译
    if (scene) {
      scene.traverse(function (o) {
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(function (m) { m.needsUpdate = true; });
          else o.material.needsUpdate = true;
        }
      });
    }
    if (player && player.viewScene) {
      player.viewScene.traverse(function (o) {
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(function (m) { m.needsUpdate = true; });
          else o.material.needsUpdate = true;
        }
      });
    }
  }

  function applySettings() {
    if (player) player.sensitivity = settings.sens;
    Sfx.setVolume(settings.volume / 100);
    applyShadows();
  }

  /* ===============================================================
     初始化
     =============================================================== */
  function init() {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = settings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.autoClear = false;
    el.app.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 420);
    scene.add(camera);

    // 后处理管线（自研，零依赖）：泛光 + 上帝光 + ACES + 色彩分级 + 暗角 + FXAA + 抖动
    if (FPS.PostFX) {
      postfx = FPS.PostFX.create(renderer, scene, camera);
      postfx.quality = settings.quality || 'high';
      postfx.toy = settings.toy !== false;
      postfx.applyLook();
      postfx.setSize(window.innerWidth, window.innerHeight);
    }

    world = FPS.World.build(scene, renderer);
    currentMap = FPS.World.mapId;
    // 切图后应用该地图自己的画面设置（画面预设与微调都是"逐地图独立记忆"）
    applyMapLook();
    // 开机第一次：把 <游戏目录>/saves 里的存档恢复进本机缓存，再重新应用一次
    if (window.FPS && FPS.Save && FPS.Save.mode === 'file' && !FPS.Save._applied) {
      FPS.Save._applied = true;
      FPS.Save.restore().then(function () {
        reloadSettings();
        applyMapLook();
        if (typeof syncLookUI === 'function') syncLookUI();
        FPS.Save.startAutoMirror(10000);   // 之后每 10 秒把存档镜像回游戏目录
      });
    } else if (window.FPS && FPS.Save && FPS.Save.mode !== 'file') {
      FPS.Save.startAutoMirror(10000);     // 浏览器调试模式：只镜像（其实不写文件）
    }
    world.group.visible = false;   // 启动先进主页：背景只留星空

    /* ================= 启动加载页（主菜单之前） =================
       全屏盖一层"资源加载中..."，同时后台预加载所有资源文件（**串行**：
       一个加载完再接下一个，见 world.js 的 loadModels）。
       界面就是一条进度条：**百分比在条的右侧**，下面一行 "第几个 / 共几个"。
       进度条满了 → 瞬间归零 → 接着走下一个文件。
       ⚠ 布局要点：百分比在右边会把"条本身"挤得不居中（标题和下面的计数却是按整行居中的，
       两个中心对不上，看起来就是整块偏右）。所以左边放一个**与百分比等宽的占位**，
       让条自己居中 —— 占位宽度按百分比的实测宽度设置（见 syncBootSpacer）。 */
    var bootEl = document.createElement('div');
    bootEl.id = 'bootLoading';
    bootEl.style.cssText = 'position:fixed;inset:0;z-index:10050;background:#0b121c;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'color:#cfe2f5;font:400 14px/1.6 system-ui,"Microsoft YaHei",sans-serif;transition:opacity .45s';
    bootEl.innerHTML =
      '<div id="bootLab" style="font-size:13px;letter-spacing:3px;opacity:.62;margin-bottom:16px">资源加载中...</div>' +
      '<div style="width:560px;display:flex;align-items:center;gap:8px">' +
        '<div id="bootPad" style="flex:none;width:0"></div>' +
        '<div style="position:relative;flex:1;height:14px;border-radius:8px;overflow:hidden;' +
          'background:rgba(8,14,24,.92);box-shadow:inset 0 0 0 1px rgba(130,190,255,.2)">' +
          '<div id="bootBar" style="height:100%;width:0;border-radius:8px;' +
            'background:linear-gradient(90deg,#1b9fd0,#35e0ff);box-shadow:0 0 14px rgba(53,224,255,.6)"></div>' +
        '</div>' +
        '<div id="bootPct" style="flex:none;width:62px;text-align:right;font-size:18px;line-height:1;' +
          'font-weight:600;color:#35e0ff;font-variant-numeric:tabular-nums;' +
          'text-shadow:0 0 14px rgba(53,224,255,.45)">0%</div>' +
      '</div>' +
      '<div id="bootCnt" style="margin-top:14px;font-size:13px;opacity:.72;' +
        'font-variant-numeric:tabular-nums"><b>0</b> / 10</div>';
    document.body.appendChild(bootEl);
    var bootBar = bootEl.querySelector('#bootBar');
    var bootPct = bootEl.querySelector('#bootPct');
    var bootLab = bootEl.querySelector('#bootLab');
    var bootCnt = bootEl.querySelector('#bootCnt');
    var bootPad = bootEl.querySelector('#bootPad');
    var bootRow = bootPad.parentNode;
    /* 左边占位 = 右边百分比格子的宽度（含 gap），这样"条"精确居中；
       百分比用固定 62px 右对齐，所以 0% 和 100% 不会让条左右晃。 */
    function syncBootPad() {
      if (!bootPad || !bootPct) return;
      var w = bootPct.getBoundingClientRect().width;
      if (!w) w = 62;                                  // 还没排版时用 CSS 宽度兜底
      var gap = 8;
      var rowW = bootRow.getBoundingClientRect().width || 560;
      /* 占位不能大到把条挤没：最多占整行的 1/2 */
      w = Math.min(w, rowW / 2 - gap);
      bootPad.style.width = w + 'px';
    }
    window.addEventListener('resize', syncBootPad);
    syncBootPad();

    /** 设进度（0..100）。cnt 给了就一起更新"第几个 / 共几个"。 */
    function setBootBar(p, cnt) {
      p = Math.max(0, Math.min(100, p));
      if (bootBar) bootBar.style.width = p + '%';
      if (bootPct) bootPct.textContent = Math.round(p) + '%';
      if (cnt !== undefined && bootCnt) bootCnt.innerHTML = '<b>' + cnt + '</b> / ' + bootTotal;
    }
    function snapBootBar() {                 // 换文件时立刻归零，不要"倒着溜回去"
      if (!bootBar) return;
      bootBar.style.transition = 'none';
      bootBar.style.width = '0%';
      bootBar.style.marginLeft = '0';        // 顺手复位不确定态的偏移
      void bootBar.offsetWidth;
      bootBar.style.transition = 'width .12s linear';
      if (bootPct) bootPct.textContent = '0%';
    }
    function removeBoot() {
      var e2 = document.getElementById('bootLoading');
      if (!e2) return;
      e2.style.opacity = '0';
      setTimeout(function () { if (e2 && e2.parentNode) e2.parentNode.removeChild(e2); }, 500);
    }
    var bootTotal = (FPS.World.MODEL_STATE && FPS.World.MODEL_STATE.total) || 8;
    var bootDone = -1;                       // 上一次看到的"正在读第几个"（-1 = 还没开始）
    setBootBar(0, 0);
    (function bootTick() {
      var st = FPS.World.MODEL_STATE || { done: 0, total: bootTotal, index: 0, fileLoaded: 0, fileTotal: 0 };
      if (st.total) bootTotal = st.total;

      if (st.done >= st.total && st.total > 0) {
        setBootBar(100, st.total);
        if (bootLab) bootLab.textContent = '加载完成';
        window.__bootLoaded = true;
        // 模型全部就绪 → 载入内置默认地图（用户建造的布局）
        applyBuiltInMap();
        removeBoot();
        return;
      }

      /* 换文件就归零（条 + 百分比）。用 index 变化判断，而不是 done ——
         done++ 和 loadNext() 之间有一帧空隙，那一帧会出现"条 100% 但计数已经是下一个"。 */
      if (st.index !== bootDone) {
        bootDone = st.index;
        snapBootBar();
      }

      /* 每帧先把"不确定态"留下的横向偏移复位。
         ⚠ 这里踩过坑：早先只在拿不到文件大小时设置 marginLeft、却没有在拿到时清零，
         于是首帧一旦走过那个分支，条就永远带着右偏移 —— 表现为"进度从框的右边开始涨"。 */
      if (bootBar && bootBar.style.marginLeft) bootBar.style.marginLeft = '0';

      var hasBytes = st.fileTotal > 0;
      var p;
      if (hasBytes) {
        p = (st.fileLoaded / st.fileTotal) * 100;
      } else {
        /* 真拿不到文件大小（模型表里没登记）：做成"来回跑"的不确定态 */
        var phase = (performance.now() / 13) % 200;
        var tri = phase <= 100 ? phase : 200 - phase;      // 0..100..0
        p = 30;
        if (bootBar) bootBar.style.marginLeft = (tri * 0.7).toFixed(1) + '%';
      }
      /* 计数从 0 开始：正在读第 index+1 个文件时显示 index（"已经完成几个"）。
         所以第一帧是 0 / 10，最后一个文件读完才到 10 / 10。 */
      var cur = Math.min(bootTotal, st.index || 0);
      setBootBar(p, cur);
      if (!hasBytes && bootPct) bootPct.textContent = '读取中';   // 有分母就一定显示百分比
      setTimeout(bootTick, hasBytes ? 90 : 40);
    })();

    P.init(scene);

    player = new FPS.Player({
      scene: scene,
      camera: camera,
      world: world,
      callbacks: {
        getTargets: getTargets,
        onEnemyHit: onEnemyHit,
        onShoot: onShoot,
        onReload: function () { },
        onReloadEnd: function () { }
      }
    });

    bindEvents();
    guardHistory();
    applySettings();
    el.stageTotal.textContent = '共 ' + TOTAL_WAVES + ' 关';
    showMenu('main');
    if (FPS.DevMode) {
    FPS.DevMode.init({
      scene: scene, camera: camera, renderer: renderer, world: world, player: player,
      // 开发者模式打开时，如果游戏正处在暂停/菜单，自动恢复对局，免得菜单挡住操作
      resume: function () {
        try {
          if (state === 'playing') return true;
          var btn = document.getElementById('btnResume') || document.getElementById('btnRestart');
          if (btn) { btn.click(); return true; }
        } catch (e) { }
        return false;
      }
    });
  }
  /* 把"内置地图（竞技场那 798 个物体）"摆进场景。
     这段逻辑住在 devmode.js 里（布局解析 / 实例化 / 碰撞体），但**它不是开发者模式专属**：
     普通游玩也必须载入，所以在这里包一层，别让它挂在"开发者模式初始化"那条路上。 */
  function applyBuiltInMap(force) {
    try {
      if (FPS.DevMode && FPS.DevMode.applyDefaultLayout) return FPS.DevMode.applyDefaultLayout(force);
    } catch (e) { }
    return false;
  }

  /* 启动即预加载建筑模型（串行），进度由上面加载页里的 bootTick 驱动 */
  if (FPS.World && FPS.World.loadModels) {
    try { FPS.World.loadModels(); } catch (e) { }
  }

  requestAnimationFrame(loop);
  }

  /* ===============================================================
     阻止浏览器后退（触控板横向滑动 / 鼠标侧键 / 退格）
     =============================================================== */
  function guardHistory() {
    try {
      history.replaceState({ ns: 0 }, '');
      history.pushState({ ns: 1 }, '');
      window.addEventListener('popstate', function () {
        // 被"后退"时立刻补一个状态，把用户留在游戏里
        try { history.pushState({ ns: 1 }, ''); } catch (e) {}
        if (state === 'playing') showBanner('已阻止网页回退', '继续战斗');
      });
    } catch (e) { /* 某些 file:// 环境不允许，忽略 */ }
  }

  /* ===============================================================
     全屏
     ---------------------------------------------------------------
     说明：浏览器出于安全考虑，**必须**允许用户用 Esc 退出全屏，
     网页无法阻止这一点。但 Chrome/Edge 支持"键盘锁定"(Keyboard Lock)：
     在全屏状态下可以捕获 Esc 键，这样按 Esc 只暂停游戏、不会退出全屏。
     不支持键盘锁定时（如 Firefox），退而求其次：每次"继续游戏"自动恢复全屏。
     =============================================================== */
  var wantFullscreen = false;   // 玩家希望保持全屏（设置里为开）
  var fsRetryPending = false;
  var fsRetryCount = 0;
  var shellFullscreen = window.Shell ? window.Shell.isLauncher : /(^|[?&])shell=1/.test(window.location.search);
  var shellMode = shellFullscreen;                                        // 由启动器/外壳启动：显示"退出游戏"
  var exitPort = (function () {
    var m = window.location.search.match(/[?&]exitport=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  })();

  /** 主页面上的"退出游戏"：桌面外壳直接结束进程；旧启动器则发信号强杀内核 */
  function exitGame() {
    if (window.Shell && window.Shell.quit()) return;      // Tauri 外壳：关窗即退，无需兜底提示
    try {
      if (exitPort) {
        var u = 'http://127.0.0.1:' + exitPort + '/exit';
        try { var img = new Image(); img.src = u + '?t=' + Date.now(); } catch (e) {}
        try {
          if (window.fetch) {
            var pr = fetch(u, { mode: 'no-cors' });
            if (pr && pr.catch) pr.catch(function () {});
          }
        } catch (e) {}
      }
    } catch (e) { }
    try { window.close(); } catch (e) { }
    setTimeout(function () {
      showBanner('如窗口未关闭，请按 Alt + F4', '');   // 兜底提示
    }, 600);
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  /**
   * 窗口是否已经是"整屏"状态（启动器用 --start-fullscreen 打开时就是这种）。
   * 这种情况不再调用 Fullscreen API —— 那正是浏览器弹出
   * "按 Esc 退出全屏"提示、并且按 Esc 会退出全屏的原因。
   */
  function alreadyScreenSized() {
    try {
      var sw = window.screen.width, sh = window.screen.height;
      return Math.abs(window.innerWidth - sw) <= 2 && Math.abs(window.innerHeight - sh) <= 2;
    } catch (e) {
      return false;
    }
  }

  function fullscreenSupported() {
    var d = document;
    return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled) &&
      !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  }

  function lockKeyboard() {
    try {
      if (navigator.keyboard && navigator.keyboard.lock) {
        var p = navigator.keyboard.lock(['Escape']);
        if (p && p.catch) p.catch(function () { /* 不支持或非全屏，忽略 */ });
        return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function unlockKeyboard() {
    try {
      if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    } catch (e) { /* 忽略 */ }
  }

  function enterFullscreen() {
    // 桌面外壳：交给原生窗口（没有 Fullscreen API 的 Esc 提示，也不需要键盘锁定）
    if (window.Shell && window.Shell.setFullscreen(true)) { wantFullscreen = true; return Promise.resolve(true); }
    if (isFullscreen()) { lockKeyboard(); return Promise.resolve(true); }
    // 已经是整屏窗口：不再请求 Fullscreen API（避免"按 Esc 退出全屏"提示与 Esc 退出行为）
    if (alreadyScreenSized()) { wantFullscreen = true; lockKeyboard(); return Promise.resolve(true); }
    if (!fullscreenSupported()) {
      showBanner('无法全屏', '请在浏览器中直接打开本页面，或按 F11');
      return Promise.resolve(false);
    }
    var root = document.documentElement;
    var fn = root.requestFullscreen || root.webkitRequestFullscreen;
    try {
      var p = fn.call(root, { navigationUI: 'hide' });
      if (p && p.then) {
        return p.then(function () {
          lockKeyboard();
          return true;
        }).catch(function () {
          // 某些浏览器在 iframe / 预览窗口里会直接拒绝
          fsRetryPending = true;
          showBanner('全屏被浏览器拦截', '点一下画面或按 F11 可再试');
          return false;
        });
      }
      lockKeyboard();
      return Promise.resolve(true);
    } catch (e) {
      fsRetryPending = true;
      return Promise.resolve(false);
    }
  }

  function exitFullscreen() {
    if (window.Shell && window.Shell.setFullscreen(false)) { wantFullscreen = false; return; }
    unlockKeyboard();
    if (!isFullscreen()) return;
    try {
      var fn = document.exitFullscreen || document.webkitExitFullscreen;
      if (fn) fn.call(document);
    } catch (e) {}
  }

  /** 设置界面里的全屏开关跟随真实状态 */
  function syncSettingsUI() {
    var sw = $('setFullscreen');
    if (!sw) return;
    sw.classList.toggle('on', settings.fullscreen);
    var v = $('setFullscreenVal');
    if (v) v.textContent = settings.fullscreen ? '开' : '关';
  }

  /* ===============================================================
     目标列表（静态场景 + 存活敌人）
     =============================================================== */
  var targets = [];
  function getTargets() {
    targets.length = 0;
    for (var i = 0; i < world.shootables.length; i++) targets.push(world.shootables[i]);
    for (var j = 0; j < enemies.length; j++) enemies[j].getHitMeshes(targets);
    return targets;
  }

  /* ===============================================================
     敌人 / 关卡
     =============================================================== */
  /* 巡逻点挑选：**优先玩家周围 20~45 米**。
     以前是"抽 6 个点、永远挑最远的那个"，于是敌人越走越远，全跑到 45~105 米的外圈，
     玩家整局都看不见人（用户反馈）。现在优先挑玩家附近，
     而且远处的敌人会被"拉过来"——每挑一次新巡逻点，就借机往玩家方向靠近一段。 */
  var PATROL_NEAR = 20;         // 期望最近距离（米）
  var PATROL_FAR = 45;          // 期望最远距离（米）
  var PATROL_PULL = 12;         // 每次换巡逻点时，朝玩家方向最多挪多少米
  var PATROL_PULL_MIN_D = 30;   // 已经比这个距离近了就不再主动靠近（避免贴脸）
  function pickPatrol(enemy) {
    var pts = world.patrolPoints;
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < 8; i++) {
      var p = pts[(Math.random() * pts.length) | 0];
      var dPlayer = p.distanceTo(player.pos);
      var score;
      if (dPlayer < PATROL_NEAR) score = 40 - (PATROL_NEAR - dPlayer) * 1.5;        // 太近（会贴脸）扣分
      else if (dPlayer > PATROL_FAR) score = 40 - (dPlayer - PATROL_FAR) * 1.2;     // 太远扣分
      else score = 40;                                                              // 区间内满分
      score += Math.random() * 10;
      if (enemy.waypoint && p.distanceTo(enemy.waypoint) < 3) score -= 14;           // 别原地打转
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return pts[0].clone();
    /* 散步靠近：如果它离玩家还比较远，把目标点朝玩家方向拉一段。
       只改"去哪"，速度仍用巡逻速度（比锁定后的追击速度慢），所以是慢慢晃过来。 */
    var out = best.clone();
    var toP = _patrolTmp.subVectors(player.pos, out);
    var dist = toP.length();
    if (dist > PATROL_PULL_MIN_D) {
      toP.normalize();
      out.addScaledVector(toP, Math.min(PATROL_PULL, dist - PATROL_PULL_MIN_D));
    }
    return out;
  }
  var _patrolTmp = new THREE.Vector3();

  function findSpawnPoint() {
    var pts = world.spawnPoints;
    /* 性能关键：这里以前对【全部 ~1089 个候选点】各跑一次 world.resolve，
       而 resolve 会遍历 798 个 BVH 实例 ×2 趟 → 单次刷怪上百万次循环，卡在主线程上
       （用户反馈"人一多立马就卡"就是这个）。现在拆两步：
         ① 先纯算术打分（不算碰撞），挑出距离最合适的十几个候选；
         ② 只对这些候选做 resolve 落点检测。 */
    var want = SPAWN_NEAR_MIN + Math.sqrt(Math.random()) * (SPAWN_NEAR_MAX - SPAWN_NEAR_MIN);
    var cand = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var d = p.distanceTo(player.pos);
      if (d < SPAWN_NEAR_MIN || d > SPAWN_NEAR_MAX) continue;
      // 落在建筑/树包围盒里的位置不能用（否则敌人一出生就在建筑里）
      if (FPS.World.insideModelBox && FPS.World.insideModelBox(p.x, p.z)) continue;
      cand.push({ p: p, s: Math.abs(d - want) + Math.random() * 6 });
    }
    cand.sort(function (a, b) { return a.s - b.s; });
    var TRY = Math.min(12, cand.length);
    for (var c = 0; c < TRY; c++) {
      var test = cand[c].p.clone();
      world.resolve(test, 0.5, 2.2);
      if (test.distanceTo(cand[c].p) <= 0.55) return cand[c].p.clone();   // 站得住 → 用它
    }
    // 这一圈里没有可站的点（地图很挤时）：退回"离玩家尽量远但可站"的少数几个候选
    var far = [];
    for (var k = 0; k < pts.length; k++) {
      var d2 = pts[k].distanceTo(player.pos);
      if (d2 >= SPAWN_NEAR_MIN) far.push({ p: pts[k], d: d2 });
    }
    far.sort(function (a, b) { return b.d - a.d; });
    var TRY2 = Math.min(8, far.length);
    for (var c2 = 0; c2 < TRY2; c2++) {
      var t2 = far[c2].p.clone();
      world.resolve(t2, 0.5, 2.2);
      if (t2.distanceTo(far[c2].p) <= 0.55) return far[c2].p.clone();
    }
    if (far.length) return far[0].p.clone();
    return pts[(Math.random() * pts.length) | 0].clone();
  }

  function spawnEnemy(typeKey, at) {
    var pos = at ? at.clone() : findSpawnPoint();
    var e = new FPS.Enemy(pos, typeKey);
    scene.add(e.group);
    enemies.push(e);
    P.burst(new THREE.Vector3(pos.x, 1.1, pos.z), {
      count: 16, color: 'green', speed: 5.5, life: 0.55, size: 0.07, spread: 1.1
    });
    return e;
  }

  /* ===============================================================
     本波出生点分配
     -----------------------------------------------------------------
     以前每个敌人各自随机挑一个出生点，同屏十来个就会挤成几堆。
     这里在开波时一次性把整波的位置排好，保证：
       · 两两之间至少隔开 SPAWN_MIN_GAP（12 米），人是散开的；
       · 优先挑离玩家更远的点，不会在脸上刷；
       · 用波次号做种，同一关分布可复现（方便测试与调平衡）。
     =============================================================== */
  function makeRand(seed) {
    var s = (seed | 0) || 1;
    return function () {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  /** 给这一波 n 个敌人排出 n 个互相分散的出生点（循环取用，超出候选数为止） */
  function buildSpawnSlots(count, waveNo) {
    var pts = (world && world.spawnPoints) || [];
    if (!pts.length) return { take: function () { return null; } };
    var rnd = makeRand(waveNo * 7919 + 13);
    var avail = pts.slice();
    var slots = [];
    var usedZones = {};

    /* 均匀分布的关键：把活动空间切成 3×3 个区，同一波尽量每个区都有人，
       而不是 15 个人全从同一侧压过来（实测过：不分区会挤在一条线上）。 */
    function zoneOf(p) {
      var zx = p.x < -22 ? 0 : (p.x > 22 ? 2 : 1);
      var zz = p.z < 6 ? 0 : (p.z > 34 ? 2 : 1);
      return zz * 3 + zx;
    }

    while (slots.length < count) {
      /* 分散策略：只看"离已选点最近的那个距离"，挑这个距离最大的点
         （经典最远点采样）。不加距离偏好、不加分区扣分，
         因为在这个距离环里，唯一要紧的就是"彼此尽量远"。 */
      var pick = -1, bestGap = -Infinity;
      for (var i = 0; i < avail.length; i++) {
        var p = avail[i];
        var dPlayer = p.distanceTo(player.pos);
        /* 只在"看得见"的那一圈里挑：太远（>SPAWN_NEAR_MAX）等于没刷出来，太近会贴脸。 */
        if (dPlayer < SPAWN_NEAR_MIN || dPlayer > SPAWN_NEAR_MAX) continue;
        // 落在建筑/树包围盒里的位置不能用（否则敌人一出生就在建筑里 → 看着像卡住）
        if (FPS.World.insideModelBox && FPS.World.insideModelBox(p.x, p.z)) continue;
        var gap = Infinity;
        for (var j = 0; j < slots.length; j++) {
          var dd = p.distanceTo(slots[j]);
          if (dd < gap) gap = dd;
        }
        if (gap > bestGap) { bestGap = gap; pick = i; }
      }
      if (pick < 0) {                                  // 这一圈里没有可用点，退回不限距离
        for (var m = 0; m < avail.length; m++) {
          var p3 = avail[m];
          var g3 = Infinity;
          for (var n = 0; n < slots.length; n++) { var d3 = p3.distanceTo(slots[n]); if (d3 < g3) g3 = d3; }
          var s3 = p3.distanceTo(player.pos) + Math.min(g3, SPAWN_MIN_GAP);
          if (s3 > bestScore) { bestScore = s3; pick = m; }
        }
      }
      if (pick < 0) break;                             // 环内没有可用点：宁缺毋滥，不重复用点
      var chosen = avail[pick];
      usedZones[zoneOf(chosen)] = (usedZones[zoneOf(chosen)] || 0) + 1;
      slots.push(chosen);
      avail.splice(pick, 1);
    }
    if (!slots.length) slots.push(pts[0]);             // 兜底，绝不返回空
    /* take()：若分配到的点不够，**从剩下的候选里继续取**，而不是循环复用同一批
       （复用会让多出来的敌人挤在同一个点上，看起来完全不分散）。 */
    var nextId = 0;
    var used = {};
    for (var u = 0; u < slots.length; u++) used[slots[u].x + ':' + slots[u].z] = 1;
    return {
      take: function () {
        if (nextId < slots.length) return slots[nextId++].clone();
        for (var k = 0; k < avail.length; k++) {       // 还有没用过的点就继续用
          var q = avail[k];
          if (used[q.x + ':' + q.z]) continue;
          used[q.x + ':' + q.z] = 1;
          return q.clone();
        }
        return slots[(nextId++) % slots.length].clone();   // 实在没有了才复用
      }
    };
  }

  /**
   * 本关敌人组成（总数固定 WAVE_ENEMIES = 20）：
   *  · 每种已解锁的超级兵种 = min(SUPER_CAP, SUPER_BASE + floor((本关 - 解锁关) / 3))；
   *  · 其余全部用士兵补足，所以每关都是整整 30 个；
   *  · 第 1 关只有士兵，特殊兵种占比随关卡从 0% 平滑涨到 60%。
   */
  function waveComposition(n) {
    var unlocked = FPS.typesForWave(n);
    var list = [];
    var specials = 0;
    for (var i = 0; i < unlocked.length; i++) {
      var key = unlocked[i];
      if (key === 'soldier') continue;
      var t = FPS.EnemyTypes[key];
      var k = Math.min(SUPER_CAP, SUPER_BASE + Math.floor((n - t.intro) / 3));
      for (var j = 0; j < k; j++) list.push(key);
      specials += k;
    }
    var soldiers = Math.max(0, WAVE_ENEMIES - specials);
    for (var s = 0; s < soldiers; s++) list.push('soldier');
    return list;
  }

  /** 统计某个兵种在本关组成里的数量（供自检与提示使用） */
  function countInWave(list, key) {
    var c = 0;
    for (var i = 0; i < list.length; i++) if (list[i] === key) c++;
    return c;
  }

  /** "士兵 ×3 · 重装兵 ×1" 这样的简要描述 */
  function describeComposition(list) {
    var counts = {};
    for (var i = 0; i < list.length; i++) counts[list[i]] = (counts[list[i]] || 0) + 1;
    var parts = [];
    var order = FPS.EnemyOrder;
    for (var k = 0; k < order.length; k++) {
      var key = order[k];
      if (!counts[key]) continue;
      parts.push(FPS.EnemyTypes[key].name + ' ×' + counts[key]);
    }
    return parts.join(' · ');
  }

  function startWave(n) {
    wave = n;
    waveKilled = 0;
    waveScore = 0;
    var comp = waveComposition(n);
    waveQueue = comp.slice();
    waveTotal = comp.length;
    waveActive = true;
    wavePending = waveQueue.length;
    waveSpawned = 0;
    hideRoundCard();

    spawnSlots = buildSpawnSlots(comp.length, n);      // 整波位置先排好，保证分散

    clearSpawnTimers();
    /* 一次把本关敌人全部召唤出来（不再按 0.8 秒节奏一个一个放）。
       位置仍然是预先排好的分散点，各占一个。 */
    var slot;
    while (waveQueue.length && (slot = spawnSlots.take())) {
      spawnEnemy(waveQueue.shift(), slot);
    }
    wavePending = 0;
    waveSpawned = waveTotal;

    // 新兵种登场时明确提示
    var fresh = FPS.newTypesAtWave(n);
    var sub;
    if (fresh.length) {
      var names = [];
      for (var j = 0; j < fresh.length; j++) names.push(FPS.EnemyTypes[fresh[j]].name);
      sub = '新增兵种：' + names.join(' / ');
    } else {
      sub = n === 1 ? '敌军已在外圈展开' : '新一轮敌军抵达';
    }
    showBanner('第 ' + n + ' 关', sub);
    Sfx.waveStart();
    updateHUD();
  }

  function aliveCount() {
    var n = 0;
    for (var i = 0; i < enemies.length; i++) if (enemies[i].alive) n++;
    return n;
  }

  function waveCleared() {
    waveActive = false;
    var bonus = WAVE_CLEAR_BONUS * wave;
    var gained = waveScore;
    score += bonus;
    waveScore += bonus;
    player.heal(WAVE_HEAL);
    player.addAmmo(WAVE_AMMO);
    Sfx.waveClear();
    var bonusPop = showPop(bonus, ['关卡奖励'], 'bonus');
    fadeOutPop(bonusPop, 2400);

    if (wave >= TOTAL_WAVES) {
      victory();
      return;
    }

    showRoundCard({
      title: '第 ' + wave + ' 关 清空',
      score: gained,
      bonus: bonus,
      heal: WAVE_HEAL,
      ammo: WAVE_AMMO
    });
    waveClearDelay = 4.6;
    updateHUD();
  }

  /* ===============================================================
     回调
     =============================================================== */
  function onShoot(pos) {
    shotsFired++;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e.alive) continue;
      if (e.group.position.distanceTo(pos) < TROOP_HEAR) e.hear(pos);
    }
  }

  function onEnemyHit(enemy, part, res) {
    shotsHit++;
    if (res && res.dead) {
      kills++;
      waveKilled++;
      var head = part === 'head';
      if (head) headshots++;

      // 连杀：窗口内连续击杀会累加，飘字显示"连杀累计得分"与每一笔的明细
      streak++;
      streakTimer = STREAK_WINDOW;
      if (streak > bestStreak) bestStreak = streak;
      var bonus = streakBonus(streak);

      var base = Math.round((enemy.cfg ? enemy.cfg.score : SCORE_KILL) * (head ? 1.5 : 1));
      var gain = base + bonus;
      score += gain;
      waveScore += gain;
      streakScore += gain;

      Sfx.kill();
      showHitmarker(true);
      var who = enemy.typeName || '敌人';
      showStreakPop(streakScore, [
        '本击 ' + (head ? '爆头' : '击杀') + ' ' + who + ' +' + base,
        streak + ' 连杀 奖励 +' + bonus
      ]);
      if (streak === 3 || streak === 5 || streak === 8 || (streak >= 10 && streak % 5 === 0)) {
        showBanner(streak + ' 连杀', '连杀累计 +' + streakScore);
      }
      player.shake = Math.min(1, player.shake + 0.22);
      for (var i = 0; i < enemies.length; i++) {
        var o = enemies[i];
        if (o !== enemy && o.alive && o.group.position.distanceTo(enemy.group.position) < 16) {
          o.hear(enemy.group.position);
        }
      }
      updateHUD();
    } else {
      Sfx.hit();
      showHitmarker(false);
    }
  }

  function onDamagePlayer(amount, enemy) {
    if (state !== 'playing' || !player.alive) return;
    if (training || trainHold || (menuOpen && training)) return;   // 训练场不会被打死
    player.takeDamage(amount, enemy ? enemy.group.position : null);
    flashDamage(0.9);
    updateHUD();
    if (!player.alive) gameOver();
  }

  function onAlert(enemy) {
    // 训练场敌人是靶子：它们"发现玩家"不该一直响警报；全体停止时也不要出声
    if (training || trainHold) return;
    if (enemy.group.position.distanceTo(player.pos) < 30) Sfx.alert();
  }

  /* ===============================================================
     敌人方位条（compass）
     -----------------------------------------------------------------
     屏幕上方一条，把附近敌人的方位映射成红点：中间 = 正前方，两侧 = 左右。
     范围 COMPASS_RANGE 米内的才显示；越近越亮、越靠前越红（锁定中的显示为黄点）。
     =============================================================== */
  var COMPASS_RANGE = 60;        // 只显示这个距离内的敌人
  var COMPASS_SPAN = 240;        // 罗盘覆盖的角度范围（度）。超出部分贴边显示
  var compassDots = [];          // 复用的 DOM 点
  var _compassFwd = new THREE.Vector3();
  function updateCompass() {
    var wrap = el.cDots;
    if (!wrap) return;
    var live = [];
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e.alive) continue;
      var dx = e.group.position.x - player.pos.x;
      var dz = e.group.position.z - player.pos.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d > COMPASS_RANGE) continue;
      /* 敌人相对玩家朝向的方位角。
         直接用**相机的世界朝向**算（不要自己从 yaw 推 sin/cos —— 相机的欧拉角
         与 yaw 的对应关系容易搞反，之前就是这样导致罗盘左右/前后颠倒）。 */
      camera.getWorldDirection(_compassFwd);
      var fx = _compassFwd.x, fz = _compassFwd.z;
      var fl = Math.sqrt(fx * fx + fz * fz) || 1;
      fx /= fl; fz /= fl;
      var nx = dx / (d || 1), nz = dz / (d || 1);
      var dot = fx * nx + fz * nz;
      var cross = fx * nz - fz * nx;                 // >0 在右侧
      var ang = Math.atan2(cross, dot) * 180 / Math.PI;
      if (ang > 180) ang -= 360;
      if (ang < -180) ang += 360;
      var half = COMPASS_SPAN / 2;
      var clamped = Math.max(-half, Math.min(half, ang));
      if (Math.abs(ang) > half) clamped = ang > 0 ? half : -half;   // 贴边（背后的人）
      live.push({ x: (clamped / half) * 50 + 50, d: d, hot: !!e.lockedToPlayer });  // 百分比
    }
    // 需要的点不够就补 DOM（之后一直复用）
    while (compassDots.length < live.length) {
      var dot = document.createElement('i');
      wrap.appendChild(dot);
      compassDots.push(dot);
    }
    for (var k = 0; k < compassDots.length; k++) {
      var node = compassDots[k];
      if (k >= live.length) { if (node.style.display !== 'none') node.style.display = 'none'; continue; }
      var o = live[k];
      node.style.display = 'block';
      node.style.left = o.x.toFixed(1) + '%';
      // 越近越亮、越大
      var near = Math.max(0, 1 - o.d / COMPASS_RANGE);
      node.style.opacity = (0.35 + 0.65 * near).toFixed(2);
      node.style.transform = 'scale(' + (0.8 + 0.6 * near).toFixed(2) + ')';
      if (o.hot) node.classList.add('hot'); else node.classList.remove('hot');
    }
  }

  /* ===============================================================
     HUD
     =============================================================== */
  function updateHUD() {
    var hp = Math.max(0, Math.round(player.health));
    el.healthValue.textContent = hp;
    el.healthBar.style.width = Math.max(0, (hp / player.maxHealth) * 100) + '%';
    el.healthBar.className = hp <= 30 ? 'low' : (hp <= 60 ? 'mid' : '');
    el.healthValue.className = 'big' + (hp <= 30 ? ' low' : '');
    el.lowhp.classList.toggle('on', hp <= 35 && player.alive);

    el.scoreValue.textContent = score;
    el.waveScoreValue.textContent = waveScore;
    el.killsValue.textContent = kills;
    el.headshotValue.textContent = headshots;
    var alive = aliveCount();
    // 训练场没有关卡进度条（进度面板整体被菜单替换掉）
    if (!training) el.waveValue.textContent = wave;
    el.aliveValue.textContent = alive;
    if (streak < 1) el.streakPanel.classList.remove('show');

    // 关卡进度：已过关卡 + 本关已清敌人比例
    var frac = waveTotal > 0 ? Math.min(1, waveKilled / waveTotal) : 0;
    var overall = TOTAL_WAVES > 0 ? ((Math.max(0, wave - 1)) + frac) / TOTAL_WAVES : 0;
    el.stageBar.style.width = Math.max(0, Math.min(100, overall * 100)).toFixed(1) + '%';
    // 注意：只改子元素文本，别写父元素的 textContent（那会把子元素一起清掉）
    el.aliveValue.textContent = alive;
    el.stageCleared.textContent = training ? '' : '（已清 ' + waveKilled + ' / ' + waveTotal + '）';
    if (training) syncTrainMenu();

    var a = player.ammoText();
    el.ammoMag.textContent = a.mag;
    el.ammoMag.className = 'big' + (a.mag === 0 ? ' empty' : '');
    // 训练场子弹无限：备弹位显示 ∞，也不用提示换弹
    el.ammoReserve.textContent = (training && FPS.Training && FPS.Training.infiniteAmmo) ? '∞' : a.reserve;

    if (training && FPS.Training && FPS.Training.infiniteAmmo) {
      el.reloadHint.classList.remove('show', 'warn');
    } else if (a.reloading) {
      el.reloadHint.innerHTML = '换弹中…';
      el.reloadHint.classList.add('show');
      el.reloadHint.classList.remove('warn');
    } else if (a.mag < a.size && a.reserve > 0) {
      el.reloadHint.innerHTML = '按 <kbd>R</kbd> 换弹';
      el.reloadHint.classList.add('show');
      el.reloadHint.classList.remove('warn');
    } else if (a.reserve <= 0) {
      el.reloadHint.innerHTML = '没有备弹了';
      el.reloadHint.classList.add('show', 'warn');
    } else {
      el.reloadHint.classList.remove('show', 'warn');
    }
  }

  /**
   * 屏幕中心下方的得分飘字。
   * points：大字；lines：右侧小字（得分构成 + 连杀原因）
   */
  function showPop(points, lines, kind) {
    var d = document.createElement('div');
    d.className = 'pop' + (kind ? ' ' + kind : '');
    var html = '<span class="pts">+' + points + '</span>';
    if (lines && lines.length) {
      html += '<span class="detail">';
      for (var i = 0; i < lines.length; i++) html += '<span class="line">' + lines[i] + '</span>';
      html += '</span>';
    }
    d.innerHTML = html;
    el.scorePopups.appendChild(d);
    while (el.scorePopups.children.length > 3) el.scorePopups.removeChild(el.scorePopups.firstChild);
    return d;
  }

  function fadeOutPop(d, lifeMs) {
    setTimeout(function () {
      if (!d.parentNode) return;
      d.classList.add('fade');
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 700);
    }, lifeMs);
  }

  /**
   * 连杀飘字：始终复用同一个元素，分数在**同一条**上累加跳动。
   * 它的寿命完全跟随连杀时间条：随时间条变暗，时间条走完就一起消失；
   * 继续得分则重新点亮。
   */
  var streakPopEl = null;

  /** 清空连杀飘字引用（重开/返回主页时用，避免指向已被移除的节点） */
  function resetStreakPop() {
    streakPopEl = null;
  }

  function showStreakPop(points, lines) {
    if (!streakPopEl || !streakPopEl.parentNode) {
      streakPopEl = showPop(points, lines, 'streak');
    } else {
      streakPopEl.querySelector('.pts').textContent = '+' + points;
      var detail = streakPopEl.querySelector('.detail');
      if (detail) {
        var h = '';
        for (var i = 0; i < lines.length; i++) h += '<span class="line">' + lines[i] + '</span>';
        detail.innerHTML = h;
      }
      // 分数累加时做一个放大跳动
      var pts = streakPopEl.querySelector('.pts');
      pts.classList.remove('bump');
      void pts.offsetWidth;
      pts.classList.add('bump');
    }
    streakPopEl.style.opacity = '1';   // 继续得分 → 重新点亮
  }

  /** ratio = 剩余时间 / 总窗口：随时间条一起变暗 */
  function updateStreakPop(ratio) {
    if (!streakPopEl) return;
    streakPopEl.style.opacity = (0.22 + 0.78 * Math.max(0, Math.min(1, ratio))).toFixed(3);
  }

  /** 连杀窗口结束：与时间条同时消失 */
  function endStreakPop() {
    if (!streakPopEl) return;
    var node = streakPopEl;
    streakPopEl = null;
    node.style.opacity = '0';
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 340);
  }

  /** 连杀面板：从第 1 杀就出现，显示连杀累计得分 */
  function updateStreakHUD() {
    var on = streak >= 1;
    el.streakPanel.classList.toggle('show', on);
    if (!on) return;
    el.streakText.textContent = streak + ' 连杀';
    el.streakBonus.textContent = '累计 +' + streakScore + ' · 本击奖励 +' + streakBonus(streak);
    var pct = Math.max(0, Math.min(1, streakTimer / STREAK_WINDOW)) * 100;
    el.streakBar.style.width = pct.toFixed(0) + '%';
  }

  function showHitmarker(kill) {
    el.hitmarker.classList.remove('show', 'kill');
    void el.hitmarker.offsetWidth;
    el.hitmarker.classList.add('show');
    if (kill) el.hitmarker.classList.add('kill');
  }

  var damageLevel = 0;
  function flashDamage(v) { damageLevel = Math.max(damageLevel, v); }

  function showBanner(title, sub) {
    el.bannerTitle.textContent = title;
    el.bannerSub.textContent = sub || '';
    el.banner.classList.remove('show');
    void el.banner.offsetWidth;
    el.banner.classList.add('show');
  }

  /* ---------------- 回合结算卡片 ---------------- */
  function showRoundCard(d) {
    el.rcTitle.textContent = d.title;
    el.rcScore.textContent = d.score;
    el.rcBonus.textContent = '+' + d.bonus;
    el.rcHeal.textContent = '+' + d.heal;
    el.rcAmmo.textContent = '+' + d.ammo;
    el.rcNextText.textContent = '下一关准备中';
    el.rcBar.style.width = '0%';
    el.roundCard.classList.add('show');
  }

  function hideRoundCard() {
    el.roundCard.classList.remove('show');
  }

  /* ===============================================================
     界面：开始页 / 教程 / 设置 / 暂停 / 结算
     =============================================================== */
  /* 内联图标（不依赖任何外部资源） */
  var ICON = {
    play: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 5.4v13.2L18.8 12z" fill="currentColor" stroke="none"/></svg>',
    book: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.4A2.4 2.4 0 0 1 6.9 3H19v14.2H6.9a2.4 2.4 0 0 0 0 4.8H19"/><path d="M4.5 5.4v13.6"/></svg>',
    gear: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.6M12 18.6v2.6M4.6 12H2M22 12h-2.6M6.6 6.6 4.8 4.8M19.2 19.2l-1.8-1.8M17.4 6.6l1.8-1.8M4.8 19.2l1.8-1.8"/></svg>',
    exit: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h8.5"/></svg>',
    back: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>',
    target: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.4"/><path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3"/></svg>'
  };

  var KEY_ROWS =
    '<div class="keyRow"><span class="keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span class="desc">移动</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>鼠标</kbd></span><span class="desc">瞄准视角</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>左键</kbd></span><span class="desc">射击（按住连发）</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>右键</kbd></span><span class="desc">开镜 / 收镜（点一下切换）</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>R</kbd></span><span class="desc">换弹</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>F</kbd></span><span class="desc">检视枪械</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>Shift</kbd></span><span class="desc">冲刺（可跑跳）</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>空格</kbd></span><span class="desc">跳跃</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>Esc</kbd></span><span class="desc">暂停菜单</span></div>' +
    '<div class="keyRow"><span class="keys"><kbd>M</kbd></span><span class="desc">静音开关</span></div>';

  /** 设置项（开始页与暂停菜单共用同一份内容） */
  /* 画面设置：可调项（key 与 postfx.js 的 LOOK_KEYS 一一对应） */
  var LOOK_ROWS = [
    { k: 'sat',      n: '饱和度',        min: 0.4,  max: 2.0, step: 0.02 },
    { k: 'contrast', n: '对比度',        min: 0.6,  max: 1.6, step: 0.02 },
    { k: 'exposure', n: '亮度（曝光）',  min: 0.5,  max: 2.0, step: 0.02 },
    { k: 'vignette', n: '暗角',          min: 0.0,  max: 1.0, step: 0.02 },
    { k: 'tilt',     n: '移轴景深',      min: 0.0,  max: 1.0, step: 0.02 },
    { k: 'focusH',   n: '清晰范围',      min: 0.05, max: 0.9, step: 0.01 },
    { k: 'ca',       n: '色差（彩边）',  min: 0.0,  max: 1.0, step: 0.02 },
    { k: 'flat',     n: '平涂（色块化）', min: 0.0, max: 1.0, step: 0.02 },
    { k: 'levels',   n: '色阶数',        min: 3,    max: 24,  step: 1 },
    { k: 'bloom',    n: '泛光强度',      min: 0.0,  max: 3.0, step: 0.05 },
    { k: 'rays',     n: '光束强度',      min: 0.0,  max: 2.0, step: 0.05 },
    { k: 'dither',   n: '抖动（噪点源）', min: 0.0, max: 1.0, step: 0.02 }
  ];

  var LOOK_PRESET_CN = { toy: '玩具微缩', clean: '干净写实', cinematic: '电影感', night: '夜景', anime: '动画平涂' };

  /* 每张地图的默认画面预设由 world.js 的 MAPS[x].look 决定（单一来源）。
     这里只声明"未知地图"的兜底值。 */
  var LOOK_FALLBACK = 'toy';

  /** 取当前地图的画面设置存档槽 { look: 预设名, over: {参数} } */
  function mapLookSlot() {
    settings.lookByMap = settings.lookByMap || {};
    var id = currentMapId();
    if (!settings.lookByMap[id]) settings.lookByMap[id] = {};
    return settings.lookByMap[id];
  }

  function currentMapId() { return (FPS.World && FPS.World.mapId) || 'arena'; }

  /** 按"当前地图自己的存档"应用画面（预设 + 该图的微调值） */
  function applyMapLook() {
    if (!postfx) return null;
    var slot = mapLookSlot();
    var preset = slot.look
      || ((FPS.World && FPS.World.look) ? FPS.World.look() : null)
      || LOOK_FALLBACK;
    postfx.overrides = {};
    var over = slot.over || {};
    Object.keys(over).forEach(function (k) { if (typeof over[k] === 'number') postfx.overrides[k] = over[k]; });
    postfx.applyLook(preset);
    return preset;
  }

  function fmtLookVal(k, v) {
    if (k === 'levels') return String(Math.round(v));
    if (k === 'flat' || k === 'dither') return (v <= 0.001 ? '关' : v.toFixed(2));
    return (+v).toFixed(2);
  }

  /** 横向预设菜单栏：所有预设一次性列出来，当前生效的高亮 */
  function lookPresetBarHTML() {
    var cur = (postfx && postfx.lookName) || 'toy';
    var names = Object.keys((postfx && postfx.LOOKS) || { toy: 1, clean: 1, cinematic: 1, night: 1, anime: 1 });
    var chips = names.map(function (k) {
      var on = (k === cur);
      return '<div class="lookChip" data-look="' + k + '" style="' +
        'padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;' +
        'border:1px solid ' + (on ? 'rgba(53,224,255,.85)' : 'rgba(130,190,255,.35)') + ';' +
        'background:' + (on ? 'rgba(53,224,255,.22)' : 'rgba(40,70,110,.45)') + ';' +
        'color:' + (on ? '#eaffff' : '#dbe7f5') + ';font-weight:' + (on ? '700' : '400') + '">' +
        (LOOK_PRESET_CN[k] || k) + '</div>';
    }).join('');
    return '<div class="setRow" style="align-items:flex-start">' +
      '<span class="name">画面预设</span>' +
      '<div id="lookBar" style="display:flex;flex-wrap:wrap;gap:8px;flex:1">' + chips + '</div>' +
      '<span class="val" style="width:auto" id="lookMapTag">' + currentMapId() + '</span></div>' +
      '<div class="setHint">预设是<b>逐地图独立</b>的：在这里改只影响当前地图（<b id="lookMapTag2">' + currentMapId() +
      '</b>），完全退出后下次进入仍然是这套。' +
      '当前地图默认：竞技场「动画平涂」、训练场「夜景」。' +
      '<br>带「平涂」的预设（玩具微缩 / 动画平涂）会把颜色量化成色块，在空旷场景会留下细网点 —— ' +
      '若在训练场觉得有噪点，把下面的「抖动」调到 0，或换成「夜景 / 干净写实」。</div>';
  }

  function lookRowsHTML() {
    var p = (postfx && postfx.params) ? postfx.params() : null;
    var out = lookPresetBarHTML();
    if (!p) return out + '<div class="setHint">后期处理未就绪</div>';
    LOOK_ROWS.forEach(function (r) {
      out += '<div class="setRow"><span class="name">' + r.n + '</span>' +
        '<input type="range" id="look_' + r.k + '" min="' + r.min + '" max="' + r.max + '" step="' + r.step +
        '" value="' + p[r.k] + '">' +
        '<span class="val" id="look_' + r.k + 'Val">' + fmtLookVal(r.k, p[r.k]) + '</span></div>';
    });
    out += '<div class="setHint">「抖动」是画面噪点的唯一来源：<b>关（0）</b> 最干净；' +
      '调大它能减轻色块之间的渐变断层（色带），代价是细颗粒。</div>';
    out += '<div class="setRow"><span class="name">恢复本图默认</span>' +
      '<div class="switch" id="setLookReset" style="width:auto;padding:0 14px">重置</div>' +
      '<span class="val" style="width:auto"></span></div>';
    if (FPS.Save) {
      out += '<div class="setHint">存档位置：<b>' +
        (FPS.Save.mode === 'file' ? ((FPS.Save.dir || '游戏目录') + '\\saves\\') : '浏览器 localStorage（调试模式）') +
        '</b> —— 存档只写入游戏文件夹。</div>';
    }
    return out;
  }

  function settingsRowsHTML() {
    return '<div class="sect">' +
      '<div class="setRow"><span class="name">鼠标灵敏度</span>' +
        '<input type="range" id="setSens" min="0.4" max="3" step="0.1" value="' + settings.sens + '">' +
        '<span class="val" id="setSensVal">' + settings.sens.toFixed(1) + '</span></div>' +
      '<div class="setRow"><span class="name">音量</span>' +
        '<input type="range" id="setVolume" min="0" max="100" step="5" value="' + settings.volume + '">' +
        '<span class="val" id="setVolumeVal">' + settings.volume + '</span></div>' +
      '<div class="setRow"><span class="name">全屏</span>' +
        '<div class="switch' + (settings.fullscreen ? ' on' : '') + '" id="setFullscreen"></div>' +
        '<span class="val" id="setFullscreenVal" style="width:auto">' + (settings.fullscreen ? '开' : '关') + '</span></div>' +
      '<div class="setRow"><span class="name">阴影</span>' +
        '<div class="switch' + (settings.shadows ? ' on' : '') + '" id="setShadows"></div>' +
        '<span class="val" id="setShadowsVal" style="width:auto">' + (settings.shadows ? '开' : '关') + '</span></div>' +
      '<div class="setHint">鼠标右键：点一下开镜、再点一下收镜 —— 开镜时视野按 HUD 显示的倍率放大、准星完全无扩散，' +
        '移动速度与跳跃都不受影响。</div>' +
    '</div>' +
    /* ---------------- 画面设置 ---------------- */
    '<div class="sect"><div class="sectTitle">画面设置</div>' + lookRowsHTML() + '</div>';
  }

  function showMenu(tab) {
    if (world && world.group) world.group.visible = false;   // 主页只留星空当背景
    state = 'menu';
    hideRoundCard();
    el.keyHints.classList.remove('show');
    el.hud.classList.add('hud-off');     // 开始页只留场景，更干净
    if (world) world.setBackdropOnly(true);   // 开始页背景 = 深色星空（上一版效果）
    el.overlay.classList.remove('hidden');
    el.overlayCard.classList.toggle('bare', tab !== 'tutorial' && tab !== 'settings');
    if (tab === 'tutorial') el.overlayCard.innerHTML = tutorialHTML();
    else if (tab === 'settings') el.overlayCard.innerHTML = settingsHTML();
    else el.overlayCard.innerHTML = menuHTML();
    wireOverlay();
    updateHUD();
  }

  function menuHTML() {
    return '<div id="menuWrap">' +
        '<div class="brand">' +
          '<h1>霓虹<span class="accent">突袭</span></h1>' +
          '<div class="en">NEON STRIKE</div>' +
          '<div class="sub">3D 第一人称射击 · 共 ' + TOTAL_WAVES + ' 关</div>' +
          '<div class="rule"></div>' +
        '</div>' +
        '<div class="iconRail">' +
          '<div class="iconItem primary" id="btnStart">' + ICON.play + '<span>开始游戏</span></div>' +
          '<div class="iconItem" id="btnTraining">' + ICON.target + '<span>训练场</span></div>' +
          '<div class="iconItem" id="btnTutorial">' + ICON.book + '<span>游戏教程</span></div>' +
          '<div class="iconItem" id="btnSettings">' + ICON.gear + '<span>游戏设置</span></div>' +
          (shellMode ? '<div class="iconItem danger" id="btnExit">' + ICON.exit + '<span>退出游戏</span></div>' : '') +
        '</div>' +
        '<div class="menuTip">进入游戏会自动全屏并锁定鼠标 · 按 Esc 暂停 · 训练场无关卡、子弹无限、敌人不会攻击</div>' +
      '</div>';
  }

  function tutorialHTML() {
    return '<div class="iconBtn left" id="btnBack">' + ICON.back + '</div>' +
      '<h2>游戏教程</h2>' +
      '<div class="sub">操作方式</div>' +
      '<div class="sect"><div class="keyGrid">' + KEY_ROWS + '</div></div>' +
      '<div class="sect">' +
        '<div class="sectTitle">玩法说明</div>' +
        '<div class="bullets">' +
          '<div class="bullet"><b>两种模式</b>：主页的<b>开始游戏</b>进入竞技场（124×124 米的彩色户外场地：红砖建筑、集装箱码头、天桥、中央阶梯高台、树林与岩石），' +
            '共 ' + TOTAL_WAVES + ' 关；<b>训练场</b>在原来的太空站里，<b>无关卡、子弹无限</b>，场上固定 5 个随机兵种，' +
            '清空后自动再刷一轮，里面的敌人<b>只会走动、不会攻击</b>。</div>' +
          '<div class="bullet"><b>训练场菜单</b>：按 <b>Alt</b> 解锁鼠标（屏幕左下会显示这条提示）→ 用左上角「训练场」菜单让敌人<b>全部停止 / 全部移动</b>、' +
            '<b>清空所有敌人</b>，或点某个兵种按钮直接把它加进地图。再按一次 <b>Alt</b> 回到游戏。<b>鼠标解锁期间除了菜单，其它操作一律不响应</b>。</div>' +
          '<div class="bullet"><b>目标</b>：一共 ' + TOTAL_WAVES + ' 关，清空每关的全部敌人即过关，全部通关即胜利。</div>' +
          '<div class="bullet"><b>敌人数量</b>：每关固定 ' + WAVE_ENEMIES + ' 个敌人，<b>开局一次性全部出现</b> —— 都刷在离你 60~95 米的场地外圈，' +
            '彼此间隔 18 米以上，站得很散（也不会刷在建筑里）。一关之内不会再有增援。</div>' +
          '<div class="bullet"><b>索敌名额</b>：士兵同时最多只有 <b>6 个</b>能锁定你并开枪，名额满了的士兵发现你也<b>不射激光</b>，只会冲上来近身攻击；' +
            '<b>特殊兵种不受这个限制</b>，发现你就会开火。</div>' +
          '<div class="bullet"><b>敌人感知</b>：视野 30 米、约 165 度，贴到 10 米内无视朝向必被发现；追丢后会去搜索你最后出现的位置，' +
            '约 11 秒才放弃。另外敌人会<b>报点</b>：一个发现你，附近 45 米内的队友都会一起警戒压上来。</div>' +
          '<div class="bullet"><b>伤害</b>：你的步枪躯干 26、爆头 52（双倍）、打腿 20（七五折），普通敌人 100 点生命 —— 躯干 4 枪、爆头 2 枪。</div>' +
          '<div class="bullet"><b>得分</b>：普通敌人击杀 +100、爆头击杀 +150（重装/指挥官等高血量兵种分更高），每关清空额外奖励 60 × 关数；' +
            '短时间（2.5 秒）内连续击杀还有额外奖励，会累加在同一个飘字里。</div>' +
          '<div class="bullet"><b>过关奖励</b>：清空一关后恢复 ' + WAVE_HEAL + ' 点生命并补给 ' + WAVE_AMMO + ' 发备弹（结算卡片会显示）。</div>' +
          '<div class="bullet"><b>枪声</b>：开火会惊动 ' + TROOP_HEAR + ' 米内的敌人，想摸过去就别乱开枪。</div>' +
          '<div class="bullet"><b>开镜</b>：点一下鼠标右键举枪、再点一下收枪。举枪时视野放大（HUD 会显示当前倍率）、准星完全不扩散，' +
            '<b>移速与跳跃都不受影响</b>；举枪时移动鼠标的灵敏度会按倍率同比降低，方便精细瞄准。</div>' +
          '<div class="bullet"><b>换弹</b>：按 R 换弹（约 1.55 秒）。换弹时枪会抬到画面左上方，方便你看清整套动作：左手离开护木取出新弹匣 → 插入 → 拍一下弹匣底 → 右手拉拉机柄上膛。换弹期间不能开火。</div>' +
          '<div class="bullet"><b>检视</b>：按 F 抬起枪看整条枪身侧面（约 9 秒的纯观赏动作）。开火 / 换弹 / 开镜都会立刻打断它。</div>' +
          '<div class="bullet"><b>激光</b>：远程敌人用激光攻击，开火前会先亮起一道红色瞄准线 —— 看到线就<b>横向跑开</b>（掩体挡不住，见下）。' +
            '<b>激光会穿墙</b>：躲在墙后、集装箱后并不能挡住激光，只有离开那条瞄准线才躲得掉；狙击兵射程远、伤害高，瞄准线停留也更久。</div>' +
          '<div class="bullet"><b>方位条</b>：屏幕最上方那条是敌人方位条，显示 60 米内的敌人：<b>中点就是你的正前方</b>，' +
            '点在左右两侧表示敌人在你左/右，越靠两端越接近你背后，点越大越亮表示越近。<b>黄色的点正在锁定你</b>。</div>' +
          '<div class="bullet"><b>地形</b>：场地里有矮箱、水泥块、立柱和集装箱，矮箱可以跳上去取得高度优势（注意：<b>激光无视掩体</b>，换位置比躲墙后面靠谱）。</div>' +
        '</div>' +
      '</div>' +
      unitTableHTML() +
      '<div class="creditLine">武器：QBZ-191（模型由本项目工具从玩家提供的模型处理而来，详见 web/models/CREDITS.txt）</div>';
  }

  /** 兵种图鉴（教程页用）：按解锁关卡列出全部兵种与能力 */
  function unitTableHTML() {
    var order = FPS.EnemyOrder;
    var rows = '';
    for (var i = 0; i < order.length; i++) {
      var t = FPS.EnemyTypes[order[i]];
      rows += '<div class="unitRow">' +
        '<span class="unitWave">第 ' + t.intro + ' 关</span>' +
        '<span class="unitName">' + t.name + '</span>' +
        '<span class="unitDesc">' + (t.desc || '') + '</span>' +
        '</div>';
    }
    return '<div class="sect"><div class="sectTitle">兵种图鉴（逐关解锁）</div><div class="units">' + rows + '</div></div>';
  }

  function settingsHTML() {    return '<div class="iconBtn left" id="btnBack">' + ICON.back + '</div>' +
      '<h2>游戏设置</h2>' +
      '<div class="sub">设置会自动保存，下次打开仍然生效</div>' +
      settingsRowsHTML();
  }

  /** 给当前 overlay 内容绑定事件 */
  function wireOverlay() {
    var b;
    if ((b = $('btnStart'))) b.onclick = function () { Sfx.init(); Sfx.resume(); Sfx.ui(); startGame('arena'); };
    if ((b = $('btnTraining'))) b.onclick = function () { Sfx.init(); Sfx.resume(); Sfx.ui(); startGame('training'); };
    if ((b = $('btnTutorial'))) b.onclick = function () { Sfx.ui(); showMenu('tutorial'); };
    if ((b = $('btnSettings'))) b.onclick = function () { Sfx.ui(); showMenu('settings'); };
    if ((b = $('btnExit'))) b.onclick = function () { Sfx.ui(); exitGame(); };
    if ((b = $('btnBack'))) b.onclick = function () { Sfx.ui(); showMenu('main'); };
    if ((b = $('btnResume'))) b.onclick = function () { Sfx.ui(); resumeGame(); };
    if ((b = $('btnRestart'))) b.onclick = function () { Sfx.ui(); startGame(); };
    if ((b = $('btnHome'))) b.onclick = function () { Sfx.ui(); goHome(); };
    if ((b = $('btnAgain'))) b.onclick = function () { Sfx.ui(); startGame(); };
    // 暂停菜单：右上角设置图标 → 设置面板（内容与开始页设置完全一致）
    if ((b = $('btnPauseSettings'))) b.onclick = function () { Sfx.ui(); showPauseSettings(); };
    if ((b = $('btnPauseBack'))) b.onclick = function () { Sfx.ui(); showPause(); };
    if ((b = $('btnPauseBackBtn'))) b.onclick = function () { Sfx.ui(); showPause(); };

    var sens = $('setSens');
    if (sens) {
      sens.oninput = function () {
        settings.sens = parseFloat(sens.value);
        $('setSensVal').textContent = settings.sens.toFixed(1);
        player.sensitivity = settings.sens;
        saveSettings();
      };
    }
    var vol = $('setVolume');
    if (vol) {
      vol.oninput = function () {
        settings.volume = parseInt(vol.value, 10);
        $('setVolumeVal').textContent = settings.volume;
        Sfx.setVolume(settings.volume / 100);
        saveSettings();
      };
      vol.onchange = function () { Sfx.ui(); };
    }
    var fs = $('setFullscreen');
    if (fs) {
      fs.onclick = function () {
        settings.fullscreen = !settings.fullscreen;
        wantFullscreen = settings.fullscreen;
        saveSettings();
        Sfx.ui();
        if (settings.fullscreen) enterFullscreen(); else exitFullscreen();
        syncSettingsUI();
      };
    }
    var sh = $('setShadows');
    if (sh) {
      sh.onclick = function () {
        settings.shadows = !settings.shadows;
        sh.classList.toggle('on', settings.shadows);
        $('setShadowsVal').textContent = settings.shadows ? '开' : '关';
        saveSettings();
        Sfx.ui();
        applyShadows();
      };
    }

    /* ---------------- 画面设置：横向预设栏 + 全部参数实时调节 ---------------- */
    if (postfx) {
      var bar = $('lookBar');
      if (bar) {
        var chips = bar.querySelectorAll('.lookChip');
        for (var ci = 0; ci < chips.length; ci++) {
          chips[ci].onclick = function () {
            var k = this.getAttribute('data-look');
            if (!k) return;
            mapLookSlot().look = k;         // 只写进"当前地图"的槽位
            postfx.applyLook(k);
            saveSettings();
            syncLookUI();
            Sfx.ui();
          };
        }
      }
      LOOK_ROWS.forEach(function (r) {
        var inp = $('look_' + r.k);
        if (!inp) return;
        inp.oninput = function () {
          var v = parseFloat(inp.value);
          postfx.setParam(r.k, v);
          var lab = $('look_' + r.k + 'Val');
          if (lab) lab.textContent = fmtLookVal(r.k, v);
          var slot = mapLookSlot();
          slot.over = slot.over || {};
          slot.over[r.k] = v;               // 微调值也只存进"当前地图"
          saveSettings();
        };
        inp.onchange = function () { Sfx.ui(); };
      });
      var rst = $('setLookReset');
      if (rst) {
        rst.onclick = function () {
          var slot = mapLookSlot();
          delete slot.look;
          delete slot.over;
          postfx.clearOverrides();
          saveSettings();
          applyMapLook();
          syncLookUI();
          Sfx.ui();
        };
      }
    }
  }

  /** 刷新画面设置面板：滑杆取值 + 预设高亮（切预设/重置后调用，不重画面板） */
  function syncLookUI() {
    if (!postfx || !postfx.params) return;
    var p = postfx.params();
    LOOK_ROWS.forEach(function (r) {
      var inp = $('look_' + r.k);
      if (inp) inp.value = p[r.k];
      var lab = $('look_' + r.k + 'Val');
      if (lab) lab.textContent = fmtLookVal(r.k, p[r.k]);
    });
    var bar = $('lookBar');
    if (bar) {
      var chips = bar.querySelectorAll('.lookChip');
      for (var i = 0; i < chips.length; i++) {
        var on = (chips[i].getAttribute('data-look') === postfx.lookName);
        chips[i].style.borderColor = on ? 'rgba(53,224,255,.85)' : 'rgba(130,190,255,.35)';
        chips[i].style.background = on ? 'rgba(53,224,255,.22)' : 'rgba(40,70,110,.45)';
        chips[i].style.color = on ? '#eaffff' : '#dbe7f5';
        chips[i].style.fontWeight = on ? '700' : '400';
      }
    }
  }

  function showPause() {
    el.overlay.classList.remove('hidden');
    el.overlayCard.classList.remove('bare');
    el.overlayCard.innerHTML =
      '<div class="iconBtn" id="btnPauseSettings">' + ICON.gear + '</div>' +
      '<h2>已暂停</h2>' +
      '<div class="sub">第 ' + wave + ' 关 · 总得分 ' + score + ' · 本关得分 ' + waveScore + '</div>' +
      '<div class="sect"><div class="sectTitle">操作方式</div><div class="keyGrid">' + KEY_ROWS + '</div></div>' +
      '<div style="margin-top:22px">' +
        '<div class="btn" id="btnResume">继续游戏</div>' +
        '<div class="btn ghost" id="btnRestart">重新开始</div>' +
        '<div class="btn ghost" id="btnHome">返回主页面</div>' +
      '</div>';
    wireOverlay();
  }

  /** 暂停菜单里的设置（内容与开始页设置一致） */
  function showPauseSettings() {
    el.overlay.classList.remove('hidden');
    el.overlayCard.classList.remove('bare');
    el.overlayCard.innerHTML =
      '<div class="iconBtn left" id="btnPauseBack">' + ICON.back + '</div>' +
      '<h2>游戏设置</h2>' +
      '<div class="sub">设置会自动保存</div>' +
      settingsRowsHTML() +
      '<div style="margin-top:20px"><div class="btn" id="btnPauseBackBtn">返回</div></div>';
    wireOverlay();
  }

  function resultHTML(title, subtitle, cls) {
    var acc = shotsFired > 0 ? Math.round((shotsHit / shotsFired) * 100) : 0;
    return '<h2 class="' + cls + '">' + title + '</h2>' +
      '<div class="sub">' + subtitle + '</div>' +
      '<div class="resultGrid">' +
      '<div class="cell gold"><div class="k">总得分</div><div class="v">' + score + '</div></div>' +
      '<div class="cell"><div class="k">击杀</div><div class="v">' + kills + '</div></div>' +
      '<div class="cell"><div class="k">爆头</div><div class="v">' + headshots + '</div></div>' +
      '<div class="cell"><div class="k">最高连杀</div><div class="v">' + bestStreak + '</div></div>' +
      '<div class="cell"><div class="k">到达关卡</div><div class="v">第 ' + wave + ' 关</div></div>' +
      '<div class="cell"><div class="k">命中率</div><div class="v">' + acc + '%</div></div>' +
      '</div>' +
      '<div style="margin-top:18px">' +
        '<div class="btn" id="btnAgain">再来一局</div>' +
        '<div class="btn ghost" id="btnHome">返回主页面</div>' +
      '</div>' +
      '<div class="tip">按 <kbd>回车</kbd> 也可以直接重开。</div>';
  }

  function showGameOver() {
    el.overlay.classList.remove('hidden');
    el.overlayCard.classList.remove('bare');
    el.overlayCard.innerHTML = resultHTML('任务失败', '你在第 ' + wave + ' 关被击倒', 'warn');
    wireOverlay();
  }

  function showVictory() {
    el.overlay.classList.remove('hidden');
    el.overlayCard.classList.remove('bare');
    el.overlayCard.innerHTML = resultHTML('恭喜通关', '你清空了全部 ' + TOTAL_WAVES + ' 关', 'win');
    wireOverlay();
  }

  /* ===============================================================
     流程控制
     =============================================================== */
  function clearEnemies() {
    clearSpawnTimers();
    waveQueue.length = 0;
    for (var i = 0; i < enemies.length; i++) {
      scene.remove(enemies[i].group);
      enemies[i].group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    }
    enemies.length = 0;
    if (FPS.resetLocks) FPS.resetLocks();     // 锁敌名额一起清空
    P.clear();
  }

  function clearSpawnTimers() {
    for (var i = 0; i < spawnTimers.length; i++) clearInterval(spawnTimers[i]);
    spawnTimers.length = 0;
  }

  /** 从出场队列里放一个敌人；场上满员则返回 false（等下一拍再试） */
  function spawnFromQueue() {
    if (!waveQueue.length) return false;
    if (enemies.length >= MAX_ALIVE) return false;
    var typeKey = waveQueue.shift();
    wavePending = waveQueue.length;
    waveSpawned++;
    spawnEnemy(typeKey, spawnSlots ? spawnSlots.take() : null);
    return true;
  }

  /* ===============================================================
     训练场：刷怪 / 菜单 / 鼠标解锁
     =============================================================== */

  /** 关掉全部敌人（训练场清空按钮用） */
  function clearAllEnemies() {
    clearSpawnTimers();
    waveQueue.length = 0;
    wavePending = 0;
    for (var i = 0; i < enemies.length; i++) {
      scene.remove(enemies[i].group);
      enemies[i].group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    }
    enemies.length = 0;
    P.clear();
  }

  /** 随机挑一种已解锁兵种 */
  function randomTypeKey() {
    var order = FPS.EnemyOrder || [];
    var pool = [];
    for (var i = 0; i < order.length; i++) {
      var t = FPS.EnemyTypes[order[i]];
      if (t && t.intro <= TOTAL_WAVES) pool.push(order[i]);
    }
    if (!pool.length) return 'soldier';
    return pool[(Math.random() * pool.length) | 0];
  }

  /**
   * 往地图上加 n 个随机兵种。
   * 注意：手动添加必须**立刻出场**，不能只丢进队列等 0.8 秒的出场节奏
   * —— 玩家点一下却没反应会以为按钮坏了。（自动开新轮才走队列慢慢铺开）
   */
  function trainSpawn(n) {
    if (!spawnSlots) spawnSlots = buildSpawnSlots(Math.max(trainRound, 8), 1);
    for (var i = 0; i < n; i++) { waveQueue.push(randomTypeKey()); trainSpawned++; }
    wavePending = waveQueue.length;
    spawnFromQueue();
    return waveQueue.length;
  }

  /** 手动添加**指定兵种**：立刻出场 */
  function trainAddType(key) {
    if (!key || !FPS.EnemyTypes[key]) return 0;
    if (!spawnSlots) spawnSlots = buildSpawnSlots(Math.max(trainRound, 8), 1);
    waveQueue.push(key);
    trainSpawned++;
    wavePending = waveQueue.length;
    spawnFromQueue();
    return waveQueue.length;
  }

  /** 清空后重新开一轮 */
  function trainRestartRound() {
    trainClearing = false;
    trainSpawned = 0;
    trainSpawn(trainRound);
    showBanner('新的一轮', '已刷新 ' + trainRound + ' 个敌人');
  }

  /** 全体停止 / 恢复移动 */
  function trainSetHold(v) {
    trainHold = !!v;
    syncTrainMenu();
  }

  /** 左上角菜单：按 Alt 解锁鼠标后使用 */
  function buildTrainMenu() {
    if (trainBound || !el.trainMenu) return;
    trainBound = true;
    var grid = $('tmTypes');
    if (grid) {
      var order = FPS.EnemyOrder || [];
      for (var i = 0; i < order.length; i++) {
        (function (key) {
          var t = FPS.EnemyTypes[key];
          if (!t) return;
          var b = document.createElement('button');
          b.className = 'tmBtn';
          b.id = 'tmAdd_' + key;
          b.innerHTML = t.name + '<span class="tmNum">第' + t.intro + '关</span>';
          b.title = t.desc || '';
          b.onclick = function (e) {
            e.preventDefault();
            e.stopPropagation();
            trainAddType(key);
            syncTrainMenu();
            Sfx.ui();
          };
          grid.appendChild(b);
        })(order[i]);
      }
    }
    var bh = $('tmHold'), bm = $('tmMove'), bc = $('tmClear');
    if (bh) bh.onclick = function (e) {
      e.preventDefault(); e.stopPropagation();
      trainSetHold(true); Sfx.ui(); showBanner('敌人已停止', '按「全部移动」恢复');
    };
    if (bm) bm.onclick = function (e) {
      e.preventDefault(); e.stopPropagation();
      trainSetHold(false); Sfx.ui();
    };
    if (bc) bc.onclick = function (e) {
      e.preventDefault(); e.stopPropagation();
      trainClearing = true;
      clearAllEnemies();
      syncTrainMenu();
      Sfx.ui();
      showBanner('已清空', '再加敌人，或等下一轮自动刷新');
    };
  }

  /** 刷新菜单上的数字与按钮高亮 */
  function syncTrainMenu() {
    if (!el.trainMenu) return;
    var a = $('tmAlive'); if (a) a.textContent = aliveCount();
    var r = $('tmRound'); if (r) r.textContent = trainRound;
    var bh = $('tmHold'), bm = $('tmMove');
    if (bh) bh.className = 'tmBtn' + (trainHold ? ' on' : '');
    if (bm) bm.className = 'tmBtn' + (trainHold ? '' : ' on');
  }

  /* ---- 鼠标解锁状态（只有训练场会用到） ---- */
  function setTrainMenu(on) {
    on = !!on;
    if (on === menuOpen) return;
    menuOpen = on;
    if (el.hud) el.hud.classList.toggle('menu-open', on);
    if (on) {
      input.firing = false;
      input.aim = false;
      input.forward = input.back = input.left = input.right = false;
      input.jump = false; input.sprint = false;
      syncTrainMenu();
    }
  }

  /** Alt：呼出鼠标 / 回到游戏 */
  function toggleTrainMenu() {
    if (!training || state !== 'playing') return false;
    if (menuOpen) {
      setTrainMenu(false);
      requestPointerLock();
      setTimeout(function () { if (state === 'playing' && !menuOpen) requestPointerLock(); }, 250);
      markActivity();
    } else {
      setTrainMenu(true);
      releaseLock();
    }
    return true;
  }

  function selectMap(id) {
    if (currentMap === id && world && world.group) return;
    // 先把玩家和敌人挪出旧地图，再清空容器（几何/材质/灯光/实例全部释放）
    if (FPS.World.clearMap) FPS.World.clearMap();
    FPS.World.setMap(id);
    world = FPS.World.build(scene, renderer);
    // 建好新地图之后再把"属于这张地图"的实例挂回去（隐藏别的地图的实例）
    // ⚠ 这一句**不是开发者模式专属**：syncMapItems 会按当前地图重建碰撞表
    //   （把别的地图的实例从 BVH_ITEMS 里摘掉）。删了它 = 切到训练场后
    //   竞技场那 798 个建筑还在碰撞表里，玩家会撞到"空气建筑"。
    if (FPS.DevMode && FPS.DevMode.syncMapItems) FPS.DevMode.syncMapItems();
    currentMap = id;
    // 非对局状态下新地图默认隐藏；startGame 里会显式打开（它一定在 selectMap 之后执行）
    world.group.visible = (state === 'playing');
    // 玩家与敌人拿的是旧 world 引用，重建后必须换掉
    player.ctx.world = world;
    player.pos.copy(world.playerStart);
    for (var i = 0; i < enemies.length; i++) if (enemies[i].ctx) enemies[i].ctx.world = world;
    // 画面设置也是"逐地图独立"的：换图后套用这张图自己的预设与微调
    applyMapLook();
    if (typeof syncLookUI === 'function') syncLookUI();
  }

  function startGame(mapId) {
    // 全屏请求要放在用户手势的同一个任务里，越早越可靠
    fsRetryPending = false;
    fsRetryCount = 0;
    if (settings.fullscreen) { wantFullscreen = true; enterFullscreen(); }
    // 训练场：原来的太空站 + 敌人不攻击
    selectMap(mapId === 'training' ? 'station' : 'arena');
    if (world && world.group) world.group.visible = true;   // 开局必须把地图显示出来（第一次进游戏也要）
    FPS.World.passiveEnemies = (mapId === 'training');
    // 训练场：无关卡、子弹无限、固定一轮敌人
    training = (mapId === 'training');
    FPS.Training = FPS.Training || {};
    FPS.Training.active = training;
    FPS.Training.infiniteAmmo = training;
    FPS.Training.round = trainRound;
    FPS.Training.enemyTypes = FPS.EnemyOrder ? FPS.EnemyOrder.slice() : [];
    trainHold = false;
    trainClearing = false;
    trainSpawned = 0;
    menuOpen = false;
    if (el.hud) el.hud.classList.remove('menu-open');
    document.body.setAttribute('data-training', training ? '1' : '0');
    buildTrainMenu();
    gameToken++;
    clearEnemies();
    player.reset(world.playerStart);
    score = 0; kills = 0; headshots = 0;
    streak = 0; streakTimer = 0; bestStreak = 0; streakScore = 0;
    shotsFired = 0; shotsHit = 0;
    wave = 0; waveClearDelay = 0; wavePending = 0; waveActive = false;
    waveScore = 0; waveKilled = 0; waveSpawned = 0; waveTotal = 0;
    damageLevel = 0;
    el.damage.style.opacity = 0;
    el.scorePopups.innerHTML = '';
    resetStreakPop();
    hideRoundCard();
    state = 'playing';
    el.hud.classList.remove('hud-off');
    if (world) world.setBackdropOnly(false);   // 恢复舱室场景
    el.overlay.classList.add('hidden');
    el.overlayCard.innerHTML = '';
    lastFrame = performance.now();
    applySettings();
    updateHUD();
    // 先全屏后锁定指针（同时发起容易互相打断），并给一次延迟兜底
    requestPointerLock();
    setTimeout(function () { if (state === 'playing') requestPointerLock(); }, 450);
    if (training) {
      spawnSlots = buildSpawnSlots(trainRound, 1);
      trainSpawn(trainRound);
      syncTrainMenu();
      showBanner('训练场', '无关卡 · 子弹无限 · 按 Alt 呼出鼠标开菜单');
    } else {
      startWave(1);
    }
  }

  function resumeGame() {
    // 若玩家开着全屏设置（可能是被 Esc/F11 退出的），继续游戏时自动恢复全屏
    if (settings.fullscreen && !isFullscreen()) enterFullscreen();
    state = 'playing';
    el.hud.classList.remove('hud-off');
    if (world) world.setBackdropOnly(false);
    el.overlay.classList.add('hidden');
    lastFrame = performance.now();
    requestPointerLock();
    setTimeout(function () { if (state === 'playing') requestPointerLock(); }, 350);
  }

  function pauseGame(showMenu2) {
    if (state !== 'playing') return;
    state = 'paused';
    setTrainMenu(false);          // 暂停时一并关掉训练场菜单模式
    input.firing = false;
    input.forward = input.back = input.left = input.right = false;
    releaseLock();
    if (showMenu2 !== false) showPause();
  }
  function gameOver() {
    state = 'gameover';
    input.firing = false;
    hideRoundCard();
    clearSpawnTimers();
    streak = 0; streakTimer = 0; streakScore = 0;
    el.streakPanel.classList.remove('show');
    releaseLock();
    unlockKeyboard();   // 结算界面里让 Esc 恢复正常行为
    Sfx.gameOver();
    showGameOver();
  }

  function victory() {
    state = 'victory';
    input.firing = false;
    hideRoundCard();
    clearSpawnTimers();
    streak = 0; streakTimer = 0; streakScore = 0;
    el.streakPanel.classList.remove('show');
    releaseLock();
    unlockKeyboard();
    Sfx.waveClear();
    showVictory();
  }

  function goHome() {
    gameToken++;
    clearEnemies();
    hideRoundCard();
    // 离开训练场时把训练态与鼠标解锁一起收干净
    training = false;
    trainHold = false;
    trainClearing = false;
    menuOpen = false;
    FPS.Training = FPS.Training || {};
    FPS.Training.active = false;
    FPS.Training.infiniteAmmo = false;
    if (el.hud) el.hud.classList.remove('menu-open');
    document.body.setAttribute('data-training', '0');
    state = 'menu';
    wave = 0; waveClearDelay = 0; wavePending = 0; waveActive = false;
    waveScore = 0; waveKilled = 0; waveSpawned = 0; waveTotal = 0;
    streak = 0; streakTimer = 0; streakScore = 0;
    el.scorePopups.innerHTML = '';
    resetStreakPop();
    el.streakPanel.classList.remove('show');
    el.stageBar.style.width = '0%';
    releaseLock();
    unlockKeyboard();   // 开始菜单不算"游戏中"，Esc 恢复默认行为
    showMenu('main');
  }

  /* ===============================================================
     指针锁定：区分"自己解锁"和"被浏览器莫名解锁"
     =============================================================== */
  var expectUnlock = false;
  var escPressedAt = 0;
  var relockTimer = null;

  function lockElement() { return renderer.domElement; }

  function requestPointerLock() {
    var c = lockElement();
    if (!c.requestPointerLock) return;
    if (document.pointerLockElement === c) return;
    function retryPlain() {
      try {
        var p2 = c.requestPointerLock();
        if (p2 && p2.catch) p2.catch(function () { /* 需要用户手势 */ });
      } catch (e) { /* 忽略 */ }
    }
    try {
      var p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(retryPlain);
    } catch (e) {
      retryPlain();
    }
  }

  /** 主动解锁（暂停/结算/返回主页时调用） */
  function releaseLock() {
    expectUnlock = true;
    if (relockTimer) { clearTimeout(relockTimer); relockTimer = null; }
    if (document.pointerLockElement) {
      try { document.exitPointerLock(); } catch (e) {}
    }
  }

  /**
   * 指针锁定意外丢失时，先静默尝试重新锁定（不打断游戏）。
   * 若用户是主动按 Esc 退出的，浏览器会拒绝自动重锁 —— 这时才弹出暂停菜单，
   * 因此不会出现"没按 Esc 却弹出菜单"的情况。
   */
  function tryRelock(attempts) {
    if (state !== 'playing') return;
    if (document.pointerLockElement === lockElement()) return;
    var c = lockElement();
    var ok = false;
    try {
      var p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && p.then) {
        p.then(function () { ok = true; }).catch(function () {});
      } else {
        ok = true;
      }
    } catch (e) { ok = false; }
    relockTimer = setTimeout(function () {
      relockTimer = null;
      if (state !== 'playing') return;
      if (document.pointerLockElement === lockElement()) return;
      if (attempts > 1) tryRelock(attempts - 1);
      else pauseGame();
    }, 260);
  }

  /* ===============================================================
     事件绑定
     =============================================================== */
  var KEYMAP = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    ShiftLeft: 'sprint', ShiftRight: 'sprint',
    Space: 'jump'
  };

  /* 焦点在输入类控件里时（开发者模式的活动空间/空气墙面板等），
     游戏必须完全让路：不抢按键、不拦鼠标默认动作。
     以前这里在**捕获阶段**无条件 preventDefault，
     导致页面上任何输入框都点不进焦点，看上去就是"面板完全不可编辑"。 */
  function isTypingField(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
  }
  function isTyping() {
    var a = document.activeElement;
    return !!(a && a !== document.body && isTypingField(a));
  }

  function bindEvents() {
    window.addEventListener('resize', function () {
      var w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    if (postfx) postfx.setSize(w, h);
    });

    document.addEventListener('keydown', function (e) {
      // 正在输入框里打字：Esc 只负责离开输入框，其余按键全给输入控件
      if (isTypingField(e.target)) {
        if (e.code === 'Escape' && e.target.blur) e.target.blur();
        return;
      }
      if (e.code === 'Escape') {
        escPressedAt = Date.now();
        // 全屏 + 键盘锁定生效时，Esc 不会退出全屏，由这里负责暂停
        if (state === 'playing') { pauseGame(); return; }
      }
      // 训练场：Alt 呼出鼠标（开菜单）/ 再按一次回到游戏
      if ((e.code === 'AltLeft' || e.code === 'AltRight') && training && state === 'playing') {
        if (!e.repeat) { e.preventDefault(); toggleTrainMenu(); }
        return;
      }
      // 鼠标已解锁（菜单模式）：除了上面的 Alt，其余按键一律不响应
      if (training && menuOpen) {
        if (e.code === 'KeyM' && state === 'playing') { /* 允许静音 */ }
        else return;
      }
      if (e.code === 'Enter' && (state === 'gameover' || state === 'victory' || state === 'menu')) {
        Sfx.init(); Sfx.resume();
        startGame();
        return;
      }
      if (e.code === 'KeyM' && state === 'playing') {
        var m = Sfx.toggleMute();
        showBanner(m ? '已静音' : '声音已开启', '');
        return;
      }
      if (e.code === 'KeyF' && state === 'playing') {
        player.startInspect();          // 检视枪械：抬枪转一圈看枪身
        return;
      }
      if (state !== 'playing') return;
      var a = KEYMAP[e.code];
      if (a) {
        input[a] = true;
        markActivity();
        if (e.code === 'Space') { input.jumpPressed = true; e.preventDefault(); }
      }
      if (e.code === 'KeyR') { input.reload = true; markActivity(); }
      // 退格键在部分浏览器里会触发后退
      if (e.code === 'Backspace') e.preventDefault();
    });

    document.addEventListener('keyup', function (e) {
      var a = KEYMAP[e.code];
      if (a) input[a] = false;
    });

    renderer.domElement.addEventListener('mousedown', function (e) {
      e.preventDefault();          // 阻止选择 / 原生拖拽 / 中键自动滚动
      if (state !== 'playing') return;
      if (e.button === 0) { input.firing = true; markActivity(); }
      if (e.button === 2) {        // 右键：点一下开镜，再点一下取消
        markActivity();
        input.aim = !input.aim;
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) input.firing = false;   // 右键是点击切换，抬起不做处理
    });
    window.addEventListener('blur', function () { input.firing = false; input.aim = false; });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });   // 不弹右键菜单

    document.addEventListener('mousemove', function (e) {
      if (state !== 'playing' || document.pointerLockElement !== renderer.domElement) return;
      if (training && menuOpen) return;            // 菜单模式：鼠标只用来点菜单
      if (e.movementX || e.movementY) markActivity();
      player.look(e.movementX || 0, e.movementY || 0);
    });

    document.addEventListener('pointerlockchange', function () {
      var locked = document.pointerLockElement === renderer.domElement;
      if (locked) {
        expectUnlock = false;
        if (relockTimer) { clearTimeout(relockTimer); relockTimer = null; }
        return;
      }
      if (state !== 'playing') return;
      // 训练场主动解锁鼠标开菜单：也不该被自动重锁或暂停
      if (training && menuOpen) { expectUnlock = false; return; }
      if (expectUnlock) { expectUnlock = false; return; }   // 我们自己解锁（暂停/结算）时已在处理
      if (Date.now() - escPressedAt < 1500) {
        // 刚按过 Esc：判定为玩家主动暂停
        pauseGame();
        return;
      }
      // 其它原因（全屏切换、焦点变化等）：先静默重锁，失败才暂停
      tryRelock(3);
    });

    document.addEventListener('pointerlockerror', function () {});

    // 全屏状态变化：同步设置界面、维护键盘锁定、必要时提示
    function onFsChange() {
      var fs2 = isFullscreen();
      if (fs2) {
        if (state === 'playing') lockKeyboard();
      } else {
        unlockKeyboard();
        if (wantFullscreen && (state === 'playing' || state === 'paused')) {
          showBanner('已退出全屏', '按 F11 或在暂停菜单里可重新开启');
        }
      }
      syncSettingsUI();
    }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // 全屏被拦截时，下一次点击/按键再自动试一次（最多 3 次，避免反复打扰）
    function retryFullscreen() {
      if (!fsRetryPending || fsRetryCount >= 3) return;
      if (state !== 'playing' && state !== 'paused') return;
      if (!settings.fullscreen || isFullscreen()) return;
      fsRetryPending = false;
      fsRetryCount++;
      enterFullscreen();
    }
    window.addEventListener('pointerdown', retryFullscreen);
    document.addEventListener('keydown', retryFullscreen);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && state === 'playing') pauseGame();
    });

    // 游戏中禁用横向滚轮/触控板滑动（会触发浏览器前进后退）
    window.addEventListener('wheel', function (e) {
      if (state === 'playing' && Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault();
    }, { passive: false });

    // 阻止鼠标侧键（后退键）等
    window.addEventListener('mousedown', function (e) {
      if (e.button === 3 || e.button === 4) e.preventDefault();
    });

    /* ---------------- 禁止"按住左键拖动"引发的浏览器手势 ----------------
       原生拖拽 / 拖放、文本选择、中键自动滚动都会打断瞄准（甚至丢失指针锁定），
       这里在捕获阶段统一拦掉，窗口模式与全屏模式都生效。 */
    var GESTURE_EVENTS = ['drag', 'dragstart', 'dragend', 'dragenter', 'dragover', 'dragleave', 'drop', 'selectstart'];
    for (var gi = 0; gi < GESTURE_EVENTS.length; gi++) {
      document.addEventListener(GESTURE_EVENTS[gi], function (e) {
        if (isTypingField(e.target)) return;       // 输入框里要能选中/拖选文字
        e.preventDefault();
      }, { passive: false, capture: true });
    }
    document.addEventListener('mousedown', function (e) {
      if (e.button === 1) e.preventDefault();      // 中键自动滚动
    });

    /* ---------------- 鼠标按键 ----------------
       左键：保留游戏功能（射击），但取消浏览器默认动作（选择、拖拽），
             这样按住左键扫射不会打断瞄准或丢失指针锁定。
       右键：游戏内用于瞄准（见上面的 mousedown 处理），这里只屏蔽右键菜单，
             避免瞄准时弹出菜单；浏览器自带的手势无法从页面禁用，
             需要时可在 Edge 设置里关闭"鼠标手势"。 */
    document.addEventListener('mousedown', function (e) {
      if (e.button === 0 && !isTyping() && !isTypingField(e.target)) e.preventDefault();
    }, { capture: true, passive: false });
    document.addEventListener('mousemove', function (e) {
      if ((e.buttons & 1) && !isTyping()) e.preventDefault();       // 按住左键移动
    }, { capture: true, passive: false });
    document.addEventListener('dblclick', function (e) {
      if (isTypingField(e.target)) return;                        // 输入框里双击选词要放行
      e.preventDefault();
    }, { capture: true, passive: false });

    // 右键菜单屏蔽（右键在游戏里是瞄准键）
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    window.addEventListener('pointerdown', function once() {
      Sfx.resume();
      window.removeEventListener('pointerdown', once);
    });
  }

  /* ===============================================================
     准星 / 状态检测
     =============================================================== */
  function checkCrosshairTarget(dt) {
    crosshairCheckT -= dt;
    if (crosshairCheckT > 0) return;
    crosshairCheckT = 0.08;
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    raycaster.far = 90;
    var list = getTargets();
    var hits = raycaster.intersectObjects(list, false);
    var found = hits.length > 0 && hits[0].object.userData.enemy && hits[0].object.userData.enemy.alive;
    if (found !== enemyUnderCrosshair) {
      enemyUnderCrosshair = found;
      el.crosshair.classList.toggle('enemy', found);
    }
    var px = Math.tan(player.spread()) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (window.innerHeight / 2);
    px = Math.max(4, Math.min(46, px));
    el.crosshair.style.setProperty('--spread', px.toFixed(1) + 'px');
    var ads = player.aimLerp > 0.5;
    if (ads !== crosshairAds) {
      crosshairAds = ads;
      el.crosshair.classList.toggle('ads', ads);
      // 举枪：有瞄具遮罩就显示镜内视野（倍镜分划板 / 红点镜二选一）
      var useScope = ads && player.hasScopeOverlay !== false;
      if (el.scope) {
        el.scope.classList.toggle('show', useScope);
        el.scope.classList.toggle('reddot', player.scopeStyle === 'reddot');
      }
      // 用红点镜时：镜片里那颗 3D 红点就是准心，所以把 HUD 准星收起来
      if (el.hud) el.hud.classList.toggle('sightdot', ads && player.hasSightDot === true);
      if (el.hud) el.hud.classList.toggle('scoped', useScope);
      if (el.scopeZoom) el.scopeZoom.textContent = player.aimZoom.toFixed(1) + '×';
      if (Sfx.scopeIn) { if (ads) Sfx.scopeIn(); else Sfx.scopeOut(); }
    }
  }

  /** 右键瞄准：视野放大（FOV 随瞄准过渡插值） */
  function updateCameraFov() {
    var want = FOV / (1 + (player.aimZoom - 1) * player.aimLerp);
    if (Math.abs(camera.fov - want) > 0.01) {
      camera.fov = want;
      camera.updateProjectionMatrix();
    }
  }

  /* ===============================================================
     主循环
     =============================================================== */
  function loop(now) {
    requestAnimationFrame(loop);
    frameCount++;

    var dt = Math.min(0.05, (now - lastFrame) / 1000);
    if (dt < 0) dt = 0;
    lastFrame = now;
    var time = now / 1000;

    fpsAcc += dt; fpsFrames++; fpsTimer += dt;
    if (fpsTimer > 0.5) {
      el.fps.textContent = '帧率 ' + Math.round(fpsFrames / fpsAcc);
      fpsAcc = 0; fpsFrames = 0; fpsTimer = 0;
    }

    var playing = (state === 'playing');
    if (playing) gameTime += dt;

    if (playing || state === 'gameover' || state === 'victory') {
      // 训练场解锁鼠标（菜单模式）时不接受任何操作：除菜单外全部失效
      var blocked = (menuOpen && training);
      player.update(dt, (playing && !blocked) ? input : IDLE_INPUT);
    }
    input.reload = false;
    input.jumpPressed = false;

    var ctx = {
      world: world,
      player: { pos: player.pos, alive: player.alive },
      enemies: enemies,
      time: time,
      pickPatrol: pickPatrol,
      onAlert: onAlert,
      onDamagePlayer: onDamagePlayer,
      onAttack: function () { },
      onExplode: function () { Sfx.kill(); player.shake = Math.min(1, player.shake + 0.3); }
    };
    for (var i = enemies.length - 1; i >= 0; i--) {
      var e = enemies[i];
      if (playing) {
        if (menuOpen && training) {
          // 菜单模式：敌人保持原样，只推进死亡动画（不能让它们趁机开枪）
          if (!e.alive) e.update(dt, ctx);
        } else if (training && trainHold) {
          // 全部停止：只推进动画/激光视觉，不运行 AI（不动、不打）
          if (!e.alive) e.update(dt, ctx);
          else if (e.updateVisual) e.updateVisual(dt, ctx);
        } else {
          e.update(dt, ctx);
        }
      } else if (!e.alive) e.update(dt, ctx);
      if (e.removable) {
        scene.remove(e.group);
        e.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
        enemies.splice(i, 1);
      }
    }

    P.update(dt);
    world.update(dt);

    if (playing) {
      if (training) {
        /* 训练场：没有关卡推进。
           出发队列还在补人时（wavePending > 0）先补完；
           场上真的清空了（连尸体都移除了）再自动开下一轮。 */
        if (!menuOpen) {
          if (waveQueue.length) spawnFromQueue();
          if (!waveQueue.length && enemies.length === 0) trainRestartRound();
        }
      } else if (waveActive) {
        if (aliveCount() === 0 && enemies.length === 0 && wavePending <= 0 && waveClearDelay === 0) waveCleared();
      }
      if (waveClearDelay > 0) {
        waveClearDelay -= dt;
        el.rcBar.style.width = Math.max(0, Math.min(100, (1 - waveClearDelay / 4.6) * 100)).toFixed(0) + '%';
        el.rcNextText.textContent = '下一关：' + Math.max(0, waveClearDelay).toFixed(1) + ' 秒';
        if (waveClearDelay <= 0) {
          waveClearDelay = 0;
          startWave(wave + 1);
        }
      }
      checkCrosshairTarget(dt);
      updateCameraFov();
      updateCompass();
      hudT -= dt;
      if (hudT <= 0) { hudT = 0.1; updateHUD(); }

      // 连杀窗口倒计时：飘字与时间条同步变暗，窗口走完一起消失
      if (streakTimer > 0) {
        streakTimer -= dt;
        if (streakTimer <= 0) {
          streakTimer = 0;
          streak = 0;
          streakScore = 0;
          updateStreakHUD();
          endStreakPop();
        } else {
          updateStreakHUD();
          updateStreakPop(streakTimer / STREAK_WINDOW);
        }
      }

      /* ---------------- 按键提示的显示时机 ----------------
         只在第 1 关常显；之后只在玩家长时间（8 秒）没有操作时提示，
         其余时间隐藏，避免遮挡视野。 */
      if (input.forward || input.back || input.left || input.right || input.jump ||
          input.sprint || input.firing || input.reload) markActivity();
      var idleSec = (performance.now() - lastInputAt) / 1000;
      var wantHints = (wave <= 1) || idleSec >= HINT_IDLE_SEC;
      if (wantHints !== hintsShown) {
        hintsShown = wantHints;
        el.keyHints.classList.toggle('show', wantHints);
      }
    } else if (hintsShown) {
      hintsShown = false;
      el.keyHints.classList.remove('show');
    }

    if (damageLevel > 0) {
      damageLevel = Math.max(0, damageLevel - dt * 2.2);
      el.damage.style.opacity = damageLevel.toFixed(3);
    }


    // 走完整后处理：世界与枪械两趟一起渲进 HDR 缓冲，再做泛光/分级/FXAA
    if (postfx) {
      // 太阳屏幕坐标（给上帝光用）：把平行光位置投影到屏幕
      if (world && world.dirLight) {
        _sunV.copy(world.dirLight.position).project(camera);
        var sunVisible = _sunV.z < 1;
        postfx.sunScreen.set(_sunV.x * 0.5 + 0.5, _sunV.y * 0.5 + 0.5);
        postfx.sunIntensity = sunVisible ? 1 : 0;
      }
      postfx.render(function () {
        renderer.render(scene, camera);
        // 开发者模式不渲染手上的枪：枪是独立相机的第二层，相机在飞时会出现黑色条纹/穿模
        if (state !== 'menu') {
          player.renderViewModel(renderer, window.innerWidth / window.innerHeight);
        }
      });
    } else {
      renderer.clear();
      renderer.render(scene, camera);
      if (state !== 'menu') player.renderViewModel(renderer, window.innerWidth / window.innerHeight);
    }
  }

  var IDLE_INPUT = {
    forward: false, back: false, left: false, right: false,
    jump: false, jumpPressed: false, sprint: false, firing: false, reload: false
  };

  /* ---------------- 启动 ---------------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 便于调试 / 自动化测试（玩家版打包时脚本会把 DEV_BUILD 改为 false，这个接口就不再暴露）
  if (DEV_BUILD) window.__FPS_GAME = function () {
    return {
      state: state, player: player, enemies: enemies, world: world,
      scene: scene, renderer: renderer, gameTime: gameTime, input: input, camera: camera,
      totalWaves: TOTAL_WAVES,
      get wave() { return wave; },
      get score() { return score; },
      get kills() { return kills; },
      get streak() { return streak; },
      get bestStreak() { return bestStreak; },
      get streakTimer() { return streakTimer; },
      get waveScore() { return waveScore; },
      // 关卡进度（供自动化测试读取）
      get waveKilled() { return waveKilled; },
      get waveSpawned() { return waveSpawned; },
      get waveTotal() { return waveTotal; },
      get wavePending() { return wavePending; },
      get waveActive() { return waveActive; },
      get waveClearDelay() { return waveClearDelay; },
      get aliveCount() { return aliveCount(); },
      get frameCount() { return frameCount; },
      // 训练场状态（自动化测试用）
      get training() { return training; },
      get trainHold() { return trainHold; },
      get trainRound() { return trainRound; },
      get trainSpawned() { return trainSpawned; },
      get menuOpen() { return menuOpen; },
      get infiniteAmmo() { return !!(FPS.Training && FPS.Training.infiniteAmmo); },
      debugTrainTypes: function () { return FPS.EnemyOrder.slice(); },
      debugTrainMenu: function () {
        return {
          visible: (el.trainMenu && getComputedStyle(el.trainMenu).display !== 'none'),
          bodyTraining: document.body.getAttribute('data-training'),
          menuOpenClass: el.hud.classList.contains('menu-open'),
          buttons: ['tmHold', 'tmMove', 'tmClear', 'tmAdd_soldier', 'tmAdd_commander'].map(function (id) {
            return id + ':' + !!document.getElementById(id);
          })
        };
      },
      debugSetMenu: function (v) { setTrainMenu(v); if (v) releaseLock(); else requestPointerLock(); return menuOpen; },
      debugToggleTrainMenu: function () { return toggleTrainMenu(); },
      // 测试用：直接开局 / 回主页（不依赖界面按钮，避免被指针锁定挡掉点击）
      debugStartMode: function (mapId) { startGame(mapId === 'training' ? 'training' : undefined); return state; },
      debugGoHome: function () { goHome(); return state; },
      debugAliveCount: function () { return aliveCount(); },
      debugUpdateCompass: function () { updateCompass(); return true; },
      // 测试用：走正式的"玩家受伤"入口（训练场防死逻辑在这里）
      debugDamagePlayer: function (amount) {
        var e = null;
        for (var i = 0; i < enemies.length; i++) if (enemies[i].alive) { e = enemies[i]; break; }
        onDamagePlayer(amount, e);
        return { hp: player.health, alive: player.alive, state: state };
      },
      settings: settings,
      // 测试用：直接跳到指定关卡（清掉旧敌人，并按该关组成重新刷满）
      debugJumpToWave: function (n) {
        wave = Math.max(1, Math.min(TOTAL_WAVES, n | 0));
        clearSpawnTimers();
        waveQueue.length = 0;
        for (var i = 0; i < enemies.length; i++) if (enemies[i].alive) enemies[i].damage(9999, 'body');
        enemies.length = 0;                       // 死掉的直接清掉，免得干扰计数
        if (FPS.resetLocks) FPS.resetLocks();
        startWave(wave);                          // 走正常开波流程（现在是一次刷满）
        updateHUD();
      },
      // 测试用：打开暂停菜单
      debugPause: function () { pauseGame(); },
      // 测试/调试用：全屏状态
      debugFullscreen: {
        supported: fullscreenSupported,
        active: isFullscreen,
        enter: enterFullscreen,
        exit: exitFullscreen,
        shell: function () { return shellFullscreen; },
        screenSized: alreadyScreenSized,
        keyboardLockSupported: function () { return !!(navigator.keyboard && navigator.keyboard.lock); }
      },
      // 测试用：把"最后操作时间"往前推，模拟玩家静止了 sec 秒
      debugIdleFor: function (sec) { lastInputAt -= sec * 1000; },
      debugMarkActive: function () { markActivity(); },
      debugHintIdleSec: function () { return HINT_IDLE_SEC; },
      debugStreakWindow: function () { return STREAK_WINDOW; },
      // 测试用：兵种系统
      debugWaveComposition: function (n) { return waveComposition(n); },
      debugTypeInfo: function (k) {
        var t = FPS.EnemyTypes[k];
        return t ? { name: t.name, hp: t.hp, chase: t.chaseSpeed, turn: t.turn, score: t.score, desc: t.desc } : null;
      },
      debugSpawn: function (typeKey, x, z) {
        var e = new FPS.Enemy(new THREE.Vector3(x || 0, 0, z || 0), typeKey);
        scene.add(e.group);
        enemies.push(e);
        return e;
      },
      // 测试用：画质档（低档只做一次合成 pass，软件渲染下才跑得完）
      debugSetQuality: function (q) { if (postfx) { postfx.quality = q; } return postfx ? postfx.quality : null; },
      debugHasPost: function () { return !!postfx; },
      // 测试用：读当前生效的画面参数 / 风格名（画面设置面板的验收依赖它）
      debugLook: function () {
        if (!postfx || !postfx.params) return null;
        var p = postfx.params();
        var out = { look: postfx.lookName };
        Object.keys(p || {}).forEach(function (k) { out[k] = p[k]; });
        out.bloomBoost = postfx.bloomBoost;
        out.raysBoost = postfx.raysBoost;
        return out;
      },
      debugSetLook: function (name) { return postfx ? postfx.applyLook(name) : null; },
      debugSetLookParam: function (k, v) { return postfx ? postfx.setParam(k, v) : null; },
      debugSetToy: function (v) { if (!postfx) return null; postfx.toy = !!v; postfx.applyLook(); return postfx.toy; },
      debugToyUniform: function (name, value) {
        if (!postfx) return null;
        var pass = postfx.debugPass ? postfx.debugPass() : null;
        return pass ? pass : 'n/a';
      },
      // 测试用：切地图（'arena' 新竞技场 / 'station' 训练场=旧太空站）
      debugSetMap: function (id) { selectMap(id); return currentMap; },
      // 测试用：开关"训练场被动敌人"（敌人只走动、不攻击）
      debugSetPassive: function (v) { FPS.World.passiveEnemies = !!v; return FPS.World.passiveEnemies; },
      debugMapInfo: function () {
        var trees = 0, rocks = 0, colorMats = 0;
        if (world && world.group) {
          world.group.traverse(function (o) {
            if (!o.isMesh) return;
            if (/^tree_/.test(o.parent && o.parent.name || '')) trees++;
            if (/^rock_/.test(o.parent && o.parent.name || '')) rocks++;
            if (o.material && o.material.map && o.material.map.image &&
                o.material.map.image.width >= 128) colorMats++;
          });
        }
        return {
          map: currentMap, half: FPS.World.HALF, trees: trees, rocks: rocks,
          textured: colorMats, passive: !!FPS.World.passiveEnemies,
          colliders: world ? world.colliders.length : 0
        };
      }
    };
  };
})();
