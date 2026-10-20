/**
 * 端到端：在真浏览器（Edge headless + SwiftShader）里跑 pet_set 的同意流程。
 *
 * 自动化的三个已知坑：
 * 1. 无头环境要 --use-gl=swiftshader，否则 WebGL 起不来，桌宠不渲染；
 * 2. 必须等 driver 自报 ready 再下发命令；
 * 3. 卡点用轮询，不要死等。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, sendCommand, pushAction, reports, shutdown } from './server.mjs';

/** 浏览器路径：默认 Edge，可用 CPN_E2E_BROWSER 覆盖。 */
const EDGE = process.env.CPN_E2E_BROWSER
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PREFS_KEY = 'dsh-coopanion-pet:prefs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, label = '条件' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(60);
  }
  throw new Error('等待超时：' + label);
}

/**
 * 取走一条回执。
 *
 * 两种来源形状不同：页面主动 POST 的（settle）在顶层；测试驱动 POST 的
 * 包在 `test` 里。两边都认。
 */
const takeReport = (kind, match) => {
  for (let i = 0; i < reports.length; i++) {
    const raw = reports[i];
    const t = raw?.test ?? raw;
    if (t && t.kind === kind && (!match || match(t))) { reports.splice(i, 1); return t; }
  }
  return null;
};

/** `settle` 帧把回执放在 `result` 里（见 client.js 的 report）。 */
const settleOf = (t) => t?.result;

let seq = 0;
/** 在页面里求值。 */
async function evaluate(code) {
  const name = 'ev' + (++seq);
  pushAction({ kind: 'eval', code, name });
  const r = await waitFor(() => takeReport('eval', (t) => t.name === name), { label: name });
  if (r.value && r.value.__error) throw new Error('页面求值失败：' + r.value.__error);
  return r.value;
}

/** 写偏好并等页面同步（页面每秒同步一次）。 */
async function setPrefs(patch) {
  const code = 'JSON.stringify(Object.assign(JSON.parse(localStorage.getItem(' + JSON.stringify(PREFS_KEY) + ") || '{}'), " + JSON.stringify(patch) + '))';
  await evaluate('(localStorage.setItem(' + JSON.stringify(PREFS_KEY) + ', ' + code + '), "ok")');
  // 页面自己就会定期同步偏好（每 32 帧约 2.7 秒），但用例等不了那么久：
  // 直接调它暴露的 syncPrefs()，让新偏好立刻生效（设置面板走的就是这条路）。
  await evaluate('(window.__dshCoopanionPet && window.__dshCoopanionPet.syncPrefs(), "synced")');
  await sleep(150);
}

