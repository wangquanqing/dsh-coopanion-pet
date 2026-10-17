/**
 * 让 Agent 能指挥桌宠的 `pet_*` 工具。
 *
 * 六个工具对应她能做的事：说话、提问、走位、做动作、换装扮、查询状态。
 * 每个工具都只做一件事——把命令经通道发给页面，等回执，然后如实回报结果。
 *
 * 三条设计约定：
 * - **她不在就如实说。** 页面没连上、或等回执超时，工具返回「没做到」和原因，
 *   而不是假装成功。模型据此决定是换个说法还是不再尝试。
 * - **超时不长。** 说话这类是一瞬间的事；提问要等用户回答，因此给的余量长得多。
 *   都不该让一次工具调用把整轮对话卡住。
 * - **提问是异步的。** 用户可能几分钟后才答，工具不该阻塞那么久——它把问题显示出去，
 *   立即回报「已经问了」，回答作为下一条消息由页面推回会话。
 */

import { defineTool } from './define-tool.js';

/** 可用的表情，取自渲染内核的词表。 */
const FACES = ['neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy',
  'thinking', 'smug', 'pout', 'worried', 'determined', 'flustered', 'scared', 'excited', 'cry', 'confused'];
/** 可用的动作。 */
const ACTS = ['wave', 'bow', 'jump', 'hop', 'nod', 'shake', 'spin', 'dance', 'shiver', 'flap', 'look', 'sit', 'sleep', 'stand'];
/** 配色。 */
const SCHEMES = ['deepseek', 'harness', 'chatgpt', 'claude', 'gemini', 'qwen', 'kimi', 'minimax'];
/** 服装。 */
const OUTFITS = ['maid', 'cape'];

/** 工具文本面向模型，用英文写。 */
const DESC = {
  say: 'Say something in a speech bubble above the desktop pet. The text types out character by character. '
    + 'Put 【expression, motion】 at the start to play an expression or motion before speaking, '
    + 'and <expression> inline to play it when typing reaches that point. One or two sentences per call.',
  ask: 'Ask the person a question through a bubble above the desktop pet, with up to 3 options plus a free-text box. '
    + 'Returns at once: the question appears and the answer arrives later as a new message from the person. '
    + 'This does not block, so do not wait for the answer in the same turn.',
  walk: 'Walk the desktop pet to a horizontal position on the screen. `x` is in pixels from the left edge; '
    + 'omit it to walk somewhere random. Set `run` to true to make her run.',
  act: 'Play one expression or motion on the desktop pet. Expressions: ' + FACES.join(', ') + '. Motions: ' + ACTS.join(', ') + '.',
  dress: 'Change the desktop pet\'s colour scheme or outfit. Schemes: ' + SCHEMES.join(', ')
    + '. Outfits: maid (default dress), cape (winter cloak).',
  status: 'Report where the desktop pet is and what she is currently doing. '
    + 'Use it to check whether the pet page is connected before relying on other pet tools.',
};

/**
 * 建工具定义。
 *
 * `deps`：`{ channel, getPetState, onPetState }`。
 *   `channel` 是 lib/channel.js 的通道。
 *   `getPetState()` 返回页面现在是否连着、在哪。
 */
