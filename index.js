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
import { detectSpeechToText, detectTextToSpeech, TTS_ROUTE, STT_PACKAGE } from './lib/optional.js';

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
/** 页面把录到的 WAV 送来这里识别（可选：宿主没装语音输入插件时返回 501）。 */
export const SPEECH = '/api/dsh-coopanion-pet/speech';
/** 页面把要朗读的文字送来这里合成（可选：宿主没装 TTS 插件时返回 501）。 */
export const TTS = '/api/dsh-coopanion-pet/tts';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
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
  // 语音：听与说各自成一类，气泡上分得出来
  [/^pet_listen$|^listen$/, 'listen'],
  [/^pet_speak$|^speak$|^tts/, 'speak'],
  // CUA（dsh-computer-use-win 经 MCP 暴露成 mcp__wincu__*）：看屏幕、点鼠标、
  // 敲键盘——对用户来说就是「在操作电脑」，因此归成一类，气泡里带上具体动作。
  [/^mcp__wincu__|^windows_computer_use|^mcp__.*__(screenshot|snapshot|ocr|find|element_info|list_windows|accessibility_tree)/, 'screen'],
  [/^mcp__.*__(click|double_click|move|drag|scroll|type_text|keypress|focus|invoke|set_value)/, 'control'],
];

/**
 * 从工具参数里挑出「在做什么」的具体对象，显示在她的状态气泡里。
 *
 * DSH 的 `tools/execute` 给的是**已经解析好的对象**，因此不必像上游那样
 * 从流式 JSON 里抠字段——直接读就行。
 *
 * 只要一个短标签：文件取 basename，命令取首行并压掉多余空白。
 */
const TOOL_TARGETS = [
  ['file_path', 'file'],
  ['path', 'file'],
  ['pattern', 'text'],
  ['glob', 'text'],
  ['command', 'text'],
  ['description', 'text'],
  ['query', 'text'],
  ['url', 'text'],
  // CUA 的参数：窗口标题、要找的控件、要敲的文字——都比工具名本身更能说明在干什么
  ['title', 'text'],
  ['window', 'text'],
  ['text', 'text'],
  ['name', 'text'],
];

