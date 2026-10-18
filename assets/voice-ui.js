/**
 * 语音交互的页面侧：按住说话（52）、录音反馈、以及把识别结果填进输入框（55）。
 *
 * 三件事分开写在这里，是因为它们各自的接缝不同：
 *
 * - **按住说话**：走页面内的 keydown/keyup。**DSH 的 shortcuts 服务只有 keydown，
 *   没有 keyup**（实测 dsh 0.2.0-rc.2），因此拿不到「松开」的时机——按住说话必须
 *   自己监听。代价是它只在 DSH 页面有焦点时生效（全局热键仍归 Electron 宿主）。
 * - **录音反馈**：录音时给她头顶一个「正在听」+ 计时 + 音量条。这是替代原计划「假流式」
 *   的方案——实测分片识别更慢更不准（见 docs/risk-verification.md），而「录的时候看得见」
 *   才是真正缺的那块体验。
 * - **填进输入框（55）**：走 DSH 的 `conversation.input.activity` 槽。实测该槽提供
 *   完整的 `inputActions`（`insertText` / `setDraft` / `submit` / `captureInsertion`），
 *   以及 `sessionId`。**必须注册进那个槽才拿得到**——`shell.overlay` 的 props 是空的。
 */

/** 按住说话的默认键（与说话热键区分开：那个是点一下说一句）。 */
const HOLD_CODE = 'Space';

/**
 * 建一个语音交互控制器。
 *
 * `deps`：
 *   `{ record(), stopRecord(), onState(state), insertText(text) }`。
 *   `record()` 开始录音并返回一个 Promise（结束时给结果）；
 *   `onState(state)` 报状态给界面（'idle' / 'recording' / 'transcribing'）；
 *   `insertText(text)` 把识别结果填进 DSH 输入框；没有那个能力时为 null。
 */
export function createVoiceUi(deps) {
  const { record, stopRecord, onState, insertText } = deps;

  /** 现在是不是按住状态。 */
  let holding = false;
  /** 本次按住的录音 promise。 */
  let pending = null;
  /** 最近一次识别结果，供界面显示与「填入」按钮用。 */
  let last = '';

  /** 现在能不能按住说话：输入框里、终端里、弹窗里都不该触发。 */
  function holdAllowed(event) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return false;
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return false;
    // 只有纯 Shift 或都不按；主修饰键组合留给别的快捷键
    return true;
  }

  const onKeyDown = (event) => {
    if (holding) return;
    if (event.code !== HOLD_CODE) return;
    if (!holdAllowed(event)) return;
    // 用 Shift+Space，避免与「翻页/确认」冲突
    if (!event.shiftKey) return;
    holding = true;
    event.preventDefault();
    onState?.('recording');
    pending = Promise.resolve(record()).then((res) => {
      pending = null;
      holding = false;
      if (res?.error) {
        onState?.('idle');
        return { ok: false, reason: res.error };
      }
      const text = res?.text ?? '';
      last = text;
      onState?.('idle');
      // 识别到了就直接填进输入框（55）——这是用户按住说话的意图
      if (text && insertText) insertText(text);
      return { ok: true, text };
    });
  };

  const onKeyUp = (event) => {
    if (!holding) return;
    if (event.code !== HOLD_CODE) return;
    // 松开：结束录音，交给上面的 promise 走识别
    holding = false;
    onState?.('transcribing');
    stopRecord?.();
  };

  /** 失焦时也要收尾，否则松开事件收不到、录音会一直录到上限。 */
  const onBlur = () => {
    if (!holding) return;
    holding = false;
    onState?.('transcribing');
    stopRecord?.();
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  return {
    /** 现在是否按住了。 */
    get holding() { return holding; },
    /** 最近一次识别结果。 */
    get last() { return last; },
    /** 等当前这次录音结束（验证脚本用）。 */
    whenDone() { return pending ?? Promise.resolve({ ok: false, reason: 'not-recording' }); },
    /** 手动把最近一次结果填进输入框（界面上的「填入」按钮用）。 */
    insertLast() {
      if (!last || !insertText) return false;
      insertText(last);
      return true;
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    },
  };
}
