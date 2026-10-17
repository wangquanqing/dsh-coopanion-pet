// dsh-coopanion-pet —— Coopanion 桌宠插件（宿主半边，零侵入）。
//
// 四件事：
//   1. 把包内 assets 目录以只读静态路由供给浏览器（渲染内核、形象包、纹理）；
//   2. 采集运行状态经 SSE 推给浏览器，她据此显示「正在思考 / 正在读文件 / 正在跑命令」；
//   3. 注册 pet_* 工具，让 Agent 能指挥她说话、提问、走位、做动作、换装扮；
//   4. 接页面回传的消息（命令回执、用户对提问的回答、桌面侧状态）。
//
// 状态为什么由宿主采集：探针实测（dsh 0.2.0-rc.2）显示浏览器端的 apply 运行时
// 只有 slots / connection / loader / modules 可用，sessions、conversation、theme
// 都取不到；shell.overlay 是 root 作用域插槽，框架注入的标准 props 里也没有会话
// 信息。而宿主侧有 agent/status 事件与 tools/execute 钩子。
//
// 为什么不用 DSH 的 RPC 做上下行：本插件只需要「宿主推一件事给页面、页面回一件事」，
// 自己的 HTTP 路由更直接，也不依赖宿主内部接口的稳定性。
//
// 路由用 prefix 而非 exact，是刻意的：形象包内部有相对路径导入
// （kit/body.js 里的 './rig.js'、whale/figure.js 里的 '../kit/rig.js'、
// 以及纹理 'tex/xxx.png'），只有路径形式的 URL 才能让浏览器按相对关系解析成功。
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChannel, readJson } from './lib/channel.js';
import { createPetTools } from './lib/tools.js';
import { PET_PROMPT } from './lib/prompt.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-coopanion-pet';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, 'assets');

/** 资源路由前缀；client.js 里的 ASSETS 必须与此保持一致。 */
export const ROUTE = '/api/dsh-coopanion-pet/assets';
/** 事件流地址；client.js 里的 EVENTS 必须与此保持一致。 */
export const EVENTS = '/api/dsh-coopanion-pet/events';
/** 页面回传消息的地址；client.js 里的 POST 必须与此保持一致。 */
export const REPORT = '/api/dsh-coopanion-pet/report';

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
  const byAgent = new Map();
  const running = new Map();

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
  const think = (now) => ({ kind: 'think', tool: null, since: now });

  return {
    snapshot,
    agentStatus(agent, status) {
      const key = String(agent);
      if (status === 'running') {
        const prev = byAgent.get(key);
        if (!prev || prev.kind === 'think') byAgent.set(key, think(Date.now()));
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
        if (byAgent.has(key)) byAgent.set(key, think(Date.now()));
      } else {
        running.set(key, n);
      }
      return snapshot();
    },
    sweep(now = Date.now()) {
      let changed = false;
      for (const [key, st] of byAgent) {
        if (st.kind !== 'think' && now - st.since > TOOL_TTL_MS) {
          byAgent.set(key, think(now));
          changed = true;
        }
      }
      return changed;
    },
  };
}

