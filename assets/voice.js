/**
 * 语音：录音（识别用）与播放（合成用）。
 *
 * **两条链路都是可选的。** 宿主侧有没有语音输入插件、有没有 TTS 插件，页面无从直接
 * 得知（客户端插件运行时只有 slots/connection/loader/modules 四个服务），因此这里
 * 的做法是**调用时才知道**：录音要先拿到麦克风权限，识别由宿主侧的 speechToText 完成；
 * 合成走 dsh-xiaomi-tts 的同源路由，路由不在就静默跳过。
 *
 * 三条边界：
 * - **不主动申请麦克风。** 只有用户/Agent 明确让她「听」时才 getUserMedia；
 *   被拒绝就如实回报，不重试、不弹第二个权限框。
 * - **WAV 自己封装。** 识别服务要的是整段 WAV（16kHz 单声道 PCM16），
 *   worklet 给的是裸 PCM，因此这里加 44 字节头。
 * - **播放不抢声音。** 合成音频用独立的 Audio 元素，与合成音效（sfx）互不干扰。
 */

/** 采集的目标采样率，与 worklet 里写死的 16000 一致。 */
const RATE = 16000;
/** 最长录多久（秒）。超时自动收尾，免得一直占着麦克风。 */
const MAX_SECONDS = 15;

/** 一段 PCM16 加 WAV 头。 */
function toWav(pcm, rate = RATE) {
  const bytes = pcm.byteLength;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt 块大小
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
 * 建一个语音控制器。
 *
 * `deps`：`{ onLevel }` 可选的音量回调，用来让她的嘴动起来。
 */
export function createVoice(deps = {}) {
  const { onLevel } = deps;

  /** 正在录的那一次。同一时刻只允许一次。 */
  let session = null;

  /** 现在能不能录：浏览器有没有麦克风 API。 */
  const supported = () => typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof AudioContext !== 'undefined';

  return {
    get supported() { return supported(); },
    get recording() { return !!session; },

    /**
     * 录一段话，返回 WAV 字节。
     *
     * @param opts - `{ seconds, signal }`；`seconds` 是上限，默认 15。
     * @returns `{ wav }`；失败时 `{ error }`（'unsupported' / 'denied' / 'empty' / 'aborted'）。
     */
    async record(opts = {}) {
      if (session) return { error: 'busy' };
      if (!supported()) return { error: 'unsupported' };
      const limit = Math.max(0.5, Math.min(Number(opts.seconds) || MAX_SECONDS, MAX_SECONDS));

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      } catch (error) {
        // 用户拒绝、或没有设备：如实回报，不再追问
        return { error: 'denied', message: String(error?.message ?? error) };
      }

      const ctx = new AudioContext();
      const chunks = [];
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        try { ctx.close(); } catch (error) { /* 已经关了 */ }
        for (const t of stream.getTracks()) t.stop();
        session = null;
      };

      try {
        await ctx.audioWorklet.addModule(new URL('mic-worklet.js', import.meta.url).href);
        const node = new AudioWorkletNode(ctx, 'pet-mic');
        node.port.onmessage = (e) => {
          chunks.push(e.data);
          if (onLevel) onLevel(1);
        };
        const src = ctx.createMediaStreamSource(stream);
        src.connect(node);
        // worklet 的输出不接扬声器（会把麦克风原声放出来），但要让它被处理：
        // 接一个 0 增益的节点到 destination。
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);

        session = { stop };

        const aborted = new Promise((resolve) => {
          const onAbort = () => resolve({ error: 'aborted' });
          if (opts.signal) {
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        const done = new Promise((resolve) => setTimeout(() => resolve({ ok: true }), limit * 1000));
        const outcome = await Promise.race([done, aborted]);
        stop();
        if (outcome.error) return outcome;

        const pcm = concat(chunks);
        if (pcm.byteLength < RATE) return { error: 'empty' };   // 不足 0.5 秒按空处理
        return { wav: toWav(pcm) };
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
