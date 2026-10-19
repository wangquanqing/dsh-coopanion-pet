/**
 * 独立桌宠的宿主侧桥接。
 *
 * ## 它解决什么问题
 *
 * 独立窗口（Electron）里的她是**同一套客户端代码**，因此也走同样的通道：
 * `EventSource(/api/dsh-coopanion-pet/events)` + `fetch(…/report)`。
 * 但窗口里的页面**没有 DSH 的 cookie**，而 DSH 的 `/api` 前缀受鉴权保护——
 * 直接连会被 401（这是做 v1.8 沙箱时实测到的同一个根因）。
 *
 * 因此这里**在宿主侧另起一个本地 HTTP 服务**（`/dsh-coopanion-pet/desktop/*`，
 * 刻意不在 `/api` 下，因此不走鉴权），由它把两个端点**代理**到插件自己的通道：
 *
 * - `GET  …/desktop/events` → 挂进 `channel.attach(res)`，与她现有的通道同一条
 * - `POST …/desktop/report` → 交给插件已有的上报处理
 *
 * ## 为什么这样做而不是让 Electron 直连 DSH
 *
 * - **不加宽 DSH 的鉴权面**：独立窗口不需要 cookie，也不接触 `/api`
 * - **工具与状态气泡自动可用**：她连上的是**同一条 channel**，于是 `pet_*` 工具、
 *   状态气泡、语音、审批**全部照旧生效**——因为那些都在宿主侧
 * - **DSH 没开时也能工作**：Electron 自己起的服务负责静态资源；连不上宿主时
 *   她只是没有「Agent 指挥」的能力，本体照常
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 独立窗口用的路由前缀（不在 /api 下 → 不走 DSH 鉴权）。 */
const DESKTOP = '/dsh-coopanion-pet/desktop';

/** 找 Electron 可执行文件。 */
function findElectron(override) {
  if (override && fs.existsSync(override)) return override;
  // 插件自己带的（打包时随包分发）
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'electron', 'electron.exe');
  if (fs.existsSync(bundled)) return bundled;
  // 常见位置：环境变量、npm 装的 electron
  for (const key of ['DSH_COOPANION_ELECTRON', 'ELECTRON_EXECUTABLE']) {
    const v = process.env[key];
    if (v && fs.existsSync(v)) return v;
  }
  // 用 createRequire 问 npm 的 electron 包要路径
  try {
    const req = createRequire(fileURLToPath(import.meta.url));
    const p = req('electron');
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch (error) { /* 没装 */ }
  return null;
}

/**
 * 造一个桥接。
 *
 * @param deps - `{ channel, report, logger, pluginDir, electronPath, onStatus }`。
 */
