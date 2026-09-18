/* =====================================================================
   三角形级精确碰撞（BVH）—— 方案 B
   ---------------------------------------------------------------------
   零依赖、经典脚本、挂到 window.FPS.BVH。

   为什么自己写：three-mesh-bvh 是 ESM 包，本项目前端是"无构建的经典
   <script>"，引进来还得改包；而这里的查询只有两种（球 vs 三角面最近点、
   球 vs 三角面集合），自己写 ~200 行更省事，也便于按需加"只取水平面 / 只取
   竖直面"这类游戏逻辑。

   ┌ 结构 ─────────────────────────────────────────────────────────┐
   │ nodes: 扁平的 Float32Array，每节点 8 个数                        │
   │        [minx,miny,minz, maxx,maxy,maxz, A, B]                  │
   │        · 内部节点：B = -1 - 右子id（负数），A = 左子id            │
   │        · 叶子：    B = 三角面数（≥1），A = order 里的起始下标      │
   │ order: Int32Array，三角形索引的排列（建树时原地划分，不复制面片）  │
   │ tri:   Float32Array，9 个数一个三角形（ax ay az bx by bz cx cy cz）│
   │ boxes: 浅层包围盒（float 数组），给实例级粗筛用                    │
   └───────────────────────────────────────────────────────────────┘
   划分策略：每次按"最长轴"的**空间中点**切分（kd 风格），退化时退回质心中位数；
             叶子 ≤ LEAF 个三角面。

   为什么用空间中点而不是常见的"质心中位数"：真实模型是"表面"（面片远小于模型
   尺寸），中点切分能让两个子包围盒基本不重叠、体积每层减半，查询时的球-AABB
   剪枝才真正有效（实测 4.3 万面的建筑网格、玩家半径 0.42 米时，每次查询只碰
   约 3 个节点、1.5 微秒）。质心中位数在"面片散在体积里"的网格上会让子盒仍覆盖
   整块空间，查询退化到几乎遍历全树 —— 所以两条路都留着，退化时自动改用中位数
   保证平衡。

   坐标系约定：BVH 建在**模型局部空间**（与实例 holder 的局部坐标系一致）。
   放多个实例不会多占内存：查询时把球心用 holder 的逆矩阵变换到局部空间即可。
   ===================================================================== */
window.FPS = window.FPS || {};

