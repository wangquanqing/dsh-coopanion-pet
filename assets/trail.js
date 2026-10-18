/**
 * 走路轨迹点：她走动时，从她脚下到身后留下三个渐小的点，
 * 像一串刚踩过的脚印，停一会儿就淡掉。
 *
 * 移植自 Coopanion 的 `web/pet-app.js` placeLines 里那段 trail（上游是用来
 * 连接她的对话气泡与头顶的，本插件没有对话栈，因此改成纯粹的走路轨迹）。
 *
 * 为什么不用 CSS 动画：点的位置每帧都在变（她在走），CSS 动画只能表达
 * 固定位置的呼吸感；位置与透明度都由这里按帧算，样式只管形状。
 */

import { t as text } from './i18n.js';

/** 轨迹最多留几个点。
 *  多一个点就多一次 DOM 写入，三个已经够看出方向。 */
const DOTS = 3;
/** 每个点从生到灭的秒数。 */
const LIFE = 0.9;
/** 走多快才算「在走」：低于这个速度不落点，免得原地呼吸也拖尾巴。 */
const MIN_SPEED = 14;
/** 隔多少秒落一个点（她走得不快时够稀疏，跑起来自然连成串）。 */
const GAP = 0.16;

/**
 * 建一条轨迹。
 *
 * `deps`：`{ anchor() }` 返回她脚下的位置 `{ x, y }`（每帧取一次，
 * 这样窗口缩放后点也落在对的地方）。
 */
export function createTrail(deps) {
  const { anchor } = deps;

  const root = document.createElement('div');
  root.className = 'cpn-trail';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');
  const dots = [];
  for (let i = 0; i < DOTS; i++) {
    const el = document.createElement('i');
    el.hidden = true;
    root.appendChild(el);
    dots.push({ el, life: 0, x: 0, y: 0 });
  }

  /** 上一次落点的时间与位置，用来算速度与间隔。 */
  let lastAt = 0;
  let lastX = null;
  let lastY = 0;
  /** 本插件的时钟（秒），由 step 累加。 */
  let clock = 0;
  /** 下一个可用的点（环形覆盖最旧的那个）。 */
  let next = 0;

  /**
   * 每帧调用一次。
   *
   * `moving` 为真时按间隔落点；点各自老化，到期就隐掉。
   */
  function step(dt, moving) {
    clock += dt;
    const at = anchor();

    if (moving && at) {
      const dx = lastX === null ? 0 : at.x - lastX;
      const dy = lastX === null ? 0 : at.y - lastY;
      const dist = Math.hypot(dx, dy);
      const speed = dt > 0 ? dist / dt : 0;
      if (speed >= MIN_SPEED && clock - lastAt >= GAP) {
        const d = dots[next];
        d.life = 1;
        d.x = at.x;
        d.y = at.y;
        d.el.hidden = false;
        d.el.style.left = `${Math.round(at.x)}px`;
        d.el.style.top = `${Math.round(at.y)}px`;
        next = (next + 1) % dots.length;
        lastAt = clock;
      }
    }
    if (at) { lastX = at.x; lastY = at.y; }

    let any = false;
    for (const d of dots) {
      if (d.life <= 0) continue;
      d.life = Math.max(0, d.life - dt / LIFE);
      if (d.life === 0) { d.el.hidden = true; continue; }
      any = true;
      d.el.style.opacity = d.life.toFixed(2);
      // 越旧越小：刚落的点最大，快灭的点最小
      d.el.style.transform = `translate(-50%, -50%) scale(${(0.55 + 0.45 * d.life).toFixed(2)})`;
    }
    root.hidden = !any;
  }

  /** 立刻清干净（她不见了、或者被收起来时用）。 */
  function clear() {
    for (const d of dots) { d.life = 0; d.el.hidden = true; }
    root.hidden = true;
    lastX = null;
  }

  return {
    root,
    step,
    clear,
    dispose() { root.remove(); },
  };
}

/** 轨迹点的样式。形状与配色跟随 DSH 主题令牌，与气泡同一套回落值。 */
export const TRAIL_CSS = `
.cpn-trail { position: fixed; inset: 0; pointer-events: none; z-index: 44; }
.cpn-trail[hidden] { display: none; }
.cpn-trail i {
  position: absolute; display: block; width: 9px; height: 9px;
  border-radius: 50%;
  border: 2px solid var(--cpn-line, #E2DFE8);
  background: var(--cpn-surface, #fff);
  opacity: .7;
  will-change: transform, opacity;
}
`;
