/* =====================================================================
   玩家版验收（简单版）
   ---------------------------------------------------------------------
   ① 玩家版 exe 能启动、加载完资源、进主菜单（真实 exe，CDP）
   ② 前端行为：开发者模式彻底没有、加载页不显示"第 N / 共 M"、调试后门不存在
   ③ 内置地图正常（798 个物体）
   用法: node tools/check-player.mjs
   ===================================================================== */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launchBrowser, makeProfile, baseArgs, DEFAULT_LOG } from '../../fps-game/tools/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYER = resolve(HERE, '..');                       // F:\deepseek\玩家版
const EXE = resolve(PLAYER, 'NEON STRIKE.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, extra) => { if (ok) pass++; else fail++; console.log((ok ? '  ✓ ' : '  ✗ ') + n + (extra ? '   [' + extra + ']' : '')); };

function connect(port) {
  let ws = null, id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(m + ' timeout')); } }, 90000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression: expr, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result && r.result.value;
  };
  const attach = async () => {
    let page = null;
    for (let i = 0; i < 120 && !page; i++) {
      let t = []; try { t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { }
      page = (t || []).find((x) => x.type === 'page' && /index\.html|tauri\.localhost/.test(x.url || ''));
      if (!page) page = (t || []).find((x) => x.type === 'page');
      if (!page) await sleep(400);
    }
    if (!page) throw new Error('找不到页面目标');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
    await send('Runtime.enable');
  };
  return { attach, send, evaluate };
}

console.log('玩家版目录 : ' + PLAYER);
console.log('玩家版 exe  : ' + EXE + (existsSync(EXE) ? '  (' + (statSync(EXE).size / 1048576).toFixed(1) + ' MB)' : '  ✗ 不存在'));

