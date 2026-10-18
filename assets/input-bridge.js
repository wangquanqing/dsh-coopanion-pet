/**
 * 55：把识别结果填进 DSH 的输入框。
 *
 * **必须注册进 `conversation.input.activity` 槽才拿得到 `inputActions`。**
 * 实测（dsh 0.2.0-rc.2，见 docs/risk-verification.md）：
 *
 * - `shell.overlay`（桌宠本体所在的槽）的标准 props 是空接口，**拿不到**；
 * - `conversation.input.activity` 提供完整的 `inputActions`：
 *   `insertText` / `setDraft` / `submit` / `captureInsertion` / `addAttachments` / `pruneAttachments`，
 *   以及 `sessionId`、`locked`、`onActiveChange`。
 *
 * 因此这里做成一个**极简的注册器**：往那个槽里挂一个几乎不可见的小元素，
 * 只为了拿到 `inputActions` 并把它交给桌宠。UI 本身刻意不占地方——
 * 那是输入框旁边的活动区，不该被桌宠占住。
 *
 * **可选**：拿不到槽就静默跳过，55 退化成「识别结果只回报给 Agent，不填输入框」。
 */

export function createInputBridge(React, opts = {}) {
  /** 拿到的 inputActions；没拿到是 null。 */
  let actions = null;
  /** 55 的降级路径：把文本交给宿主作为一条用户消息（`agent.followup`）。 */
  const submitViaHost = opts.submitViaHost ?? null;
  /** 拿到的会话 id（备用）。 */
  let sessionId = '';
  /** 拿到的 locked 标志（输入被锁住时不该插入）。 */
  let locked = false;

  return {
    /** 能不能**填进输入框**（需要那个槽；被官方语音插件占用时不能）。 */
    get ready() { return !!actions && typeof actions.insertText === 'function'; },
    /** 能不能把识别文本送进会话（宿主降级路径，一直可用）。 */
    get canSubmit() { return !!submitViaHost; },
    /** 现在实际走的是哪条路：'input' 填输入框 / 'session' 送会话 / 'none'。 */
    get mode() {
      if (this.ready) return 'input';
      if (this.canSubmit) return 'session';
      return 'none';
    },
    /** 当前会话 id（拿到就有）。 */
    get sessionId() { return sessionId; },

    /**
     * 把一段文字填进输入框。
     *
     * @param text - 要填的文字。
     * @returns 是否填成功。
     */
    insert(text) {
      const s = String(text ?? '').trim();
      if (!s) return false;
      // 槽拿不到时走宿主降级：文本作为一条用户消息送进会话
      if (!this.ready) {
        if (submitViaHost) { submitViaHost(s); return true; }
        return false;
      }
      if (locked) return false;
      try {
        // captureInsertion() 记住插入位置；insertText 往那里插。
        // 两个都拿不到时退回 setDraft（整体替换草稿）。
        if (typeof actions.captureInsertion === 'function') {
          actions.insertText(s, actions.captureInsertion());
        } else {
          actions.insertText(s);
        }
        return true;
      } catch (error) {
        // 有的实现只给 setDraft；再试一次
        try {
          if (typeof actions.setDraft === 'function') { actions.setDraft(s); return true; }
        } catch (error2) { /* 都不行就算了 */ }
        return false;
      }
    },

    /**
     * 直接提交（说完了就发）。
     *
     * @returns 是否提交成功。
     */
    submit() {
      if (locked || !actions || typeof actions.submit !== 'function') return false;
      try { actions.submit(); return true; } catch (error) { return false; }
    },

    /**
     * 往 `conversation.input.activity` 槽注册一个「只为拿 inputActions」的组件。
     *
     * @param register - `ctx.slots.register`。
     * @param name - 槽名。
     * @returns disposer。
     */
    register(register, name) {
      const Bridge = (props) => {
        React.useEffect(() => {
          actions = props?.inputActions ?? null;
          sessionId = props?.sessionId ?? '';
          locked = props?.locked === true;
        }, [props]);
        // 极简：一个零尺寸的锚点，不占输入框旁边的位置
        return React.createElement('span', {
          'data-cpn-input-bridge': '1',
          'aria-hidden': 'true',
          style: { display: 'none' },
        });
      };
      /**
       * 那个槽是 **single**，官方语音输入插件也会注册它——两者只能有一个。
       *
       * 注册冲突会**抛异常**（`single slot ... already has a registration`），
       * 而这个异常在槽的注册回调里抛出，外层 try/catch 包不住（它是异步的）。
       * 因此在这里就地捕获，失败就返回一个空 disposer——**这不是故障，
       * 是预期内的情况**：功能走宿主的 speech-submit 降级，不丢。
       */
      try {
        return register({ name, id: 'coopanion-pet-input' }, Bridge);
      } catch (error) {
        return () => {};
      }
    },
  };
}
