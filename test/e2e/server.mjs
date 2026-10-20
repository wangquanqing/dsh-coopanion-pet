/**
 * 端到端验证台：把插件的**真实客户端代码**跑在一个真浏览器里，
 * 用真 SSE 下发命令、用真点击回答气泡。
 *
 * 它复刻 index.js 的四条路由（资源 / client.js / 预览页 / SSE）与 report 端点，
 * 因此 client.js **一个字都不用改**——这一点与预览页同因。
 *
 * 用法：node _work/e2e/server.mjs  → 打印端口，随后由 run.mjs 驱动。
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';

/** 仓库根：本文件在 test/e2e/ 下，往上两级。 */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const ASSETS = path.join(ROOT, 'assets');

const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav',
};

/** 收到的 report（settle 回执等）。 */
export const reports = [];
/** 当前 SSE 连接。 */
const clients = new Set();
/** 待执行的浏览器动作（由 driver.js 轮询取走）。 */
const actions = [];

export function start(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    // ---- SSE：下发命令帧 ----
    if (p === '/api/dsh-coopanion-pet/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': hello\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // ---- 回执 ----
    if (p === '/api/dsh-coopanion-pet/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { reports.push(JSON.parse(body)); } catch (e) { reports.push({ bad: body }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }

    // ---- 预览页（注入 driver）----
    if (p === '/api/dsh-coopanion-pet/preview') {
      const html = readFileSync(path.join(ASSETS, 'preview.html'), 'utf8')
        .replace('</body>', '<script type="module" src="/test/driver.js"></script></body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    // ---- 测试驱动脚本 ----
    if (p === '/test/driver.js') {
      const js = readFileSync(new URL('./driver.js', import.meta.url), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(js);
      return;
    }
    // ---- 驱动脚本的指令队列 ----
    if (p === '/test/poll') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(actions.shift() ?? null));
      return;
    }
    if (p === '/test/result' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { reports.push({ test: JSON.parse(body) }); } catch (e) { /* 忽略 */ }
        res.writeHead(200); res.end('ok');
      });
      return;
    }

    // ---- client.js（包根）----
    if (p === '/api/dsh-coopanion-pet/assets/client.js') {
      const file = path.join(ROOT, 'client.js');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      createReadStream(file).pipe(res);
      return;
    }

    // ---- 其余资源 ----
    if (p.startsWith('/api/dsh-coopanion-pet/assets/')) {
      const rel = decodeURIComponent(p.slice('/api/dsh-coopanion-pet/assets/'.length));
      const file = path.join(ASSETS, rel);
      if (!file.startsWith(ASSETS) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      createReadStream(file).pipe(res);
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 往页面下发一条命令帧（与宿主 channel.command 的形状一致）。 */
export function sendCommand(op, args, id) {
  const text = `data: ${JSON.stringify({ type: 'command', id, op, args })}\n\n`;
  let n = 0;
  for (const res of clients) { try { res.write(text); n++; } catch (e) { clients.delete(res); } }
  return n;
}

/** 让浏览器做一件事（driver 轮询取走）。 */
export function pushAction(action) { actions.push(action); }

/**
 * 收工：把 SSE 连接掐掉再关服务。
 *
 * **SSE 是长连接**，不主动 destroy 的话 `server.close()` 会一直等到浏览器那边断，
 * 而浏览器已经 taskkill 了——于是 Node 进程挂在那里不退（实测踩过：
 * 用例全过、进程却卡到超时）。`closeAllConnections` 是 Node 18+ 的兜底。
 */
export function shutdown(server) {
  for (const c of clients) { try { c.destroy(); } catch (e) { /* 已断 */ } }
  clients.clear();
  try { server.closeAllConnections?.(); } catch (e) { /* 老 Node 没有 */ }
  try { server.close(); } catch (e) { /* 已关 */ }
}

export const state = () => ({ clients: clients.size, reports: reports.length });
