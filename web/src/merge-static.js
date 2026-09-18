/* =====================================================================
   静态模型合并（web/src/merge-static.js）
   ---------------------------------------------------------------------
   干什么：把一个模型里所有 Mesh 按【材质】合并成"每个材质一个 Mesh"，
           几何烘焙到模型根节点的局部空间。

   为什么需要：几份资源是"碎网格"——公寓 135 个网格却只有 1232 个三角面，
             动漫室内 102 个网格，交通道具 79 个。每个网格 = 一次 draw call，
             地图上放 58 个公寓就是几千次绘制调用 → 帧率直接掉到 30。
             合并后公寓从 135 次降到 ≤10 次（按材质数），画面完全不变。

   前提：只能用于**静态**模型（没有骨骼动画、不需要逐帧移动子网格）。
        本项目的建筑/树木都满足；武器（hand/QBZ191）和有动画的模型不要用它。
   ===================================================================== */
window.FPS = window.FPS || {};
(function () {
  'use strict';

  var M = (FPS.Merge = {});
  M.stats = { totalMs: 0, items: [] };   // 给诊断脚本读：每个模型合并前后网格数与耗时

  /** 把几何统一成"position + normal + uv + index"，便于拼接 */
  function normalize(geo) {
    var g = geo.index ? geo : null;
    var pos = geo.attributes.position;
    if (!pos) return null;
    var count = pos.count;
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', pos.clone());
    if (geo.attributes.normal) out.setAttribute('normal', geo.attributes.normal.clone());
    else {
      var n = new Float32Array(count * 3);
      for (var i = 0; i < count; i++) { n[i * 3 + 1] = 1; }   // 没有法线就朝上，避免一片黑
      out.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    }
    if (geo.attributes.uv) out.setAttribute('uv', geo.attributes.uv.clone());
    else out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    if (geo.index) out.setIndex(geo.index.clone());
    return out;
  }

  /** 合并同一材质的若干几何（保持索引，只做偏移） */
  function mergeGeos(list) {
    var geos = [];
    for (var i = 0; i < list.length; i++) {
      var g = normalize(list[i]);
      if (g) geos.push(g);
    }
    if (!geos.length) return null;
    if (geos.length === 1) return geos[0];

    var totalV = 0, totalI = 0;
    geos.forEach(function (g) {
      totalV += g.attributes.position.count;
      totalI += g.index ? g.index.count : g.attributes.position.count;
    });

    var pos = new Float32Array(totalV * 3);
    var nor = new Float32Array(totalV * 3);
    var uv = new Float32Array(totalV * 2);
    var idx = totalV > 65535 ? new Uint32Array(totalI) : new Uint16Array(totalI);

    var vo = 0, io = 0;
    geos.forEach(function (g) {
      var c = g.attributes.position.count;
      pos.set(g.attributes.position.array, vo * 3);
      nor.set(g.attributes.normal.array, vo * 3);
      uv.set(g.attributes.uv.array, vo * 2);
      if (g.index) {
        var ia = g.index.array;
        for (var k = 0; k < ia.length; k++) idx[io + k] = ia[k] + vo;
        io += ia.length;
      } else {
        for (var k2 = 0; k2 < c; k2++) idx[io + k2] = k2 + vo;
        io += c;
      }
      vo += c;
    });

    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    // 让 three 重新算包围球，否则视锥裁剪会用旧范围
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }

  /**
   * 按材质合并 root 下的全部 Mesh。
   * 返回新的 Group（每个材质一个 Mesh）；材质对象**复用原引用**，
   * 所以之后对材质做的"哑光化"等处理依然生效。
   */
  M.byMaterial = function (root, opts) {
    opts = opts || {};
    if (!root) return root;
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // 网格太少就没必要合并（省下加载时间）；默认门槛 8，可用 opts.minMeshes 覆盖
    var minMeshes = opts.minMeshes === undefined ? 8 : opts.minMeshes;
    var meshCount = 0;
    root.traverse(function (o) { if (o.isMesh) meshCount++; });
    if (meshCount < minMeshes) return root;
    root.updateMatrixWorld(true);

    var groups = {};      // material.uuid -> { mat, geos: [] }
    var skipped = 0;
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      if (o.isSkinnedMesh || (o.isMesh && o.morphTargetInfluences && o.morphTargetInfluences.length)) {
        skipped++;        // 有骨骼/形变的不能合
        return;
      }
      var mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!mat) { skipped++; return; }
      var key = mat.uuid;
      if (!groups[key]) groups[key] = { mat: mat, geos: [] };
      var g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);       // 烘焙到 root 的局部空间
      groups[key].geos.push(g);
    });

    var keys = Object.keys(groups);
    if (!keys.length) return root;

    var out = new THREE.Group();
    out.name = (root.name || 'model') + '_merged';
    var before = 0;
    keys.forEach(function (k) {
      before += groups[k].geos.length;
      var merged = mergeGeos(groups[k].geos);
      if (!merged) return;
      var mesh = new THREE.Mesh(merged, groups[k].mat);
      mesh.castShadow = opts.castShadow !== false;
      mesh.receiveShadow = opts.receiveShadow !== false;
      mesh.name = 'merged_' + k.slice(0, 6);
      out.add(mesh);
    });
    // 保留原根节点的矩阵（模型可能自带缩放/旋转）
    out.position.copy(root.position);
    out.quaternion.copy(root.quaternion);
    out.scale.copy(root.scale);
    if (opts.verbose !== false) {
      var dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
      M.stats.totalMs += dt;
      M.stats.items.push({ name: out.name, from: before, to: out.children.length, mats: keys.length, ms: +dt.toFixed(1) });
      console.log('[合并] ' + out.name + ': ' + before + ' 个网格 → ' + out.children.length +
        ' 个（材质 ' + keys.length + '），耗时 ' + dt.toFixed(0) + 'ms' + (skipped ? '，跳过 ' + skipped + ' 个动态网格' : ''));
    }
    return out;
  };
})();
