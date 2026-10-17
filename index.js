// dsh-coopanion-pet —— Coopanion 桌宠插件（宿主半边，零侵入）。
//
// 两件事：
//   1. 把包内 assets 目录以只读静态路由供给浏览器（渲染内核、形象包、纹理）；
//   2. 把宿主侧的运行状态经 SSE 推给浏览器里的桌宠——她据此显示「正在思考 /
//      正在读文件 / 正在跑命令」这类状态气泡。
//
// 第 2 件非做不可，是因为客户端插件拿不到会话状态：探针实测（dsh 0.2.0-rc.2）
// 显示浏览器端的 apply 运行时只有 slots / connection / loader / modules 可用，
// sessions、conversation、theme 都取不到；shell.overlay 是 root 作用域插槽，
// 框架注入的标准 props 里也没有会话信息。而宿主侧有 agent/status 事件与
// tools/execute 钩子，因此状态由宿主采集、经 SSE 下发。
//
// 路由用 prefix 而非 exact，是刻意的：形象包内部有相对路径导入
// （kit/body.js 里的 './rig.js'、whale/figure.js 里的 '../kit/rig.js'、
// 以及纹理 'tex/xxx.png'），只有路径形式的 URL 才能让浏览器按相对关系解析成功。
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-coopanion-pet';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, 'assets');

/** 资源路由前缀；client.js 里的 ASSETS 必须与此保持一致。 */
export const ROUTE = '/api/dsh-coopanion-pet/assets';
/** 状态事件流地址；client.js 里的 EVENTS 必须与此保持一致。 */
export const EVENTS = '/api/dsh-coopanion-pet/events';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** 把请求路径解析为 assets 目录内的安全路径；越界返回 null。 */
function safeResolve(rel) {
  const target = path.normalize(path.join(ASSETS_DIR, rel));
  if (target !== ASSETS_DIR && !target.startsWith(ASSETS_DIR + path.sep)) return null;
  return target;
}

/** 一帧 SSE 数据。 */
function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 工具名 → 状态气泡的词。按前缀匹配，因此第三方 MCP 工具
 * （`mcp__github__create_issue` 之类）也能落到合适的一类，不必穷举。
 */
const TOOL_WORDS = [
  [/^read$|^read_image$|^ops_inspect/, 'read'],
  [/^write$|^edit$|^ops_replace|^ops_write/, 'write'],
  [/^glob$|^grep$|^ops_glob|^ops_grep/, 'search'],
  [/^bash$|^pwsh$|^ops_bash|^bash_|^ops_pwsh/, 'run'],
  [/^web_search|^web_fetch|^research$|_search$|^domain_search/, 'search'],
  [/^subagent|^workflow$/, 'work'],
  [/^todo_write$|^create_goal|^update_goal|^get_goal/, 'write'],
  [/^ask_user_question$/, 'wait'],
];
/** 工具类状态最多停留多久（毫秒），免得一个卡住的调用把气泡钉死。 */
const TOOL_TTL_MS = 120_000;

/**
 * 一个按 agent 记录「此刻在做什么」的小状态机。
 *
 * 只输出状态本身（kind + 工具名），措辞交给客户端——改文案不必动宿主，
 * 也避免中文散落到两边。
 */
function createStatusTracker() {
  /** 每个 agent 的当前状态：{ kind, tool, since }。 */
  const byAgent = new Map();
  /** 每个 agent 正在跑的工具调用数（可能有嵌套）。 */
  const running = new Map();

  /** 现在最该显示的那条状态：工具优先于「思考」，同类取最新，没有则 null。 */
  function current() {
    let best = null;
    for (const st of byAgent.values()) {
      if (!st) continue;
      const rank = st.kind === 'think' ? 0 : 1;
      if (!best || rank > best.rank || (rank === best.rank && st.since > best.st.since)) {
        best = { rank, st };
      }
    }
    return best?.st ?? null;
  }

  const snapshot = () => {
    const st = current();
    return st ? { kind: st.kind, tool: st.tool, since: st.since } : { kind: 'none' };
  };

  const think = (key, now) => ({ kind: 'think', tool: null, since: now });

  return {
    snapshot,
    agentStatus(agent, status) {
      const key = String(agent);
      if (status === 'running') {
        // 已经在跑工具就不要用「思考」把它盖掉
        const prev = byAgent.get(key);
        if (!prev || prev.kind === 'think') byAgent.set(key, think(key, Date.now()));
      } else {
        byAgent.delete(key);
        running.delete(key);
      }
      return snapshot();
    },
    toolStart(agent, toolName) {
      const key = String(agent);
      running.set(key, (running.get(key) ?? 0) + 1);
      const kind = TOOL_WORDS.find(([re]) => re.test(toolName))?.[1] ?? 'work';
      byAgent.set(key, { kind, tool: toolName, since: Date.now() });
      return snapshot();
    },
    toolEnd(agent) {
      const key = String(agent);
      const n = Math.max(0, (running.get(key) ?? 1) - 1);
      if (n === 0) {
        running.delete(key);
        // 工具跑完但这一轮还没结束：退回「思考」
        if (byAgent.has(key)) byAgent.set(key, think(key, Date.now()));
      } else {
        running.set(key, n);
      }
      return snapshot();
    },
    /** 清掉停留过久的工具状态，返回是否发生了变化。 */
    sweep(now = Date.now()) {
      let changed = false;
      for (const [key, st] of byAgent) {
        if (st.kind !== 'think' && now - st.since > TOOL_TTL_MS) {
          byAgent.set(key, think(key, now));
          changed = true;
        }
      }
      return changed;
    },
  };
}

