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
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createChannel, readJson } from './lib/channel.js';
import { createPetTools } from './lib/tools.js';
import { PET_PROMPT } from './lib/prompt.js';
import { detectSpeechToText, detectTextToSpeech, TTS_ROUTE, STT_PACKAGE } from './lib/optional.js';
import { createCuaPolicy, cuaGate, PERMISSION_LEVELS } from './lib/cua-policy.js';
import { scanPacks, resolvePackFile, MANIFEST_FILE } from './lib/packs.js';
import { createImporter, IMPORT_MAX } from './lib/pack-import.js';
import { createDesktopBridge } from './lib/desktop-bridge.js';
import { createChatService } from './lib/chat-service.js';

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
/**
 * 41：形象包的路由前缀。
 *
 * - `/dsh-coopanion-pet/packs`：包清单（页面用它列出可用形象）
 * - `/dsh-coopanion-pet/packs/<id>/…`：包内的素材文件
 * - `/dsh-coopanion-pet/packs/<id>/__entry.js`：包的入口脚本（沙箱 frame 加载它）
 * - `/dsh-coopanion-pet/frame`：沙箱 frame 的页面与脚本
 */
/**
 * 41：形象包的路由前缀。
 *
 * **同样刻意不在 `/api` 下**：沙箱 iframe 是 opaque origin、不带 cookie，
 * 因此包内的素材与入口脚本若走 `/api` 会被鉴权拦下（401）。
 * 挪出来之后不走鉴权，且这些文件本来就是本插件自己的静态资源。
 *
 * - `/dsh-coopanion-pet/packs`：包清单
 * - `/dsh-coopanion-pet/packs/<id>/…`：包内素材
 * - `/dsh-coopanion-pet/packs/<id>/__entry.js`：包的入口脚本
 */
export const PACKS = '/dsh-coopanion-pet/packs';
/** 42：导入端点。 */
export const IMPORT = '/api/dsh-coopanion-pet/import';
/** 41：沙箱 frame 的页面。 */
/**
 * 41：沙箱 frame 的页面。
 *
 * **刻意不在 `/api` 下**：DSH 的鉴权中间件拦 `/api` 前缀的全部请求，
 * 而沙箱 iframe 是 **opaque origin，不带 cookie**，因此 `/api/...` 会被 401。
 * 实测（见 docs/risk-verification.md 的第二轮）：脚本请求报
 * `origin 'null' has been blocked`，根因就是鉴权而不是 CORS。
 *
 * 挪到 `/api` 之外后不走鉴权；frame 里只有本插件自己的静态文件，
 * 且 CSP 把它的来源限死（`default-src 'none'`），因此安全边界不变。
 */
export const FIGURE_FRAME = '/dsh-coopanion-pet/frame';

/**
 * 46：独立预览页。一个带地板与墙的最小页面，只为「单独看她」用。
 *
 * 为什么不复用 DSH 的页面：那个页面里她住在覆盖层里，下面是完整的应用界面。
 * 想单独看她（调形象、录屏、给别人演示）时需要一块干净的背景。
 *
 * 与桌宠共用同一套资源（`assets/`）与同一条 SSE 通道，因此预览页里的她
 * 一样能说话、走位、收工具命令。
 */
export const PREVIEW = '/api/dsh-coopanion-pet/preview';

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

/**
 * 把文件流安全地送出去。
 *
 * **必须挂 error 处理**：`createReadStream(file).pipe(res)` 在文件于
 * `existsSync` 与流打开之间消失（并发删除、包被 rm、权限变化）时会抛
 * **未处理的 stream error**，在 Node 里那是 uncaughtException，可能把
 * 整个宿主进程带崩。这里把「头还没发出去」与「已经发了」分开处理：
 * 前者可以回 500，后者只能掐断连接。
 *
 * @param res - 响应对象。
 * @param file - 已经过存在性检查的绝对路径。
 * @param headers - 要写的响应头。
 */