function createDesktopBridge(deps) {
  const { channel, report, logger, pluginDir, onStatus, chat } = deps;
  let server = null;
  let child = null;
  let port = 0;
  let statusFile = null;
  let lastExit = null;

  /** 记一条状态（给设置面板与排查看）。 */
  const note = (line) => {
    try { logger?.info?.('[desktop] ' + line); } catch (error) { /* 忽略 */ }
    // 同时写一份到文件：DSH 的 logger 不往 stdout 写，排查时只有这个能看到
    try { fs.appendFileSync(path.join(os.tmpdir(), 'dsh-coopanion-desktop.log'), new Date().toISOString() + ' ' + line + '\n'); } catch (error) { /* 忽略 */ }
    try { onStatus?.({ at: Date.now(), line }); } catch (error) { /* 忽略 */ }
  };

  /**
   * 起本地桥接服务。
   *
   * 端口让系统挑（0）——**避免与用户的其它服务撞车**，且不需要配置。
   */
  function startServer() {
    return new Promise((resolve, reject) => {
      server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const p = url.pathname;

        // 下行：与她现有的通道同一条
        if (p === DESKTOP + '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          res.write(': desktop-bridge\n\n');
          channel.attach(res);
          // 连上先给一份当前状态与对话栈（与 DSH 页面同规则）
          try { res.write('data: ' + JSON.stringify({ type: 'status', ...channel.state }) + '\n\n'); } catch (error) { /* 已断 */ }
          return;
        }

        // 上行：交回插件已有的上报处理
        if (p === DESKTOP + '/report') {
          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
          req.on('end', async () => {
            let payload = null;
            try { payload = body.trim() ? JSON.parse(body) : null; } catch (error) { payload = null; }
            try { await report(payload); } catch (error) { /* 上报失败不该影响窗口 */ }
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            res.end();
          });
          return;
        }

        /**
         * 聊天面板的三个端点。
         *
         * **由 bridge 直接实现**（不再转发到 DSH 的 /api）：面板要读会话列表、
         * 历史与发送，而这三件事背后是 DSH 的会话服务——`chat` 依赖就是它。
         * 面板因此操作的是**同一批会话**，与 DSH 主面板看到的完全一致。
         */
        if (p === '/dsh-coopanion-pet/chat/list') {
          const r = chat ? await chat.list() : { ok: false, reason: 'unavailable', message: '聊天服务不可用。' };
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(r));
          return;
        }
        if (p.startsWith('/dsh-coopanion-pet/chat/history')) {
          const id = decodeURIComponent(p.slice('/dsh-coopanion-pet/chat/history'.length)).replace(/^\/+/, '');
          const r = chat ? await chat.history(id) : { ok: false, reason: 'unavailable', message: '聊天服务不可用。' };
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(r));
          return;
        }
        if (p === '/dsh-coopanion-pet/chat/send') {
          let raw = '';
          req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
          req.on('end', async () => {
            let body = null;
            try { body = raw.trim() ? JSON.parse(raw) : null; } catch (error) { body = null; }
            const r = chat
              ? await chat.send(body?.sessionId, body?.text, body?.requestId)
              : { ok: false, reason: 'unavailable', message: '聊天服务不可用。' };
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(r));
          });
          return;
        }

        // 能力探测：窗口用它判断「宿主在不在」
        if (p === DESKTOP + '/alive') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, electron: !!child, online: channel.online }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        note('bridge on ' + port);
        resolve(port);
      });
    });
  }

  /** 拉起 Electron 窗口。 */
  function startElectron(electronPath, hotkey) {
    const electronMain = path.join(pluginDir, 'desktop', 'main.cjs');
    if (!fs.existsSync(electronMain)) { note('找不到 desktop/main.cjs'); return null; }
    const args = [
      // 这类环境下 GPU 常起不来；软件渲染下窗口照常显示（实测确认）
      '--no-sandbox',
      '--disable-gpu',
      '--plugin-dir=' + pluginDir,
      '--bridge-port=' + port,
      // 快捷键由偏好决定（默认 Alt+Space）
      '--hotkey=' + (hotkey || 'Alt+Space'),
      // 开发/验收时开远程调试端口，便于连进窗口看它的实际状态
      ...(process.env.DSH_PET_DEBUG_PORT ? ['--remote-debugging-port=' + process.env.DSH_PET_DEBUG_PORT] : []),
      // 窗口侧的状态写到临时目录：Electron 的 stdout 不便于读，写文件最可靠
      '--status-file=' + path.join(os.tmpdir(), 'dsh-coopanion-electron.log'),
      '--port=0',
      electronMain,
    ];
    child = spawn(electronPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立窗口不该继承宿主的 ELECTRON_RUN_AS_NODE（会让 Electron 退化成 node）
      env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; })(),
    });
    let err = '';
    child.stdout?.on('data', (d) => { const s = d.toString().trim(); if (s) note('electron: ' + s.slice(0, 200)); });
    child.stderr?.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    child.on('error', (error) => { note('electron spawn 失败: ' + error.message); });
    child.on('exit', (code, signal) => {
      lastExit = { code, signal, at: Date.now(), stderr: err.slice(-600) };
      note('electron 退出 code=' + code + ' signal=' + signal);
      child = null;
    });
    note('electron 已拉起 pid=' + child.pid);
    return child;
  }

  return {
    /** 起桥接并拉起窗口。 */
    async start(options = {}) {
      if (!server) await startServer();
      const electronPath = findElectron(options.electronPath);
      if (!electronPath) {
        note('没找到 Electron 可执行文件——独立窗口无法启动');
        return { ok: false, reason: 'no-electron' };
      }
      if (child) return { ok: true, port, already: true };
      startElectron(electronPath, options.hotkey);
      return { ok: true, port };
    },

    /** 关掉窗口与服务。 */
    async stop() {
      if (child) {
        /**
         * **要杀进程树，不只是主进程。**
         *
         * Electron 会再拉起渲染/GPU/utility 几个子进程；只 `kill()` 主进程时，
         * 那些子进程可能变成孤儿继续占着内存（实测踩过：宿主退出后仍有 4 个
         * electron.exe 残留）。Windows 上用 `taskkill /T` 收整棵树。
         */
        const pid = child.pid;
        try {
          if (process.platform === 'win32' && pid) {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', detached: true }).unref();
          } else {
            child.kill('SIGTERM');
          }
        } catch (error) { /* 已经退了 */ }
        child = null;
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
      }
      note('已停止');
    },

    /** 当前状态（设置面板与诊断用）。 */
    get state() {
      return {
        running: !!child,
        port,
        online: channel.online,
        lastExit,
      };
    },
  };
}

export { createDesktopBridge, findElectron, DESKTOP };