/** 一个参数值 → 可显示的短标签。 */
function targetOf(args) {
  if (!args || typeof args !== 'object') return null;
  for (const [key, kind] of TOOL_TARGETS) {
    const raw = args[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const text = raw.trim().replace(/\s+/g, ' ');
    if (kind === 'file') {
      // 只留文件名：完整路径在气泡里太长，也把用户目录摊开在屏幕上
      const base = text.split(/[\\/]/).filter(Boolean).pop() ?? text;
      return base.slice(0, 32);
    }
    return text.slice(0, 40);
  }
  return null;
}
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
    if (!st) return { kind: 'none' };
    // target 只在有值时下发，省得每帧带一堆 null
    return st.target
      ? { kind: st.kind, tool: st.tool, target: st.target, since: st.since }
      : { kind: st.kind, tool: st.tool, since: st.since };
  };
  const think = (now) => ({ kind: 'think', tool: null, target: null, since: now });

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
    toolStart(agent, toolName, args) {
      const key = String(agent);
      running.set(key, (running.get(key) ?? 0) + 1);
      const kind = TOOL_WORDS.find(([re]) => re.test(toolName))?.[1] ?? 'work';
      // 具体在做什么：文件名或命令，让气泡从「正在读文件」细到「正在看 config.ts」
      byAgent.set(key, { kind, tool: toolName, target: targetOf(args), since: Date.now() });
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

  /* ---------- 可选接缝 ----------
     语音识别与语音合成都是**可选**的：对应插件没装、没就绪或已关闭时，
     下面的对象返回 null，调用方安全跳过。因此这里不写 `inject`——`inject` 是
     必需依赖，缺一个整插件就加载不了；语音不该挡住桌宠。 */
  const speech = detectSpeechToText(ctx);
  const tts = detectTextToSpeech();

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

    /* ---------- 3.5 可选：语音识别与合成 ----------
       两个端点都**只在对应能力可用时才工作**，否则回 501 与一句人话原因。
       页面据此安全跳过——她不会因为宿主没装语音插件而报错或卡住。

       为什么绕宿主而不让页面直接调：
       - 识别：DSH 的 speechToText 是**宿主侧服务**，浏览器端拿不到（客户端插件
         运行时只有 slots/connection/loader/modules）；官方语音输入插件也是经
         它的 Remote 桥过来的。这里走同一套服务，不自己搬 ASR。
       - 合成：dsh-xiaomi-tts 注册的是**同源路由**，页面本来就能直接 POST。
         但绕宿主一圈有实际好处：路由不在时能给出「没装那个插件」这句人话，
         而不是让页面拿到一个 404 去猜。 */

    const disposeSpeech = webServer.register({
      kind: 'exact',
      path: SPEECH,
      handler: async (req, res) => {
        const fail = (code, reason, message) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, reason, message }));
        };
        // GET 是**能力探测**：页面在申请麦克风权限之前先问一句「你能不能听」，
        // 免得没装语音插件时还去弹权限框、让用户白点一次拒绝。
        // 这里只回能力状态，不碰音频。
        if (req.method === 'GET' || req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, available: speech.available, package: STT_PACKAGE }));
          return;
        }
        if (req.method !== 'POST') { fail(405, 'method', 'POST only'); return; }
        if (!speech.available) {
          fail(501, 'no-speech-plugin', `语音输入不可用：宿主里没有装上带识别能力的插件（${STT_PACKAGE}）。装好并重启后她才能听。`);
          return;
        }
        let body;
        try {
          // 上限必须放宽：readJson 默认只收 64KB，而一段 2 秒的 16kHz 单声道
          // PCM16 录音 base64 后就有 ~85KB，会被判成「payload too large」而把
          // 连接直接 destroy 掉——浏览器侧表现为 ERR_EMPTY_RESPONSE（连响应都没有）。
          // 15 秒录音 base64 约 640KB，这里给到 1.5MB；解码后的真实大小在下面另有一道校验。
          body = await readJson(req, 1_500_000);
        } catch (error) {
          fail(413, 'too-large', String(error?.message ?? error));
          return;
        }
        // 页面送的是 base64 的 WAV：整段录音，识别单位就是一句
        const base64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : '';
        if (!base64) { fail(400, 'no-audio', '缺少 audioBase64'); return; }
        let wav;
        try {
          wav = Buffer.from(base64, 'base64');
        } catch (error) {
          fail(400, 'bad-audio', 'base64 解不开');
          return;
        }
        if (!wav.byteLength) { fail(400, 'no-audio', '录音是空的'); return; }
        // 上限：15 秒 16kHz 单声道 PCM16 约 480KB，base64 约 640KB；给一倍余量
        if (wav.byteLength > 1_400_000) { fail(413, 'too-long', '录音太长'); return; }
        try {
          const text = await speech.transcribe(
            new Uint8Array(wav),
            typeof body?.language === 'string' ? body.language : '',
          );
          if (text === null) {
            // 服务在这期间被撤掉了（插件卸载/关闭）
            fail(503, 'no-speech-plugin', '识别服务刚被撤下，这次没听到。');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: true, text }));
        } catch (error) {
          fail(502, 'speech-failed', String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposeSpeech, 'dsh-coopanion-pet: 语音识别端点');

    const disposeTts = webServer.register({
      kind: 'exact',
      path: TTS,
      handler: async (req, res) => {
        const fail = (code, reason, message) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, reason, message }));
        };
        if (req.method !== 'POST') { fail(405, 'method', 'POST only'); return; }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          fail(400, 'bad-json', String(error?.message ?? error));
          return;
        }
        const text = typeof body?.text === 'string' ? body.text : '';
        if (!text.trim()) { fail(400, 'no-text', '没有要读的文字'); return; }
        // 上游默认上限 12000 字；桌宠的台词都很短，这里卡在 500 字免得被当朗读器使
        if (text.length > 500) { fail(413, 'too-long', '一次最多 500 字'); return; }
        // 宿主侧的 fetch 不接受相对 URL，因此按本次请求的 Host 组一个绝对地址。
        // 用请求里的 Host 而不是写死 127.0.0.1，是因为宿主可能绑在别的地址上；
        // 这个请求本来就是浏览器打到本宿主的，Host 必然指向它自己。
        const host = req.headers.host ?? '127.0.0.1';
        const audio = await tts.synthesize(text, {
          format: typeof body?.format === 'string' ? body.format : undefined,
          base: `http://${host}`,
        });
        if (!audio) {
          fail(501, 'no-tts-plugin', `语音合成不可用：宿主里没有 ${TTS_ROUTE} 这条路由（dsh-xiaomi-tts 未装、未启用，或没配 API key）。装好并重启后她才能出声。`);
          return;
        }
        res.writeHead(200, {
          'Content-Type': audio.type,
          'Content-Length': String(audio.audio.byteLength),
          'Cache-Control': 'no-store',
        });
        res.end(Buffer.from(audio.audio));
      },
    });
    wctx.effect(() => disposeTts, 'dsh-coopanion-pet: 语音合成端点');

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
          tracker.toolStart(key, toolName, exec?.arguments);
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