(function () {
  'use strict';

  var BVH = (FPS.BVH = {});

  var LEAF = 8;              // 叶子最多 8 个三角面（再小收益不明显、建树变慢）
  var MAX_DEPTH = 48;        // 防御性上限：退化的共面网格不会无限递归

  /* ---------------------------------------------------------------
     遍历一个 Object3D 下的所有三角面（世界坐标）
     cb(ax,ay,az, bx,by,bz, cx,cy,cz)
     体素化 / 天花板图 / BVH 建树共用这一份提取逻辑，避免三处各写一遍。
     --------------------------------------------------------------- */
  BVH.eachTriangle = function (src, cb) {
    src.updateWorldMatrix(true, true);
    var v = new THREE.Vector3();
    src.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var g = o.geometry, pos = g.attributes && g.attributes.position;
      if (!pos) return;
      var idx = g.index, m = o.matrixWorld;
      var n = idx ? idx.count : pos.count;
      for (var i = 0; i + 2 < n; i += 3) {
        var a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (var k = 0; k < 3; k++) {
          var vi = idx ? idx.getX(i + k) : (i + k);
          v.fromBufferAttribute(pos, vi).applyMatrix4(m);
          a[k * 3] = v.x; a[k * 3 + 1] = v.y; a[k * 3 + 2] = v.z;
        }
        cb(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]);
      }
    });
  };

  /* ---------------------------------------------------------------
     建树
     返回 { ok, nodes, order, tri, count, boxes[], triCount, depth }
     boxes / count 都是**唯一**包围盒（位置连续出现时合并），
     查询时先用它在世界空间粗筛，绝大多数实例一次都不用进树。
     --------------------------------------------------------------- */
  BVH.buildFromSource = function (src, opts) {
    opts = opts || {};
    var leaf = opts.leaf || LEAF;
    var tris = [];            // 9 个数一个三角形

    BVH.eachTriangle(src, function (ax, ay, az, bx, by, bz, cx, cy, cz) {
      tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    });

    var n = tris.length / 9;
    if (!n) return { ok: false, count: 0, triCount: 0, boxes: [] };

    var tri = new Float32Array(tris);
    var cx = new Float32Array(n), cy = new Float32Array(n), cz = new Float32Array(n);
    var tmin = new Float32Array(n * 3), tmax = new Float32Array(n * 3);
    var i, o;
    for (i = 0; i < n; i++) {
      o = i * 9;
      var ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
      var bx = tri[o + 3], by = tri[o + 4], bz = tri[o + 5];
      var ccx = tri[o + 6], ccy = tri[o + 7], ccz = tri[o + 8];
      var x0 = Math.min(ax, bx, ccx), x1 = Math.max(ax, bx, ccx);
      var y0 = Math.min(ay, by, ccy), y1 = Math.max(ay, by, ccy);
      var z0 = Math.min(az, bz, ccz), z1 = Math.max(az, bz, ccz);
      tmin[i * 3] = x0; tmin[i * 3 + 1] = y0; tmin[i * 3 + 2] = z0;
      tmax[i * 3] = x1; tmax[i * 3 + 1] = y1; tmax[i * 3 + 2] = z1;
      cx[i] = (ax + bx + ccx) / 3; cy[i] = (ay + by + ccy) / 3; cz[i] = (az + bz + ccz) / 3;
    }

    var order = new Int32Array(n);
    for (i = 0; i < n; i++) order[i] = i;

    // 先建"节点对象树"，最后再按前序压平成两个定长数组。
    // 为什么分两步：节点的编号必须满足"右子树 = 左子树下标 + 左子树节点数"，
    // 而递归过程中节点是随建随分配的（顺序不可控）。压平时自己编号最稳。
    var boxes = [];                      // 浅层包围盒，给世界空间粗筛用
    var maxDepth = 0;

    /* 算 [lo,hi) 区间的包围盒 + 最长轴 */
    function bound(lo, hi) {
      var mnx = Infinity, mny = Infinity, mnz = Infinity;
      var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (var q = lo; q < hi; q++) {
        var t = order[q] * 3;
        if (tmin[t] < mnx) mnx = tmin[t];
        if (tmin[t + 1] < mny) mny = tmin[t + 1];
        if (tmin[t + 2] < mnz) mnz = tmin[t + 2];
        if (tmax[t] > mxx) mxx = tmax[t];
        if (tmax[t + 1] > mxy) mxy = tmax[t + 1];
        if (tmax[t + 2] > mxz) mxz = tmax[t + 2];
      }
      return { minx: mnx, miny: mny, minz: mnz, maxx: mxx, maxy: mxy, maxz: mxz };
    }

    /* 只保留浅层（前几级）的包围盒做粗筛：整棵树有几千个节点，
       全记下来既费内存又没意义 —— 粗筛只需要几个"大块"。
       每个实例的粗筛盒数 ≤ 2^COARSE_DEPTH。 */
    var COARSE_DEPTH = 4;
    function pushBox(b, depth) {
      if (depth > COARSE_DEPTH) return;
      var k = boxes.length;
      if (k >= 6) {
        // 与上一个盒子完全相同 → 合并（同一段 order 常常重复出现同一个盒子）
        var p = k - 6;
        if (boxes[p] === b.minx && boxes[p + 1] === b.miny && boxes[p + 2] === b.minz &&
            boxes[p + 3] === b.maxx && boxes[p + 4] === b.maxy && boxes[p + 5] === b.maxz) {
          return;
        }
      }
      boxes.push(b.minx, b.miny, b.minz, b.maxx, b.maxy, b.maxz);
    }

    /* 阶段一：递归建出节点对象树（子节点用对象引用，不关心编号） */
    function buildTree(lo, hi, depth) {
      var b = bound(lo, hi);
      pushBox(b, depth);
      if (depth > maxDepth) maxDepth = depth;
      var node = { box: b, left: null, right: null };

      var cnt = hi - lo;
      if (cnt <= leaf || depth >= MAX_DEPTH) {
        node.start = lo;                          // 叶子：order 起点
        node.count = cnt;                         // 叶子：三角面数（≥1）
        return node;
      }

      // 最长轴
      var ex = b.maxx - b.minx, ey = b.maxy - b.miny, ez = b.maxz - b.minz;
      var axis = 0;
      if (ey > ex && ey >= ez) axis = 1;
      else if (ez > ex && ez > ey) axis = 2;
      var arr = axis === 0 ? cx : (axis === 1 ? cy : cz);
      var split = axis === 0 ? (b.minx + b.maxx) / 2 : (axis === 1 ? (b.miny + b.maxy) / 2 : (b.minz + b.maxz) / 2);

      /* 空间切分（kd 风格）：按最长轴的**中点**把三角形分到两边。
         这样两个子节点的包围盒互不重叠、体积每层减半 —— 查询时的球-AABB
         剪枝才真正有效。
         质心中位数切分（另一种常见做法）在"面片散在体积里"的网格上很差：
         子盒仍然覆盖整块空间，查询会退化到几乎遍历全树。
         切分退化时（有一边空 / 一边占了 95% 以上）退回中位数切分，保证平衡。 */
      var mid = partitionByAxis(arr, order, lo, hi, split);
      if (mid <= lo || mid >= hi) {
        mid = lo + (cnt >> 1);
        quickSelect(arr, order, lo, hi - 1, mid);
      } else if ((mid - lo) > cnt * 0.95 || (hi - mid) > cnt * 0.95) {
        mid = lo + (cnt >> 1);
        quickSelect(arr, order, lo, hi - 1, mid);
      }

      node.left = buildTree(lo, mid, depth + 1);
      node.right = buildTree(mid, hi, depth + 1);
      return node;
    }

    /* 阶段二：前序压平成 Float32Array，每个节点 8 个数：
         [minx,miny,minz, maxx,maxy,maxz, A, B]
         · 内部节点：A = 左子树 id，B = 右子树 id
         · 叶子：    A = 该叶子在 order 里的起点，B = 三角面数（≥1）
       两种含义靠 B 的符号区分：B = -1/其它负数 → 内部节点？不 —— 这里更直接：
       内部节点的 B 是"节点 id"（≥1 且 < 节点总数），叶子的 B 是面数（≥1）。
       为了不产生歧义，统一用**负号标记内部节点**：内部节点 B = -1 - 右子 id。
       （这样 A、B 都可以直接取用，且叶子的 B 永远 > 0。） */
    var root = buildTree(0, n, 0);
    var total = 0;
    (function countNodes(nd) { total++; if (nd.right) { countNodes(nd.left); countNodes(nd.right); } })(root);
    var nodes = new Float32Array(total * 8);
    var counter = { n: 0 };
    (function flatten(nd) {
      var id = counter.n++;                       // 本节点 id（前序）
      var p = id * 8;
      nodes[p] = nd.box.minx; nodes[p + 1] = nd.box.miny; nodes[p + 2] = nd.box.minz;
      nodes[p + 3] = nd.box.maxx; nodes[p + 4] = nd.box.maxy; nodes[p + 5] = nd.box.maxz;
      if (!nd.right) {                            // 叶子
        nodes[p + 6] = nd.start;
        nodes[p + 7] = nd.count;                  // ≥ 1
        return;
      }
      // 内部节点：两个子树的 id 必须在递归之前算好并写入，否则会被递归
      // 过程中已经占用的槽覆盖掉（曾经就在这里踩坑）。
      var leftId = counter.n;
      var rightId = leftId + nodeSize(nd.left);   // 前序：右子排在整棵左子树之后
      nodes[p + 6] = leftId;
      nodes[p + 7] = -1 - rightId;                // 负数 = 内部节点，绝对值编码右子 id
      flatten(nd.left);
      flatten(nd.right);
    })(root);

    return { ok: true, nodes: nodes, order: order, tri: tri, count: n,
             boxes: boxes, triCount: n, depth: maxDepth, nodeCount: total };
  };

  /** 子树节点数（压平时算右子 id 用；只数一次，成本可忽略） */
  function nodeSize(nd) {
    if (!nd.right) return 1;
    return 1 + nodeSize(nd.left) + nodeSize(nd.right);
  }

  /** 按坐标值把 [lo,hi) 分成 < split 与 >= split 两段，返回分界下标 */
  function partitionByAxis(arr, order, lo, hi, split) {
    var i = lo, j = hi - 1;
    while (i <= j) {
      if (arr[order[i]] < split) { i++; continue; }
      var t = order[i]; order[i] = order[j]; order[j] = t;
      j--;
    }
    return i;
  }

  /* 原地快速选择：把 [lo,hi] 里第 k 小的元素排到 k 位置（左右不要求有序） */
  function quickSelect(arr, order, lo, hi, k) {
    while (lo < hi) {
      var pivot = arr[order[(lo + hi) >> 1]];
      var i = lo, j = hi;
      while (i <= j) {
        while (arr[order[i]] < pivot) i++;
        while (arr[order[j]] > pivot) j--;
        if (i <= j) {
          var t = order[i]; order[i] = order[j]; order[j] = t;
          i++; j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  /* ---------------------------------------------------------------
     查询：球（球心 p，半径 r）与所有三角面的最近点
     mode: 0 全部   1 只算竖直面（法线水平，用来做"侧向挡住"）
           2 只算水平面（法线竖直，用来做"站在屋顶/地面"）
     返回 null 或 { dist, qx,qy,qz, nx,ny,nz, mx,my,mz }
       · q = 三角面上离球心最近的点
       · n = 该三角面的单位法线（**朝向球心**，即向外推出方向）
       · m = 该三角面的质心
     --------------------------------------------------------------- */
  BVH.closestPoint = function (b, px, py, pz, r, mode, out) {
    if (!b || !b.ok) return null;
    var nodes = b.nodes, order = b.order, tri = b.tri;
    var r2 = r * r;
    var best = out || { dist: 0, qx: 0, qy: 0, qz: 0, nx: 0, ny: 1, nz: 0, mx: 0, my: 0, mz: 0 };
    best.dist = Infinity;

    // 栈用普通数组（显式栈，避免递归 + 便于提前剪枝）
    var stack = [0];
    var guard = 0;
    var nodeCount = nodes.length / 8;
    while (stack.length) {
      var id = stack.pop();
      if (guard++ > 400000) throw new Error('BVH 遍历异常：步数超限（树可能损坏）');
      if (!(id >= 0) || id >= nodeCount) continue;      // 越界保护：坏节点直接跳过
      var p = id * 8;
      // 包围盒粗筛（球 vs AABB），没交集直接剪掉整个子树
      var dx = px < nodes[p] ? nodes[p] - px : (px > nodes[p + 3] ? px - nodes[p + 3] : 0);
      var dy = py < nodes[p + 1] ? nodes[p + 1] - py : (py > nodes[p + 4] ? py - nodes[p + 4] : 0);
      var dz = pz < nodes[p + 2] ? nodes[p + 2] - pz : (pz > nodes[p + 5] ? pz - nodes[p + 5] : 0);
      if (dx * dx + dy * dy + dz * dz > r2) continue;

      var left = nodes[p + 6], cnt = nodes[p + 7];
      if (cnt < 0) {
        // 内部节点：B = -1 - 右子 id，A = 左子 id
        stack.push(left); stack.push(-1 - cnt);
      } else if (cnt > 0) {
        // 叶子：left = order 起点，cnt = 三角面数
        var start = left;
        for (var q = start; q < start + cnt; q++) {
          var t = order[q] * 9;
          var ax = tri[t], ay = tri[t + 1], az = tri[t + 2];
          var bx = tri[t + 3], by = tri[t + 4], bz = tri[t + 5];
          var ccx = tri[t + 6], ccy = tri[t + 7], ccz = tri[t + 8];

          // 面法线（叉积），顺手判断朝向
          var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
          var e2x = ccx - ax, e2y = ccy - ay, e2z = ccz - az;
          var nx = e1y * e2z - e1z * e2y;
          var ny = e1z * e2x - e1x * e2z;
          var nz = e1x * e2y - e1y * e2x;
          var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nl < 1e-12) continue;                     // 退化三角面
          nx /= nl; ny /= nl; nz /= nl;

          if (mode === 1 && Math.abs(ny) > 0.7) continue;      // 只要竖直面
          if (mode === 2 && Math.abs(ny) < 0.7) continue;      // 只要水平面

          // 球心到三角面的最近点（Ericson《Real-Time Collision Detection》5.1.5 的
          // 完整 Voronoi 区域法：7 个区域逐个判断，点在面内时投影到三角面上）
          var qx, qy, qz;
          var abx = bx - ax, aby = by - ay, abz = bz - az;
          var acx = ccx - ax, acy = ccy - ay, acz = ccz - az;
          var apx = px - ax, apy = py - ay, apz = pz - az;
          var d1 = abx * apx + aby * apy + abz * apz;
          var d2 = acx * apx + acy * apy + acz * apz;
          if (d1 <= 0 && d2 <= 0) {
            qx = ax; qy = ay; qz = az;                          // 顶点 A 区域
          } else {
            var bpx = px - bx, bpy = py - by, bpz = pz - bz;
            var d3 = abx * bpx + aby * bpy + abz * bpz;
            var d4 = acx * bpx + acy * bpy + acz * bpz;
            if (d3 >= 0 && d4 <= d3) {
              qx = bx; qy = by; qz = bz;                        // 顶点 B 区域
            } else {
              var vc = d1 * d4 - d3 * d2;
              if (vc <= 0 && d1 >= 0 && d3 <= 0) {
                var v1 = d1 / (d1 - d3);                        // 边 AB
                qx = ax + abx * v1; qy = ay + aby * v1; qz = az + abz * v1;
              } else {
                var cpx = px - ccx, cpy = py - ccy, cpz = pz - ccz;
                var d5 = abx * cpx + aby * cpy + abz * cpz;
                var d6 = acx * cpx + acy * cpy + acz * cpz;
                if (d6 >= 0 && d5 <= d6) {
                  qx = ccx; qy = ccy; qz = ccz;                 // 顶点 C 区域
                } else {
                  var vb = d5 * d2 - d1 * d6;
                  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                    var w1 = d2 / (d2 - d6);                    // 边 AC
                    qx = ax + acx * w1; qy = ay + acy * w1; qz = az + acz * w1;
                  } else {
                    var va = d3 * d6 - d5 * d4;
                    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
                      var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));   // 边 BC
                      qx = bx + (ccx - bx) * w2; qy = by + (ccy - by) * w2; qz = bz + (ccz - bz) * w2;
                    } else {
                      // 面内区域：投影到三角面（u/v/w 是三个顶点的重心权重）
                      var den = 1 / (va + vb + vc);
                      var v3 = vb * den, w3 = vc * den;
                      qx = ax + abx * v3 + acx * w3;
                      qy = ay + aby * v3 + acy * w3;
                      qz = az + abz * v3 + acz * w3;
                    }
                  }
                }
              }
            }
          }

          var ddx = px - qx, ddy = py - qy, ddz = pz - qz;
          var d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 > r2 || d2 >= best.dist * best.dist) continue;

          // 法线朝向球心（背面朝里时翻一下）
          if (nx * ddx + ny * ddy + nz * ddz < 0) { nx = -nx; ny = -ny; nz = -nz; }
          best.dist = Math.sqrt(d2);
          best.qx = qx; best.qy = qy; best.qz = qz;
          best.nx = nx; best.ny = ny; best.nz = nz;
          best.mx = (ax + bx + ccx) / 3; best.my = (ay + by + ccy) / 3; best.mz = (az + bz + ccz) / 3;
        }
      }
    }
    return best.dist === Infinity ? null : best;
  };

  /** 点是否落在三角面内（保留：给"脚下这块地是不是水平的"之类的快速判断用） */
  function pointInTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz) {
    var v1x = px - ax, v1y = py - ay, v1z = pz - az;
    var v2x = px - bx, v2y = py - by, v2z = pz - bz;
    var v3x = px - cx, v3y = py - cy, v3z = pz - cz;
    // 三个顶点在同一侧的判定：v1-v2 / v2-v3 / v3-v1 与法线同向
    var a = (v1y * v2z - v1z * v2y) * nx + (v1z * v2x - v1x * v2z) * ny + (v1x * v2y - v1y * v2x) * nz;
    if (a < 0) return false;
    var b = (v2y * v3z - v2z * v3y) * nx + (v2z * v3x - v2x * v3z) * ny + (v2x * v3y - v2y * v3x) * nz;
    if (b < 0) return false;
    var c = (v3y * v1z - v3z * v1y) * nx + (v3z * v1x - v3x * v1z) * ny + (v3x * v1y - v3y * v1x) * nz;
    return c >= 0;
  }

  /** 点到线段最近点（保留：拾取 / 调试时按需使用） */
  function closestOnSeg(px, py, pz, ax, ay, az, bx, by, bz) {
    var abx = bx - ax, aby = by - ay, abz = bz - az;
    var t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) /
            Math.max(1e-12, abx * abx + aby * aby + abz * abz);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var x = ax + abx * t, y = ay + aby * t, z = az + abz * t;
    var dx = px - x, dy = py - y, dz = pz - z;
    return { x: x, y: y, z: z, d2: dx * dx + dy * dy + dz * dz };
  }
  BVH.pointInTriangle = pointInTriangle;
  BVH.closestOnSeg = closestOnSeg;

  /* ================= 屋内实心：点在实体内部判定 + 推出去 =================
     需求：**建筑一律进不去**（室内装饰已放弃，不需要门）。
     难点：模型不一定封闭（比如"小镇街道"有真正通透的门洞，16 个方向里有 13 个
     能直接走进去）。只靠"表面推出"挡不住开口。
     做法：奇偶法则 —— 从待测点往四周打射线，命中的表面片数是奇数 → 点在实体内部；
     再沿"到表面最短的那条射线"方向把人推出去。等价于把模型当成实心体，
     所以有没有门都一样进不去。
     参数用**局部空间**（查询前自己把点用 holder 逆矩阵变换过来）。
     ===================================================================== */
  // 26 个方向（6 轴 + 12 面心对角 + 8 体对角），方向分布够均匀
  var DIRS = (function () {
    var out = [], i, j, k;
    for (i = -1; i <= 1; i++) for (j = -1; j <= 1; j++) for (k = -1; k <= 1; k++) {
      if (!i && !j && !k) continue;
      var l = Math.sqrt(i * i + j * j + k * k);
      out.push([i / l, j / l, k / l]);
    }
    return out;
  })();

  /**
   * 一次遍历，同时给出该方向上的**所有交点**：
   *   hits = 命中距离数组（升序），extra = 命中数统计
   * 每个叶子只走一趟，比"打一枪数一段"便宜一个数量级。
   */
  function rayCrossings(b, ox, oy, oz, dx, dy, dz, maxDist, out) {
    var nodes = b.nodes, order = b.order, tri = b.tri;
    var nodeCount = nodes.length / 8;
    var n = 0;
    var stack = [0];
    var o = [ox, oy, oz], d = [dx, dy, dz];
    while (stack.length) {
      var id = stack.pop();
      if (!(id >= 0) || id >= nodeCount) continue;
      var p = id * 8;
      // 射线 vs AABB（slab 法）
      var t0 = 0, t1 = maxDist, okBox = true;
      for (var ax = 0; ax < 3 && okBox; ax++) {
        var oo = o[ax], dd = d[ax], mn = nodes[p + ax], mx = nodes[p + 3 + ax];
        if (Math.abs(dd) < 1e-12) {
          if (oo < mn || oo > mx) okBox = false;
        } else {
          var inv = 1 / dd;
          var ta = (mn - oo) * inv, tb = (mx - oo) * inv;
          if (ta > tb) { var tmp = ta; ta = tb; tb = tmp; }
          if (ta > t0) t0 = ta;
          if (tb < t1) t1 = tb;
          if (t0 > t1) okBox = false;
        }
      }
      if (!okBox) continue;

      var left = nodes[p + 6], cnt = nodes[p + 7];
      if (cnt < 0) { stack.push(left); stack.push(-1 - cnt); continue; }
      for (var q = left; q < left + cnt; q++) {
        var t = order[q] * 9;
        var ax0 = tri[t], ay0 = tri[t + 1], az0 = tri[t + 2];
        var e1x = tri[t + 3] - ax0, e1y = tri[t + 4] - ay0, e1z = tri[t + 5] - az0;
        var e2x = tri[t + 6] - ax0, e2y = tri[t + 7] - ay0, e2z = tri[t + 8] - az0;
        var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        var det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        var invd = 1 / det;
        var tx = ox - ax0, ty = oy - ay0, tz = oz - az0;
        var u = (tx * px + ty * py + tz * pz) * invd;
        if (u < 0 || u > 1) continue;
        var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        var vv = (dx * qx + dy * qy + dz * qz) * invd;
        if (vv < 0 || u + vv > 1) continue;
        var tt = (e2x * qx + e2y * qy + e2z * qz) * invd;
        if (tt > 1e-5 && tt < maxDist && n < out.length) out[n++] = tt;
      }
    }
    // 只取最近的几个就够用（排序小数组，长度一般 < 8）
    for (var a = 1; a < n; a++) {
      var key = out[a], bb = a - 1;
      while (bb >= 0 && out[bb] > key) { out[bb + 1] = out[bb]; bb--; }
      out[bb + 1] = key;
    }
    return n;
  }

  var _cross = new Float32Array(64);

  /**
   * 点是否在实体内部（奇偶法则）。
   * 每条方向看**最近交点之后是否还有交点**：有 → 这条射线穿过了实体的"外侧壁"，
   * 说明起点在里面。取多数方向投票，开口/自交模型也不会误判成"墙"。
   */
  BVH.insidePoint = function (b, x, y, z, maxDist) {
    if (!b || !b.ok) return false;
    var insideVotes = 0, total = 0;
    for (var i = 0; i < DIRS.length; i++) {
      var d = DIRS[i];
      var n = rayCrossings(b, x, y, z, d[0], d[1], d[2], maxDist, _cross);
      if (!n) continue;                       // 这个方向没打到面：不投票
      total++;
      if (n % 2 === 1) insideVotes++;         // 奇数个交点 = 从内部射出
    }
    if (!total) return false;
    return insideVotes * 2 > total;
  };

  /** 从内部找最近出口：返回最短射线方向与距离（局部空间） */
  BVH.escape = function (b, x, y, z, maxDist) {
    if (!b || !b.ok) return null;
    var bestCost = Infinity, bestDist = Infinity, bi = -1;
    for (var i = 0; i < DIRS.length; i++) {
      var d = DIRS[i];
      var n = rayCrossings(b, x, y, z, d[0], d[1], d[2], maxDist, _cross);
      if (!n) continue;
      var hit = _cross[0];
      // 往下要略加惩罚：否则容易把人从地板缝里挤出去
      var cost = d[1] < -0.5 ? hit * 1.6 : hit;
      if (cost < bestCost) { bestCost = cost; bestDist = hit; bi = i; }
    }
    if (bi < 0) return null;
    return { dist: bestDist, nx: DIRS[bi][0], ny: DIRS[bi][1], nz: DIRS[bi][2] };
  };

  BVH.LEAF = LEAF;
  /** 导出射线求交：返回命中数，out[i] 为第 i 个交点的距离（升序）。激光挡墙用。 */
  BVH.rayCrossings = rayCrossings;
})();
