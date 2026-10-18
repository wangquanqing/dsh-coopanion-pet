/**
 * 41：页面侧的形象包宿主。
 *
 * 它在页面上放一个**沙箱 iframe**，把包代码关在里面跑，自己每帧驱动它。
 * 上游的 `web/body-host.js` 是同一角色；这里按本插件的需要重写，保留它的安全立场：
 *
 * **包代码不可信，因此页面这一侧要守住三条线**（照搬上游）：
 * - 她的包围盒与命中圆**必须落在舞台内**：包不能把可点区域铺满屏幕、
 *   把本该给下面界面的点击吞掉；
 * - 触摸事件（戳/摸/拎/扔）只在**页面刚给过指针输入之后**才算数：
 *   包不能凭空捏造「被戳了」来唤醒她；
 * - 气泡锚点与按钮条位置**必须落在舞台内**。
 *
 * 沙箱形态（已实测，见 docs/risk-verification.md）：
 * - `sandbox="allow-scripts"`（**不给 allow-same-origin**，否则沙箱形同虚设）；
 * - 纹理用 `new Image()` 加载（不受 CORS 限制，opaque origin 里能成）；
 * - 清单与脚本走 CORS 已放开的资源路由。
 */

/** 包若在这个时间内没画出第一帧，就当它坏了。 */
const READY_MS = 20_000;
/**
 * 包围盒的最大边长（按 256 单位方块计）。
 * 内核会把身体压扁到 1.33 倍宽、拉伸到 1.5 倍高，盒子再任意旋转会乘 √2。
 */
const BOX_MAX = 1.5 * Math.SQRT2;
/** 页面给过指针输入之后，多久内的触摸事件才算数。 */
const TOUCH_MS = 1000;
const TOUCHES = new Set(['poke', 'pet', 'grab', 'drop', 'throw', 'crash']);

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clampTo = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 把包报来的布局**收进合法范围**（上游 `readLayout` 的等价物）。
 *
 * @param l - 包报的布局。
 * @param size - 舞台 `{ W, H, S }`。
 * @returns 收好的布局；无效时返回 `null`。
 */
export function readLayout(l, size) {
  if (!l || typeof l !== 'object') return null;
  const { W, H, S } = size;
  const side = 256 * S * BOX_MAX;
  const b = l.box ?? {};
  const w = clampTo(num(b.w), 0, side);
  const h = clampTo(num(b.h), 0, side);
  const x0 = clampTo(num(b.x), -w, W);
  const y0 = clampTo(num(b.y), -h, H);
  const box = {
    x: Math.max(0, x0), y: Math.max(0, y0),
    w: Math.min(W, x0 + w) - Math.max(0, x0),
    h: Math.min(H, y0 + h) - Math.max(0, y0),
  };
  const pt = (p) => ({ x: clampTo(num(p?.x), 0, W), y: clampTo(num(p?.y), 0, H) });
  return {
    x: clampTo(num(l.x, W / 2), 0, W),
    facing: l.facing === -1 ? -1 : 1,
    mode: typeof l.mode === 'string' ? l.mode.slice(0, 32) : 'idle',
    busy: !!l.busy, moving: !!l.moving, pressing: !!l.pressing,
    cursor: l.cursor === 'grab' || l.cursor === 'grabbing' ? l.cursor : '',
    box,
    // 命中圆收进包围盒：包不能把可点区域铺到盒子外面
    hit: (Array.isArray(l.hit) ? l.hit : [])
      .map((c) => ({ x: num(c?.x), y: num(c?.y), r: Math.max(0, num(c?.r)) }))
      .filter((c) => c.x >= box.x && c.x <= box.x + box.w && c.y >= box.y && c.y <= box.y + box.h),
    bubble: pt(l.bubble),
    side: { ...pt(l.side), reach: clampTo(num(l.side?.reach), 0, side / 2) },
  };
}

/**
 * 建一个包宿主。
 *
 * `deps`：`{ root, bounds, onEvent, onSound, onError }`。
 *
 * @param pack - 清单 + 资源地址（`frameUrl` / `entryUrl` / `baseUrl` / `kitUrl`）。
 */
