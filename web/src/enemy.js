/* =====================================================================
   霓虹突袭 — 粒子特效、兵种系统与敌人 AI
   ---------------------------------------------------------------------
   兵种从第 1 关开始逐级解锁，能力各不相同：
     1 士兵     短距离激光点射（基础兵）
     2 冲锋兵   跑得极快、近身重击，血少
     3 重装兵   高血量慢速，霰弹式激光齐射
     4 狙击兵   超远距离高伤害激光，开火前有长时间瞄准线，且会保持距离
     5 护盾兵   正面护盾：正面中弹只吃两成伤害，需要绕后打
     6 幻影兵   半透明隐身，靠近或开火时才显形
     7 自爆兵   高速贴近后自爆，范围伤害（打死它可以阻止爆炸）
     8 指挥官   周期性治疗并加速附近友军，自身很硬
   ===================================================================== */
window.FPS = window.FPS || {};

/* ============================ 粒子系统 ============================ */
(function () {
  'use strict';

  var MAX = 320;
  var pool = [];
  var group = null;
  var geo = null;
  var mats = null;
  var inited = false;
  var cursor = 0;

  var COLORS = {
    spark: 0x9ff4ff,
    blood: 0xff3b52,
    debris: 0xffb347,
    smoke: 0x8fa4c0,
    green: 0x49ffa8
  };

  function init(scene) {
    if (inited) return;
    inited = true;
    group = new THREE.Group();
    group.name = 'particles';
    scene.add(group);

    geo = new THREE.BoxGeometry(1, 1, 1);
    mats = {};
    Object.keys(COLORS).forEach(function (k) {
      mats[k] = new THREE.MeshBasicMaterial({ color: COLORS[k], transparent: true, opacity: 1 });
    });

    for (var i = 0; i < MAX; i++) {
      var m = new THREE.Mesh(geo, mats.spark);
      m.visible = false;
      m.frustumCulled = false;
      group.add(m);
      pool.push({
        mesh: m,
        life: 0, maxLife: 1,
        vx: 0, vy: 0, vz: 0,
        size: 0.07, gravity: -12, drag: 0.9, fade: true
      });
    }
  }

  var Particles = {
    init: init,

    burst: function (pos, opt) {
      if (!inited) return;
      opt = opt || {};
      var count = opt.count || 10;
      var speed = opt.speed == null ? 5 : opt.speed;
      var life = opt.life == null ? 0.5 : opt.life;
      var color = opt.color || 'spark';
      var size = opt.size == null ? 0.075 : opt.size;
      var dir = opt.dir || null;
      var spread = opt.spread == null ? 1 : opt.spread;
      var gravity = opt.gravity == null ? -12 : opt.gravity;

      for (var i = 0; i < count; i++) {
        var p = pool[cursor];
        cursor = (cursor + 1) % MAX;

        var vx = (Math.random() * 2 - 1) * spread;
        var vy = (Math.random() * 2 - 1) * spread + 0.35;
        var vz = (Math.random() * 2 - 1) * spread;
        if (dir) {
          vx += dir.x * 1.2; vy += dir.y * 1.2; vz += dir.z * 1.2;
        }
        var len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        var sp = speed * (0.45 + Math.random() * 0.75);

        p.mesh.material = mats[color] || mats.spark;
        p.mesh.position.copy(pos);
        p.mesh.scale.setScalar(size * (0.6 + Math.random() * 0.9));
        p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        p.mesh.visible = true;

        p.vx = (vx / len) * sp;
        p.vy = (vy / len) * sp;
        p.vz = (vz / len) * sp;
        p.gravity = gravity;
        p.drag = opt.drag == null ? 1.4 : opt.drag;
        p.life = p.maxLife = life * (0.6 + Math.random() * 0.8);
        p.size = size;
      }
    },

    update: function (dt) {
      if (!inited) return;
      for (var i = 0; i < MAX; i++) {
        var p = pool[i];
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) { p.mesh.visible = false; continue; }

        var damp = Math.max(0, 1 - p.drag * dt);
        p.vx *= damp; p.vz *= damp;
        p.vy = p.vy * damp + p.gravity * dt;

        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        if (p.mesh.position.y < 0.02) {
          p.mesh.position.y = 0.02;
          p.vy = Math.abs(p.vy) * 0.28;
          p.vx *= 0.7; p.vz *= 0.7;
        }
        p.mesh.rotation.x += dt * 5;
        p.mesh.rotation.y += dt * 3.4;

        var k = p.life / p.maxLife;
        p.mesh.scale.setScalar(p.size * (0.35 + k * 0.9));
      }
    },

    clear: function () {
      for (var i = 0; i < MAX; i++) {
        pool[i].life = 0;
        pool[i].mesh.visible = false;
      }
    }
  };

  FPS.Particles = Particles;
})();

