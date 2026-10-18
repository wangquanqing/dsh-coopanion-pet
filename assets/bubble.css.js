/**
 * 桌宠气泡的样式。
 *
 * 配色优先跟随 DSH 的主题令牌（`--dsw-alias-*`），拿不到时回落到自己的
 * 明暗两套值。主题判定用 DSH 自己的标记：`body[data-ds-dark-theme]`。
 *
 * 可调项走 CSS 变量（由 client.js 写到 `.cpn-pet-layer` 与气泡上）：
 * - `--cpn-bubble-size` 气泡框大小（只改框，不改字）
 * - `--cpn-font-size`   气泡文字大小（只改字，不改框）
 * - `--cpn-glow`        她本体周围的光晕强度（0 = 关）
 *
 * 主题两种：`auto` 跟随 DSH 的 `body[data-ds-dark-theme]`；`light`/`dark` 由
 * `data-cpn-theme` 强制（见设置面板的「主题」三档）。
 *
 * 移植自 Coopanion 的 `web/pet.css` 里的气泡段落，变量名改为 `--cpn-*`
 * 以免与宿主样式撞车，并去掉舞台、地板、工具条等无关部分。
 */

export const BUBBLE_CSS = `
.cpn-pet-layer, .cpn-bubble {
  --cpn-bubble-size: 1;
  --cpn-font-size: 1;
  --cpn-glow: 0;
  --cpn-surface: var(--dsw-alias-bg-module-platform, #FFFFFF);
  --cpn-text: var(--dsw-alias-label-primary, #1B1626);
  --cpn-muted: var(--dsw-alias-label-secondary, #6A6577);
  --cpn-line: var(--dsw-alias-border-l2, #E2DFE8);
  --cpn-ink: #1B1626;
  --cpn-eye: #00A870;
  --cpn-shadow: rgba(27,22,38,.14);
}
/* auto：DSH 是深色时才深。属性由 client.js 写在 .cpn-pet-layer 与气泡上。 */
body[data-ds-dark-theme] .cpn-pet-layer[data-cpn-theme="auto"],
body[data-ds-dark-theme] .cpn-bubble[data-cpn-theme="auto"] {
  --cpn-surface: var(--dsw-alias-bg-module-platform, #151A22);
  --cpn-text: var(--dsw-alias-label-primary, #E9EDF2);
  --cpn-muted: var(--dsw-alias-label-secondary, #8C95A3);
  --cpn-line: var(--dsw-alias-border-l2, #252C37);
  --cpn-ink: #FFFFFF;
  --cpn-eye: #2FD59B;
  --cpn-shadow: rgba(0,0,0,.36);
}
/* 强制深色：不管 DSH 是什么主题 */
.cpn-pet-layer[data-cpn-theme="dark"], .cpn-bubble[data-cpn-theme="dark"] {
  --cpn-surface: var(--dsw-alias-bg-module-platform, #151A22);
  --cpn-text: var(--dsw-alias-label-primary, #E9EDF2);
  --cpn-muted: var(--dsw-alias-label-secondary, #8C95A3);
  --cpn-line: var(--dsw-alias-border-l2, #252C37);
  --cpn-ink: #FFFFFF;
  --cpn-eye: #2FD59B;
  --cpn-shadow: rgba(0,0,0,.36);
}

/* 光晕：她融进背景时能看清轮廓。上游是采样屏幕算的，这里是 CSS 近似。
   用 drop-shadow 而不是 box-shadow，因为她的画布是透明底。 */
.cpn-pet-layer canvas, .cpn-pet-layer svg.kit {
  filter: drop-shadow(0 0 calc(1.5px * var(--cpn-glow)) var(--cpn-shadow));
}
.cpn-pet-layer[data-cpn-glow="off"] canvas,
.cpn-pet-layer[data-cpn-glow="off"] svg.kit { filter: none; }

.cpn-bubble {
  position: fixed; left: 0; top: 0; z-index: 40;
  width: max-content; min-width: calc(46px * var(--cpn-bubble-size));
  max-width: min(calc(300px * var(--cpn-bubble-size)), calc(100vw - 20px));
  padding: calc(10px * var(--cpn-bubble-size)) calc(14px * var(--cpn-bubble-size));
  border-radius: calc(18px * var(--cpn-bubble-size));
  background: var(--cpn-surface); color: var(--cpn-text);
  border: 2.5px solid var(--cpn-ink);
  box-shadow: 0 8px 22px var(--cpn-shadow);
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif;
  font-size: calc(14.5px * var(--cpn-font-size)); line-height: 1.55;
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
.cpn-bubble.ask { min-width: min(calc(236px * var(--cpn-bubble-size)), calc(100vw - 20px)); }
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
  font: inherit; font-size: calc(14px * var(--cpn-font-size)); padding: 6px 10px; border-radius: 11px;
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
  font: inherit; font-size: calc(14px * var(--cpn-font-size)); color: var(--cpn-text); outline: none; padding: 4px 0;
}
/* 录音指示器：她头顶的小胶囊（52 的录音反馈） */
.cpn-voice {
  position: fixed; z-index: 41;
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 999px;
  background: var(--cpn-surface); color: var(--cpn-text);
  border: 1.5px solid var(--cpn-line);
  box-shadow: 0 6px 18px var(--cpn-shadow);
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif;
  font-size: 12px; white-space: nowrap;
  pointer-events: none;
}
.cpn-voice[hidden] { display: none; }
.cpn-voice-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: var(--cpn-eye);
  animation: cpn-voice-pulse 1s ease-in-out infinite;
}
@keyframes cpn-voice-pulse { 50% { opacity: .35; transform: scale(.8) } }
.cpn-voice-bar {
  display: block; width: 40px; height: 4px; border-radius: 2px; flex: none;
  background: var(--cpn-line); position: relative; overflow: hidden;
}
.cpn-voice-bar[hidden] { display: none; }
.cpn-voice-bar::after {
  content: ""; position: absolute; inset: 0 auto 0 0;
  width: calc(100% * var(--cpn-voice-level, 0));
  background: var(--cpn-eye);
  transition: width .08s linear;
}

.cpn-b-own button[type="submit"] {
  flex: none; font: inherit; font-size: calc(12.5px * var(--cpn-font-size)); padding: 4px 10px;
  border-radius: 8px; border: 0; background: var(--cpn-text); color: var(--cpn-surface);
  cursor: pointer;
}
`;
