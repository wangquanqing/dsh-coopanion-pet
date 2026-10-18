/**
 * 状态气泡：她头顶那个小的、圆角的活动指示——正在思考、正在读文件、
 * 正在跑命令。与说话气泡共用同一个元素，但永不抢对话的位置。
 *
 * 数据来自宿主的 SSE（`/api/dsh-coopanion-pet/events`），因为客户端插件
 * 拿不到会话状态（见 index.js 的说明）。宿主只发状态本身（kind + 工具名），
 * 措辞在这里定。
 *
 * 移植自 Coopanion 的 `web/pet-app.js` 的 stepStatus/drawStatus，
 * 去掉多来源聚合，改成单一 SSE 源；文案走本插件的 i18n.js。
 */

// 别名成 `text`：这个模块里 `t` 是它自己的时钟（按帧累加的秒数），
// 直接导入同名函数会被 createStatus 里的 `let t = 0` 遮蔽掉。
import { t as text } from './i18n.js';

/** 「思考」状态先压这么久（秒）再显示：很多操作是瞬时的，闪一下反而吵。 */
const THINK_DELAY = 0.5;

/** 状态种类 → 文案键与图标。图标是 24×24 的线性图形，与内核的线宽约定一致。 */
const KINDS = {
  think: { key: '', icon: '<circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="20" cy="12" r="1.5"/>' },
  read: { key: 'status.read', icon: '<path d="M6 3h9l4 4v14H6zM14 3v5h5"/><path class="cpn-scan" d="M9 11h7"/>' },
  write: { key: 'status.write', icon: '<path d="m5 15 11-11 4 4L9 19l-5 1zM13 7l4 4M5 15l4 4"/>' },
  search: { key: 'status.search', icon: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>' },
  run: { key: 'status.run', icon: '<path d="m5 8 4 4-4 4M13 16h6"/>' },
  work: { key: 'status.work', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M5.6 18.4l2.2-2.2M16.2 7.8l2.2-2.2"/>' },
  wait: { key: 'status.wait', icon: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>' },
  // 语音：听与说各一个图标
  listen: { key: 'status.listen', icon: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>' },
  speak: { key: 'status.speak', icon: '<path d="M4 9v6h3l4 4V5L7 9z"/><path d="M15 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12"/>' },
  // 电脑操作（CUA）：看屏幕与动手各一个
  screen: { key: 'status.screen', icon: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><circle cx="12" cy="10" r="2.5"/>' },
  control: { key: 'status.control', icon: '<path d="M5 3v6M5 15v6M12 3v10M12 19v2M19 3v3M19 12v9"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="16" r="2"/><circle cx="19" cy="9" r="2"/>' },
};

/** 造一个 24×24 的线性图标。 */
const icon = (inner) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

/**
 * 建一个状态气泡。
 *
 * `els`：`{ el }` 与说话气泡共用的元素。
 * `deps`：`{ busy() }` 返回「对话是否正占着气泡」；对话优先，状态让位。
 */
export function createStatus(els, deps) {
  const { el } = els;
  const { busy } = deps;

  /** 宿主说现在该显示什么。 */
  let wanted = null;
  /** 正在显示的那条。 */
  let shown = null;
  let shownAt = 0;
  let fadeAt = null;
  /** 本插件的时钟，按帧累加（秒）。 */
  let t = 0;
  /**
   * 第一次见到当前这条「思考」状态时的本地时刻（秒）；null = 当前没有思考状态。
   * 用本地时钟而不是宿主的 `since`，理由见 step() 里的说明。
   */
  let thinkSeenAt = null;

  /** 换掉气泡内容。`pop` 为真时播一次弹出动画。 */
  function draw(next, pop) {
    if (!el.classList.contains('cpn-status') || el.dataset.icon !== next.kind) {
      el.className = 'cpn-bubble cpn-status';
      el.dataset.icon = next.kind;
      el.innerHTML = `<span class="cpn-status-icon">${icon((KINDS[next.kind] ?? KINDS.work).icon)}</span><span class="cpn-status-text"></span>`;
    }
    el.dataset.kind = next.kind;
    // 有具体对象时把它附在文案后面：「正在看文件 · config.ts」
    const label = KINDS[next.kind]?.key ? text(KINDS[next.kind].key) : '';
    const full = next.target ? `${label} · ${next.target}` : label;
    const textEl = el.querySelector('.cpn-status-text');
    textEl.textContent = full;
    // 具体对象可能很长，气泡最多显示一行，靠 title 让人悬停能看到全文
    textEl.title = full;
    el.setAttribute('aria-label', full || text('status.aria'));
    el.classList.remove('cpn-fading');
    el.hidden = false;
    if (pop) {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
  }

  return {
    /** 宿主推来一条新状态。 */
    set(state) {
      wanted = state && state.kind && state.kind !== 'none' ? state : null;
    },

    /** 每帧调用一次；`dt` 是秒。 */
    step(dt) {
      t += dt;

      // 对话永远优先：说话或提问时状态气泡让位
      if (busy()) {
        if (el.classList.contains('cpn-status')) el.hidden = true;
        shown = null;
        fadeAt = null;
        return;
      }

      // 淡出结束后真正隐藏
      if (fadeAt !== null && t - fadeAt >= 0.2) {
        el.hidden = true;
        shown = null;
        fadeAt = null;
      }

      const next = wanted;

      /**
       * 「思考」刚出现时先等半秒：很多操作是瞬时的，闪一下反而吵。
       *
       * **这里不能用宿主的 `since` 直接比**：宿主给的是 `Date.now()`（毫秒
       * 纪元时间戳，约 1.7e12），而本模块的 `t` 是页面加载起累加的秒数
       * （0～100）。`t - since/1000` 恒为约 −1.7e9，于是「正在思考」
       * **永远不显示**——实测确认过的 bug。
       *
       * 改成本地记一份「第一次见到这个 think 时的 t」，用它算延迟。
       */
      if (next?.kind === 'think') {
        if (thinkSeenAt === null) thinkSeenAt = t;
        if (t - thinkSeenAt < THINK_DELAY) return;
      } else {
        thinkSeenAt = null;
      }

      // 同一类活动但对象换了（看 a.ts → 看 b.ts）也要重画，否则文案停在旧文件上
      const same = shown && next && shown.kind === next.kind && shown.target === next.target;
      // 还没显示过东西时立刻画：`shownAt` 初值 0，若也走 1.2 秒防抖，
      // 第一条状态会被白白压住一秒多，看起来像没反应。
      const readyForNew = !shown || t - shownAt >= 1.2;
      if (same) {
        if (fadeAt !== null) draw(next, false);
        shown = next;
        fadeAt = null;
      } else if (readyForNew) {
        if (next) {
          draw(next, shown?.kind !== next.kind);
          shown = next;
          shownAt = t;
          fadeAt = null;
        } else if (shown && fadeAt === null) {
          fadeAt = t;
          el.classList.add('cpn-fading');
        }
      }
    },

    /** 对话要开始了：把状态气泡收掉。 */
    yield() {
      if (el.classList.contains('cpn-status')) el.hidden = true;
      shown = null;
      fadeAt = null;
    },

    /** 现在显示的是不是状态气泡。 */
    get active() { return !el.hidden && el.classList.contains('cpn-status'); },
  };
}

/** 状态气泡的样式。 */
export const STATUS_CSS = `
.cpn-bubble.cpn-status {
  display: flex; align-items: center; gap: 6px;
  max-width: min(220px, calc(100vw - 20px));
  padding: 6px 10px; font-size: 12.5px; line-height: 1.4;
  pointer-events: none;
  transition: opacity .2s;
}
.cpn-bubble.cpn-status[hidden] { display: none; }
.cpn-bubble.cpn-status.cpn-fading { opacity: 0; }
.cpn-bubble.cpn-status.pop { animation: cpn-bubble-in .24s cubic-bezier(.3,1.4,.5,1); }

.cpn-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cpn-status-icon { display: flex; flex: none; color: var(--cpn-eye, #00A870); }
.cpn-status-icon svg { width: 14px; height: 14px; overflow: visible; }

/* 「思考」只显示三个跳动的点 */
.cpn-bubble.cpn-status[data-kind="think"] { justify-content: center; }
.cpn-bubble.cpn-status[data-kind="think"] .cpn-status-text { display: none; }
.cpn-bubble.cpn-status[data-kind="think"] .cpn-status-icon svg { width: 24px; }

.cpn-status-icon svg, .cpn-status-icon svg * { transform-box: fill-box; transform-origin: center; }
.cpn-bubble.cpn-status[data-kind="think"] circle { animation: cpn-status-think 1.3s ease-in-out infinite; }
.cpn-bubble.cpn-status[data-kind="think"] circle:nth-child(2) { animation-delay: .16s; }
.cpn-bubble.cpn-status[data-kind="think"] circle:nth-child(3) { animation-delay: .32s; }
.cpn-bubble.cpn-status .cpn-scan { animation: cpn-status-read 1.8s ease-in-out infinite; }
.cpn-bubble.cpn-status[data-kind="search"] svg { animation: cpn-status-search 2s linear infinite; }
.cpn-bubble.cpn-status[data-kind="write"] svg { animation: cpn-status-write 1.2s ease-in-out infinite; }
.cpn-bubble.cpn-status[data-kind="wait"] svg { animation: cpn-status-wait 2.8s ease-in-out infinite; }
.cpn-bubble.cpn-status[data-kind="work"] svg { animation: cpn-status-work 4s linear infinite; }

@keyframes cpn-status-think { 0%,60%,100% { transform: none; opacity: .45 } 30% { transform: translateY(-3px); opacity: 1 } }
@keyframes cpn-status-read { 0%,100% { transform: translateY(0); opacity: .5 } 70% { transform: translateY(6px); opacity: 1 } }
@keyframes cpn-status-search { 0%,100% { transform: translate(0,0) } 25% { transform: translate(0,-1.5px) } 50% { transform: translate(1.5px,0) } 75% { transform: translate(0,1.5px) } }
@keyframes cpn-status-write { 0%,100% { transform: translate(-1px,1px) rotate(-5deg) } 50% { transform: translate(1px,-1px) rotate(5deg) } }
@keyframes cpn-status-wait { 0%,30% { transform: rotate(0) } 60%,100% { transform: rotate(180deg) } }
@keyframes cpn-status-work { to { transform: rotate(360deg) } }
`;
