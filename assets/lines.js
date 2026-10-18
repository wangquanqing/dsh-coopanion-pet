/**
 * 40：她身边的对话栈。
 *
 * 上游（`web/pet-app.js` 的 lines 栈）把最近几条消息排在她头顶旁边：
 * 最新的在下面、离她头最近，旧的在上面；每条都从旁边滑到位。
 *
 * **本插件的数据来自宿主经 SSE 推来的 `lines` 帧**（宿主订阅 DSH 的 `session/event`，
 * 取 `user/message` 与 `assistant/message` 的文本）。因此这里不做分页、不做附件、
 * 不做 pending 提升与撤回——那些是 DSH 会话 UI 的活，重复造没有意义。
 *
 * 三条设计约定：
 * - **只显示 3 条**（与上游 MAX_LINES 一致）。再多会挡住界面。
 * - **让位对话气泡**：她正在说话/提问时，栈整体淡出——那是更重要的事。
 * - **自己找地方**：她靠屏幕边时栈换到另一侧，两侧都没位置就移到她头顶上方。
 */

/** 最多几条。 */
const MAX_LINES = 3;
/** 每条最多显示多少字（宿主已经截到 300，这里再收一次免得撑爆）。 */
const MAX_CHARS = 160;
/** 一条从出现到就位的秒数。 */
const EASE = 0.18;
/** 淡出的秒数。 */
const FADE = 0.4;

/**
 * 建一个对话栈。
 *
 * `deps`：`{ anchor() }` 返回她头顶的锚点与朝向（每帧取一次）。
 */
export function createLines(deps) {
  const { anchor } = deps;

  const root = document.createElement('div');
  root.className = 'cpn-lines';
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-label', '最近对话');

  /** 当前显示的几条：`{ el, role, text, ox, oy, targetX, targetY, alpha }`。 */
  let items = [];
  /** 正在淡出（她说话时让位）。 */
  let fading = false;

  /**
   * 宿主推来新的一批。
   *
   * @param list - `[{ role, text }]`，最新的一条在最后。
   */
  function set(list) {
    const next = (Array.isArray(list) ? list : [])
      .filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .slice(-MAX_LINES);
    // 复用已有的 DOM（按文本比对），避免每次都重建
    const old = items;
    items = next.map((l, i) => {
      const prev = old.find((o) => o.text === l.text && o.role === l.role);
      if (prev) { prev.fresh = false; return prev; }
      const el = document.createElement('div');
      el.className = 'cpn-line';
      el.dataset.role = l.role === 'user' ? 'user' : 'pet';
      el.textContent = l.text.slice(0, MAX_CHARS);
      el.title = l.text;
      root.appendChild(el);
      return { el, role: l.role, text: l.text, ox: null, oy: null, targetX: 0, targetY: 0, alpha: 1, fresh: true };
    });
    // 清掉不再显示的
    for (const o of old) if (!items.includes(o)) o.el.remove();
    root.hidden = items.length === 0;
  }

  /**
   * 每帧调用一次。
   *
   * `dt` 是秒；`busy` 为真（她在说话/提问）时整体淡出并让位。
   */
  function step(dt, busy) {
    if (!items.length) return;
    const at = anchor();
    if (!at) return;

    const wantFade = !!busy;
    if (wantFade !== fading) fading = wantFade;

    // 量一次尺寸（它们不常变）
    const widths = items.map((it) => it.el.offsetWidth || 140);
    const heights = items.map((it) => it.el.offsetHeight || 28);
    const widest = Math.max(...widths, 120);
    const gap = 6;
    const stackH = heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, items.length - 1);

    /**
     * 选边：优先她**背对**的那侧（不挡她看的方向），没位置就换另一侧，
     * 两侧都不行就移到她头顶上方。
     */
    const side = -(at.facing ?? 1);
    const beside = 14;
    const inner = (s) => (s < 0 ? at.x - beside - widest : at.x + beside);
    const fits = (s) => (s < 0 ? inner(s) >= 8 : inner(s) + widest <= window.innerWidth - 8);
    let use = side;
    if (!fits(use) && fits(-use)) use = -use;
    const above = !fits(use);

    // 从下往上排：最新的一条贴着她的头
    let bottom = above ? at.y - 30 : at.y - 10;
    const k = dt > 0 ? Math.min(1, dt / EASE) : 1;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const w = widths[i], h = heights[i];
      const x = above
        ? Math.max(8, Math.min(at.x - w / 2, window.innerWidth - w - 8))
        : Math.max(8, Math.min(use < 0 ? inner(use) - w : inner(use), window.innerWidth - w - 8));
      const y = Math.max(8, bottom - h);
      it.targetX = x;
      it.targetY = y;
      // 第一次出现直接放到位，之后缓动
      if (it.ox === null) { it.ox = x; it.oy = y; }
      else { it.ox += (x - it.ox) * k; it.oy += (y - it.oy) * k; }
      bottom = y - gap;
    }

    // 淡出/淡入
    const targetAlpha = fading ? 0 : 1;
    for (const it of items) {
      it.alpha += (targetAlpha - it.alpha) * (dt > 0 ? Math.min(1, dt / FADE) : 1);
      it.el.style.opacity = it.alpha.toFixed(2);
      it.el.style.transform = `translate(${Math.round(it.ox)}px, ${Math.round(it.oy)}px)`;
      it.el.hidden = it.alpha < 0.02;
    }
    // 整体淡出到几乎看不见时收起来（别挡界面）
    root.style.pointerEvents = 'none';
  }

  function clear() {
    for (const it of items) it.el.remove();
    items = [];
    root.hidden = true;
  }

  return {
    root,
    set,
    step,
    clear,
    dispose() { root.remove(); },
  };
}

/** 对话栈的样式。 */
export const LINES_CSS = `
.cpn-lines { position: fixed; inset: 0; pointer-events: none; z-index: 39; }
.cpn-lines[hidden] { display: none; }
.cpn-line {
  position: absolute; left: 0; top: 0;
  max-width: min(220px, calc(100vw - 20px));
  padding: 5px 9px; border-radius: 11px;
  background: var(--cpn-surface, #fff); color: var(--cpn-text, #1B1626);
  border: 1.5px solid var(--cpn-line, #E2DFE8);
  box-shadow: 0 4px 12px var(--cpn-shadow, rgba(27,22,38,.12));
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif;
  font-size: calc(12.5px * var(--cpn-font-size, 1)); line-height: 1.45;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  will-change: transform, opacity;
}
/* 人说的话：靠她一侧加一条竖线，与她的回话区分 */
.cpn-line[data-role="user"] { border-left: 3px solid var(--cpn-eye, #00A870); }
.cpn-line[data-role="pet"] { opacity: .92; }
`;
