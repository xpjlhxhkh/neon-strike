/* =====================================================================
   存档统一网关（web/src/save.js）
   ---------------------------------------------------------------------
   规则：**所有存档只允许写进游戏文件夹** —— <exe 所在目录>/saves/<key>.json

   · 在 Tauri 外壳里：通过 Rust 命令 save_game_file / load_game_file 读写文件，
     并在开机时把 saves/ 里的全部存档恢复进 localStorage（这样老代码里的
     localStorage 读写完全不用改，但权威副本在游戏目录里）。
   · 在普通浏览器里（无 Tauri）：退回 localStorage，仅用于开发调试。

   为什么这么做：WebView2 的 localStorage 落在用户数据目录（游戏文件夹之外），
   而需求要求"存档类文件只可存入游戏文件夹"，所以文件才是权威副本。
   ===================================================================== */
window.FPS = window.FPS || {};
(function () {
  'use strict';

  var T = window.__TAURI__;
  var core = (T && T.core && T.core.invoke) ? T.core : ((T && T.invoke) ? T : null);
  var invoke = core ? function (cmd, args) { return core.invoke(cmd, args); } : null;

  var S = (FPS.Save = {
    mode: invoke ? 'file' : 'localStorage',   // file = 写游戏目录；localStorage = 浏览器调试
    dir: '',
    lastError: '',
    ready: false
  });

  function ls() { try { return window.localStorage; } catch (e) { return null; } }

  /** 该 localStorage key 是否值得镜像到文件（跳过明显临时的） */
  function worthMirroring(k) {
    if (!k || k.length > 90) return false;
    if (k.indexOf('__') === 0) return false;
    return true;
  }

  /** 把 localStorage 里的所有存档镜像到 <游戏目录>/saves/*.json */
  S.mirror = function () {
    if (!invoke) return Promise.resolve(0);
    var st = ls();
    if (!st) return Promise.resolve(0);
    var jobs = [];
    for (var i = 0; i < st.length; i++) {
      var k = st.key(i);
      if (!worthMirroring(k)) continue;
      var v = st.getItem(k);
      if (v == null) continue;
      jobs.push(invoke('save_game_file', { name: k + '.json', content: v }).catch(function (e) {
        S.lastError = String(e); return null;
      }));
    }
    return Promise.all(jobs).then(function (r) {
      var ok = r.filter(function (x) { return x; }).length;
      if (r.length && r[0]) S.dir = String(r[0]).replace(/[\\/][^\\/]*$/, '');
      return ok;
    });
  };

  /** 开机：把 <游戏目录>/saves/*.json 全部恢复进 localStorage（文件覆盖本机缓存） */
  S.restore = function () {
    if (!invoke) { S.ready = true; return Promise.resolve(0); }
    return invoke('list_game_files').then(function (list) {
      var names = list || [];
      return Promise.all(names.map(function (n) {
        return invoke('load_game_file', { name: n }).then(function (txt) {
          if (txt == null) return 0;
          var key = n.replace(/\.json$/, '');
          var st = ls();
          if (!st) return 0;
          try { st.setItem(key, txt); return 1; } catch (e) { return 0; }
        }).catch(function () { return 0; });
      }));
    }).then(function (arr) {
      var n = (arr || []).filter(function (x) { return x; }).length;
      return invoke('saves_path').then(function (p) {
        S.dir = String(p || '');
        S.ready = true;
        if (n) console.log('[存档] 已从游戏目录恢复 ' + n + ' 个存档: ' + S.dir);
        return n;
      }).catch(function () { S.ready = true; return n; });
    }).catch(function (e) {
      S.lastError = String(e);
      S.ready = true;
      return 0;
    });
  };

  /** 主动写一个存档（同时写本机缓存与游戏目录） */
  S.set = function (key, text) {
    var st = ls();
    if (st) { try { st.setItem(key, text); } catch (e) { } }
    if (!invoke) return Promise.resolve(true);
    return invoke('save_game_file', { name: key + '.json', content: String(text) })
      .then(function (p) { S.dir = String(p).replace(/[\\/][^\\/]*$/, ''); return true; })
      .catch(function (e) { S.lastError = String(e); return false; });
  };

  /** 定时镜像 + 切到后台时镜像一次（避免退出时来不及写） */
  S.startAutoMirror = function (everyMs) {
    if (!invoke || S._auto) return;
    S._auto = setInterval(function () { S.mirror(); }, everyMs || 10000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') S.mirror();
    });
  };
})();