export async function apply(ctx) {
  const tracker = createStatusTracker();

  // 必须走 inject —— apply 运行时刻 webserver 的 fiber 可能尚未创建。
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer');

    /* ---------- 1. 静态资源 ---------- */

    const disposeAssets = webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const rel = decodeURIComponent(url.pathname.slice(ROUTE.length)).replace(/^\/+/, '');
          const file = safeResolve(rel);
          if (file === null || rel === '' || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
          }
          const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
          createReadStream(file).pipe(res);
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposeAssets, 'dsh-coopanion-pet: 静态资源路由');

    /* ---------- 2. 状态事件流 ---------- */

    /** 连着的浏览器。 */
    const connections = new Set();
    /** 上一次广播出去的状态，只有变了才推。 */
    let lastSent = '';

    const broadcast = (force = false) => {
      if (!connections.size) return;
      const snap = tracker.snapshot();
      const line = JSON.stringify(snap);
      if (!force && line === lastSent) return;
      lastSent = line;
      const frame = sse(snap);
      for (const res of connections) {
        try { res.write(frame); } catch (error) { connections.delete(res); }
      }
    };

    const disposeEvents = webServer.register({
      kind: 'exact',
      path: EVENTS,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // 注释帧让中间层与浏览器立刻确认连接已建立
        res.write(': connected\n\n');
        connections.add(res);
        lastSent = '';
        // 连上先给一份当前状态，免得等下一次变化
        try { res.write(sse(tracker.snapshot())); } catch (error) { /* 立刻断了就算了 */ }
        res.on('close', () => { connections.delete(res); });
      },
    });
    wctx.effect(() => disposeEvents, 'dsh-coopanion-pet: 状态事件流');

    /* ---------- 3. 采集状态 ---------- */

    // 一轮对话的开始与结束
    ctx.on('agent/status', (payload) => {
      try {
        tracker.agentStatus(payload?.agent, payload?.status);
        broadcast();
      } catch (error) {
        ctx.logger?.warn?.('dsh-coopanion-pet: 处理 agent/status 失败', error);
      }
    });

    // 包住每次工具调用，开始与结束各报一次。
    // 写法与官方策略插件一致（tools/execute 是 waterfall，必须把 next() 的结果传下去），
    // 且 exec.agent 可能为空（非 agent 上下文的调用），因此用 String() 兜底。
    ctx.on('tools/execute', async (exec, next) => {
      const key = exec?.agent === undefined ? null : String(exec.agent);
      const name = typeof exec?.name === 'string' ? exec.name : '';
      // 没有名字的调用不是真实工具（注册表在名字未知时会走到这里），不上报
      if (key !== null && name) {
        try {
          tracker.toolStart(key, name);
          broadcast();
        } catch (error) {
          /* 采集失败不能影响工具本身 */
        }
      }
      try {
        return await next();
      } finally {
        if (key !== null && name) {
          try {
            tracker.toolEnd(key);
            broadcast();
          } catch (error) {
            /* 同上 */
          }
        }
      }
    });

    // 兜底：卡住的工具状态不要永远挂着
    const timer = setInterval(() => { if (tracker.sweep()) broadcast(); }, 15_000);
    wctx.effect(() => () => clearInterval(timer), 'dsh-coopanion-pet: 状态清扫');
  });

  ctx.logger?.info?.(`dsh-coopanion-pet: 已挂载（资源 ${ROUTE}/，状态 ${EVENTS}）`);
}
