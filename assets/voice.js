/**
 * 语音：录音（识别用）、播放（合成用）、以及识别结果的后处理。
 *
 * **两条链路都是可选的。** 宿主侧有没有语音输入插件、有没有 TTS 插件，页面无从直接
 * 得知（客户端插件运行时只有 slots/connection/loader/modules 四个服务），因此这里
 * 的做法是**调用时才知道**：录音要先拿到麦克风权限，识别由宿主侧的 speechToText 完成；
 * 合成走 dsh-xiaomi-tts 的同源路由，路由不在就静默跳过。
 *
 * 四条边界：
 * - **不主动申请麦克风。** 只有用户/Agent 明确让她「听」时才 getUserMedia；
 *   被拒绝就如实回报，不重试、不弹第二个权限框。
 * - **WAV 自己封装。** 识别服务要的是整段 WAV（16kHz 单声道 PCM16），
 *   worklet 给的是裸 PCM，因此这里加 44 字节头。
 * - **播放不抢声音。** 合成音频用独立的 Audio 元素，与合成音效（sfx）互不干扰。
 * - **后处理在出口这一层。** 幻觉过滤与繁简归一是**纯函数**，放在识别之后、
 *   交给调用方之前；识别引擎自己不管这些（它也不该管）。
 */

/** 采集的目标采样率，与 worklet 里写死的 16000 一致。 */
const RATE = 16000;
/** 最长录多久（秒）。超时自动收尾，免得一直占着麦克风。 */
const MAX_SECONDS = 15;

/** 一段 PCM16 加 WAV 头。 */
export function toWav(pcm, rate = RATE) {
  const bytes = pcm.byteLength;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt 块大小（标准 16，SAPI 会写 18 导致别人读错）
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // 单声道
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);    // 字节率
  view.setUint16(32, 2, true);           // 块对齐
  view.setUint16(34, 16, true);          // 位深
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer ?? pcm));
  return new Uint8Array(buf);
}

/** 把分片的 PCM16 拼成一段。 */
function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(new Uint8Array(c), at); at += c.byteLength; }
  return out;
}

/**
 * 49：幻觉过滤。识别引擎在没人说话时会「听到」一些不是话的东西。
 *
 * **照搬上游 `src/asr/result.ts` 的判据**（比我第一版更完善，因此改用它的）：
 * 模型在没有语音的音频上会吐出训练语料里的字幕，**靠内容分不出真假，只能按名单拦**。
 * 另外 Whisper 类模型会把声音标注在括号里（`[Musik]`、`(звук пива)`、`*Bruit de la porte*`），
 * 有时还没闭合。放过一条，就等于她宣称了一句没人说过的话。
 *
 * 与上游的差别只有一处：它把「同一字重复」交给调用方判断，我这里加了一条
 * （「啊啊啊啊」丢掉、但「哈哈哈哈」保留），因为识别器在静音上常吐前者。
 */
