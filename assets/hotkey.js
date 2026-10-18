/**
 * 全局说话热键：在任何页面里按一个组合键，让她开口说话。
 *
 * **为什么走 DSH 的 `shortcuts` 服务而不是自己监听 keydown**：
 *
 * - DSH 已经有一套窗口级快捷键仲裁：它处理输入框焦点、终端区域、弹窗（modal）、
 *   IME 组合输入、以及「用户正在录快捷键」这些情况。自己挂一个 window keydown
 *   很容易在用户打字时误触发，或者抢掉浏览器/系统的既有组合键。
 * - 走 `registerFixed` 还能**占位**：这个组合键会被登记进快捷键目录，与可编辑
 *   绑定做冲突检查，用户也能在 DSH 的快捷键设置里看到它。
 *
 * **仍然不是必需依赖**：`shortcuts` 服务在某些组合里可能不存在（例如纯终端宿主）。
 * 因此用 `ctx.inject` 的**可选形式**——拿不到就静默跳过，热键功能不生效，
 * 但桌宠本体照常工作。
 *
 * 默认组合：`Ctrl+Shift+.`（主修饰键 + Shift + 句号）。选它的理由：不与
 * DSH 既有的输入类快捷键（Enter / Shift+Enter / Esc Esc / Shift+1..3）重叠，
 * 也不占浏览器常用组合。用户可在 DSH 的快捷键页里改。
 */

/** 默认绑定的物理键与修饰键。 */
const DEFAULT_BINDING = { code: 'Period', modifiers: ['primary', 'shift'] };

/**
 * 注册全局说话热键。
 *
 * @param shortcuts - DSH 的 `shortcuts` 服务；不可用时调用方不该调这个函数。
 * @param deps - `{ speak(), t() }`：`speak()` 是按下后要做的事，`t` 取文案。
 * @returns disposer，移除命令与输入监听。
 */
export function registerSpeakShortcut(shortcuts, deps) {
  const { speak, t } = deps;

  // 先问一下这个绑定在这台设备上长什么样（keys 是给人看的键帽文字，
  // 并且会按平台把 primary 展开成 Ctrl 或 Cmd）
  let keys = ['Ctrl', 'Shift', '.'];
  try {
    const described = shortcuts.describeBinding?.(DEFAULT_BINDING);
    if (described?.keys?.length) keys = described.keys;
  } catch (error) {
    /* 描述不出来就用兜底文字，不影响功能 */
  }

  const offCommand = shortcuts.registerFixed({
    id: 'pet.speak',
    label: () => t('hotkey.speak'),
    keys,
    bindings: [DEFAULT_BINDING],
    group: 'application',
  });

  /**
   * 真正处理按键。
   *
   * 自己再做一遍过滤是刻意的：`observeFixedInput` 给的是**局部仲裁后**的输入，
   * 但它把「该不该响应」留给拥有者判断。因此这里排除：
   * - 输入框里（用户正在打字）
   * - 终端区域（命令行有自己的键位）
   * - **真正的弹窗**打开时（`modal` 非 null 且不是 `'other'`）。
   *   注意 `'other'` 不是弹窗——实测（dsh 0.2.0-rc.2）页面常态下 `modal` 就是
   *   `'other'`，把它当弹窗排除会让热键永远不触发。
   * - IME 组合中、以及已被别人消费掉的按键
   * - 按住的重复触发（长按不该连续说话）
   *
   * `localStorage['dsh-coopanion-pet:debug-hotkey'] = '1'` 时把每次收到的输入
   * 打进控制台；默认关，排查键位冲突时打开。
   */
  const debug = () => {
    try { return window.localStorage.getItem('dsh-coopanion-pet:debug-hotkey') === '1'; } catch (error) { return false; }
  };

  const offInput = shortcuts.observeFixedInput((input) => {
    if (debug()) console.log('[dsh-coopanion-pet:hotkey] 收到输入', input.type === 'reset' ? 'reset' : JSON.stringify({
      code: input.gesture.code, ctrl: input.gesture.control, shift: input.gesture.shift, alt: input.gesture.alt, meta: input.gesture.meta,
      repeat: input.gesture.repeat, composing: input.gesture.composing, prevented: input.gesture.defaultPrevented,
      region: input.context.region, modal: input.context.modal,
    }));
    if (input.type === 'reset') return;
    const { gesture, context } = input;
    if (gesture.repeat || gesture.composing || gesture.defaultPrevented) return;
    if (context.region !== 'page') return;
    // `'other'` 是页面常态而不是弹窗（实测）；只有真正的弹窗才让位。
    if (context.modal !== null && context.modal !== 'other') return;
    if (gesture.code !== DEFAULT_BINDING.code) return;
    // primary → 本平台的主修饰键；Shift 也要按住
    const primary = shortcuts.platform === 'macos' ? gesture.meta : gesture.control;
    if (!primary || !gesture.shift) return;
    if (gesture.alt) return;
    input.consume();
    try { speak(); } catch (error) { /* 她没能说话不该影响页面 */ }
  });

  return () => {
    offInput();
    offCommand();
  };
}
