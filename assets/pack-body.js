/**
 * 41：把沙箱里的形象包包装成「与内核 body 同接口」的适配器。
 *
 * **为什么需要这一层**：本插件的其余代码（帧循环、指针、装扮、状态气泡）都在调
 * 内核 body 的那套方法（`step` / `layout` / `do` / `pointer` / `set` …）。
 * 而第三方包跑在沙箱里，只能通过 `postMessage` 转发调用，且 `layout` 是
 * **上一帧回传的**（异步）。
 *
 * 这一层把差异吃掉：对外仍是同步接口，内部把调用转发给沙箱、把回传的布局缓存下来。
 *
 * **哪些能力第三方包给不了**（如实说明）：
 * - `setScheme`：包自己的装扮轴由它的清单定义，本插件目前只转发 `set`；
 * - `words`：包的词表来自它的清单（宿主读的），不是运行时拿的；
 * - `setSkin` / `cue`：内核专有，包不一定实现（转发过去，没有就是空操作）。
 */

import { createPackHost } from './pack-host.js';

/**
 * 建一个包 body 适配器。
 *
 * @param pack - `{ id, entryUrl, baseUrl, kitUrl, frameUrl, exportName, start }`。
 * @param deps - `{ root, bounds, onEvent, onSound, onError, viewport }`。
 */
export function createPackBody(pack, deps) {
  const { root, bounds, onEvent, onSound, onError, viewport } = deps;

  const host = createPackHost(pack, {
    root,
    bounds: () => viewport(),
    onEvent,
    onSound,
    onError,
  });

  /** 最近一次布局（沙箱回传的）。 */
  let layout = null;

  /**
   * 沙箱的布局与内核的布局形状不同（少了 `figure` 之类），
   * 但本插件用到的字段（x/facing/mode/busy/moving/box/hit/bubble/side）都有。
   * 这里补一个 `moving` 的兜底，因为帧率控制要用它。
   */
  const shape = (l) => (l ? { ...l, moving: l.moving ?? (l.mode !== 'idle') } : null);

  return {
    /** 帧循环每帧调它：驱动沙箱并取回新布局。 */
    step(dt) {
      host.step(dt);
      layout = shape(host.layout());
    },
    /** 当前布局（可能是上一帧的——沙箱是异步的）。 */
    layout: () => layout,
    /** 重新量尺寸（把新 bounds 推给沙箱）。 */
    resize() {
      host.call('resize');
    },
    /** 做一个表情或动作。 */
    do(word) {
      host.call('do', word);
      // 包不一定认得这个词；这里无法同步知道结果，因此一律当成功
      return true;
    },
    /** 她知道的词（来自清单，不是运行时）。 */
    words: pack.vocab ?? [],
    /** 走到某个横向位置。 */
    walk(x, run, id) { host.call('walk', x, run, id); },
    stopWalk(id) { host.call('stopWalk', id); },
    /** 指针事件。 */
    pointer(type, p) { host.call('pointer', type, p); },
    /** 放下（拖动结束时）。 */
    drop(p) { host.call('drop', p); },
    /** 舞台移动时修正。 */
    shift(dx, dy) { host.call('shift', dx, dy); },
    /** 直接放到某个位置。 */
    place(x, facing) { host.call('place', x, facing); },
    /** 状态（bounds/roam/hold/...）。包可能只实现一部分。 */
    set(s) { host.call('set', s); },
    /** 页面自己的时刻。 */
    cue(kind) { host.call('cue', kind); },
    talk() { host.call('talk'); },
    /** 换装扮。第三方包的轴由它的清单定义，这里只把 id 转过去。 */
    setScheme(id, opts) { host.call('setScheme', id, opts); },
    /** 睡觉 z 的颜色。 */
    get z() { return host.z; },
    /** 沙箱是否已就绪。 */
    get ready() { return host.ready; },
    dispose() { host.dispose(); },
  };
}
