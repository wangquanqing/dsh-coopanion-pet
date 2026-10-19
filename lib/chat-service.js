/**
 * 独立聊天面板的宿主侧服务。
 *
 * ## 它做什么
 *
 * 给独立窗口（Electron）的聊天面板提供三个能力，**全部经 DSH 的会话服务**：
 *
 * 1. **列会话** —— `sessionController.list()`：拿到可见会话（标题、时间、状态）
 * 2. **读历史** —— `sessionQuery.observeSession()`：拿一条会话的消息投影
 * 3. **发消息** —— `sessionController.prompt()`：以用户身份发一条，`mode: 'queue'`
 *
 * ## 为什么走会话服务而不是自己存一份
 *
 * 那样会出现「两套会话状态」：DSH 页面里的对话与独立面板里的对话不同步。
 * 走会话服务意味着**独立面板与 DSH 主面板操作的是同一批会话**——
 * 在面板里发的消息，DSH 页面刷新就能看到；在 DSH 里发的，面板也能读到。
 * 这正是「可以切换到主聊天面板」的技术基础。
 *
 * ## 幂等
 *
 * `prompt` 要一个 `requestId`，DSH 用它去重（同一条消息重复提交不会发两次）。
 * 这里由面板生成并回传，避免网络重试造成重复发言。
 */

/** 会话 id → 上一次观察的句柄（避免重复 observe）。 */
const observers = new Map();

/**
 * 造一个聊天服务。
 *
 * @param deps - `{ getContext }`：返回当前 cordis Context（用来惰性取会话服务）。
 */
export function createChatService(deps) {
  const { getContext } = deps;

  /** 取会话服务；任一缺失就返回 null（面板据此如实报「不可用」）。 */
  function services() {
    const ctx = getContext();
    if (!ctx) return null;
    const controller = ctx.get('sessionController');
    const query = ctx.get('sessionQuery');
    if (!controller || !query) return null;
    return { controller, query };
  }

  /**
   * 从一条会话记录里取可显示的字段。
   *
   * **实测的字段形状**（`sessionController.list()` 返回的行）：
   * `{ sessionId, updatedAt, agentAvailable, formatStatus, running, blank, cwd, projections }`
   * —— **没有 `title`**。标题在 `projections` 里（若已生成）；
   * 未生成的会话只能显示别的东西（这里用目录名 + 时间兜底）。
   *
   * 因此这里刻意**不假装读到了标题**：读不到就用能反映「这是哪条会话」的信息。
   */
  function summarize(record) {
    if (!record) return null;
    const id = record.sessionId ?? record.id ?? record.header?.id;
    if (!id) return null;
    // 标题可能藏在 projections 里（结构随版本变化，因此宽松地找一遍）
    const proj = record.projections;
    let title = '';
    if (proj && typeof proj === 'object') {
      for (const value of Object.values(proj)) {
        const cand = value?.title ?? value?.value?.title ?? value?.snapshot?.title;
        if (typeof cand === 'string' && cand.trim()) { title = cand.trim(); break; }
      }
    }
    const cwd = String(record.cwd ?? '');
    // 兜底：用「目录名 · 时间」——比一串 id 有用得多
    const dirName = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
    const when = Number(record.updatedAt ?? 0) || 0;
    const fallback = dirName || (when ? new Date(when).toLocaleDateString() : '会话');
    return {
      id: String(id),
      title: title.slice(0, 120) || fallback,
      cwd,
      updatedAt: when,
      running: record.running === true,
      blank: record.blank === true,
    };
  }

  /** 把一条会话事件投影成面板能渲染的一条消息。 */
  function projectEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const type = event.type;
    const data = event.data ?? {};
    if (type === 'user/message') {
      const text = partsToText(data.content);
      if (!text) return null;
      return { role: 'user', text, at: Number(event.time ?? data.time ?? 0) || 0 };
    }
    if (type === 'assistant/message') {
      const text = partsToText(data.content);
      if (!text) return null;
      return { role: 'assistant', text, at: Number(event.time ?? data.time ?? 0) || 0 };
    }
    // 工具调用：面板只显示一行摘要，不展开参数（那是 DSH 页面的活）
    if (type === 'tool/call' || type === 'function_call') {
      const name = String(data.name ?? data.tool ?? '').trim();
      if (!name) return null;
      return { role: 'tool', text: name, at: Number(event.time ?? 0) || 0 };
    }
    return null;
  }

  /** 内容块数组 → 纯文本。 */
  function partsToText(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return {
    /** 会话服务可用吗（面板用它决定显示什么）。 */
    get available() { return services() !== null; },

    /** 列可见会话。 */
    async list() {
      const s = services();
      if (!s) return { ok: false, reason: 'unavailable', message: '会话服务不可用。' };
      try {
        const ac = new AbortController();
        const value = await s.controller.list({}, ac.signal);
        const rows = Array.isArray(value?.sessions) ? value.sessions
          : Array.isArray(value?.items) ? value.items
            : Array.isArray(value) ? value : [];
        const out = rows.map(summarize).filter(Boolean);
        // 最近活动的排前面
        out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return { ok: true, sessions: out };
      } catch (error) {
        return { ok: false, reason: 'list-failed', message: String(error?.message ?? error) };
      }
    },

    /** 读一条会话的历史消息。 */
    async history(sessionId) {
      const s = services();
      if (!s) return { ok: false, reason: 'unavailable', message: '会话服务不可用。' };
      if (!sessionId) return { ok: false, reason: 'no-session', message: '没有指定会话。' };
      try {
        const observed = await s.query.observeSession(sessionId);
        try {
          const events = Array.isArray(observed?.events) ? observed.events : [];
          const messages = events.map(projectEvent).filter(Boolean);
          // 只回最近 200 条：面板不做无限滚动（那是 DSH 页面的活）
          return { ok: true, messages: messages.slice(-200) };
        } finally {
          // observeSession 返回的句柄要释放
          try { observed?.[Symbol.dispose]?.(); } catch (error) { /* 忽略 */ }
        }
      } catch (error) {
        return { ok: false, reason: 'history-failed', message: String(error?.message ?? error) };
      }
    },

    /** 以用户身份发一条消息。 */
    async send(sessionId, text, requestId) {
      const s = services();
      if (!s) return { ok: false, reason: 'unavailable', message: '会话服务不可用。' };
      const body = String(text ?? '').trim();
      if (!body) return { ok: false, reason: 'empty', message: '消息是空的。' };
      if (!sessionId) return { ok: false, reason: 'no-session', message: '没有指定会话。' };
      try {
        const ac = new AbortController();
        const receipt = await s.controller.prompt({
          sessionId,
          // 幂等：同一条 requestId 重复提交不会发两次
          requestId: String(requestId ?? ('pet-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
          mode: 'queue',
          content: [{ type: 'text', text: body.slice(0, 4000) }],
          clientTimeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return undefined; } })(),
        }, ac.signal);
        if (receipt?.accepted === false) {
          return { ok: false, reason: 'rejected', message: '会话没有接受这条消息。' };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: 'send-failed', message: String(error?.message ?? error) };
      }
    },
  };
}