export function createPetTools(deps) {
  const { channel, getPetState } = deps;

  /** 统一的「她不在」回答。`what` 用动词原形（如 "say it"），拼进句子才通顺。 */
  const offline = (what) => ({
    ok: false,
    reason: 'offline',
    message: `The desktop pet page is not connected, so she could not ${what}. `
      + 'The person has to open the Harness web UI with the pet plugin enabled.',
  });

  /** 命令结果 → 工具输出。 */
  const fromCommand = (what) => (res) => {
    if (res.ok) return { ok: true, message: `She managed to ${what}.` };
    if (res.reason === 'timeout') {
      return { ok: false, reason: 'timeout', message: `The desktop pet did not acknowledge in time when asked to ${what}; the page may be hidden or busy.` };
    }
    if (res.reason === 'offline') return offline(what);
    return { ok: false, reason: res.reason ?? 'failed', message: `She could not ${what}: ${res.reason ?? 'unknown reason'}.` };
  };

  /** 一个工具的输出契约：成功与失败同在一个 oneOf 里。 */
  const resultSchema = {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', enum: [true], required: true, description: 'True when the pet acknowledged the command.' },
          message: { type: 'string', required: true, description: 'Short statement of what happened, for you to relay or ignore.' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', enum: [false], required: true, description: 'False when the pet could not carry out the command.' },
          reason: { type: 'string', required: true, description: 'Machine-readable cause: offline, timeout, or a page-reported reason.' },
          message: { type: 'string', required: true, description: 'Short explanation of why it did not happen.' },
        },
      },
    ],
  };

  /** 输出的呈现：给模型一句话，不必把整个对象塞过去。 */
  const render = (args, value) => [{ type: 'text', text: value?.message ?? 'done' }];

  return {
    say: defineTool({
      name: 'pet_say',
      description: DESC.say,
      parameters: {
        script: {
          type: 'string',
          required: true,
          description: 'What she should say. Supports 【expression, motion】 as a lead-in and <expression> inline.',
        },
      },
      output: { schema: resultSchema, render },
      async execute(args) {
        const text = String(args?.script ?? '').slice(0, 4000);
        if (!text.trim()) return { ok: false, reason: 'empty', message: 'Nothing to say: the script was empty.' };
        const res = await channel.command('say', { text }, 8000);
        return fromCommand('say it')(res);
      },
    }),

    ask: defineTool({
      name: 'pet_ask',
      description: DESC.ask,
      parameters: {
        question: {
          type: 'string',
          required: true,
          description: 'The question, one sentence.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 3 short choices. Leave empty to only let the person type an answer.',
        },
        own: {
          type: 'boolean',
          description: 'Whether to also offer a free-text box. Defaults to true.',
        },
      },
      output: { schema: resultSchema, render },
      async execute(args) {
        const question = String(args?.question ?? '').slice(0, 500);
        if (!question.trim()) return { ok: false, reason: 'empty', message: 'Nothing to ask: the question was empty.' };
        const options = (Array.isArray(args?.options) ? args.options : [])
          .map((o) => String(o ?? '').slice(0, 80)).filter(Boolean).slice(0, 3);
        // 提问不等回答：显示出去就回报，回答稍后由页面作为新消息送回。
        const res = await channel.command('ask', { question, options, own: args?.own !== false }, 8000);
        if (res.ok) return { ok: true, message: 'The question is up; the answer will arrive as a new message.' };
        return fromCommand('ask it')(res);
      },
    }),

    walk: defineTool({
      name: 'pet_walk',
      description: DESC.walk,
      parameters: {
        x: {
          type: 'number',
          description: 'Target horizontal position in pixels from the left edge. Omit for a random spot.',
        },
        run: {
          type: 'boolean',
          description: 'Whether she runs instead of walking. Defaults to false.',
        },
      },
      output: { schema: resultSchema, render },
      async execute(args) {
        const x = typeof args?.x === 'number' && Number.isFinite(args.x) ? args.x : null;
        const res = await channel.command('walk', { x, run: args?.run === true }, 8000);
        return fromCommand('walk over')(res);
      },
    }),

    act: defineTool({
      name: 'pet_act',
      description: DESC.act,
      parameters: {
        word: {
          type: 'string',
          required: true,
          description: 'One expression or motion name from the lists in the description.',
        },
      },
      output: { schema: resultSchema, render },
      async execute(args) {
        const word = String(args?.word ?? '').trim();
        if (!FACES.includes(word) && !ACTS.includes(word)) {
          return {
            ok: false,
            reason: 'unknown-word',
            message: `"${word}" is not one of her expressions or motions. Expressions: ${FACES.join(', ')}. Motions: ${ACTS.join(', ')}.`,
          };
        }
        const res = await channel.command('act', { word }, 8000);
        return fromCommand(`perform "${word}"`)(res);
      },
    }),

    dress: defineTool({
      name: 'pet_dress',
      description: DESC.dress,
      parameters: {
        scheme: {
          type: 'string',
          description: 'Colour scheme: ' + SCHEMES.join(', ') + '. Omit to keep the current one.',
        },
        outfit: {
          type: 'string',
          description: 'Outfit: ' + OUTFITS.join(', ') + '. Omit to keep the current one.',
        },
      },
      output: { schema: resultSchema, render },
      async execute(args) {
        const scheme = args?.scheme === undefined ? null : String(args.scheme);
        const outfit = args?.outfit === undefined ? null : String(args.outfit);
        if (scheme === null && outfit === null) {
          return { ok: false, reason: 'empty', message: 'Nothing to change: give a scheme, an outfit, or both.' };
        }
        if (scheme !== null && !SCHEMES.includes(scheme)) {
          return { ok: false, reason: 'unknown-scheme', message: `"${scheme}" is not a scheme. Choose from: ${SCHEMES.join(', ')}.` };
        }
        if (outfit !== null && !OUTFITS.includes(outfit)) {
          return { ok: false, reason: 'unknown-outfit', message: `"${outfit}" is not an outfit. Choose from: ${OUTFITS.join(', ')}.` };
        }
        // 换装要加载纹理，给的时间比说话长
        const res = await channel.command('dress', { scheme, outfit }, 15_000);
        return fromCommand('change outfit')(res);
      },
    }),

    status: defineTool({
      name: 'pet_status',
      description: DESC.status,
      parameters: {},
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                connected: { type: 'boolean', enum: [false], required: true, description: 'False when no pet page is open.' },
                message: { type: 'string', required: true, description: 'What to do about it.' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                connected: { type: 'boolean', enum: [true], required: true, description: 'True when a pet page is open.' },
                mode: { type: 'string', required: true, description: 'What she is doing right now, such as idle, walk, or sleep.' },
                x: { type: 'number', required: true, description: 'Horizontal position in pixels from the left edge.' },
                scheme: { type: 'string', required: true, description: 'Current colour scheme and outfit, as scheme-outfit.' },
                message: { type: 'string', required: true, description: 'Short summary.' },
              },
            },
          ],
        },
        render,
      },
      async execute() {
        const st = getPetState?.() ?? {};
        if (!st.connected) {
          return { connected: false, message: 'No pet page is open, so she is not visible. Open the Harness web UI with the pet plugin enabled.' };
        }
        // 位置与装扮由页面定期上报；没有就如实说明
        const mode = st.mode ?? 'unknown';
        const x = typeof st.x === 'number' ? st.x : 0;
        const scheme = st.scheme ?? 'unknown';
        return {
          connected: true,
          mode,
          x,
          scheme,
          message: `She is on screen at x=${Math.round(x)}, currently ${mode}, wearing ${scheme}.`,
        };
      },
    }),

    quiet: defineTool({
      name: 'pet_quiet',
      description: 'Make the desktop pet go quiet for a while: no sounds, no roaming, no status bubble. '
        + 'She stays where she is and still answers pet_say. Use it when the person asks for silence or '
        + 'when your work would be noisy in the background. Pass minutes: 0 to end it at once. '
        + 'The setting is temporary and does not change the person\'s preferences.',
      parameters: {
        minutes: {
          type: 'number',
          description: 'How long to stay quiet, in minutes. 0 ends it immediately. Defaults to 15.',
        },
      },
      output: { schema: resultSchema, render },
      async execute(args) {
        const raw = typeof args?.minutes === 'number' && Number.isFinite(args.minutes) ? args.minutes : 15;
        const minutes = Math.max(0, Math.min(raw, 12 * 60));
        const res = await channel.command('quiet', { minutes }, 8000);
        if (!res.ok) return fromCommand('go quiet')(res);
        return {
          ok: true,
          message: minutes === 0
            ? 'She is back to her usual self.'
            : `She will stay quiet for about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        };
      },
    }),

    set: defineTool({
      name: 'pet_set',
      description: 'Change the desktop pet\'s own appearance or habits: size, how much she roams, whether her sounds '
        + 'and status bubble are on. Only pass what should change. These are the person\'s preferences, so use it '
        + 'when they asked for the change, not on your own initiative.',
      parameters: {
        size: {
          type: 'number',
          description: 'Body size index: 0 small, 1 medium, 2 large. Omit to keep the current one.',
        },
        roam: {
          type: 'number',
          description: 'How much she walks on her own: 0 quiet, 1 occasional, 2 lively. Omit to keep the current one.',
        },
        sound: {
          type: 'boolean',
          description: 'Whether her synthesized sounds play. Omit to keep the current setting.',
        },
        statusBubble: {
          type: 'boolean',
          description: 'Whether the activity bubble above her head shows. Omit to keep the current setting.',
        },
      },
      output: { schema: resultSchema, render },
      async execute(args) {
        const patch = {};
        const names = [];
        if (typeof args?.size === 'number' && Number.isFinite(args.size)) {
          const n = Math.round(args.size);
          if (n < 0 || n > 2) return { ok: false, reason: 'bad-size', message: 'size must be 0, 1, or 2.' };
          patch.sizeIndex = n;
          names.push(`size ${['small', 'medium', 'large'][n]}`);
        }
        if (typeof args?.roam === 'number' && Number.isFinite(args.roam)) {
          const n = Math.round(args.roam);
          if (n < 0 || n > 2) return { ok: false, reason: 'bad-roam', message: 'roam must be 0, 1, or 2.' };
          patch.roamIndex = n;
          names.push(`roaming ${['quiet', 'occasional', 'lively'][n]}`);
        }
        if (typeof args?.sound === 'boolean') { patch.sound = args.sound; names.push(`sounds ${args.sound ? 'on' : 'off'}`); }
        if (typeof args?.statusBubble === 'boolean') {
          patch.statusBubble = args.statusBubble;
          names.push(`status bubble ${args.statusBubble ? 'on' : 'off'}`);
        }
        if (!names.length) {
          return { ok: false, reason: 'empty', message: 'Nothing to change: pass at least one of size, roam, sound, or statusBubble.' };
        }
        const res = await channel.command('set', { patch }, 8000);
        if (!res.ok) return fromCommand('change that')(res);
        return { ok: true, message: `She now has ${names.join(', ')}.` };
      },
    }),
  };
}