function assertEqual(actual, expected, why) {
  if (actual !== expected) {
    throw new Error(why + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

async function main() {
  const { server, port } = await start();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'cpn-e2e-'));
  const url = 'http://127.0.0.1:' + port + '/api/dsh-coopanion-pet/preview';
  const log = [];
  const trace = (m) => { console.error('[trace] ' + m); };

  const browser = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1280,900',
    '--user-data-dir=' + profile, url,
  ], { stdio: 'ignore' });

  try {
    trace('等待浏览器…');
    await waitFor(() => reports.some((r) => r?.test?.kind === 'driver-up'), { timeout: 45000, label: '浏览器加载' });
    trace('浏览器已连上');
    log.push('浏览器加载了 preview 页');

    // 桌宠本体是否起来（有 canvas 才算真的渲染了）
    await sleep(3000);
    trace('等 canvas');
    // 先看看预览页有没有报错（它的 catch 会把原因写进 #hint）
    const diag = await evaluate('({ hint: (document.getElementById("hint")||{}).textContent || "", canvas: document.querySelectorAll("canvas").length, host: (document.getElementById("host")||{children:{length:-1}}).children.length, pet: typeof window.__dshCoopanionPet })');
    log.push('诊断：' + JSON.stringify(diag));
    let boot = false;
    for (let i = 0; i < 40 && !boot; i += 1) {
      boot = await evaluate('!!document.querySelector("canvas")');
      if (!boot) await sleep(250);
    }
    log.push('WebGL canvas 存在 = ' + boot);
    assertEqual(boot, true, '桌宠应当渲染出来');

    // ---- 用例 1：默认档只改 roam（她自己的）→ 直接成功，不提问 ----
    await setPrefs({ selfAdjust: 'default', enabled: true });
    trace('用例1');
    sendCommand('set', { patch: { roamIndex: 2 } }, 'c1');
    const r1 = settleOf(await waitFor(() => takeReport('settle', (t) => t.id === 'c1'), { label: '回执 c1' }));
    log.push('1) 默认档改 roam → ' + JSON.stringify(r1));
    assertEqual(r1.ok, true, '默认档改 roam 应当成功');
    assertEqual(r1.refused.length, 0, '不该有被拒绝的项');

    // ---- 用例 2：默认档改 sound（要先问）→ 弹气泡，点「可以」才改 ----
    trace('用例2');
    sendCommand('set', { patch: { sound: false } }, 'c2');
    await waitFor(() => reports.length >= 0, { label: '等待提问' });
    await sleep(700);
    const ask = await evaluate('({ opts: [...document.querySelectorAll(".cpn-b-opt")].map(b => b.textContent), q: (document.querySelector(".cpn-b-q")||{}).textContent || "" })');
    log.push('2) 提问气泡 = ' + JSON.stringify(ask));
    if (!ask.opts.length) throw new Error('没有弹出提问气泡');
    assertEqual(ask.opts.length, 3, '应当是三个选项');

    pushAction({ kind: 'click', selector: '.cpn-b-opt', index: 0, name: 'yes' });
    await waitFor(() => takeReport('clicked', (t) => t.name === 'yes'), { label: '点「可以」' });
    const r2 = settleOf(await waitFor(() => takeReport('settle', (t) => t.id === 'c2'), { label: '回执 c2' }));
    log.push('   点「' + ask.opts[0] + '」→ ' + JSON.stringify(r2));
    assertEqual(r2.ok, true, '答应后应当成功');
    assertEqual(r2.applied.sound, false, 'sound 应当变成 false');

    // ---- 用例 3：改 sound，点「不用了」→ declined，值不变 ----
    sendCommand('set', { patch: { sound: true } }, 'c3');
    await sleep(800);
    const ask2 = await evaluate('[...document.querySelectorAll(".cpn-b-opt")].map(b => b.textContent)');
    log.push('3) 再次提问 = ' + JSON.stringify(ask2));
    if (!ask2.length) throw new Error('没有再次弹出提问');
    pushAction({ kind: 'click', selector: '.cpn-b-opt', index: 2, name: 'no' });
    await waitFor(() => takeReport('clicked', (t) => t.name === 'no'), { label: '点「不用了」' });
    const r3 = settleOf(await waitFor(() => takeReport('settle', (t) => t.id === 'c3'), { label: '回执 c3' }));
    log.push('   点「' + ask2[2] + '」→ ' + JSON.stringify(r3));
    assertEqual(r3.ok, false, '拒绝应当失败');
    assertEqual(r3.reason, 'declined', '原因应为 declined');

    // ---- 用例 4：off 档 → 连问都不问，直接拒绝 ----
    await setPrefs({ selfAdjust: 'off' });
    sendCommand('set', { patch: { sound: true } }, 'c4');
    const r4 = settleOf(await waitFor(() => takeReport('settle', (t) => t.id === 'c4'), { label: '回执 c4' }));
    log.push('4) off 档改 sound → ' + JSON.stringify(r4));
    assertEqual(r4.ok, false, 'off 档应当拒绝');
    assertEqual(r4.reason, 'self-adjust-off', '原因应为 self-adjust-off');

    // ---- 用例 5：「以后都行」→ 切成 custom，再改同样的项不再问 ----
    await setPrefs({ selfAdjust: 'default' });
    sendCommand('set', { patch: { sound: true } }, 'c5');
    await sleep(800);
    await evaluate('[1]');
    pushAction({ kind: 'click', selector: '.cpn-b-opt', index: 1, name: 'always' });
    await waitFor(() => takeReport('clicked', (t) => t.name === 'always'), { label: '点「以后都行」' });
    const r5 = settleOf(await waitFor(() => takeReport('settle', (t) => t.id === 'c5'), { label: '回执 c5' }));
    const after = await evaluate('JSON.parse(localStorage.getItem("' + PREFS_KEY + '") || "{}")');
    log.push('5) 以后都行 → ' + JSON.stringify(r5) + ' 偏好=' + JSON.stringify({ selfAdjust: after.selfAdjust, sound: after.selfAdjustCustom?.sound }));
    assertEqual(r5.ok, true, '「以后都行」应当成功');
    assertEqual(after.selfAdjust, 'custom', '应当切成 custom');
    assertEqual(after.selfAdjustCustom.sound, true, 'sound 应当被记成可直接改');

    // 再改一次，不该再弹气泡
    sendCommand('set', { patch: { sound: false } }, 'c6');
    const r6 = settleOf(await waitFor(() => takeReport('settle', (t) => t.id === 'c6'), { label: '回执 c6' }));
    const bubbleNow = await evaluate('document.querySelectorAll(".cpn-b-opt").length');
    log.push('   再改一次 → ' + JSON.stringify(r6) + '（气泡选项数 ' + bubbleNow + '）');
    assertEqual(r6.ok, true, '第二次应当直接成功');
    assertEqual(bubbleNow, 0, '不该再弹提问');

    console.log('\n=== 端到端通过（' + log.length + ' 步）===');
    for (const line of log) console.log('· ' + line);
  } finally {
    /**
     * **必须清整棵进程树**：Edge 会派生一堆子进程，只 kill 主进程的话
     * 那个 profile 锁还占着，而且 Node 进程也退不出去（SSE 连接不断）。
     */
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        browser.kill('SIGKILL');
      }
    } catch (e) { /* 已经退出就算了 */ }
    shutdown(server);
    await sleep(800);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 清理失败不致命 */ }
  }
}

/**
 * 跑完就退。
 *
 * **为什么不等事件循环自然空掉**：`setInterval` 的 tick 轮询与 SSE 连接都可能
 * 让进程挂着不退，而用例其实早就跑完了。用 `process.exit` 显式收尾，
 * 退出码由是否抛错决定——CI 与 `npm test` 看到的都是准确的那个。
 */
main().then(
  () => process.exit(0),
  (error) => { console.error('✖ 失败：' + error.message); process.exit(1); },
);
