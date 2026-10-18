/**
 * 46：预览页的挂载入口。
 *
 * 预览页**不重新实现桌宠**——它复用同一套客户端模块（`client.js` 里那份）。
 * 但 `client.js` 是按 DSH 的 `__ModuleLoader__.load()` 契约写的，因此这里
 * 造一个**最小的桩**：只提供 `load()`（记录工厂）与 `require('react')`。
 *
 * 为什么这么做而不是「把 client.js 改成不依赖 ModuleLoader」：
 * 那样会动到主路径（DSH 页面里的加载方式），风险大；
 * 而造桩只影响预览页，主路径一个字都不用改。
 *
 * 桩里的 React 用 `createElement` 直接构造 DOM 的能力替代——
 * 预览页只需要它做最外层挂载，不需要真正的 React 运行时。
 */

/** 一个最小的 React 替身：只实现 client.js 用到的几个 API。 */
function makeReactShim() {
  /** 一个极简的「组件」：直接调函数拿回 DOM 节点。 */
  const createElement = (type, props, ...children) => {
    // client.js 只把它当「最外层容器」用：type 是 'div'，带 ref。
    if (typeof type === 'string') {
      const el = document.createElement(type);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (k === 'ref') continue;
          if (k === 'style' && v && typeof v === 'object') Object.assign(el.style, v);
          else if (k.startsWith('data-') || k === 'aria-hidden') el.setAttribute(k, String(v));
        }
      }
      for (const c of children.flat()) if (c != null) el.append(c);
      return el;
    }
    return null;
  };
  /** useEffect：立刻执行（预览页没有 React 的调度，同步执行等价）。 */
  const useEffect = (fn) => { try { fn(); } catch (error) { /* 出错不阻塞 */ } };
  const useRef = (init) => ({ current: init ?? null });
  const useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
  const useReducer = (fn, init) => [init, () => {}];
  const useMemo = (fn) => fn();
  return { createElement, useEffect, useRef, useState, useReducer, useMemo };
}

/**
 * 在预览页里把桌宠挂起来。
 *
 * @param host - 容器元素。
 */
export async function startPreview(host) {
  if (!host) throw new Error('没有挂载点');

  // 1. 造 ModuleLoader 桩（必须在 import client.js 之前）
  let factory = null;
  const shimReact = makeReactShim();
  window.__ModuleLoader__ = {
    load({ factory: f }) { factory = f; },
  };
  // 2. 加载客户端模块（它会在 load() 里注册工厂）
  // 绝对路径：这个文件在 assets/ 下，而 client.js 也在同一目录，
  // 但预览页的 base 是 /api/dsh-coopanion-pet/preview，相对路径会解析错。
  await import('/api/dsh-coopanion-pet/assets/client.js');
  if (!factory) throw new Error('client.js 没有注册工厂');

  // 3. 调工厂拿插件对象；require('react') 给我们的替身
  const plugin = factory((id) => {
    if (id === 'react') return shimReact;
    throw new Error(`预览页不提供模块：${id}`);
  });

  // 4. 直接调 startPet（client.js 已经把它挂到 window 上了）
  const startPet = window.__dshCoopanionPetStart;
  if (typeof startPet !== 'function') throw new Error('client.js 没有暴露 startPet');
  const prefs = window.__dshCoopanionPetPrefs?.read?.() ?? {};
  const pet = await startPet(prefs);
  host.appendChild(pet.root);
  return pet;
}
