/**
 * 可选接缝：DSH 语音输入（语音识别）与 dsh-xiaomi-tts（语音合成）。
 *
 * **两个都是可选的，而且都不声明为必需注入。** 插件未安装、未就绪、或已被关闭时，
 * 这里对应的方法返回 `null`，调用方安全跳过——桌宠本体与其余功能不受影响。
 *
 * 为什么不做成 cordis 的 `inject`：`inject` 是「必需依赖」，缺一个整插件就加载不了。
 * 语音是锦上添花，装不装都不该挡住桌宠。因此这里用**运行期探测**：
 * 服务在就给个函数，不在就返回 null。
 *
 * 两条通道的来源（都实测过，dsh 0.2.0-rc.2）：
 *
 * - **识别**：`@deepseek-ai/dsh-experimental-speech-to-text` 在宿主侧提供 `speechToText`
 *   服务；浏览器端经 `@deepseek-ai/dsh-experimental-api-speech-to-text` 暴露成远程调用
 *   `remote.speech.transcribe({ audioBase64, providerId?, language? })`，入参是**整段 WAV**
 *   （16kHz 单声道 PCM16 编码成 base64），出参 `{ text, audioSeconds, inferenceSeconds }`。
 *   官方语音输入插件（`...client-ui-voice-input`）走的就是这条，本插件复用它，不自己搬 ASR。
 *
 * - **合成**：`dsh-xiaomi-tts` 注册同源路由 `POST /plugins/xiaomi-mimo-tts/synthesize`，
 *   请求体 `{ text, format?, voice? }`，成功时直接回音频字节（`audio/wav` 或 `audio/mpeg`）。
 *   因此**不需要读它的配置、也不需要 API key**：请求发给它自己的宿主半边，由它去调上游。
 *   未装时这个路由不存在，`fetch` 会拿到 404 或网络错误，这里如实回报。
 *
 * 路由路径取自该插件的公开导出常量（`lib/constants`），不是猜的。
 */

/** 语音合成的路由，与 dsh-xiaomi-tts 的 TTS_ROUTE 一致。 */
export const TTS_ROUTE = '/plugins/xiaomi-mimo-tts/synthesize';
/** 识别服务的包名，用于日志与错误信息。 */
export const STT_PACKAGE = '@deepseek-ai/dsh-experimental-speech-to-text';

/**
 * 探测宿主侧的语音识别服务。
 *
 * 返回 `{ transcribe } ` 或 `null`。`transcribe` 收 WAV 字节，回文本。
 * 服务不在、或没有可用的识别器时返回 `null`——调用方据此跳过，而不是报错。
 */
export function detectSpeechToText(ctx) {
  // 服务可能在本插件之后才挂上（DSH 的插件加载顺序不保证），
  // 因此用一个「稍后重试」的探测：每次调用现查一次，不在就返回 null。
  const service = () => {
    try {
      return ctx.get?.('speechToText') ?? null;
    } catch (error) {
      return null;
    }
  };

  return {
    /** 现在有没有可用的识别服务。 */
    get available() {
      const s = service();
      return !!(s && typeof s.resolve === 'function' && typeof s.transcribe === 'function');
    },
    /**
     * 把一段 WAV 交给 DSH 的识别服务。
     *
     * @param wav - 16kHz 单声道 PCM16 的 WAV 字节。
     * @param language - 语言提示，空则用服务自己的默认。
     * @param signal - 调用方取消信号。
     * @returns 识别文本；服务不可用时返回 null。
     */
    async transcribe(wav, language, signal) {
      const s = service();
      if (!s || typeof s.resolve !== 'function' || typeof s.transcribe !== 'function') return null;
      const request = { audio: wav };
      if (language) request.language = language;
      const spec = s.resolve(request);
      const result = await s.transcribe(spec, signal ?? new AbortController().signal);
      return typeof result?.text === 'string' ? result.text : null;
    },
  };
}

/**
 * 探测语音合成（dsh-xiaomi-tts）。
 *
 * 不做「装没装」的静态判断：那要看宿主里有没有那个插件，代价高且会误判。
 * 这里只看**它注册的同源路由在不在**——路由是它的公开契约，也是真正要用的东西。
 * 路由 404 就说明没装（或没启用），如实回报。
 */
export function detectTextToSpeech(fetchImpl = fetch) {
  /** 记住上次探测结果，免得每次说话都先打一次空请求。 */
  let known = null;
  let checkedAt = 0;
  /** 路由的可用性在一轮会话里不会变，缓存久一点。 */
  const CACHE_MS = 60_000;

  return {
    /** 这条路由上次探测是否可用；没探过返回 null。 */
    get known() { return known; },

    /**
     * 合成一段语音。
     *
     * @param text - 要朗读的文字。
     * @param opts - `{ format, base, signal }`。`base` 是**绝对**前缀
     *   （如 `http://127.0.0.1:1234`）——宿主侧的 `fetch` 不接受相对 URL，
     *   路由是相对路径，因此调用方必须给出本次请求的绝对地址。
     * @returns 音频字节与 MIME；路由不可用或失败时返回 null。
     */
    async synthesize(text, opts = {}) {
      const now = Date.now();
      if (known === false && now - checkedAt < CACHE_MS) return null;
      const body = { text: String(text ?? '') };
      if (opts.format) body.format = opts.format;
      const url = opts.base ? new URL(TTS_ROUTE, opts.base).href : TTS_ROUTE;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
        if (!res.ok) {
          // 404/405 = 那个插件不在；其余（409 未配 key、502 上游失败）也都不该让
          // 桌宠这边报错，只是这次没合成出来。
          known = false;
          checkedAt = now;
          return null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.byteLength) { known = false; checkedAt = now; return null; }
        known = true;
        checkedAt = now;
        return { audio: buf, type: res.headers.get('content-type') ?? 'audio/wav' };
      } catch (error) {
        // 网络错误也算「不可用」，但不写进 known：可能是临时故障，下次再试
        return null;
      }
    },

    /** 清掉缓存，让下次调用重新探测（设置面板改过插件状态后用）。 */
    forget() { known = null; checkedAt = 0; },
  };
}