/* ============================ 兵种 / 敌人 ============================ */
(function () {
  'use strict';

  var P = FPS.Particles;

  /* ---------------- 兵种表 ---------------- */
  var ORDER = ['soldier', 'rusher', 'heavy', 'sniper', 'guardian', 'phantom', 'bomber', 'commander'];

  var TYPES = {
    soldier: {
      key: 'soldier', name: '士兵', intro: 1, score: 100,
      hp: 100, radius: 0.46, height: 2.15, patrolSpeed: 2.4, chaseSpeed: 5.9, turn: 7, scale: 1,
      sight: 1.0,
      gun: { len: 0.5, w: 0.11, h: 0.13 },
      laser: { range: 18, dmg: 7, cd: 1.7, telegraph: 0.45, width: 0.055, beams: 1 },
      melee: { dmg: 9, cd: 1.15, range: 2.5 },
      look: { armor: 0x333a46, dark: 0x1c2129, hazard: 0x3d2a18, hazardEm: 0xff8a3c, core: 0x49ffa8, visor: 0x9ff4ff }
    },
    rusher: {
      key: 'rusher', name: '冲锋兵', intro: 2, score: 130,
      hp: 70, radius: 0.42, height: 2.0, patrolSpeed: 3.0, chaseSpeed: 7.6, turn: 9, scale: 0.94,
      sight: 0.85,
      gun: { len: 0.42, w: 0.1, h: 0.11 },
      laser: { range: 12, dmg: 5, cd: 2.4, telegraph: 0.3, width: 0.05, beams: 1 },
      melee: { dmg: 14, cd: 0.8, range: 2.7 },
      look: { armor: 0x4a3a22, dark: 0x241a10, hazard: 0x4a2e10, hazardEm: 0xffc23c, core: 0xffc23c, visor: 0xffd166 }
    },
    heavy: {
      key: 'heavy', name: '重装兵', intro: 3, score: 220,
      hp: 280, radius: 0.66, height: 2.45, patrolSpeed: 1.7, chaseSpeed: 4.2, turn: 3.5, scale: 1.3,
      sight: 0.9,
      gun: { len: 0.62, w: 0.2, h: 0.22 },
      laser: { range: 14, dmg: 6, cd: 2.5, telegraph: 0.6, width: 0.075, beams: 3, spread: 0.1 },
      melee: { dmg: 17, cd: 1.6, range: 3.1 },
      look: { armor: 0x2b3341, dark: 0x161b23, hazard: 0x3a2a14, hazardEm: 0xff9d3c, core: 0xff8a5c, visor: 0xff9d3c }
    },
    sniper: {
      key: 'sniper', name: '狙击兵', intro: 4, score: 180,
      hp: 90, radius: 0.44, height: 2.2, patrolSpeed: 2.2, chaseSpeed: 5.2, turn: 6, scale: 0.98,
      sight: 2.0,
      gun: { len: 0.95, w: 0.075, h: 0.09 },
      laser: { range: 44, dmg: 24, cd: 3.1, telegraph: 1.15, width: 0.035, beams: 1, keepDistance: 12 },
      melee: { dmg: 8, cd: 1.4, range: 2.4 },
      look: { armor: 0x2f3d3a, dark: 0x18211f, hazard: 0x14343a, hazardEm: 0x38e8ff, core: 0x38e8ff, visor: 0x8afff0 }
    },
    guardian: {
      key: 'guardian', name: '护盾兵', intro: 5, score: 240,
      hp: 200, radius: 0.54, height: 2.3, patrolSpeed: 1.9, chaseSpeed: 3.6,
      turn: 0.8,                                   // 转身极慢：绕到侧后方就能稳定输出（原来 2.2）
      sight: 0.9,
      scale: 1.08,
      gun: { len: 0.5, w: 0.12, h: 0.14 },
      shield: { front: 0.2, arc: -0.3 },
      laser: { range: 16, dmg: 8, cd: 2.0, telegraph: 0.55, width: 0.06, beams: 1 },
      melee: { dmg: 13, cd: 1.3, range: 2.9 },
      look: { armor: 0x3a3550, dark: 0x1d1a2c, hazard: 0x2a2350, hazardEm: 0x9d7bff, core: 0x9d7bff, visor: 0xc9b6ff }
    },
    phantom: {
      key: 'phantom', name: '幻影兵', intro: 6, score: 200,
      hp: 120, radius: 0.45, height: 2.15, patrolSpeed: 2.6, chaseSpeed: 5.4, turn: 8, scale: 0.96,
      sight: 1.1,
      gun: { len: 0.46, w: 0.1, h: 0.11 },
      cloak: { far: 0.14, nearDist: 7 },
      laser: { range: 20, dmg: 10, cd: 1.9, telegraph: 0.5, width: 0.05, beams: 1 },
      melee: { dmg: 12, cd: 1.1, range: 2.6 },
      look: { armor: 0x3b4550, dark: 0x1a2029, hazard: 0x1c3340, hazardEm: 0x7ce7ff, core: 0x9ff4ff, visor: 0xd8fbff }
    },
    bomber: {
      key: 'bomber', name: '自爆兵', intro: 7, score: 160,
      hp: 85, radius: 0.5, height: 1.9, patrolSpeed: 2.8, chaseSpeed: 6.4, turn: 8, scale: 1.05,
      sight: 1.0,
      explode: { trigger: 2.6, fuse: 0.75, dmg: 34, radius: 4.6 },
      laser: null,
      melee: null,
      look: { armor: 0x4a2630, dark: 0x241318, hazard: 0x5a1520, hazardEm: 0xff3b52, core: 0xff3b52, visor: 0xff6a7c }
    },
    commander: {
      key: 'commander', name: '指挥官', intro: 8, score: 320,
      hp: 360, radius: 0.6, height: 2.5, patrolSpeed: 1.8, chaseSpeed: 3.5, turn: 4, scale: 1.16,
      sight: 1.2,
      gun: { len: 0.56, w: 0.14, h: 0.16 },
      heal: { radius: 13, amount: 16, cd: 2.4, boostTime: 2.4 },
      laser: { range: 20, dmg: 11, cd: 1.6, telegraph: 0.4, width: 0.07, beams: 2, spread: 0.05 },
      melee: { dmg: 16, cd: 1.2, range: 3.0 },
      look: { armor: 0x35452f, dark: 0x1b2318, hazard: 0x1c3a20, hazardEm: 0x8aff9d, core: 0x8aff9d, visor: 0xd6ffcf }
    }
  };

  /** 第 n 关可出场的兵种 */
  function typesForWave(n) {
    var list = [];
    for (var i = 0; i < ORDER.length; i++) if (TYPES[ORDER[i]].intro <= n) list.push(ORDER[i]);
    return list;
  }
  /** 第 n 关首次登场的新兵种 */
  function newTypesAtWave(n) {
    var list = [];
    for (var i = 0; i < ORDER.length; i++) if (TYPES[ORDER[i]].intro === n) list.push(ORDER[i]);
    return list;
  }

  /* 兵种能力说明（给教程与提示用） */
  var DESC = {
    soldier: '短距离激光点射，被逼近时会近身攻击',
    rusher: '移动极快、近身重击，但血量较低',
    heavy: '高血量慢速，霰弹式激光齐射，近身伤害很高',
    sniper: '超远距离高伤害激光，开火前会有长时间瞄准线，且会主动保持距离',
    guardian: '正面护盾：从正面打只吃两成伤害，需要绕到侧面或背后',
    phantom: '半透明隐身，靠近或开火时才显形',
    bomber: '高速贴近后自爆，范围伤害；在引爆前击杀可以阻止爆炸',
    commander: '周期性治疗并加速附近的友军，自身很硬，优先击杀'
  };
  for (var dk in DESC) { if (TYPES[dk]) TYPES[dk].desc = DESC[dk]; }

  /* ---------------- 索敌参数 ----------------
     统一用「基础值 × 兵种倍率」：狙击兵看得最远，冲锋兵/自爆兵偏近。
     倍率写在兵种表的 sight 字段里，没写就是 1.0。 */
  var VIEW_RANGE = 30;                                  // 基础视野（米）
  var FOV_HALF = Math.cos(THREE.MathUtils.degToRad(82.5));   // 视野角 165°
  var NEAR_ALWAYS = 10;                                 // 贴这么近无视朝向，必定发现
  var LOST_GIVE_UP = 11;                                // 追丢多久才放弃（原来 6 秒）
  var SQUAD_ALERT_RANGE = 45;                           // 一人发现 → 附近队友一起警戒
  var SQUAD_ALERT_MAX = 8;                              // 单次联动最多通知几个（避免一人牵动全场）
  var SEARCH_STEP = 25;                                 // 追丢后朝最后位置收缩搜索的距离
  var SEARCH_EVERY = 5;                                 // 搜索间隔（秒）
  var ATTACK_RANGE = 2.5;

  /* 锁敌上限：同时"锁定玩家并攻击"的**士兵**最多 MAX_LOCKS 个。
     规则：
       · 特殊兵种（除士兵外的所有兵种）**不受锁敌限制**，发现玩家就会攻击
       · 士兵名额满了 → 不射激光，只做近战（贴上去打），在周围压着
     谁先发现谁先占名额；死亡/放弃追击时释放名额，后面的补上。 */
  var MAX_LOCKS = 6;
  var lockCount = 0;

  /** 士兵申请锁敌名额。特殊兵种直接通过；名额满 → 该士兵只能近战。 */
  function acquireLock(self) {
    if (self.cfg && self.cfg.key !== 'soldier') { self.lockedToPlayer = true; return true; }  // 特殊兵种不占名额
    if (self.lockedToPlayer) return true;
    if (lockCount >= MAX_LOCKS) return false;
    self.lockedToPlayer = true;
    lockCount++;
    return true;
  }
  function releaseLock(self) {
    if (!self.lockedToPlayer) return;
    self.lockedToPlayer = false;
    lockCount = Math.max(0, lockCount - 1);
  }
  /** 测试/重置用 */
  FPS.debugLockCount = function () { return lockCount; };
  /** 清空敌人时调用，避免名额残留 */
  FPS.resetLocks = function () { lockCount = 0; };

  /* 报点：一个敌人发现玩家后，把最后已知位置告诉附近队友，
     让整片区域一起压上来（最多 SQUAD_ALERT_MAX 个，避免一个人牵动全图）。 */
  function alertSquad(self, ctx) {
    var list = ctx && ctx.enemies;
    if (!list || !list.length) return;
    var pos = self.group.position;
    var near = [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o === self || !o.alive || o.alerted) continue;         // 已经警戒的不用再通知
      var d = o.group.position.distanceTo(pos);
      if (d > SQUAD_ALERT_RANGE) continue;
      near.push({ e: o, d: d });
    }
    if (!near.length) return;
    near.sort(function (a, b) { return a.d - b.d; });            // 先通知最近的
    var n = Math.min(near.length, SQUAD_ALERT_MAX);
    for (var k = 0; k < n; k++) {
      var t = near[k].e;
      t.alerted = true;                 // 直接进入警戒，共享玩家位置
      t.state = 'chase';
      t.lostT = 0;
      t.searchT = 0;
      t.lastKnown.copy(self.lastKnown);
    }
  }

  var _v1 = new THREE.Vector3();
  var _v2 = new THREE.Vector3();
  var _fwd = new THREE.Vector3();
  var _eye = new THREE.Vector3();
  var _tgt = new THREE.Vector3();
  var _searchDir = new THREE.Vector3();
  var _p0 = new THREE.Vector3();
  var _p1 = new THREE.Vector3();
  var _face = new THREE.Vector3();
  var _dirv = new THREE.Vector3();
  var _before = new THREE.Vector3();
  var _muzzle = new THREE.Vector3();
  var _shotDir = new THREE.Vector3();
  var _shotEnd = new THREE.Vector3();
  var _shotMid = new THREE.Vector3();

  /** 射线是否打中玩家（玩家视作半径 0.5、高 1.8 的圆柱） */
  function rayHitsPlayer(origin, dir, maxDist, ppos) {
    var cx = ppos.x, cz = ppos.z;
    var t = (cx - origin.x) * dir.x + (cz - origin.z) * dir.z;
    if (t < 0 || t > maxDist) return false;
    var py = origin.y + dir.y * t;
    if (py < ppos.y + 0.15 || py > ppos.y + 1.85) return false;
    var px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
    var dx = px - cx, dz = pz - cz;
    return (dx * dx + dz * dz) < 0.25;
  }

  /* ---------------- 机体（按兵种参数生成） ---------------- */
  function buildBody(self, cfg) {
    var g = new THREE.Group();
    var mats = [];
    var look = cfg.look;
    var transparent = !!cfg.cloak;
    var s = cfg.scale;

    function mat(color, emissive, emIntensity) {
      var m = new THREE.MeshStandardMaterial({
        color: color, roughness: 0.48, metalness: 0.62,
        emissive: emissive == null ? 0x000000 : emissive,
        emissiveIntensity: emIntensity == null ? 0 : emIntensity,
        transparent: transparent, opacity: 1
      });
      m.userData.baseEmissive = new THREE.Color(emissive == null ? 0x000000 : emissive);
      m.userData.baseEmissiveIntensity = emIntensity == null ? 0 : emIntensity;
      mats.push(m);
      return m;
    }

    var armor = mat(look.armor);
    var dark = mat(look.dark);
    var hazard = mat(look.hazard, look.hazardEm, 0.55);
    var glowMat = new THREE.MeshBasicMaterial({ color: look.core, toneMapped: false, transparent: transparent });
    var visorMat = new THREE.MeshBasicMaterial({ color: look.visor, toneMapped: false, transparent: transparent });

    function add(geo, material, x, y, z, part) {
      var m = new THREE.Mesh(geo, material);
      m.position.set(x * s, y * s, z * s);
      m.castShadow = true;
      m.userData.enemy = self;
      m.userData.part = part || 'body';
      g.add(m);
      return m;
    }

    add(new THREE.BoxGeometry(0.66 * s, 0.8 * s, 0.42 * s), armor, 0, 1.34, 0, 'body');
    add(new THREE.BoxGeometry(0.5 * s, 0.26 * s, 0.36 * s), dark, 0, 0.86, 0, 'body');
    var core = add(new THREE.BoxGeometry(0.2 * s, 0.2 * s, 0.08 * s), glowMat, 0, 1.42, 0.23, 'body');
    core.castShadow = false;
    var beltF = add(new THREE.BoxGeometry(0.56 * s, 0.1 * s, 0.04 * s), hazard, 0, 1.12, 0.22, 'body');
    var beltB = add(new THREE.BoxGeometry(0.56 * s, 0.1 * s, 0.04 * s), hazard, 0, 1.12, -0.22, 'body');
    beltF.castShadow = beltB.castShadow = false;
    add(new THREE.BoxGeometry(0.42 * s, 0.4 * s, 0.42 * s), armor, 0, 1.98, 0, 'head');
    var visor = add(new THREE.BoxGeometry(0.3 * s, 0.11 * s, 0.06 * s), visorMat, 0, 2.02, 0.22, 'head');
    visor.castShadow = false;
    add(new THREE.BoxGeometry(0.22 * s, 0.24 * s, 0.34 * s), dark, -0.44, 1.6, 0, 'limb');
    add(new THREE.BoxGeometry(0.22 * s, 0.24 * s, 0.34 * s), dark, 0.44, 1.6, 0, 'limb');
    var lampL = add(new THREE.BoxGeometry(0.1 * s, 0.1 * s, 0.1 * s), hazard, -0.44, 1.72, 0.02, 'limb');
    var lampR = add(new THREE.BoxGeometry(0.1 * s, 0.1 * s, 0.1 * s), hazard, 0.44, 1.72, 0.02, 'limb');
    lampL.castShadow = lampR.castShadow = false;

    var armGeo = new THREE.BoxGeometry(0.17 * s, 0.6 * s, 0.19 * s);
    armGeo.translate(0, -0.3 * s, 0);
    var armL = add(armGeo, armor, -0.44, 1.5, 0.02, 'limb');
    var armR = add(armGeo, armor, 0.44, 1.5, 0.02, 'limb');
    var legGeo = new THREE.BoxGeometry(0.22 * s, 0.74 * s, 0.26 * s);
    legGeo.translate(0, -0.37 * s, 0);
    var legL = add(legGeo, dark, -0.18, 0.74, 0, 'limb');
    var legR = add(legGeo, dark, 0.18, 0.74, 0, 'limb');

    /* ---- 兵种专属外观 ---- */
    var shieldMesh = null, auraMesh = null, bombMesh = null;

    if (cfg.shield) {
      shieldMesh = add(new THREE.BoxGeometry(1.05 * s, 1.4 * s, 0.1 * s), mat(0x514a72, 0x9d7bff, 0.35), 0, 1.32, 0.36, 'body');
      var edge = add(new THREE.BoxGeometry(1.05 * s, 0.07 * s, 0.13 * s), hazard, 0, 1.98, 0.36, 'body');
      edge.castShadow = false;
    }
    if (cfg.gun) {
      // 手里握着的枪：挂在右臂上，随手臂摆动/抬枪一起动，
      // 激光就从枪口发出（而不是凭空从胸口冒出来）
      var gun = new THREE.Group();
      gun.position.set(0, -0.62 * s, 0.02 * s);
      var gunBody = new THREE.Mesh(
        new THREE.BoxGeometry(cfg.gun.w * s, cfg.gun.h * s, cfg.gun.len * s),
        dark
      );
      gunBody.position.set(0, 0, cfg.gun.len * s * 0.5);
      gunBody.castShadow = true;
      gun.add(gunBody);
      var gunTip = new THREE.Mesh(
        new THREE.BoxGeometry(cfg.gun.w * s * 0.7, cfg.gun.h * s * 0.7, cfg.gun.len * s * 0.22),
        glowMat
      );
      gunTip.position.set(0, 0, cfg.gun.len * s * 0.98);
      gunTip.castShadow = false;
      gun.add(gunTip);
      armR.add(gun);
      self.gunMesh = gun;
    }

    if (cfg.laser && cfg.laser.keepDistance) {
      // 狙击兵的瞄具（枪管已经握在手里了）
      add(new THREE.BoxGeometry(0.12 * s, 0.12 * s, 0.3 * s), armor, 0.3, 1.58, 0.1, 'limb');
    }
    if (cfg.key === 'heavy') {
      add(new THREE.BoxGeometry(0.3 * s, 0.3 * s, 0.5 * s), hazard, -0.52, 1.5, 0.16, 'limb');
      add(new THREE.BoxGeometry(0.3 * s, 0.3 * s, 0.5 * s), hazard, 0.52, 1.5, 0.16, 'limb');
    }
    if (cfg.key === 'bomber') {
      bombMesh = add(new THREE.BoxGeometry(0.44 * s, 0.44 * s, 0.16 * s), glowMat, 0, 1.34, 0.26, 'body');
      bombMesh.castShadow = false;
    }
    if (cfg.key === 'commander') {
      add(new THREE.BoxGeometry(0.05 * s, 0.5 * s, 0.05 * s), hazard, 0, 2.36, 0, 'head');
      var tipMesh = add(new THREE.BoxGeometry(0.14 * s, 0.14 * s, 0.14 * s), glowMat, 0, 2.62, 0, 'head');
      tipMesh.castShadow = false;
      auraMesh = new THREE.Mesh(
        new THREE.RingGeometry(1.5, 1.62, 32),
        new THREE.MeshBasicMaterial({ color: 0x8aff9d, transparent: true, opacity: 0.22, side: THREE.DoubleSide, toneMapped: false })
      );
      auraMesh.rotation.x = -Math.PI / 2;
      auraMesh.position.y = 0.05;
      auraMesh.raycast = function () { };
      g.add(auraMesh);
    }

    // 脚下状态光环（不参与射线检测）
    var ringMat = new THREE.MeshBasicMaterial({
      color: 0x35e08a, transparent: true, opacity: 0.55, toneMapped: false, side: THREE.DoubleSide
    });
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.52 * s, 0.66 * s, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    ring.raycast = function () { };
    g.add(ring);

    /* ---- 激光：瞄准线 + 光束（放在 group 内，随朝向走） ---- */
    var beamMat = new THREE.MeshBasicMaterial({
      color: 0xff5a6a, transparent: true, opacity: 0.9, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var beam = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), beamMat);
    beam.visible = false;
    beam.frustumCulled = false;
    beam.raycast = function () { };
    g.add(beam);

    // 实心内芯：白色舱室里加色混合的辉光会被冲淡，加一条实心芯才看得清
    var beamCoreMat = new THREE.MeshBasicMaterial({ color: 0xff3350, toneMapped: false });
    var beamCore = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), beamCoreMat);
    beamCore.visible = false;
    beamCore.frustumCulled = false;
    beamCore.raycast = function () { };
    g.add(beamCore);

    var aimMat = new THREE.MeshBasicMaterial({
      color: 0xff2d4b, transparent: true, opacity: 0.42, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    var aimLine = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), aimMat);
    aimLine.visible = false;
    aimLine.frustumCulled = false;
    aimLine.raycast = function () { };
    g.add(aimLine);

    self.group = g;
    self.mats = mats;
    self.glowMat = glowMat;
    self.visorMat = visorMat;
    self.ringMat = ringMat;
    self.legL = legL; self.legR = legR;
    self.armL = armL; self.armR = armR;
    self.beam = beam;
    self.beamCore = beamCore;
    self.aimLine = aimLine;
    self.shieldMesh = shieldMesh;
    self.auraMesh = auraMesh;
    self.bombMesh = bombMesh;
  }

  /* ---------------- 敌人 ---------------- */
  function Enemy(spawnPos, typeKey) {
    var cfg = TYPES[typeKey] || TYPES.soldier;
    this.cfg = cfg;
    this.typeKey = cfg.key;
    this.typeName = cfg.name;

    this.maxHp = cfg.hp;
    this.hp = cfg.hp;
    this.radius = cfg.radius;
    this.height = cfg.height;
    this.state = 'patrol';
    this.alive = true;
    this.removable = false;

    this.waypoint = null;
    this.waitT = 0;
    this.lastKnown = new THREE.Vector3();
    this.lostT = 0;
    this.searchT = 0;             // 追丢后下一次"收缩搜索"的计时
    this.attackCd = 0;
    this.windup = 0;
    this._hitDone = false;
    this.laserCd = 0.8 + Math.random() * 1.2;
    this.aimT = 0;
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.beamT = 0;
    this.beamEnd = new THREE.Vector3();
    this.stun = 0;
    this.flash = 0;
    this.shieldFlash = 0;
    this.deathT = 0;
    this.walkPhase = 0;
    this.moveDist = 0;
    this.stuckT = 0;
    this.avoidT = 0;
    this.avoidDir = 1;
    this.detourX = 0;
    this.detourZ = 0;
    this.detourT = 0;
    this.spawnT = 0;
    this.alerted = false;
    this.playerSeen = false;
    this.lastSeenAt = -99;
    this.boostT = 0;
    this.fuseT = 0;
    this.fusing = false;
    this.healCd = 1.5;
    this.cloakOpacity = cfg.cloak ? cfg.cloak.far : 1;
    this.deathBySelf = false;
    this.shotsFired = 0;
    this.lastShotOrigin = new THREE.Vector3();

    buildBody(this, cfg);
    this.group.position.copy(spawnPos);
    this.group.position.y = 0;
    this.group.rotation.y = Math.random() * Math.PI * 2;
    this.group.scale.setScalar(0.15);
  }

  Enemy.prototype = {
    constructor: Enemy,

    eyePos: function (out) {
      return (out || _v1).set(this.group.position.x, this.group.position.y + 1.9 * this.cfg.scale, this.group.position.z);
    },
    centerPos: function (out) {
      return (out || _v2).set(this.group.position.x, this.group.position.y + 1.25 * this.cfg.scale, this.group.position.z);
    },

    /** 受击。dir 为子弹飞行方向（用来判断是否打在护盾正面） */
    damage: function (amount, part, hitPoint, dir) {
      if (!this.alive) return { dead: false, applied: 0 };
      var cfg = this.cfg;
      var mult = part === 'head' ? 2.0 : (part === 'limb' ? 0.75 : 1);
      var applied = amount * mult;

      if (cfg.shield && dir) {
        var fwdX = Math.sin(this.group.rotation.y), fwdZ = Math.cos(this.group.rotation.y);
        var facing = dir.x * fwdX + dir.z * fwdZ;    // < 0 表示从正面打来
        if (facing < cfg.shield.arc) {
          applied *= cfg.shield.front;
          this.shieldFlash = 0.18;
        }
      }

      this.hp -= applied;
      this.flash = 0.14;
      this.stun = Math.max(this.stun, part === 'head' ? 0.35 : 0.16);
      this.alerted = true;
      if (this.state === 'patrol') this.state = 'chase';

      if (hitPoint) {
        P.burst(hitPoint, {
          count: part === 'head' ? 12 : 8,
          color: 'blood', speed: 4.2, life: 0.45, size: 0.055,
          dir: dir ? { x: -dir.x, y: -dir.y, z: -dir.z } : null, spread: 1.1
        });
      }

      if (this.hp <= 0) {
        this.die(false);
        return { dead: true, applied: applied, headshot: part === 'head' };
      }
      return { dead: false, applied: applied, headshot: part === 'head' };
    },

    die: function (bySelf) {
      if (!this.alive) return;
      this.alive = false;
      releaseLock(this);              // 死了就腾出锁敌名额，后面的敌人可以补上
      this.state = 'dead';
      this.deathT = 0;
      this.hp = 0;
      this.deathBySelf = !!bySelf;
      this.beam.visible = false;
      this.beamCore.visible = false;
      this.aimLine.visible = false;
      if (this.auraMesh) this.auraMesh.visible = false;
      var p = this.centerPos(new THREE.Vector3());
      P.burst(p, { count: 26, color: 'spark', speed: 7.5, life: 0.7, size: 0.075, spread: 1.2 });
      P.burst(p, { count: 14, color: 'debris', speed: 5, life: 0.9, size: 0.09, spread: 1 });
      P.burst(p, { count: 10, color: 'smoke', speed: 2.2, life: 1.1, size: 0.16, spread: 1, gravity: -1.2 });
      for (var i = 0; i < this.mats.length; i++) {
        this.mats[i].transparent = true;
        this.mats[i].depthWrite = false;
      }
      this.glowMat.transparent = this.visorMat.transparent = true;
      if (this.shieldMesh) { this.shieldMesh.material.transparent = true; this.shieldMesh.material.depthWrite = false; }
    },

    hear: function (pos) {
      if (!this.alive) return;
      this.alerted = true;
      if (this.state === 'patrol') { this.state = 'chase'; this.lostT = 0; }
      this.lastKnown.copy(pos);
    },

    getHitMeshes: function (out) {
      if (!this.alive) return out;
      var kids = this.group.children;
      for (var i = 0; i < kids.length; i++) out.push(kids[i]);
      return out;
    },

    /** 枪口世界坐标：右手握枪的枪口（激光从这里发出） */
    muzzleWorld: function (out) {
      var cfg = this.cfg;
      var s = cfg.scale;
      this.group.updateMatrixWorld(true);          // 保证用的是本帧的手臂姿态
      if (this.armR) {
        out.set(0, -0.62 * s, cfg.gun ? cfg.gun.len * s * 1.05 : 0.3 * s);
        return this.armR.localToWorld(out);
      }
      out.set(0, 1.45 * s, 0.3 * s);
      return this.group.localToWorld(out);
    },

    /** 沿锁定方向发射激光（短距离光束，被墙挡住则只画光束） */
    fireLaser: function (ctx, lockDir) {
      var cfg = this.cfg;
      var L = cfg.laser;
      if (!L) return;
      var g = this.group;
      this.muzzleWorld(_muzzle);
      this.lastShotOrigin.copy(_muzzle);

      var beams = L.beams || 1;
      var spread = L.spread || 0;
      var hitPlayer = false;
      var farthest = -1;

      for (var b = 0; b < beams; b++) {
        var dir = _shotDir.copy(lockDir);
        if (spread > 0 && beams > 1) {
          var off = (b - (beams - 1) / 2) * spread;
          dir.x += -lockDir.z * off;
          dir.z += lockDir.x * off;
          dir.normalize();
        }
        // 墙体遮挡：光束到墙为止
        var far = L.range;
        if (ctx.world.rayDist) {
          var wall = ctx.world.rayDist(_muzzle, dir, L.range);
          if (wall !== null && wall < far) far = wall;
        }
        if (rayHitsPlayer(_muzzle, dir, far, ctx.player.pos)) hitPlayer = true;
        if (far > farthest) {
          farthest = far;
          _shotEnd.copy(_muzzle).addScaledVector(dir, Math.max(0.4, far));
        }
      }

      // 画光束（世界坐标 → group 局部）：外层辉光 + 实心内芯
      _shotMid.copy(_muzzle).add(_shotEnd).multiplyScalar(0.5);
      var len = _muzzle.distanceTo(_shotEnd);
      g.worldToLocal(_shotMid);
      this.beam.position.copy(_shotMid);
      this.beam.scale.set(L.width, L.width, Math.max(0.1, len));
      this.beam.rotation.set(0, Math.atan2(lockDir.x, lockDir.z), 0);
      this.beam.visible = true;
      this.beam.material.opacity = 0.95;
      this.beamCore.position.copy(_shotMid);
      this.beamCore.scale.set(L.width * 0.38, L.width * 0.38, Math.max(0.1, len));
      this.beamCore.rotation.copy(this.beam.rotation);
      this.beamCore.visible = true;
      this.beamT = 0.1;

      P.burst(_muzzle, { count: 6, color: 'spark', speed: 5, life: 0.25, size: 0.05, spread: 1, gravity: 0 });

      this.shotsFired++;
      if (hitPlayer && ctx.onDamagePlayer) ctx.onDamagePlayer(L.dmg, this);
      this.laserCd = L.cd * (0.85 + Math.random() * 0.3);
    },

    updateAimLine: function () {
      var cfg = this.cfg;
      var L = cfg.laser;
      if (!L) return;
      var g = this.group;
      this.muzzleWorld(_muzzle);
      var len = Math.min(L.range, 60);
      _shotMid.copy(_muzzle).addScaledVector(this.aimDir, len * 0.5);
      g.worldToLocal(_shotMid);
      this.aimLine.position.copy(_shotMid);
      this.aimLine.scale.set(0.022, 0.022, len);
      this.aimLine.rotation.set(0, Math.atan2(this.aimDir.x, this.aimDir.z), 0);
      this.aimLine.visible = true;
      var k = 1 - Math.max(0, this.aimT) / Math.max(0.01, L.telegraph);
      this.aimLine.material.opacity = 0.22 + 0.4 * k;
    },

    /** 自爆 */
    explodeNow: function (ctx) {
      var E = this.cfg.explode;
      var pos = this.group.position;
      var p = new THREE.Vector3(pos.x, pos.y + 1.0, pos.z);
      P.burst(p, { count: 40, color: 'blood', speed: 11, life: 0.7, size: 0.11, spread: 1.2, gravity: -6 });
      P.burst(p, { count: 22, color: 'debris', speed: 8, life: 0.9, size: 0.13, spread: 1, gravity: -10 });
      P.burst(new THREE.Vector3(pos.x, pos.y + 0.9, pos.z), { count: 14, color: 'smoke', speed: 3.4, life: 1.2, size: 0.22, spread: 1, gravity: -0.8 });

      var d = ctx.player.pos.distanceTo(pos);
      if (d < E.radius && ctx.onDamagePlayer) {
        var dmg = Math.max(6, Math.round(E.dmg * (1 - (d / E.radius) * 0.55)));
        ctx.onDamagePlayer(dmg, this);
      }
      // 波及同伴（半个伤害）
      for (var i = 0; i < ctx.enemies.length; i++) {
        var o = ctx.enemies[i];
        if (o === this || !o.alive) continue;
        var od = o.group.position.distanceTo(pos);
        if (od < E.radius) o.damage(E.dmg * 0.5 * (1 - (od / E.radius) * 0.5), 'body', null, null);
      }
      if (ctx.onExplode) ctx.onExplode(this);
      this.die(true);
    },

    /** 推进各种"视觉效果"计时（激光余辉、护盾闪光、出场缩放、受击闪白、死亡动画） */
    advanceVisual: function (dt) {
      var g = this.group;
      if (this.spawnT < 1) {
        this.spawnT = Math.min(1, this.spawnT + dt / 0.45);
        g.scale.setScalar(0.15 + 0.85 * (1 - Math.pow(1 - this.spawnT, 3)));
      }
      if (this.boostT > 0) this.boostT -= dt;
      if (this.beamT > 0) {
        this.beamT -= dt;
        if (this.beamT <= 0) { this.beam.visible = false; this.beamCore.visible = false; }
      }
      if (this.shieldFlash > 0) {
        this.shieldFlash -= dt;
        if (this.shieldMesh) {
          var sf = Math.max(0, this.shieldFlash / 0.18);
          this.shieldMesh.material.emissiveIntensity = 0.35 + sf * 1.5;
        }
      }
      // 受击闪白（之后还原基础自发光）
      if (this.flash >= 0) {
        this.flash = Math.max(0, this.flash - dt);
        var f = this.flash / 0.14;
        for (var i = 0; i < this.mats.length; i++) {
          var mm = this.mats[i];
          var be = mm.userData.baseEmissive, bi = mm.userData.baseEmissiveIntensity;
          mm.emissive.setRGB(be.r * (1 - f) + f, be.g * (1 - f) + f, be.b * (1 - f) + f);
          mm.emissiveIntensity = bi * (1 - f) + f * 1.8;
        }
      }
    },

    /**
     * 训练场"全体停止"用：只推进表现，不运行任何 AI。
     * 活着的敌人原地不动（连转身都没有），但激光余辉/护盾闪光正常收尾。
     */
    updateVisual: function (dt, ctx) {
      if (this.alive) { this.advanceVisual(dt); return; }
      this.update(dt, ctx);          // 已死的走正常流程，把死亡动画放完并置 removable
    },

    update: function (dt, ctx) {
      var cfg = this.cfg;
      var world = ctx.world;
      var g = this.group;

      this.advanceVisual(dt);

      /* ---------------- 死亡动画 ---------------- */
      if (!this.alive) {
        this.deathT += dt;
        var k2 = Math.min(1, this.deathT / 0.55);
        g.rotation.x = -Math.PI / 2 * (1 - Math.pow(1 - k2, 3));
        g.position.y = Math.max(-0.75, (this.deathT - 0.55) * -1.1);
        var fade2 = Math.max(0, 1 - Math.max(0, this.deathT - 0.75) / 0.7);
        for (var j = 0; j < this.mats.length; j++) this.mats[j].opacity = fade2;
        this.glowMat.opacity = this.visorMat.opacity = fade2;
        this.ringMat.opacity = fade2 * 0.6;
        if (this.shieldMesh) this.shieldMesh.material.opacity = fade2;
        if (this.deathT > 1.6) this.removable = true;
        return;
      }

      var pos = g.position;
      var player = ctx.player;
      var staggered = this.stun > 0;
      if (staggered) this.stun -= dt;
      if (this.attackCd > 0) this.attackCd -= dt;
      if (this.windup > 0) this.windup -= dt;
      if (this.laserCd > 0) this.laserCd -= dt;

      /* ---------------- 感知 ---------------- */
      var toPlayer = _v1.subVectors(player.pos, pos);
      var dist = toPlayer.length();
      var seeRange = VIEW_RANGE * (cfg.sight || 1);
      var canSee = false;
      if (player.alive && dist < seeRange) {
        _fwd.set(Math.sin(g.rotation.y), 0, Math.cos(g.rotation.y));
        var flat = _v2.set(toPlayer.x, 0, toPlayer.z).normalize();
        var inFov = _fwd.dot(flat) > FOV_HALF || dist < NEAR_ALWAYS || this.alerted;
        if (inFov) {
          _eye.set(pos.x, pos.y + 1.9 * cfg.scale, pos.z);
          _tgt.set(player.pos.x, player.pos.y + 1.5, player.pos.z);
          if (!world.blocked(_eye, _tgt)) canSee = true;
        }
      }

      if (canSee) {
        this.playerSeen = true;
        this.lastSeenAt = ctx.time;
        this.lastKnown.copy(player.pos);
        this.searchT = 0;
        // 锁敌名额：满员时仍然"发现"玩家（会靠拢），但不进入攻击
        acquireLock(this);
        if (!this.alerted) {
          this.alerted = true;
          this.searchT = 0;
          if (ctx.onAlert) ctx.onAlert(this);          // 声音提示
          alertSquad(this, ctx);                       // 报点：附近队友一起压上来
        }
      } else {
        this.playerSeen = false;
      }

      /* ---------------- 指挥官：治疗 / 加速附近友军 ---------------- */
      if (cfg.heal) {
        this.healCd -= dt;
        if (this.auraMesh) {
          this.auraMesh.material.opacity = 0.14 + 0.1 * Math.sin(ctx.time * 3);
          this.auraMesh.scale.setScalar(1 + 0.04 * Math.sin(ctx.time * 3));
        }
        if (this.healCd <= 0) {
          this.healCd = cfg.heal.cd;
          var healed = 0;
          for (var n = 0; n < ctx.enemies.length; n++) {
            var ally = ctx.enemies[n];
            if (ally === this || !ally.alive) continue;
            if (ally.group.position.distanceTo(pos) > cfg.heal.radius) continue;
            ally.hp = Math.min(ally.maxHp, ally.hp + cfg.heal.amount);
            ally.boostT = cfg.heal.boostTime;
            healed++;
            P.burst(ally.centerPos(new THREE.Vector3()), {
              count: 6, color: 'green', speed: 2.4, life: 0.5, size: 0.06, spread: 1, gravity: 1.5
            });
          }
          if (healed > 0 && FPS.Sfx && FPS.Sfx.heal) { try { FPS.Sfx.heal(); } catch (e) { } }
        }
      }

      /* ---------------- 自爆兵：贴近点火 ---------------- */
      if (cfg.explode) {
        if (!this.fusing && canSee && dist < cfg.explode.trigger) {
          this.fusing = true;
          this.fuseT = cfg.explode.fuse;
        }
        if (this.fusing) {
          this.fuseT -= dt;
          var rate = 6 + (cfg.explode.fuse - this.fuseT) * 14;
          var on = Math.sin(ctx.time * rate) > 0;
          this.glowMat.color.setHex(on ? 0xffffff : 0xff3b52);
          if (this.bombMesh) this.bombMesh.scale.setScalar(on ? 1.35 : 0.9);
          if (this.fuseT <= 0) { this.explodeNow(ctx); return; }
        }
      }

      /* ---------------- 状态机 ---------------- */
      var speed = 0;
      var target = null;
      var faceDir = null;
      var L = cfg.laser;

      if (this.aimT > 0) {
        // 瞄准中：站定、锁定方向、读秒开火
        this.aimT -= dt;
        faceDir = _face.set(this.aimDir.x, 0, this.aimDir.z);
        this.updateAimLine();
        if (this.aimT <= 0) {
          this.aimLine.visible = false;
          // 训练场：敌人不攻击，只当靶子
          // 另外：失去锁敌名额（士兵超员）时把这次蓄能取消，不许开火
          if (FPS.World && FPS.World.passiveEnemies) { this.alerted = false; }
          else if (!this.lockedToPlayer) { /* 名额没了，取消开火 */ }
          else this.fireLaser(ctx, this.aimDir);
        }
      } else if (this.alerted && (this.lockedToPlayer || cfg.key === 'soldier') && !this.fusing) {
        /* 能进到这里的情况：
           · lockedToPlayer —— 拿到锁敌名额（或本身就是不受限制的特殊兵种）→ 正常攻击
           · 没名额的士兵 —— 允许进来，但下面把激光关掉，只保留近战（贴上来打） */
        var passive = !!(FPS.World && FPS.World.passiveEnemies);
        var meleeOk = cfg.melee && canSee && dist < ATTACK_RANGE * cfg.scale && !passive;
        var laserAllowed = this.lockedToPlayer;      // 没名额 → 不射激光
        var wantLaser = laserAllowed && L && canSee && dist <= L.range && dist > 2.6 && this.laserCd <= 0 && !staggered && !passive;

        if (meleeOk) {
          this.state = 'attack';
          faceDir = _face.set(player.pos.x - pos.x, 0, player.pos.z - pos.z);
          if (this.windup > 0) {
            if (this.windup < 0.16 && !this._hitDone) {
              this._hitDone = true;
              if (dist < cfg.melee.range + 1.4 && ctx.onDamagePlayer) ctx.onDamagePlayer(cfg.melee.dmg, this);
            }
          } else if (this.attackCd <= 0 && !staggered) {
            this.attackCd = cfg.melee.cd;
            this.windup = 0.42;
            this._hitDone = false;
            if (ctx.onAttack) ctx.onAttack(this);
          }
          if (dist < 1.5) {
            target = _v1.set(pos.x - (player.pos.x - pos.x), 0, pos.z - (player.pos.z - pos.z));
            speed = cfg.chaseSpeed * 0.45;
          }
        } else if (wantLaser) {
          // 开始蓄能瞄准
          this.aimT = L.telegraph;
          this.aimDir.set(
            player.pos.x - pos.x,
            (player.pos.y + 1.2) - (pos.y + 1.45 * cfg.scale),
            player.pos.z - pos.z
          ).normalize();
          faceDir = _face.set(this.aimDir.x, 0, this.aimDir.z);
          this.updateAimLine();
        } else {
          /* 追丢后的搜索：每 SEARCH_EVERY 秒把搜索点朝自己方向收缩一段，
             一直扫到玩家附近才罢休 —— 躲起来也会被逐渐搜出来。
             原来只会傻站在最后位置，等到 LOST_GIVE_UP 就直接回去巡逻。 */
          if (!canSee) {
            this.searchT += dt;
            if (this.searchT > SEARCH_EVERY) {
              this.searchT = 0;
              _searchDir.subVectors(pos, this.lastKnown);
              var back = _searchDir.length();
              if (back < 3) {                       // 搜到自己脚下了：玩家确实不在这
                this.alerted = false;
                this.state = 'patrol';
                this.waypoint = null;
                releaseLock(this);                  // 放开锁敌名额，让后面的补上
              } else {
                _searchDir.multiplyScalar(SEARCH_STEP / back);
                this.lastKnown.add(_searchDir);      // 搜索点向自己推进 25 米
              }
            }
          }
          if (this.alerted) {
            this.state = 'chase';
            target = this.lastKnown;
            speed = cfg.chaseSpeed;
            if (canSee) faceDir = _face.set(player.pos.x - pos.x, 0, player.pos.z - pos.z);
            this.lostT = canSee ? 0 : this.lostT + dt;
            if (!canSee && this.lostT > LOST_GIVE_UP) {
              this.alerted = false; this.state = 'patrol'; this.waypoint = null;
              releaseLock(this);                    // 放弃追击 → 放开锁敌名额
            }
            // 狙击兵保持距离
            if (L && L.keepDistance && canSee && dist < L.keepDistance) {
              target = _v1.set(pos.x - (player.pos.x - pos.x), 0, pos.z - (player.pos.z - pos.z));
              speed = cfg.chaseSpeed * 0.8;
            }
          } else {
            this.state = 'patrol';
            this.waypoint = null;
          }
        }
      }

      if (!this.alerted) {
        this.state = 'patrol';
        if (!this.waypoint || this.waitT > 0 || pos.distanceTo(this.waypoint) < 1.4) {
          if (this.waitT > 0) {
            this.waitT -= dt;
            faceDir = _face.set(Math.sin(g.rotation.y + 0.6), 0, Math.cos(g.rotation.y + 0.6));
          } else {
            this.waypoint = ctx.pickPatrol(this);
            this.waitT = 0.4 + Math.random() * 1.4;
          }
        }
        if (this.waypoint) { target = this.waypoint; speed = cfg.patrolSpeed; }
      }

      /* ---------------- 移动 ---------------- */
      var aiming = this.aimT > 0;
      if (target && speed > 0 && !staggered && !aiming && !this.fusing) {
        var dir = _dirv.set(target.x - pos.x, 0, target.z - pos.z);
        var dl = dir.length();
        if (dl > 0.001) dir.multiplyScalar(1 / dl);

        if (this.detourT > 0) {
          this.detourT -= dt;
          dir.set(this.detourX, 0, this.detourZ);
        } else {
          this.avoidT -= dt;
          if (this.avoidT <= 0) {
            this.avoidT = 0.12 + Math.random() * 0.1;
            var probe = 1.7;
            _p0.set(pos.x, pos.y + 1.55, pos.z);
            _p1.set(pos.x + dir.x * probe, pos.y + 1.55, pos.z + dir.z * probe);
            if (world.blocked(_p0, _p1)) {
              var side = this.avoidDir;
              _eye.set(pos.x + (dir.x * 0.35 - dir.z * side) * probe, pos.y + 1.55, pos.z + (dir.z * 0.35 + dir.x * side) * probe);
              if (!world.blocked(_p0, _eye)) dir.set(_eye.x - pos.x, 0, _eye.z - pos.z).normalize();
              else this.avoidDir = -side;
            }
          }
        }

        var speedMul = this.boostT > 0 ? 1.28 : 1;
        var step = speed * speedMul * dt;
        var before = _before.set(pos.x, 0, pos.z);
        pos.x += dir.x * step;
        pos.z += dir.z * step;
        if (!faceDir) faceDir = dir;
        this.moveDist += step;

        var others = ctx.enemies;
        for (var q = 0; q < others.length; q++) {
          var o = others[q];
          if (o === this || !o.alive) continue;
          var ox = pos.x - o.group.position.x, oz = pos.z - o.group.position.z;
          var od2 = ox * ox + oz * oz;
          var minD = this.radius + o.radius + 0.25;
          if (od2 > 0.0001 && od2 < minD * minD) {
            var od = Math.sqrt(od2);
            var push = (minD - od) * 0.5;
            pos.x += (ox / od) * push;
            pos.z += (oz / od) * push;
          }
        }

        var moved = Math.sqrt((pos.x - before.x) * (pos.x - before.x) + (pos.z - before.z) * (pos.z - before.z));
        if (moved < step * 0.25) this.stuckT += dt;
        else this.stuckT = Math.max(0, this.stuckT - dt * 2);
        if (this.stuckT > 1.3) {
          this.stuckT = 0;
          this.avoidDir = -this.avoidDir;
          if (this.state === 'patrol') this.waypoint = null;
          else {
            var s2 = this.avoidDir;
            _p0.set(pos.x, pos.y + 1.55, pos.z);
            _eye.set(pos.x - dir.z * s2 * 2.2, pos.y + 1.55, pos.z + dir.x * s2 * 2.2);
            var okLeft = !world.blocked(_p0, _eye);
            this.detourX = okLeft ? -dir.z * s2 : dir.z * s2;
            this.detourZ = okLeft ? dir.x * s2 : -dir.x * s2;
            this.detourT = 0.75;
          }
        }
      }

      var ground = world.resolve(pos, this.radius, this.height);
      if (pos.y > ground + 0.02) pos.y = Math.max(ground, pos.y - 9 * dt);
      else pos.y = ground;

      if (faceDir && (faceDir.x || faceDir.z)) {
        var want = Math.atan2(faceDir.x, faceDir.z);
        var diff = want - g.rotation.y;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        // 转身速度按兵种区分：护盾兵很慢，方便绕到背后打
        var turn = (cfg.turn || 7) * (aiming ? 1.5 : 1);
        g.rotation.y += diff * Math.min(1, dt * turn);
      }

      /* ---------------- 幻影兵：隐身 ---------------- */
      if (cfg.cloak) {
        var wantOp = (dist < cfg.cloak.nearDist || aiming || this.flash > 0 || this.beamT > 0) ? 1 : cfg.cloak.far;
        this.cloakOpacity += (wantOp - this.cloakOpacity) * Math.min(1, dt * 4);
        for (var c = 0; c < this.mats.length; c++) this.mats[c].opacity = this.cloakOpacity;
        this.glowMat.opacity = Math.min(1, this.cloakOpacity + 0.25);
        this.visorMat.opacity = Math.min(1, this.cloakOpacity + 0.35);
      }

      /* ---------------- 动画与状态色 ---------------- */
      var moving = (target && speed > 0 && !staggered && !aiming && !this.fusing) ? 1 : 0;
      this.walkPhase += dt * (moving ? speed * 2.1 : 2);
      var sw = moving ? Math.sin(this.walkPhase) * 0.55 : 0;
      this.legL.rotation.x = sw;
      this.legR.rotation.x = -sw;
      var attackPose = this.windup > 0 ? Math.sin((1 - this.windup / 0.42) * Math.PI) : 0;
      var aimPose = aiming ? 1 : 0;
      this.armL.rotation.x = -sw * 0.7 - attackPose * 1.5 - aimPose * 1.35;
      this.armR.rotation.x = sw * 0.7 - attackPose * 1.5 - aimPose * 1.35;
      g.rotation.z = Math.sin(this.walkPhase * 0.5) * (moving ? 0.03 : 0.012);

      var hot = this.alerted || this.state === 'attack' || this.state === 'chase';
      var pulse = 0.55 + 0.45 * Math.sin(ctx.time * (hot ? 9 : 2.6));
      if (staggered) pulse = 1;
      this.visorMat.color.setHex(hot ? 0xff3b52 : cfg.look.visor);
      this.glowMat.color.setHex(hot ? 0xff6a5c : cfg.look.core);
      this.glowMat.color.multiplyScalar(0.6 + pulse * 0.4);
      this.ringMat.color.setHex(hot ? 0xff3b52 : 0x35e08a);
      this.ringMat.opacity = (cfg.cloak ? 0.2 + 0.35 * this.cloakOpacity : 0.35 + pulse * 0.28);
    }
  };

  FPS.Enemy = Enemy;
  FPS.EnemyTypes = TYPES;
  FPS.EnemyOrder = ORDER;
  FPS.typesForWave = typesForWave;
  FPS.newTypesAtWave = newTypesAtWave;
  /* 测试用：直接跑一次"报点"（与感知里发现在那一刻调用的是同一个函数），
     这样可以在不受地图遮挡影响的前提下验证全队联动。 */
  FPS.debugAlertSquad = alertSquad;
})();
