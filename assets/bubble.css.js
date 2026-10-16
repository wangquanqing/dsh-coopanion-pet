/**
 * 桌宠气泡的样式。
 *
 * 配色优先跟随 DSH 的主题令牌（`--dsw-alias-*`），拿不到时回落到自己的
 * 明暗两套值。主题判定用 DSH 自己的标记：`body[data-ds-dark-theme]`。
 *
 * 移植自 Coopanion 的 `web/pet.css` 里的气泡段落，变量名改为 `--cpn-*`
 * 以免与宿主样式撞车，并去掉舞台、地板、工具条等无关部分。
 */

export const BUBBLE_CSS = `
.cpn-pet-layer, .cpn-bubble {
  --cpn-surface: var(--dsw-alias-bg-module-platform, #FFFFFF);
  --cpn-text: var(--dsw-alias-label-primary, #1B1626);
  --cpn-muted: var(--dsw-alias-label-secondary, #6A6577);
  --cpn-line: var(--dsw-alias-border-l2, #E2DFE8);
  --cpn-ink: #1B1626;
  --cpn-eye: #00A870;
  --cpn-shadow: rgba(27,22,38,.14);
}
body[data-ds-dark-theme] .cpn-pet-layer,
body[data-ds-dark-theme] .cpn-bubble {
  --cpn-surface: var(--dsw-alias-bg-module-platform, #151A22);
  --cpn-text: var(--dsw-alias-label-primary, #E9EDF2);
  --cpn-muted: var(--dsw-alias-label-secondary, #8C95A3);
  --cpn-line: var(--dsw-alias-border-l2, #252C37);
  --cpn-ink: #FFFFFF;
  --cpn-eye: #2FD59B;
  --cpn-shadow: rgba(0,0,0,.36);
}

.cpn-bubble {
  position: fixed; left: 0; top: 0; z-index: 40;
  width: max-content; min-width: 46px; max-width: min(300px, calc(100vw - 20px));
  padding: 10px 14px; border-radius: 18px;
  background: var(--cpn-surface); color: var(--cpn-text);
  border: 2.5px solid var(--cpn-ink);
  box-shadow: 0 8px 22px var(--cpn-shadow);
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif;
  font-size: 14.5px; line-height: 1.55;
  transform-origin: var(--cpn-tail, 50%) calc(100% + 10px);
  pointer-events: auto;
  user-select: none; -webkit-user-select: none;
}
.cpn-bubble[hidden] { display: none; }
/* 尾巴：外描边三角的底边压在边框内，内三角比它低一个线宽，把边框在中间打开一条缝。 */
.cpn-bubble::before, .cpn-bubble::after {
  content: ""; position: absolute; left: calc(var(--cpn-tail, 50%) - 13.5px); bottom: -11px;
  width: 22px; height: 11.5px;
}
.cpn-bubble::before {
  background: var(--cpn-ink);
  clip-path: path('M0.75 1.25 L8.9 9.4 Q11 11.5 13.1 9.4 L21.25 1.25 Z');
}
.cpn-bubble::after {
  background: var(--cpn-surface);
  clip-path: path('M3.04 0 L10.53 7.49 Q11 7.96 11.47 7.49 L18.96 0 Z');
}
.cpn-bubble.ask { min-width: min(236px, calc(100vw - 20px)); }
.cpn-bubble.pop { animation: cpn-bubble-in .26s cubic-bezier(.3,1.5,.5,1); }
@keyframes cpn-bubble-in { from { transform: scale(.5); opacity: 0 } }

.cpn-b-text {
  margin: 0; min-height: 1.55em;
  white-space: pre-wrap; text-wrap: pretty;
}

.cpn-b-opts { display: flex; flex-direction: column; gap: 6px; margin: 10px -4px 2px 0; }
.cpn-b-opts[hidden] { display: none; }
.cpn-b-opt, .cpn-b-own { animation: cpn-opt-in .24s cubic-bezier(.3,1.4,.5,1) both; }
@keyframes cpn-opt-in { from { transform: translateY(6px) scale(.92); opacity: 0 } }

.cpn-b-opt {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  font: inherit; font-size: 14px; padding: 6px 10px; border-radius: 11px;
  border: 1.5px solid var(--cpn-line); background: transparent; color: var(--cpn-text);
  cursor: pointer; transition: border-color .15s;
}
.cpn-b-opt:hover, .cpn-b-opt.chosen { border-color: var(--cpn-eye); }
.cpn-b-opt kbd {
  flex: none; display: grid; place-items: center; width: 20px; height: 20px;
  border-radius: 50%; border: 2px solid var(--cpn-eye);
  font: 500 11px/1 ui-monospace, Consolas, monospace; color: var(--cpn-text);
}

.cpn-b-own {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 3px 3px 10px; border-radius: 11px;
  border: 1.5px dashed var(--cpn-line);
}
.cpn-b-own:focus-within { border-style: solid; border-color: var(--cpn-eye); }
.cpn-b-own input {
  flex: 1; min-width: 0; border: 0; background: transparent;
  font: inherit; font-size: 14px; color: var(--cpn-text); outline: none; padding: 4px 0;
}
.cpn-b-own button[type="submit"] {
  flex: none; font: inherit; font-size: 12.5px; padding: 4px 10px;
  border-radius: 8px; border: 0; background: var(--cpn-text); color: var(--cpn-surface);
  cursor: pointer;
}
`;
