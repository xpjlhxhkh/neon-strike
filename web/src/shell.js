/* =====================================================================
   霓虹突袭 — 外壳适配层（Shell）
   ---------------------------------------------------------------------
   同一份游戏代码要跑在两种环境里：
     · 浏览器 / 启动器（file:// 或 http）—— 走 Fullscreen API、window.close()
     · Tauri 桌面外壳 —— 走原生窗口命令（set_fullscreen / quit）

   这层只负责"窗口能力"，不碰任何玩法逻辑；在浏览器里调用会退化成原来的行为，
   所以在浏览器中自检（tools/smoke-test.mjs）依旧完全有效。
   ===================================================================== */
window.Shell = (function () {
  'use strict';

  var T = window.__TAURI__;                        // tauri.conf.json: withGlobalTauri: true
  var TI = window.__TAURI_INTERNALS__;             // Tauri 2 内部桥接（不依赖 withGlobalTauri）
  var invoke = (T && T.core && T.core.invoke) || (TI && TI.invoke) || null;
  var win = (T && T.window && T.window.getCurrentWindow) ? T.window.getCurrentWindow() : null;

  // 启动时先记录一次环境信息（进入游戏后会写进 %TEMP%\neon-boot.log 与窗口标题）
  if (invoke) {
    try {
      invoke('log_from_page', {
        msg: 'shell 初始化: __TAURI__=' + !!T + ' __TAURI_INTERNALS__=' + !!TI + ' win=' + !!win
      }, {});
    } catch (e) { }
  }

  function call(cmd, args) {
    if (!invoke) return Promise.resolve(null);
    try {
      // Tauri 2 内部桥接的签名是 invoke(cmd, args, options)
      var p = invoke(cmd, args || {}, {});
      if (p && p.catch) return p.catch(function (e) { diag(cmd + ' 失败: ' + e); return null; });
      return p || Promise.resolve(null);
    } catch (e) {
      diag(cmd + ' 抛错: ' + e);
      return Promise.resolve(null);
    }
  }

  /** 诊断输出：桌面外壳里写进 %TEMP%\neon-boot.log（浏览器里忽略） */
  function diag(msg) {
    if (!invoke) return;
    try { invoke('log_from_page', { msg: String(msg) }, {}); } catch (e) { }
  }

  return {
    /** 是否运行在 Tauri 桌面外壳里 */
    desktop: !!(invoke || T || TI),
    /** 是否由启动器/外壳启动（桌面外壳恒为真；浏览器里看 ?shell=1） */
    isLauncher: !!(invoke || T || TI) || /(^|[?&])shell=1/.test(window.location.search),

    /** 设置原生全屏（桌面外壳），返回是否已处理 */
    setFullscreen: function (on) {
      if (!invoke) return false;
      // 优先用应用自己的 Rust 命令：插件命令（win.setFullscreen）在 Tauri 2 里
      // 需要 capabilities 授权，未授权会被静默拒绝，所以只作为兜底。
      call('set_fullscreen', { on: !!on });
      return true;
    },

    /** 退出游戏：桌面外壳直接结束进程（关窗即退），浏览器里退回 window.close() */
    quit: function () {
      if (invoke) { call('quit'); return true; }
      try { window.close(); } catch (e) { }
      return false;
    },

    /** 键盘锁定只在浏览器里需要（用来在全屏时捕获 Esc） */
    needsKeyboardLock: function () { return !invoke; },
    /** 浏览器里"窗口已经是整屏"时要跳过 Fullscreen API；桌面外壳不需要这套启发式 */
    needsScreenSizedCheck: function () { return !invoke; }
  };
})();