export function createPackHost(pack, deps) {
  const { root, bounds, onEvent, onSound, onError } = deps;

  /** 沙箱 iframe。 */
  const frame = document.createElement('iframe');
  // **不给 allow-same-origin**：给了它就能摸到主页面的 DOM，沙箱等于没有
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:absolute;inset:0;border:0;background:transparent;pointer-events:none';
  frame.src = pack.frameUrl;
  root.appendChild(frame);

  /** 最近一次布局（页面读它做命中判定）。 */
  let layout = null;
  /** 最近一次指针输入的时间（触摸事件的时效判据）。 */
  let lastPointerAt = 0;
  /** 最近一次是「扔」吗（crash 只在扔之后算数）。 */
  let lastWasThrow = false;
  let ready = false;
  let dead = false;
  let readyTimer = 0;
  let words = null;
  let z = null;

  /** 往 frame 发一条消息。 */
  const send = (m) => {
    if (dead) return;
    try { frame.contentWindow?.postMessage(m, '*'); } catch (error) { /* frame 没了 */ }
  };

  const onMessage = (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data || {};
    if (m.t === 'ready') {
      ready = true;
      if (readyTimer) clearTimeout(readyTimer);
      words = m.words;
      z = m.z;
      return;
    }
    if (m.t === 'error') {
      dead = true;
      try { onError?.(new Error(m.message)); } catch (error) { /* 订阅者自己的问题 */ }
      return;
    }
    if (m.t === 'frame') {
      layout = readLayout(m.layout, bounds());
      if (m.z !== undefined) z = m.z;
      // 事件：触摸要过时效判据
      for (const ev of m.events ?? []) {
        if (TOUCHES.has(ev?.kind)) {
          const fresh = Date.now() - lastPointerAt <= TOUCH_MS;
          // crash 只在刚扔过之后算数
          const okCrash = ev.kind !== 'crash' || lastWasThrow;
          if (!fresh || !okCrash) continue;
        }
        try { onEvent?.(ev.kind, ev.detail); } catch (error) { /* 同上 */ }
      }
      for (const s of m.sounds ?? []) {
        try { onSound?.(s.name, s.kind, ...(s.args ?? [])); } catch (error) { /* 同上 */ }
      }
    }
  };
  window.addEventListener('message', onMessage);

  // frame 里的脚本加载完之后才能 init（用 load 事件等它）
  frame.addEventListener('load', () => {
    send({
      t: 'init',
      entry: pack.entryUrl,
      export: pack.exportName,
      base: pack.baseUrl,
      kit: pack.kitUrl,
      start: pack.start ?? { x: 0, facing: 1, enter: 'drop' },
      bounds: bounds(),
    });
  }, { once: true });

  readyTimer = setTimeout(() => {
    if (!ready) {
      dead = true;
      try { onError?.(new Error('形象包在 ' + READY_MS / 1000 + ' 秒内没有画出第一帧')); } catch (error) { /* 同上 */ }
    }
  }, READY_MS);

  return {
    /** 每帧驱动它。 */
    step(dt) { if (ready && !dead) send({ t: 'tick', dt }); },
    /** 当前布局。 */
    layout: () => layout,
    /** 它知道的词（ready 之后才有）。 */
    get words() { return words; },
    /** 睡觉 z 的颜色。 */
    get z() { return z; },
    get ready() { return ready && !dead; },
    /** 转发一次调用（do/walk/pointer/...）。 */
    call(name, ...args) {
      // 触摸类调用要记时间：包靠它判时效
      if (name === 'pointer') lastPointerAt = Date.now();
      if (name === 'do' && args[0] === 'throw') lastWasThrow = true;
      send({ t: 'call', name, args });
    },
    dispose() {
      dead = true;
      if (readyTimer) clearTimeout(readyTimer);
      window.removeEventListener('message', onMessage);
      send({ t: 'dispose' });
      frame.remove();
    },
  };
}