function sendFile(res, file, headers) {
  let headersSent = false;
  const stream = createReadStream(file);
  stream.on('error', (error) => {
    // 已经发出去的头改不了，只能结束连接；没发出去的还能回一个 500
    if (headersSent) {
      try { res.destroy(); } catch (e) { /* 已经断了 */ }
      return;
    }
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读文件失败');
    } catch (e) { /* 连接已经没了 */ }
    // 打一条日志：这类错误若静默，排查时完全看不出发生了什么
    console.warn('[dsh-coopanion-pet] 读文件失败：', file, error?.message ?? error);
  });
  stream.on('open', () => {
    try { res.writeHead(200, headers); headersSent = true; } catch (e) { headersSent = true; }
  });
  stream.pipe(res);
}

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

  /* ---------- 41/42：形象包 ----------
     包放在 DSH home 下（不是插件包里）——插件包升级时不该丢掉用户装的形象。
     内置的两个（whale / coo）在 assets/ 下，不占这个目录。 */
  const PACK_DIR = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'coopanion-pet-packs');
  /** 内置形象 id：不许被导入的包覆盖（与上游一致）。 */
  const BUILTIN_FIGURES = ['whale', 'coo'];
  const importer = createImporter({ packDir: PACK_DIR, builtins: BUILTIN_FIGURES });

  /**
   * CUA 权限政策层：当 `mcp__wincu__*` 要动用户的电脑时，由桌宠当面问一句。
   *
   * 她不在时 `ask` 会等超时，政策按「不许」处理——但**那种情况不该发生**：
   * 没有页面时 `channel.online` 为假，`permit` 直接返回 `unavailable`，
   * 不去抢审批，让 DSH 自己的审批通道处理，免得把用户的 CUA 卡死。
   */
  const cuaPolicy = createCuaPolicy({
    ask: async (question, choices) => {
      if (!channel?.online) return 'timeout';
      try {
        // 让她用气泡问：两个选项，等用户点或按 1/2
        const res = await channel.command('confirm', {
          question,
          choices: choices.slice(0, 2),
        }, 120_000);
        if (!res.ok) return 'timeout';
        return res.choice === 'yes' ? 'yes' : 'no';
      } catch (error) {
        return 'timeout';
      }
    },
  });

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

  /** 独立窗口的运行状态（设置面板与 pet_desktop 读它）。 */
  /**
   * 独立窗口的**最后一条状态日志**（`{ at, line }`）。
   *
   * 刻意**不带** `running`/`port` 之类的字段：真实值来自 `desktopBridge.state`，
   * 若这里也放一份默认值，展开时会把真实值覆盖掉（实测踩过这个坑）。
   */
  let desktopStatus = { at: 0, line: '' };
  /**
   * 独立窗口的偏好（由页面报来——它存在浏览器 localStorage，宿主读不到）。
   */
  let desktopPrefs = { enabled: false, hotkey: 'Alt+Space', electron: '' };
  /**
   * 桥接实例。
   *
   * 它建在 `webServer` 的注入回调里（那里才拿得到 `webServer` 与 `channel`），
   * 而工具与设置面板在别的注入回调里——因此用这个外层变量转一手。
   */
  let desktopBridge = null;

  // 必须走 inject —— apply 运行时刻 webserver 的 fiber 可能尚未创建。
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer');

    channel = createChannel();
    channel.onChange((st) => { petState = { ...petState, connected: st.connected }; });

    /**
     * 独立聊天面板的宿主侧服务。
     *
     * `getContext` 返回**注入后的 ctx**：会话服务（sessionController / sessionQuery）
     * 在 `apply` 时刻还没就绪，必须等注入回调里才拿得到（实测确认）。
     */
    const chat = createChatService({ getContext: () => wctx });

    /**
     * 独立桌宠窗口的桥接（Electron）。
     *
     * **它让独立窗口里的她拥有与 DSH 页面里相同的能力**——因为窗口连上的是
     * 同一条 `channel`，于是 `pet_*` 工具、状态气泡、语音、审批全部照旧。
     *
     * 桥接服务刻意不在 `/api` 下：独立窗口没有 DSH 的 cookie，
     * 走 `/api` 会被鉴权拦下（这是做 v1.8 沙箱时实测到的同一个根因）。
     */
    const desktop = createDesktopBridge({
      channel,
      report: (payload) => handleReport(payload),
      logger: ctx.logger,
      pluginDir: HERE,
      // 聊天面板的三个端点由 bridge 直接实现（背后是 DSH 的会话服务）
      chat,
      /**
       * 状态变更：**并入**而不是整体替换——否则 `running`/`port` 会被
       * 一条日志行覆盖掉，设置面板就看不到真实状态（实测踩过）。
       */
      onStatus: (st) => { desktopStatus = { ...desktopStatus, ...st }; },
    });
    desktopBridge = desktop;
    wctx.effect(() => { desktop.stop().catch(() => {}); }, 'dsh-coopanion-pet: 独立窗口');

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
          // 加 CORS 头是**为形象包沙箱预留的**：实测（风险 3 验证）opaque origin 的
          // 沙箱 iframe 里 `fetch` 会被 CORS 拦下（`new Image()` 不受限，因此纹理本来
          // 就能加载，但读 model.json 之类要 fetch 的就不行）。放开这一个只读资源路由
          // 的 CORS 没有安全代价——它本来就是对浏览器公开的静态资源。
          sendFile(res, file, {
            'Content-Type': type,
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
          });
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposeAssets, 'dsh-coopanion-pet: 静态资源路由');

    /* ---------- 1.5 独立预览页（46） ----------
       一个带地板与墙的干净页面，只为「单独看她」——调形象、录屏、演示。
       它加载的是同一套客户端模块，因此能力与 DSH 页面里的她相同。 */
    const disposePreview = webServer.register({
      kind: 'exact',
      path: PREVIEW,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          res.end();
          return;
        }
        const file = path.join(ASSETS_DIR, 'preview.html');
        if (!existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('preview page missing');
          return;
        }
        sendFile(res, file, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      },
    });
    wctx.effect(() => disposePreview, 'dsh-coopanion-pet: 预览页');

    /**
     * 预览页还要用 `client.js`，而它在**包根**（不在 assets/ 下，因此静态资源路由
     * 够不到它）。单独开一条精确路由提供它。
     *
     * 为什么不把 client.js 挪进 assets/：DSH 的 `dsh.client` 入口指向包根的它，
     * 挪动会改动主路径的加载方式。
     */
    const disposePreviewClient = webServer.register({
      kind: 'exact',
      path: `${ROUTE}/client.js`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        const file = path.join(HERE, 'client.js');
        if (!existsSync(file)) { res.writeHead(404); res.end('client missing'); return; }
        sendFile(res, file, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      },
    });
    wctx.effect(() => disposePreviewClient, 'dsh-coopanion-pet: 预览页脚本');

    /* ---------- 41/42：形象包路由 ----------
       包放在 DSH home 下的 PACK_DIR（插件包升级不会丢用户装的形象）。
       包代码只在沙箱 frame 里跑，宿主**只读文件、不执行**。 */
    try { mkdirSync(PACK_DIR, { recursive: true }); } catch (error) { /* 建不出来后面会报 */ }

    /** 包目录里当前的包（每次请求现扫，装了新包立刻生效）。 */
    const listPacks = () => {
      const r = scanPacks(PACK_DIR);
      return r;
    };

    /** 清单：内置两个 + 目录里装的。 */
    const disposePackList = webServer.register({
      kind: 'exact',
      path: PACKS,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        const { packs, problems } = listPacks();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          builtin: BUILTIN_FIGURES,
          installed: packs.map((p) => ({
            id: p.id, version: p.version, name: p.name, author: p.author,
            axes: p.axes, presets: p.presets, can: p.can,
            // **客户端建 body 要用这两个**：entry 决定加载哪个文件、
            // export 决定调哪个导出函数。第一版漏了它们，于是沙箱报
            // 「包的入口没有导出 」（导出名是空串）。
            entry: p.entry, export: p.export, vocab: p.vocab,
          })),
          problems,
          // zip 那条路没做（不引第三方 inflate 库），如实说明
          zipSupported: false,
        }));
      },
    });
    wctx.effect(() => disposePackList, 'dsh-coopanion-pet: 包清单');

    /** 包内的素材与入口脚本。 */
    const disposePackFiles = webServer.register({
      kind: 'prefix',
      // 用 PACKS 而不是 PACKS + '/'：prefix 的语义是「以此开头」，
      // 加上尾斜杠后 `/packs` 本身（清单）会被这条路由抢走，子路径的切片也会错位。
      path: PACKS,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const rest = decodeURIComponent(url.pathname.slice(PACKS.length)).replace(/^\/+/, '');
          const slash = rest.indexOf('/');
          // 没有子路径 = 清单本身（那条精确路由管它），这里让位
          if (slash <= 0) { res.writeHead(404); res.end('bad pack path'); return; }
          const id = rest.slice(0, slash);
          const rel = rest.slice(slash + 1);
          const { packs } = listPacks();
          const pack = packs.find((p) => p.id === id);
          if (!pack) { res.writeHead(404); res.end('no such pack'); return; }
          // 入口脚本走单独一支：沙箱要 import 它，因此不限制扩展名
          if (rel === '__entry.js') {
            const file = path.join(pack.dir, pack.entry);
            if (!existsSync(file)) { res.writeHead(404); res.end('entry missing'); return; }
            sendFile(res, file, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
            return;
          }
          // 其余只放素材（图片/音频），防止任意文件被读出去
          const file = resolvePackFile(pack.dir, rel);
          if (!file) { res.writeHead(404); res.end('not found'); return; }
          const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
          sendFile(res, file, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
        } catch (error) {
          res.writeHead(400); res.end(String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposePackFiles, 'dsh-coopanion-pet: 包文件');

    /**
     * 41：沙箱 frame 的页面与脚本。
     *
     * **关键：给这里加 CSP，把 frame 限制成 opaque origin。**
     * 页面用 `sandbox="allow-scripts"`（不给 allow-same-origin），
     * 而 CSP 再补一道：只允许加载自己的脚本与图片，禁止任何连接。
     *
     * 上游（`src/server.ts`）也是这么做的——两道防线一起上。
     */
    const disposeFrame = webServer.register({
      kind: 'prefix',
      path: FIGURE_FRAME,
      handler: (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const rel = url.pathname.slice(FIGURE_FRAME.length).replace(/^\/+/, '');
        const name = rel === '' ? 'figure-frame.html' : rel;
        const file = path.join(ASSETS_DIR, path.basename(name));
        if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(file).toLowerCase();
        // 无扩展名的请求（/figure-frame）当 HTML 处理——**CSP 只对 HTML 加**，
        // 因此这里必须把「按扩展名判」改成「按实际文件判」，否则 CSP 会漏掉。
        const isHtml = ext === '.html' || ext === '';
        const type = isHtml ? 'text/html; charset=utf-8' : (MIME[ext] ?? 'application/octet-stream');
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
        /**
         * **脚本与 HTML 都要带 CORS 头。**
         *
         * 实测：沙箱是 opaque origin（origin 为 `null`），此时 CSP 里的 `'self'`
         * 对它不成立，因此脚本请求会被 CORS 拦下（`origin 'null' has been blocked`）。
         * 加上 `Access-Control-Allow-Origin: *` 才放行——这也与资源路由的做法一致。
         */
        if (isHtml || type.startsWith('text/javascript')) headers['Access-Control-Allow-Origin'] = '*';
        if (isHtml) {
          // 沙箱的两道防线：CSP 限死来源，页面侧再叠 sandbox 属性
          headers['Content-Security-Policy'] = [
            "default-src 'none'",
            "script-src 'self'",
            "img-src 'self'",
            "style-src 'unsafe-inline'",
            "connect-src 'none'",
          ].join('; ');
        }
        sendFile(res, file, headers);
      },
    });
    wctx.effect(() => disposeFrame, 'dsh-coopanion-pet: 沙箱 frame');

    /** 42：导入端点。 */
    const disposeImport = webServer.register({
      kind: 'exact',
      path: IMPORT,
      handler: async (req, res) => {
        const fail = (code, reason, message) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, reason, message }));
        };
        if (req.method !== 'POST') { fail(405, 'method', 'POST only'); return; }
        let body;
        try {
          // 上限与 IMPORT_MAX 一致（base64 会胀 1/3，因此放宽）
          body = await readJson(req, Math.round(IMPORT_MAX * 1.4));
        } catch (error) {
          /**
           * **按错误类型区分**：原来一律回 413「too-large」，
           * 连「JSON 非法」也这么报，排查时会被引到错误的方向
           * （实测确认过的问题）。
           */
          const msg = String(error?.message ?? error);
          if (msg === 'payload too large') fail(413, 'too-large', msg);
          else fail(400, 'bad-json', msg);
          return;
        }
        const action = String(body?.action ?? 'stage');
        try {
          if (action === 'stage') {
            // 页面把文件列表发来：`[{ path, base64 }]`
            const raw = Array.isArray(body?.files) ? body.files : [];
            if (!raw.length) { fail(400, 'no-files', '没有收到文件'); return; }
            const files = raw.map((f) => ({ path: String(f?.path ?? ''), data: Buffer.from(String(f?.base64 ?? ''), 'base64') }));
            const out = await importer.stage(files);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...out }));
            return;
          }
          if (action === 'install') {
            const out = await importer.install(String(body?.token ?? ''), body?.ids);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, ...out }));
            return;
          }
          if (action === 'cancel') {
            await importer.cancel();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          fail(400, 'bad-action', 'action 必须是 stage / install / cancel');
        } catch (error) {
          fail(400, 'import-failed', String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposeImport, 'dsh-coopanion-pet: 导入端点');

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
        /**
         * **对话栈也要补发**：`pushLine` 只在有新消息时推送，而页面刷新后
         * 是新连接——不补这一份的话，对话栈一直空着，直到下一条消息才出现，
         * 用户看到的是「刷新把历史清空了」（实测确认过的问题）。
         */
        if (lines.length) {
          try { res.write(`data: ${JSON.stringify({ type: 'lines', lines: lines.map((l) => ({ role: l.role, text: l.text })) })}\n\n`); } catch (error) { /* 同上 */ }
        }
      },
    });
    wctx.effect(() => disposeEvents, 'dsh-coopanion-pet: 事件流');

    /* ---------- 3. 页面回传（上行） ---------- */

    /**
     * 处理一条页面回传（`/report` 的 body）。
     *
     * **抽成独立函数的原因**：独立窗口（Electron）走的是宿主侧另一个本地服务
     * （见 `lib/desktop-bridge.js`），但**上行的语义完全一样**。抽出来之后
     * 两条通道共用同一份处理，不必维护两套。
     *
     * @returns `{ ok: true }` 或 `{ ok: false, code, message }`。
     */
    async function handleReport(body) {
      if (!body || typeof body !== 'object') return { ok: false, code: 400, message: 'bad payload' };
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
      } else if (body.kind === 'speech-submit') {
        /**
         * 55 的降级方案：把识别文本**作为一条用户消息**送进会话。
         *
         * 为什么不用「填进 DSH 输入框」：那条路要 `inputActions`，而它只经
         * `conversation.input.activity` 提供，**那个槽是 single 且被官方语音输入插件
         * 独占**（实测：注册会报 "already has a registration"，而 DOM 直改会被
         * React 受控组件覆盖）。因此改走这条路：语义上等价于「用户说了这句话」，
         * 只是会直接触发一轮对话，而不是填进输入框等用户自己按回车。
         */
        const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : '';
        if (!text) return { ok: false, code: 400, message: 'empty-text' };
        const agent = activeAgent;
        if (!agent || typeof agent.followup !== 'function') {
          return { ok: false, code: 503, message: '当前没有可用的会话，语音内容没能送出去。' };
        }
        try {
          agent.followup({ content: [{ type: 'text', text }] });
        } catch (error) {
          return { ok: false, code: 500, message: String(error?.message ?? error) };
        }
      } else if (body.kind === 'cua-level') {
        // 设置面板改了审批档位：宿主侧的政策层是真正生效的那个，因此由它来改。
        // 页面不持有这个状态（它拿不到政策层对象）。
        const lv = typeof body.level === 'string' ? body.level : '';
        if (!PERMISSION_LEVELS.includes(lv)) return { ok: false, code: 400, message: 'bad-level' };
        cuaPolicy.setLevel(lv);
        if (typeof body.grantMinutes === 'number') cuaPolicy.setGrantMinutes(body.grantMinutes);
      } else if (body.kind === 'desktop-prefs') {
        /**
         * 页面报来独立窗口的三个偏好（它存在浏览器的 localStorage 里，宿主读不到）。
         *
         * 收到后：**按偏好决定要不要拉起独立窗口**。这是「启动时打开独立窗口」
         * 那个开关的实现——用户勾上，下次 DSH 一起来她就在桌面上。
         */
        desktopPrefs = {
          enabled: body.enabled === true,
          hotkey: String(body.hotkey ?? 'Alt+Space').slice(0, 60),
          electron: String(body.electron ?? '').slice(0, 500),
        };
        if (desktopBridge && desktopPrefs.enabled) {
          const r = await desktopBridge.start({ electronPath: desktopPrefs.electron || process.env.DSH_COOPANION_ELECTRON, hotkey: desktopPrefs.hotkey });
          if (!r?.ok) {
            ctx.logger?.warn?.('dsh-coopanion-pet: 独立窗口没能启动：' + (r?.reason ?? 'unknown'));
          }
        }
      } else if (body.kind === 'desktop-stop') {
        // 设置面板点了「关闭」：停掉 bridge（它会连带杀掉 Electron 进程树）
        if (desktopBridge) await desktopBridge.stop();
      } else if (body.kind === 'answer') {
        // 用户回答了一个提问：作为一条新消息送回会话，让 Agent 接着做。
        const text = typeof body.text === 'string' ? body.text.slice(0, 500) : '';
        const question = typeof body.question === 'string' ? body.question.slice(0, 200) : '';
        if (!text) return { ok: false, code: 400, message: 'empty answer' };
        deliverAnswer(text, question);
      } else {
        return { ok: false, code: 400, message: 'unknown kind' };
      }
      return { ok: true };
    }

    const disposeReport = webServer.register({
      kind: 'exact',
      path: REPORT,
      handler: async (req, res) => {
        const fail = (code, message) => {
          res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(message);
        };
        /**
         * **GET 用来读宿主侧的真实状态**（目前是 CUA 审批档位）。
         *
         * 为什么需要：设置面板原来把档位写进 localStorage 再 POST 一次，
         * POST 失败静默——于是面板显示的是**本地那份**，而真正生效的是
         * 宿主政策层那份（默认 `ask-once`）。用户设成最严的
         * `ask-each-turn` 后重启 DSH，面板还显示「每一轮」，实际更松
         * （实测确认过的问题）。让面板能读到真值就消除了这个错位。
         */
        if (req.method === 'GET' || req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({
            ok: true,
            cua: { level: cuaPolicy.state.level, grantMinutes: cuaPolicy.state.grantMinutes, granted: cuaPolicy.state.granted === true },
            // 独立窗口的状态：设置面板与验证脚本读它
            desktop: desktopBridge ? { ...desktopStatus, ...desktopBridge.state } : desktopStatus,
          }));
          return;
        }
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
          /**
           * 共用 `handleReport`：**独立窗口（Electron）那条通道走的是同一份逻辑**。
           * 抽出来之后两条通道的行为必然一致，不必维护两套。
           */
          const r = await handleReport(body);
          if (!r.ok) { fail(r.code ?? 400, r.message ?? 'bad payload'); return; }
          res.writeHead(204);
          res.end();
        } catch (error) {
          fail(500, String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposeReport, 'dsh-coopanion-pet: 回传通道');

    /**
     * 独立窗口的启停端点（设置面板与验证脚本用）。
     *
     * 为什么要有它：独立窗口的启动要走宿主侧的 Electron 路径探测，
     * 页面自己做不了。`pet_desktop` 工具走的是同一套。
     */
    const disposeDesktopCtl = webServer.register({
      kind: 'exact',
      path: '/api/dsh-coopanion-pet/desktop-start',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        try {
          const out = await desktop.start({ electronPath: process.env.DSH_COOPANION_ELECTRON });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }));
        }
      },
    });
    wctx.effect(() => disposeDesktopCtl, 'dsh-coopanion-pet: 独立窗口启停');

    /**
     * 验证用的命令下发端点（`pet_say` 工具走的是同一条通道）。
     */
    const disposeSayTest = webServer.register({
      kind: 'exact',
      path: '/api/dsh-coopanion-pet/say-test',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let body = null;
        try { body = await readJson(req); } catch (error) { /* 空也算 */ }
        const text = String(body?.text ?? 'test').slice(0, 200);
        const r = await channel.command('say', { text }, 8000);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r));
      },
    });
    wctx.effect(() => disposeSayTest, 'dsh-coopanion-pet: 验证端点');

    /* ---------- 3.4 独立聊天面板的三个端点 ----------
       面板在 Electron 窗口里，拿不到 DSH 的 cookie，因此这三个端点走宿主侧的
       **非 /api 前缀**（与独立窗口的桥接同因：/api 受鉴权保护）。
       它们操作的是**同一批会话**——因此面板与 DSH 主面板看到的是同一份对话，
       这也正是「可以切回主面板」的基础。 */

    const chatFail = (res, r) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(r));
    };

    const disposeChatList = webServer.register({
      kind: 'exact',
      path: '/api/dsh-coopanion-pet/chat/list',
      handler: async (req, res) => {
        chatFail(res, await chat.list());
      },
    });
    wctx.effect(() => disposeChatList, 'dsh-coopanion-pet: 聊天列表');

    /**
     * **prefix 路由不能带尾斜杠**（v1.8 的包路由踩过同一个坑）：
     * 带斜杠时 `/chat/history` 本身不匹配，而切片长度也会错位。
     */
    const CHAT_HISTORY = '/api/dsh-coopanion-pet/chat/history';
    const disposeChatHistory = webServer.register({
      kind: 'prefix',
      path: CHAT_HISTORY,
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const id = decodeURIComponent(url.pathname.slice(CHAT_HISTORY.length)).replace(/^\/+/, '');
        chatFail(res, await chat.history(id));
      },
    });
    wctx.effect(() => disposeChatHistory, 'dsh-coopanion-pet: 聊天历史');

    /**
     * 诊断端点：dump 一条会话记录的**原始结构**，好对准字段名。
     */
    const disposeChatProbe = webServer.register({
      kind: 'exact',
      path: '/api/dsh-coopanion-pet/chat/probe',
      handler: async (req, res) => {
        try {
          const ctx2 = wctx;
          const ctrl = ctx2.get('sessionController');
          const q = ctx2.get('sessionQuery');
          const ac = new AbortController();
          const raw = await ctrl.list({}, ac.signal);
          const titles = q ? await q.readTitleSnapshots((raw?.sessions ?? raw?.items ?? []).slice(0, 3).map((x) => x.id ?? x.sessionId), ac.signal).catch((e) => String(e.message)) : null;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            rawKeys: Object.keys(raw ?? {}),
            firstRow: (raw?.sessions ?? raw?.items ?? [])[0] ?? null,
            titles,
          }, null, 1));
        } catch (error) {
          res.writeHead(500); res.end(String(error?.message ?? error));
        }
      },
    });
    wctx.effect(() => disposeChatProbe, 'dsh-coopanion-pet: 诊断');

    const disposeChatSend = webServer.register({
      kind: 'exact',
      path: '/api/dsh-coopanion-pet/chat/send',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let body = null;
        try { body = await readJson(req, 64 * 1024); } catch (error) { /* 空也算 */ }
        chatFail(res, await chat.send(body?.sessionId, body?.text, body?.requestId));
      },
    });
    wctx.effect(() => disposeChatSend, 'dsh-coopanion-pet: 聊天发送');

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
          /**
           * 44：能力探测顺便把**识别器的就绪状态**一起报出去。
           *
           * 为什么需要：语音识别要下载模型（SenseVoice 约 231MB）。用户在设置面板里
           * 应当看得到「模型已就绪 / 还没下载」，而不是调了一次才发现要等。
           *
           * 上游（src/runtime/store.ts）自己管理模型下载；本插件**不重复那件事**——
           * 模型由 DSH 的语音输入插件管，这里只**显示状态**，如实说明谁在管。
           */
          const info = { ok: true, available: speech.available, package: STT_PACKAGE };
          try {
            const list = speech.providers?.();
            if (Array.isArray(list) && list.length) info.providers = list;
          } catch (error) {
            /* 拿不到就少报一项，不影响可用性判断 */
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(info));
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
          // 同 import 端点：过大与坏 JSON 要分开报，否则排查会被误导
          const msg = String(error?.message ?? error);
          if (msg === 'payload too large') fail(413, 'too-large', msg);
          else fail(400, 'bad-json', msg);
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
        // 一轮结束就清掉本轮的 CUA 授权答案（上游语义：一次问管一轮）
        if (payload?.status !== 'running') cuaPolicy.endTurn();
        tracker.agentStatus(payload?.agent, payload?.status);
        broadcast();
      } catch (error) {
        ctx.logger?.warn?.('dsh-coopanion-pet: 处理 agent/status 失败', error);
      }
    });

    /* ---------- CUA 权限闸门 ----------
       拦 `mcp__wincu__*`（dsh-computer-use-win 经 MCP 暴露的工具），在真正执行前
       按权限档位问一次。这是 tools/pre-execute 的 waterfall：返回 deny 就拦下，
       返回 allow 就放行。

       **为什么用 pre-execute 而不是包装工具本身**：那些工具是另一个插件注册的，
       本插件不该去改它、也不该抢它的注册。pre-execute 是 DSH 官方的策略接缝，
       正是给这种情况用的。

       **只拦 CUA，不拦别的。** 其余工具一律 allow，本插件不做通用审批。 */
    // 判定逻辑在 lib/cua-policy.js 的 cuaGate 里（纯函数，可单独测）；
    // 这里只把它接到 DSH 的策略接缝上。
    ctx.on('tools/pre-execute', (exec, next) => cuaGate(exec, next, {
      policy: cuaPolicy,
      isOnline: () => channel?.online === true,
    }));

    /* ---------- 40 对话页：把会话消息推给她 ----------
       让她头顶显示最近几条对话（上游 `src/chat.ts` + `pet-app.js` 的 lines 栈）。

       **数据源是 DSH 的会话事件**，不是自己存一份：
       - `user/message`：人说的话（含 Agent 注入的上下文，因此要按 source 区分）
       - `assistant/message`：模型这一轮说的话（取文本块）

       **只推最近 3 条**（与上游 MAX_LINES 一致），且**不推工具调用细节**——
       那是状态气泡的活，对话栈只放人话与她的回话。 */
    const MAX_LINES = 3;
    /** 最近的对话行：`{ role, text, at }`。 */
    const lines = [];

    /** 从消息内容里取纯文本（丢掉工具调用等非文本块）。 */
    const textOf = (content) => {
      if (!Array.isArray(content)) return '';
      return content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    };

    /** 追加一行并广播。只留最近 MAX_LINES 条。 */
    const pushLine = (role, text) => {
      const t = String(text ?? '').trim();
      if (!t) return;

      lines.push({ role, text: t.slice(0, 300), at: Date.now() });
      while (lines.length > MAX_LINES) lines.shift();
      if (channel.online) channel.push({ type: 'lines', lines: lines.map((l) => ({ role: l.role, text: l.text })) });
    };

    /**
     * 事件名是 **`session/event`**，签名 `(session, event)`——实测确认，
     * 不是 `session/message`（我第一版猜错了）。
     */
    ctx.on('session/event', (session, ev) => {
      try {
        const type = ev?.type;
        if (type === 'user/message') {
          // source.kind === 'user' 才是真人说的；其余是注入的上下文（AGENTS.md、技能等）
          if (ev?.data?.source?.kind !== 'user') return;
          pushLine('user', textOf(ev?.data?.content));
          return;
        }
        if (type === 'assistant/message') {
          pushLine('pet', textOf(ev?.data?.message?.content));
        }
      } catch (error) {
        /* 采集失败不影响会话 */
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
      getCuaPolicy: () => cuaPolicy,
      /**
       * 独立窗口的控制接口（`pet_desktop` 工具用）。
       *
       * 惰性取：桥接建在 webServer 的注入回调里，而 tools 注入可能更早。
       */
      getDesktop: () => ({
        get state() { return desktopBridge ? { ...desktopBridge.state, ...desktopStatus } : desktopStatus; },
        start: (opts) => (desktopBridge ? desktopBridge.start(opts) : Promise.resolve({ ok: false, reason: 'no-bridge' })),
        stop: () => (desktopBridge ? desktopBridge.stop() : Promise.resolve()),
      }),
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