export async function apply(ctx) {
  const tracker = createStatusTracker();
  /** 通道在 apply 就建好：HTTP 路由与工具都要用它，不能等到 webserver 注入之后。 */
  let channel = null;
  /** 页面最近上报的东西（位置、模式、装扮）。工具用它回答「她怎么样」。 */
  let petState = { connected: false };
  /** 最近活跃的 agent。用户对提问的回答要靠它送回会话。 */
  let activeAgent = null;

  /**
   * 把用户对提问的回答作为一条新消息送回会话。
   *
   * 用 `agent.followup`：它排一轮新的普通对话并唤醒驱动，这正是「用户又说了句话」
   * 该有的语义。没有活跃 agent 时静默丢弃——回答已经显示给用户了，不该因此报错。
   */
  const deliverAnswer = (text, question) => {
    const agent = activeAgent;
    if (!agent || typeof agent.followup !== 'function') {
      ctx.logger?.warn?.('dsh-coopanion-pet: 没有可用的会话，回答未送达');
      return;
    }
    const body = question
      ? `（回答桌宠的提问「${question}」）${text}`
      : text;
    try {
      agent.followup({ content: [{ type: 'text', text: body }] });
    } catch (error) {
      ctx.logger?.warn?.('dsh-coopanion-pet: 送回回答失败', error);
    }
  };

  // 必须走 inject —— apply 运行时刻 webserver 的 fiber 可能尚未创建。
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer');

    channel = createChannel();
    channel.onChange((st) => { petState = { ...petState, connected: st.connected }; });

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

    /* ---------- 2. 事件流（下行：状态 + 命令） ---------- */

    /** 上一次广播出去的状态，只有变了才推。 */
    let lastSent = '';

    const broadcast = (force = false) => {
      if (!channel.online) return;
      const snap = tracker.snapshot();
      const line = JSON.stringify(snap);
      if (!force && line === lastSent) return;
      lastSent = line;
      channel.push({ type: 'status', ...snap });
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
        res.write(': connected\n\n');
        channel.attach(res);
        lastSent = '';
        // 连上先给一份当前状态，免得等下一次变化
        try { res.write(`data: ${JSON.stringify({ type: 'status', ...tracker.snapshot() })}\n\n`); } catch (error) { /* 立刻断了就算了 */ }
      },
    });
    wctx.effect(() => disposeEvents, 'dsh-coopanion-pet: 事件流');

    /* ---------- 3. 页面回传（上行） ---------- */

    const disposeReport = webServer.register({
      kind: 'exact',
      path: REPORT,
      handler: async (req, res) => {
        const fail = (code, message) => {
          res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(message);
        };
        if (req.method !== 'POST') { fail(405, 'POST only'); return; }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          fail(400, String(error?.message ?? error));
          return;
        }
        if (!body || typeof body !== 'object') { fail(400, 'bad payload'); return; }

        try {
          if (body.kind === 'settle' && typeof body.id === 'string') {
            // 命令回执
            channel.settle(body.id, body.result ?? {});
          } else if (body.kind === 'state') {
            // 桌面侧状态：位置、模式、装扮
            const next = {};
            if (typeof body.x === 'number' && Number.isFinite(body.x)) next.x = body.x;
            if (typeof body.mode === 'string') next.mode = body.mode.slice(0, 32);
            if (typeof body.scheme === 'string') next.scheme = body.scheme.slice(0, 64);
            channel.report(next);
            petState = { ...petState, ...next };
          } else if (body.kind === 'answer') {
            // 用户回答了一个提问：作为一条新消息送回会话，让 Agent 接着做。
            const text = typeof body.text === 'string' ? body.text.slice(0, 500) : '';
            const question = typeof body.question === 'string' ? body.question.slice(0, 200) : '';
            if (!text) { fail(400, 'empty answer'); return; }
            deliverAnswer(text, question);
          } else {
            fail(400, 'unknown kind');
            return;
          }
          res.writeHead(204);
          res.end();
        } catch (error) {
          fail(500, String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposeReport, 'dsh-coopanion-pet: 回传通道');

    /* ---------- 4. 采集运行状态 ---------- */

    ctx.on('agent/status', (payload) => {
      try {
        // 记住最近活跃的 agent：用户对提问的回答要靠它送回会话
        if (payload?.agent) activeAgent = payload.agent;
        tracker.agentStatus(payload?.agent, payload?.status);
        broadcast();
      } catch (error) {
        ctx.logger?.warn?.('dsh-coopanion-pet: 处理 agent/status 失败', error);
      }
    });

    // 写法与官方策略插件一致（tools/execute 是 waterfall，必须把 next() 传下去）；
    // exec.agent 可能为空（非 agent 上下文的调用），无名调用不是真实工具，都不上报。
    ctx.on('tools/execute', async (exec, next) => {
      const key = exec?.agent === undefined ? null : String(exec.agent);
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      if (key !== null && toolName) {
        try {
          tracker.toolStart(key, toolName);
          broadcast();
        } catch (error) {
          /* 采集失败不能影响工具本身 */
        }
      }
      try {
        return await next();
      } finally {
        if (key !== null && toolName) {
          try {
            tracker.toolEnd(key);
            broadcast();
          } catch (error) {
            /* 同上 */
          }
        }
      }
    });

    const timer = setInterval(() => { if (tracker.sweep()) broadcast(); }, 15_000);
    wctx.effect(() => () => clearInterval(timer), 'dsh-coopanion-pet: 状态清扫');
    wctx.effect(() => () => channel?.dispose(), 'dsh-coopanion-pet: 通道');
  });

  /* ---------- 5. pet_* 工具 ---------- */

  // 工具要在 tools 服务就绪后注册。实测：没有活跃会话时 tools 注册表可能为空，
  // 因此必须用 inject 而不是假设 apply 时刻就能拿到。
  ctx.inject(['tools'], (tctx) => {
    const tools = tctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
      ctx.logger?.warn?.('dsh-coopanion-pet: tools 服务不可用，pet_* 工具未注册');
      return;
    }
    const defs = createPetTools({
      // 通道可能还没建好（webserver 注入晚于 tools），用惰性代理保证两边都能用
      channel: {
        command: (...a) => (channel ? channel.command(...a) : Promise.resolve({ ok: false, reason: 'offline' })),
        get online() { return channel?.online ?? false; },
      },
      getPetState: () => petState,
    });

    for (const [key, def] of Object.entries(defs)) {
      try {
        const off = tools.register(def);
        tctx.effect(() => off, `dsh-coopanion-pet: 工具 ${def.name}`);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-coopanion-pet: 注册工具 ${def.name} 失败（${key}）`, error);
      }
    }
    ctx.logger?.info?.(`dsh-coopanion-pet: 已注册 ${Object.keys(defs).length} 个 pet_* 工具`);
  });

  /* ---------- 6. 环境提示词 ---------- */

  // 让模型知道她存在、有哪些工具、什么时候别用。放在工具注册之后：
  // 提示词描述的工具必须真的能用。
  ctx.inject(['systemPrompt'], (pctx) => {
    const systemPrompt = pctx.get('systemPrompt');
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      ctx.logger?.warn?.('dsh-coopanion-pet: systemPrompt 服务不可用，提示词未注入');
      return;
    }
    try {
      systemPrompt.section({
        name: 'ui:coopanion-pet',
        // 排在工具说明之后：它引用上面那些 pet_* 工具的名字
        order: systemPrompt.getSectionOrder?.('TOOLS') ?? 100,
        text: PET_PROMPT,
      });
    } catch (error) {
      ctx.logger?.warn?.('dsh-coopanion-pet: 注入提示词失败', error);
    }
  });

  ctx.logger?.info?.(`dsh-coopanion-pet: 已挂载（资源 ${ROUTE}/，事件 ${EVENTS}，回传 ${REPORT}）`);
}
