/**
 * 41：形象包沙箱的运行侧。
 *
 * 这个文件在**沙箱 iframe** 里跑（opaque origin，无同源权限）。它的职责：
 * 收主页面的 `init`，动态 import 包的入口模块，建 body，然后每帧被 `tick` 驱动。
 *
 * 契约照搬上游 `web/figure-frame.js`（api 2）：
 * - 包导出 `factory(base, { kit, host })`，返回一个 body；
 * - body 至少要 `step(dt)`、`layout()`、`do(word)`；
 * - 事件与声音通过 host 回调，随每帧的 `frame` 消息回传。
 *
 * **与上游的差别**：上游还传 `model`（预解析的 model.json）与 `scheme` 给包；
 * 本插件先只传 `base`/`kit`/`host`，其余按需再加。
 */

const root = document.getElementById('root');
let body = null;
let dead = false;
let bounds = { W: 0, H: 0, floorY: 0, S: 0.42 };
const events = [];
const sounds = [];
const post = (m) => parent.postMessage(m, '*');

function fail(err) {
  if (dead) return;
  dead = true;
  post({ t: 'error', message: String(err?.message ?? err).slice(0, 300) });
}
addEventListener('error', (e) => fail(e.error ?? e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));

/** 图片加载。**用 Image 而不是 fetch**——图片不受 CORS 限制，因此在 opaque origin 里能成。 */
function loadImage(url) {
  return new Promise((ok, bad) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => bad(new Error('图片加载失败：' + url));
    im.src = String(url);
  });
}

const host = {
  root,
  bounds: () => bounds,
  emit: (kind, detail) => events.push({ kind, detail }),
  sound: (name, kind, ...args) => sounds.push({ name, kind, args }),
};

addEventListener('message', async (e) => {
  // 只认父窗口，且只认我们自己发的那几种消息
  if (e.source !== parent || dead) return;
  const m = e.data || {};
  try {
    if (m.t === 'init') {
      bounds = m.bounds ?? bounds;
      const mod = await import(m.entry);
      const make = mod[m.export];
      if (typeof make !== 'function') throw new Error('包的入口没有导出 ' + m.export);
      const base = new URL(m.base);
      body = await make(base, {
        kit: m.kit ? await import(m.kit) : undefined,
        loadImage,
        asset: (p) => new URL(p, base),
        host: { ...host, start: m.start },
      });
      for (const fn of ['step', 'layout', 'do']) {
        if (typeof body?.[fn] !== 'function') throw new Error('body 缺少 ' + fn + '()');
      }
      post({ t: 'ready', z: body.z ?? null, words: Array.isArray(body.words) ? body.words : null });
      return;
    }
    if (!body) return;
    if (m.t === 'tick') {
      body.step(m.dt);
      const layout = body.layout();
      post({ t: 'frame', layout, events: events.splice(0), sounds: sounds.splice(0), z: body.z ?? null });
      return;
    }
    if (m.t === 'call') {
      // 其余调用按名字转发：do/walk/pointer/set/place/resize/...
      const fn = body[m.name];
      if (typeof fn === 'function') fn(...(m.args ?? []));
      return;
    }
    if (m.t === 'dispose') {
      try { body.dispose?.(); } catch (error) { /* 已经坏了 */ }
      body = null;
    }
  } catch (err) {
    fail(err);
  }
});