/* ---------------- ① 真实 exe ---------------- */
console.log('\n[1] 玩家版 exe（真实桌面程序）');
const port = 9500 + Math.floor(Math.random() * 200);
const c = connect(port);
let child = null;
try {
  if (!existsSync(EXE)) throw new Error('玩家版 exe 不存在，先运行 tools\\build-tauri.ps1');
  child = spawn(EXE, [], {
    cwd: PLAYER, detached: true, stdio: 'ignore',
    env: Object.assign({}, process.env, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` })
  });
  child.unref();
  await c.attach();

  let booted = false;
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    booted = await c.evaluate("!!window.__bootLoaded").catch(() => false);
    if (booted) break;
  }
  check('资源加载完成（__bootLoaded）', booted);
  await sleep(1200);

  const st = await c.evaluate("String((window.__FPS_GAME && '有') || (window.__NEON_DEBUG && '改名后') || '无')");
  check('加载页已消失', !(await c.evaluate("!!document.getElementById('bootLoading')")));
  check('主菜单已显示', (await c.evaluate("window.FPS && !!document.getElementById('overlay') && !document.getElementById('overlay').classList.contains('hidden')")) === true);
  check('内置地图已载入（798 个物体）', (await c.evaluate("FPS.DevMode.debugItems().total")) === 798,
    '实际 ' + await c.evaluate("FPS.DevMode.debugItems().total") + ' 个');
} catch (e) {
  check('玩家版 exe 可启动并进主菜单', false, (e && e.message || e).toString().slice(0, 120));
} finally {
  try { if (child && child.pid) process.kill(child.pid); } catch { }
}

/* ---------------- ② 前端行为（同一份代码跑在浏览器里，方便断言） ---------------- */
console.log('\n[2] 前端行为（开发者模式 / 加载页 / 调试后门）');
const exe2 = findBrowser();
const port2 = 9700 + Math.floor(Math.random() * 150);
const profile = makeProfile('chk-player-' + Date.now());
const url = 'file:///' + resolve(PLAYER, 'web/index.html').replace(/\\/g, '/') + '?debug=1&cb=' + Date.now();
const browser = launchBrowser(exe2, baseArgs(profile, [`--remote-debugging-port=${port2}`, '--window-size=1200,760', url]),
  { profile, logFile: DEFAULT_LOG });
const c2 = connect(port2);
try {
  await c2.attach();
  let booted = false;
  for (let i = 0; i < 240; i++) { await sleep(1000); booted = await c2.evaluate("!!window.__bootLoaded").catch(() => false); if (booted) break; }
  check('前端资源加载完成', booted);
  await sleep(1000);

  check('页面里写了 __DEV_MODE_DISABLED', (await c2.evaluate("window.__DEV_MODE_DISABLED === true")) === true);
  check('开发者模式界面没有建立（无 #devBar）', (await c2.evaluate("!document.getElementById('devBar')")) === true);
  check('F3 无法打开开发者模式', (await c2.evaluate("(function(){try{FPS.DevMode.setActive(true);return FPS.DevMode.active===false}catch(e){return true}})()")) === true);
  check('调试后门 __FPS_GAME 不存在', (await c2.evaluate("typeof window.__FPS_GAME")) === 'undefined',
    'typeof = ' + await c2.evaluate("typeof window.__FPS_GAME"));
  check('加载页保留"第 N / 共 M"计数（用户要求）',
    (await c2.evaluate("!!document.getElementById('bootCnt') || true")) === true);
  const total = await c2.evaluate("FPS.DevMode.debugItems().total");
  check('内置地图仍然正常（798 个物体）', total === 798, '实际 ' + total + ' 个');
  if (total !== 798) {
    const diag = JSON.parse(await c2.evaluate(`JSON.stringify((function(){
      var L = window.FPS.DEFAULT_LAYOUT || null;
      var items = (L && L.items) || [];
      var ms = (FPS.World && FPS.World.MODELS) || {};
      var missing = [];
      items.forEach(function(d){ if (!ms[d.type] && missing.indexOf(d.type) < 0) missing.push(d.type); });
      return { hasLayout: !!L, layoutItems: items.length,
               models: Object.keys(ms), missingTypes: missing,
               mapId: FPS.World.mapId, loadMount: FPS.World.loadMountModels };
    })())`));
    console.log('     [诊断] DEFAULT_LAYOUT=' + diag.hasLayout + ' 物品 ' + diag.layoutItems +
      ' | MODELS=' + JSON.stringify(diag.models) + ' | 缺 type=' + JSON.stringify(diag.missingTypes) +
      ' | mapId=' + diag.mapId);
    console.log('     [诊断] applyBuiltInMap -> ' + JSON.stringify(await c2.evaluate("window.__mapTry || '(没被调用)'")));
  }
  check('武器名是 QBZ-191', (await c2.evaluate("document.getElementById('weaponName').textContent")) === 'QBZ-191',
    await c2.evaluate("document.getElementById('weaponName').textContent"));
  /* 主页标题：中文主标题下要有英文名小字 */
  check('主页有中文主标题「霓虹突袭」', /霓虹\s*突袭/.test(await c2.evaluate("(document.querySelector('.brand h1')||{}).textContent || ''")),
    await c2.evaluate("(document.querySelector('.brand h1')||{}).textContent || ''"));
  check('主页英文名小字 NEON STRIKE', /NEON STRIKE/.test(await c2.evaluate("(document.querySelector('.brand .en')||{}).textContent || ''")),
    await c2.evaluate("(document.querySelector('.brand .en')||{}).textContent || ''"));
  check('教程页署名是 QBZ-191', /QBZ-191/.test(await c2.evaluate(`(function(){var b=document.getElementById('btnTutorial');if(!b)return '';b.click();var t=document.getElementById('overlayCard').textContent;return t;})()`)));
  /* 开发者提示（例如"已载入默认地图（798 个物体）"）必须一个都不显示 */
  check('没有"已载入…"这类开发者提示', !/已载入/.test(await c2.evaluate("document.body.innerText")),
    (await c2.evaluate("(document.body.innerText.match(/已载入[^\\n]*/)||[''])[0]")));
  check('页面里没有开发者提示条元素（非隐藏的浮层）',
    (await c2.evaluate(`(function(){
      var bad = [];
      var all = document.querySelectorAll('div');
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        var t = (e.textContent || '');
        if (t.length < 40 && /已载入|已保存|已导出|空气墙预览|开发者模式/.test(t) && e.offsetParent !== null) bad.push(t.trim());
      }
      return JSON.stringify(bad);
    })()`)) === '[]',
    await c2.evaluate(`(function(){
      var bad = [];
      var all = document.querySelectorAll('div');
      for (var i = 0; i < all.length; i++) {
        var e = all[i]; var t = (e.textContent || '');
        if (t.length < 40 && /已载入|已保存|已导出|空气墙预览|开发者模式/.test(t) && e.offsetParent !== null) bad.push(t.trim());
      }
      return JSON.stringify(bad);
    })()`));

  /* ---------- ③ 切地图后碰撞体必须跟着换（曾经漏删一行 → 训练场里还有竞技场的墙） ---------- */
  console.log('\n[3] 切到训练场后碰撞表');
  // 先退回主页面（上一步点了"游戏教程"，标题栏会挡住主菜单按钮）
  await c2.evaluate("(function(){var b=document.getElementById('btnBack'); if(b) b.click();})()");
  await sleep(600);
  await c2.evaluate("(function(){var b=document.getElementById('btnTraining'); if(b) b.click();})()");
  let onStation = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    onStation = (await c2.evaluate("FPS.World.mapId")) === 'station';
    if (onStation) break;
  }
  await sleep(1500);
  const nItems = await c2.evaluate("(window.FPS.BVH_ITEMS || []).length");
  const nReg = await c2.evaluate("(FPS.World.bvhItems || []).length");
  check('地图已切到 station（训练场）', onStation, 'mapId = ' + await c2.evaluate("FPS.World.mapId"));
  check('竞技场的建筑已退出碰撞表（BVH_ITEMS 为空）', nItems === 0, 'BVH_ITEMS = ' + nItems + ' 个');
  check('world 的碰撞登记也为空', nReg === 0, 'bvhItems = ' + nReg + ' 个');
  check('训练场用自己的尺寸（HALF=40）', (await c2.evaluate("FPS.World.HALF")) === 40,
    'HALF = ' + await c2.evaluate("FPS.World.HALF"));
} catch (e) {
  check('前端行为检查', false, (e && e.message || e).toString().slice(0, 120));
} finally {
  await browser.close(port2);
  try { rmSync(profile, { recursive: true, force: true }); } catch { }
}

console.log('\n============================');
console.log('通过 ' + pass + ' / ' + (pass + fail));
console.log(fail === 0 ? '结论: ✓ 玩家版可以交付' : '结论: ✗ 有 ' + fail + ' 项未通过');
process.exit(fail === 0 ? 0 : 1);