/**
 * 设置面板的「逐项开关」测试（`node --test test/`）。
 *
 * 面板是 React 组件，但**不需要真 React**：这里给一个只实现面板用到的
 * 那几个 API 的替身，把组件函数调一次拿到元素树，再在树里找那一行。
 * 好处是快、无需浏览器，而且能钉住「哪种档位下才显示这行」这种容易忘的规则。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsSection } from '../assets/settings.js';
import { SELF_KEYS } from '../assets/self-adjust.js';

/** 只实现面板用到的那几个 React API。`useEffect` 不执行（面板里只用来拉 CUA 档位）。 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useReducer: (fn, init) => [init, () => {}],
    useMemo: (fn) => fn(),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (init) => ({ current: init ?? null }),
  };
}

/** 在元素树里收集所有字符串（用来找行标题）。 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out; }
  if (node.children) { for (const n of node.children) texts(n, out); }
  return out;
}

/**
 * 找带某段文案的**那一行**：行的结构固定是 `div[ 标签span, 控件span ]`，
 * 因此按「第一个孩子里含这段文字」认行，再只收这一行里的按钮。
 *
 * 不按「子树里含这段文字」认——那样根节点也匹配，会把整棵树的按钮都算进来
 * （第一版就是这么错的）。
 */
function rowWithButtons(tree, needle) {
  const hits = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type === 'function') return;
    const kids = node.children ?? [];
    const first = kids[0];
    if (node.type === 'div' && first && texts(first).join('').includes(needle)) {
      const buttons = [];
      const scan = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(scan); return; }
        if (n.type === 'button') { buttons.push({ label: texts(n).join(''), pressed: n.props?.['aria-pressed'] === true }); return; }
        (n.children ?? []).forEach(scan);
      };
      kids.slice(1).forEach(scan);
      hits.push(buttons);
      return;
    }
    kids.forEach(walk);
  };
  walk(tree);
  return hits;
}

/** 用给定偏好渲染一次面板。 */
function render(prefs) {
  const write = () => {};
  const Section = createSettingsSection(fakeReact(), { read: () => prefs, write });
  return Section();
}

test('default 档不显示逐项开关（其余三档下它没有意义）', () => {
  const tree = render({ selfAdjust: 'default', selfAdjustCustom: {} });
  const hits = rowWithButtons(tree, '逐项开关');
  assert.equal(hits.length, 0, '非 custom 档不该出现这行');
});

test('custom 档显示逐项开关，覆盖每一个 SELF_KEYS', () => {
  const tree = render({
    selfAdjust: 'custom',
    selfAdjustCustom: Object.fromEntries(SELF_KEYS.map((k) => [k, true])),
  });
  const hits = rowWithButtons(tree, '逐项开关');
  assert.equal(hits.length, 1, 'custom 档应当有且只有一行');
  // 16 个键各一个按钮
  assert.equal(hits[0].length, SELF_KEYS.length);
  // 按钮上显示的是人看的名字，不是原始键名，也不重复
  const labels = hits[0].map((b) => b.label);
  assert.equal(new Set(labels).size, labels.length, '按钮文案不该重复');
  assert.equal(labels.some((l) => SELF_KEYS.includes(l)), false, '不该显示原始键名');
});

test('custom 档下没勾过的项按默认表显示为「已开」', () => {
  // 全不写 → 回落默认表：figure/scheme/roam/snoreSeconds/状态气泡/足迹/帧率 是开的
  const tree = render({ selfAdjust: 'custom', selfAdjustCustom: {} });
  const hits = rowWithButtons(tree, '逐项开关');
  assert.equal(hits.length, 1);
  // 默认表里恰好 7 项可直接改：figure、scheme、roam、snoreSeconds、状态气泡、足迹、帧率
  assert.equal(hits[0].filter((b) => b.pressed).length, 7);
});