const HALLUCINATION_PATTERNS = [
  /^[\s。.,、!?！？…~～-]*$/,
  /字幕|谢谢观看|请不吝点赞|订阅|转发|打赏|明镜与点点栏目/,
  /^(thank you|thanks for watching|subtitles by|you)[\s.!]*$/i,
  /^\s*(sous-titr|untertitel|subt[ií]tulos|legendas|sottotitoli|субтитр)/i,
  /^\s*[[(（【*♪]/,
];

export function filterHallucination(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (HALLUCINATION_PATTERNS.some((re) => re.test(t))) return '';
  // 额外的保守规则：同一个字重复 4 次以上且整串只有它（「啊啊啊啊」丢掉；
  // 「哈哈哈哈」这类带笑意的保留）
  const bare = t.replace(/[\s，。、！？,.!?…~～]/g, '');
  if (bare.length >= 4 && /^(.)\1+$/.test(bare) && !/[哈嘿嘻呵]/u.test(bare[0])) return '';
  return t;
}

/**
 * 把识别器连续输出的片段拼成一条。
 *
 * **照搬上游 `joinSpeech`**，语义与它一致：**同一句话被分片识别后拼接时**，
 * 拉丁文片段之间补一个空格，中日韩文之间不补。
 *
 * **边界（实测澄清）**：它判的是「前一段结尾 + 后一段开头」的语言，
 * 因此中文片段后面接英文片段时**不会补空格**（`['你好','world']` → `你好world`）。
 * 这不是 bug，是上游的取舍——它服务的是**同一种语言被切碎后拼接**的场景，
 * 不是中英混排排版。本插件用它做同一件事，因此保持上游行为。
 */
const UNSPACED_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const UNSPACED_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
export function joinSpeech(pieces) {
  let out = '';
  for (const p of pieces ?? []) {
    if (!p) continue;
    const spaced = /[\p{L}\p{N}.,!?;:]$/u.test(out) && !UNSPACED_END.test(out)
      && /^[\p{L}\p{N}]/u.test(p) && !UNSPACED_START.test(p);
    out += spaced ? ` ${p}` : p;
  }
  return out;
}

/**
 * 50：繁体 → 简体字形归一。
 *
 * **不能整句丢给映射表做无差别替换**：那会把已经是简体的字也换掉。
 * 上游 `src/asr/simplify.ts` 的做法是逐字判断——这个字有没有另一个繁体形，
 * 有就说明它本身已经是简体，原样留着。这里照同一思路，但用一张内联的常用字表
 * （不引第三方依赖）。
 *
 * **与上游的差别（如实说明）**：上游用 `opencc-js` 做逐字判断（`s2t(c) !== c` 说明该字
 * 本身已是简体，原样保留），覆盖全表；本插件**不引第三方依赖**，用一张内联的常用字表。
 * 因此：表内的字能正确转换；**表外的字原样保留**（宁可少换，也不要把简体换成别的东西）；
 * 覆盖范围明显小于 OpenCC，将来要全表再考虑引入依赖或补表。
 *
 * 上游还有一张「出口纠错表」（人名、圈内词的固定错法整段替换），**本插件没做**——
 * 那需要用户自己维护词表，属进阶功能。
 */
const T2S = {
  '這': '这', '個': '个', '們': '们', '說': '说', '話': '话', '時': '时', '候': '候',
  '現': '现', '在': '在', '麼': '么', '甚': '甚', '樣': '样', '對': '对', '開': '开',
  '關': '关', '東': '东', '西': '西', '會': '会', '來': '来', '過': '过', '還': '还',
  '進': '进', '點': '点', '兒': '儿', '嗎': '吗', '呢': '呢', '沒': '没', '有': '有',
  '實': '实', '問': '问', '題': '题', '覺': '觉', '得': '得', '應': '应', '該': '该',
  '幫': '帮', '忙': '忙', '讓': '让', '給': '给', '買': '买', '賣': '卖', '錢': '钱',
  '車': '车', '門': '门', '見': '见', '聽': '听', '寫': '写', '讀': '读', '認': '认',
  '識': '识', '錯': '错', '誰': '谁', '什': '什', '為': '为', '為': '为', '產': '产',
  '經': '经', '網': '网', '絡': '络', '頁': '页', '書': '书', '報': '报', '號': '号',
  '國': '国', '語': '语', '詞': '词', '總': '总', '結': '结', '果': '果', '條': '条',
  '件': '件', '統': '统', '計': '计', '數': '数', '據': '据', '庫': '库', '類': '类',
  '場': '场', '區': '区', '單': '单', '雙': '双', '複': '复', '雜': '杂', '簡': '简',
  '選': '选', '擇': '择', '設': '设', '置': '置', '動': '动', '態': '态', '靜': '静',
  '態': '态', '權': '权', '限': '限', '錯': '错', '誤': '误', '訊': '讯', '息': '息',
  '發': '发', '送': '送', '收': '收', '錄': '录', '音': '音', '樂': '乐', '聲': '声',
  '響': '响', '轉': '转', '換': '换', '變': '变', '更': '更', '舊': '旧', '新': '新',
  '長': '长', '短': '短', '寬': '宽', '窄': '窄', '高': '高', '低': '低', '遠': '远',
  '近': '近', '快': '快', '慢': '慢', '輕': '轻', '重': '重', '熱': '热', '冷': '冷',
  '餓': '饿', '飽': '饱', '喝': '喝', '吃': '吃', '睡': '睡', '醒': '醒', '夢': '梦',
  '愛': '爱', '喜': '喜', '歡': '欢', '樂': '乐', '哭': '哭', '笑': '笑', '怒': '怒',
  '氣': '气', '怕': '怕', '驚': '惊', '訝': '讶', '難': '难', '易': '易', '簡': '简',
};

/**
 * 把一段识别结果里的繁体字换成简体。
 *
 * 只换表里有的字；表外的字原样保留（宁可少换，不要把简体换成别的东西）。
 */
export function toSimplified(text) {
  const s = String(text ?? '');
  if (!s) return s;
  let out = '';
  for (const ch of s) out += T2S[ch] ?? ch;
  return out;
}

/**
 * 48：切句器。
 *
 * 上游的 `src/asr/segmenter.ts`（310 行）是**能量门限 + 起说时长 + 收尾静音**的状态机，
 * 用来把连续的麦克风流切成一句一句。本插件**不需要流式切分**（DSH 的识别接口收整段 WAV，
 * 见 docs/risk-verification.md 的实测：分片反而更慢更不准）。
 *
 * 因此这里只搬**它的纯逻辑里最有用的那一半**：把一段识别结果按句切开。
 * 用途是「按住热键说话」松开后，若一次说了好几句，可以按句处理（如逐句填入输入框）。
 */
/** 句末标点。 */
const SENTENCE_END = /([。！？!?…；;]+)/;

/**
 * 把一段文字切成句子。标点跟着前一句；空句丢掉。
 *
 * @param text - 一段文字。
 * @returns 句子数组；没有内容时返回空数组。
 */
export function splitSentences(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const out = [];
  // 用 lookbehind 在标点后切；不支持 lookbehind 的老浏览器由 catch 兜底
  try {
    for (const part of raw.split(/(?<=[。！？!?…；;])/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  } catch (error) {
    // 兜底：按标点手动切
    let cur = '';
    for (const ch of raw) {
      cur += ch;
      if (SENTENCE_END.test(ch)) { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/**
 * 建一个语音控制器。
 *
 * `deps`：`{ onLevel, onTick }`。
 *   `onLevel(level)` 每帧报一次音量（0–1），用来让她的嘴动或画波形。
 *   `onTick({ elapsed, limit })` 每 100ms 报一次录音进度，用来显示计时。
 */
export function createVoice(deps = {}) {
  const { onLevel, onTick } = deps;

  /** 正在录的那一次。同一时刻只允许一次。 */
  let session = null;
  /** 53：用户选的麦克风设备 id；空 = 系统默认。 */
  let deviceId = '';

  /** 现在能不能录：浏览器有没有麦克风 API。 */
  const supported = () => typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof AudioContext !== 'undefined';

  return {
    get supported() { return supported(); },
    get recording() { return !!session; },

    /** 53：设置/读取要用的麦克风。空字符串表示系统默认。 */
    setDevice(id) { deviceId = String(id ?? ''); },
    get device() { return deviceId; },

    /**
     * 53：列出可用的麦克风。
     *
     * 注意：`enumerateDevices` 在**没有授权之前**只给得到设备数量，拿不到名字
     * （浏览器隐私要求）。因此设置面板里要如实说明「先录一次才看得到名字」。
     *
     * @returns `[{ deviceId, label }]`；拿不到时返回空数组。
     */
    async listDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        return all
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({
            deviceId: d.deviceId,
            // 没授权时 label 是空串，给个占位名
            label: d.label || `麦克风 ${i + 1}`,
          }));
      } catch (error) {
        return [];
      }
    },

    /**
     * 录一段话，返回 WAV 字节。
     *
     * @param opts - `{ seconds, signal }`；`seconds` 是上限，默认 15。
     * @returns `{ wav, seconds, chunks }`；失败时 `{ error }`。
     *   `chunks` 是分片 PCM，供调用方按需处理（48 切句器用不到它，留着以备后用）。
     */
    async record(opts = {}) {
      if (session) return { error: 'busy' };
      if (!supported()) return { error: 'unsupported' };
      const limit = Math.max(0.5, Math.min(Number(opts.seconds) || MAX_SECONDS, MAX_SECONDS));

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            // 53：指定设备；空串交给浏览器用系统默认
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        });
      } catch (error) {
        // 用户拒绝、或没有设备、或指定的设备不见了：如实回报，不再追问
        const name = error?.name ?? '';
        if (name === 'OverconstrainedError' || name === 'NotFoundError') {
          return { error: 'device', message: '选定的麦克风不可用，请在设置里重新选一个。' };
        }
        return { error: 'denied', message: String(error?.message ?? error) };
      }

      const ctx = new AudioContext();
      const chunks = [];
      let stopped = false;
      /**
       * **「已经请求停止」标志。**
       *
       * 录音要等 `audioWorklet.addModule` 完成才能拿到 `session`，而
       * `stop()` 只作用于 `session`。若用户在加载完成前就松手
       * （按住 Shift+Space 立刻松开是常见操作），那次 stop 是**空操作**，
       * 录音会一直录到 15 秒上限才收尾（实测确认过的问题）。
       *
       * 因此这里先记一个标志：`stop()` 无论如何都置位，`record` 在
       * worklet 就绪后立刻检查它，已置位就直接收尾。
       */
      let stopRequested = false;
      let tickTimer = 0;
      const startedAt = Date.now();
      const stop = () => {
        stopRequested = true;
        if (stopped) return;
        stopped = true;
        if (tickTimer) clearInterval(tickTimer);
        try { ctx.close(); } catch (error) { /* 已经关了 */ }
        for (const t of stream.getTracks()) t.stop();
        session = null;
      };

      try {
        await ctx.audioWorklet.addModule(new URL('mic-worklet.js', import.meta.url).href);
        const node = new AudioWorkletNode(ctx, 'pet-mic');
        node.port.onmessage = (e) => {
          chunks.push(e.data);
          if (onLevel) {
            // 从这一帧的 PCM 估一个音量（0–1），用来画波形或让她嘴动
            const pcm = new Int16Array(e.data);
            let peak = 0;
            for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
            onLevel(Math.min(1, peak / 32768 * 4));
          }
        };
        const src = ctx.createMediaStreamSource(stream);
        src.connect(node);
        // worklet 的输出不接扬声器（会把麦克风原声放出来），但要让它被处理：
        // 接一个 0 增益的节点到 destination。
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);

        session = { stop, startedAt };

        /**
         * 用户在 worklet 就绪前就松手了 → 现在立刻收尾，不再往下等满 15 秒。
         * 这里直接返回「空」：这么短的按压本来也识别不出东西。
         */
        if (stopRequested) {
          stop();
          return { error: 'empty', message: '按得太短，没有录到内容。' };
        }

        // 录音进度：每 100ms 报一次，供界面显示计时（替代原计划的「假流式」）
        if (onTick) {
          tickTimer = setInterval(() => {
            onTick({ elapsed: (Date.now() - startedAt) / 1000, limit });
          }, 100);
        }

        const aborted = new Promise((resolve) => {
          const onAbort = () => resolve({ error: 'aborted' });
          if (opts.signal) {
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        const done = new Promise((resolve) => setTimeout(() => resolve({ ok: true }), limit * 1000));
        const outcome = await Promise.race([done, aborted]);
        const seconds = (Date.now() - startedAt) / 1000;
        stop();
        if (outcome.error) return outcome;

        const pcm = concat(chunks);
        if (pcm.byteLength < RATE) return { error: 'empty' };   // 不足 0.5 秒按空处理
        return { wav: toWav(pcm), seconds, chunks };
      } catch (error) {
        stop();
        return { error: 'failed', message: String(error?.message ?? error) };
      }
    },

    /** 提前结束当前录音（到点前收尾）。 */
    stop() { session?.stop(); },

    /**
     * 播一段合成音频。
     *
     * @param audio - 音频字节。
     * @param type - MIME。
     * @returns 播完 resolve 的 Promise；播放被策略拒绝时也 resolve（不抛）。
     */
    play(audio, type = 'audio/wav') {
      return new Promise((resolve) => {
        try {
          const url = URL.createObjectURL(new Blob([audio], { type }));
          const el = new Audio(url);
          const done = () => { URL.revokeObjectURL(url); resolve(); };
          el.addEventListener('ended', done, { once: true });
          el.addEventListener('error', done, { once: true });
          el.play().catch(done);
        } catch (error) {
          resolve();
        }
      });
    },
  };
}
