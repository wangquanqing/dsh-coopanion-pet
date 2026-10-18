/**
 * 桌宠的宿主↔浏览器通道。
 *
 * 它有三件事：
 *   1. 下行：把宿主的命令（说、问、走、做动作、换装）经 SSE 推给页面；
 *   2. 上行：页面通过 POST 回传三类消息——命令回执、用户对提问的回答、桌面侧事件；
 *   3. 排队：Agent 调工具时要等结果，而页面可能还没连上或正在忙，因此命令编号、逐条等待、
 *      超时兜底。
 *
 * 为什么不用 DSH 的 RPC：本插件只需要「宿主推一件事给页面、页面回一件事」，
 * 自己的 HTTP 路由更直接，也不依赖宿主内部接口的稳定性。
 */

/** 一条下行的命令。 */
let seq = 0;

/**
 * 造一个通道。
 *
 * `send(frame)` 是把一帧写进所有 SSE 连接的回调，由插件提供。
 */
export function createChannel(send) {
  /** 页面连上时用的下行帧。 */
  const connections = new Set();

  /** 还在等回执的命令：id → { resolve, reject, timer }。 */
  const pending = new Map();

  /** 页面最近一次上报的状态（位置、是否连着、当前装扮）。 */
  let pageState = { connected: false, at: 0 };

  /** 页面连上／断开时通知插件，用于工具判断「她现在在不在」。 */
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(pageState); } catch (error) { /* 订阅者自己的问题 */ } } };

  const api = {
    /** 页面的 SSE 连接建立。 */
    attach(res) {
      connections.add(res);
      pageState = { ...pageState, connected: true, at: Date.now() };
      notify();
      res.on('close', () => {
        connections.delete(res);
        // 最后一个连接断了才算离线
        if (!connections.size) {
          pageState = { ...pageState, connected: false, at: Date.now() };
          notify();
        }
      });
    },

    /** 订阅页面连接状态的变化。 */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** 当前页面状态。 */
    get state() { return pageState; },

    /** 页面是否连着。没有页面时工具应当直接如实回报，而不是干等。 */
    get online() { return connections.size > 0; },

    /** 连着的页面数，诊断用。 */
    get count() { return connections.size; },

    /** 把一帧写给所有页面。 */
    push(frame) {
      const text = `data: ${JSON.stringify(frame)}\n\n`;
      for (const res of connections) {
        try { res.write(text); } catch (error) { connections.delete(res); }
      }
    },

    /**
     * 下发一条命令并等页面回执。
     *
     * `timeout` 到点还没回执就 resolve `{ ok: false, reason: 'timeout' }`——
     * 工具不该因为用户没在看屏幕而一直挂着，超时是一种如实的答案。
     */
    command(op, args = {}, timeout = 15_000) {
      if (!connections.size) return Promise.resolve({ ok: false, reason: 'offline' });
      const id = `c${++seq}`;
      const frame = { type: 'command', id, op, args };
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve({ ok: false, reason: 'timeout' });
        }, timeout);
        pending.set(id, { resolve, timer });
        const text = `data: ${JSON.stringify(frame)}\n\n`;
        let delivered = 0;
        for (const res of connections) {
          try { res.write(text); delivered++; } catch (error) { connections.delete(res); }
        }
        /**
         * **一条都没送出去就别干等。**
         *
         * 写失败只删连接的话，SSE 半关闭（`close` 事件还没触发）时
         * `connections` 看着非空、实际全是死连接，这条命令没人能回执，
         * 要挂到超时——`pet_speak` 30 秒、CUA 确认 120 秒，用户和模型都
         * 白等（实测确认过的问题）。
         */
        if (delivered === 0) {
          if (pending.delete(id)) {
            clearTimeout(timer);
            resolve({ ok: false, reason: 'offline' });
          }
        }
      });
    },

    /** 页面回执一条命令。 */
    settle(id, payload) {
      const entry = pending.get(id);
      if (!entry) return false;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve({ ok: true, ...payload });
      return true;
    },

    /** 页面报来的状态。 */
    report(state) {
      pageState = { ...pageState, ...state, at: Date.now() };
      notify();
    },

    /**
     * 页面断开时把它还在等的命令一次性收掉，避免工具永远挂着。
     * 页面重连后是新的连接，旧命令不会复活。
     */
    dropOutstanding(reason = 'disconnected') {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, reason });
        pending.delete(id);
      }
    },

    dispose() {
      api.dropOutstanding('disposed');
      connections.clear();
      listeners.clear();
    },
  };

  return api;
}

/**
 * 读一个 HTTP 请求的 JSON body。
 *
 * 上限刻意压得很小：桌宠的上下行都是短帧，不需要大 payload，
 * 限制住就不必担心有人拿这个端点当上传口。
 */
export function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(text)); } catch (error) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
