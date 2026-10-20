/**
 * 66 的单元测试（`node --test test/`）。
 *
 * 这套判定的意义是「**她能不能不问你就改**」，因此每条规则都要能钉死——
 * 而这些规则住在浏览器插件的闭包里，跑一次真实页面要起浏览器、点气泡，
 * 既慢又容易被别的失败掩盖。`assets/self-adjust.js` 是它们的纯逻辑副本，
 * 这里逐条验它；`lib/tools.js` 的 `pet_set` 用假通道验四条路径。
 *
 * 这里也留了 v1.9.0 那个缺陷的回归用例（见 `regression` 那一节）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SELF_KEYS, SELF_MODES, DIRECT_BY_DEFAULT, selfAdjustMode, directMap, selfTier,
  planSelfPatch, pickPatch, alwaysPatch, readConsent,
} from '../assets/self-adjust.js';
import { createPetTools } from '../lib/tools.js';

/* ---------------------------------------------------------------- 分级 */

test('默认档：她自己的外观与习惯可直接改，碰到用户屏幕/耳朵/称呼的先问', () => {
  const prefs = { selfAdjust: 'default' };
  const m = directMap(prefs);
  // 与上游 SELF_DEFAULT 逐项相同的前 11 项
  assert.deepEqual(
    ['figure', 'scheme', 'roam', 'snoreSeconds'].map((k) => m[k]),
    [true, true, true, true],
  );
  assert.deepEqual(
    ['sound', 'scale', 'bubbleSize', 'fontSize', 'theme', 'hoverButtons', 'user'].map((k) => m[k]),
    [false, false, false, false, false, false, false],
  );
  // 本插件独有的 5 项：她的（状态气泡/足迹/帧率）算 self，用户的（音效开关/光晕）算 ask
  assert.deepEqual(
    ['statusBubble', 'trail', 'fps', 'sounds', 'glow'].map((k) => m[k]),
    [true, true, true, false, false],
  );
});

test('any：全部直接改；off：全部先问（一个都不许）', () => {
  assert.equal(Object.values(directMap({ selfAdjust: 'any' })).every(Boolean), true);
  assert.equal(Object.values(directMap({ selfAdjust: 'off' })).some(Boolean), false);
});

test('custom：逐项看 selfAdjustCustom，没写过的项回落到默认表', () => {
  const prefs = { selfAdjust: 'custom', selfAdjustCustom: { sound: true, roam: false } };
  const m = directMap(prefs);
  assert.equal(m.sound, true);        // 显式打开
  assert.equal(m.roam, false);        // 显式关闭
  assert.equal(m.figure, true);       // 没写 → 默认表里的 true
  assert.equal(m.scale, false);       // 没写 → 默认表里的 false
});

test('非法/缺失的 selfAdjust 按 default 处理（上游同义）', () => {
  for (const bad of [undefined, null, '', 'DEFAULT', 42, true]) {
    assert.equal(selfAdjustMode(bad), 'default');
    assert.deepEqual(directMap({ selfAdjust: bad }), directMap({ selfAdjust: 'default' }));
  }
});

test('每一个 SELF_KEYS 在四种模式下都有明确档位', () => {
  for (const mode of SELF_MODES) {
    const m = directMap({ selfAdjust: mode });
    assert.deepEqual(Object.keys(m), SELF_KEYS);
    for (const key of SELF_KEYS) assert.equal(typeof m[key], 'boolean');
  }
});

test('patch 键到权限键的映射：sizeIndex → scale、roamIndex → roam、fpsIndex → fps', () => {
  const prefs = { selfAdjust: 'default' };
  assert.equal(selfTier(prefs, 'sizeIndex'), 'ask');    // 体型动的是用户的屏幕
  assert.equal(selfTier(prefs, 'roamIndex'), 'self');
  assert.equal(selfTier(prefs, 'fpsIndex'), 'self');
  assert.equal(selfTier(prefs, 'statusBubble'), 'self');
  assert.equal(selfTier(prefs, 'sound'), 'ask');
});

/* ------------------------------------------------------------ 变更规划 */

test('只看这次真正出现的键——没出现的键不参与判定', () => {
  const plan = planSelfPatch({ roamIndex: 2, fpsIndex: 0 }, { selfAdjust: 'default' });
  assert.deepEqual(plan.allowed.sort(), ['fpsIndex', 'roamIndex']);
  assert.deepEqual(plan.ask, []);
});

test('值为 undefined 的键不算「要改」', () => {
  const plan = planSelfPatch({ roamIndex: 1, sound: undefined }, { selfAdjust: 'default' });
  assert.deepEqual(plan.allowed, ['roamIndex']);
  assert.deepEqual(plan.ask, []);
});

test('混合 patch 分成两拨：可以改的照改，要问的单独列出', () => {
  const plan = planSelfPatch({ roamIndex: 1, sound: false, sizeIndex: 2 }, { selfAdjust: 'default' });
  assert.deepEqual(plan.allowed, ['roamIndex']);
  assert.deepEqual(plan.ask, ['sound', 'sizeIndex']);
});

test('边界本身不受约束：selfAdjust / selfAdjustCustom 永远走豁免', () => {
  const plan = planSelfPatch({ selfAdjust: 'any', selfAdjustCustom: { sound: true } }, { selfAdjust: 'off' });
  assert.deepEqual(plan.exempt.sort(), ['selfAdjust', 'selfAdjustCustom']);
  assert.deepEqual(plan.ask, []);
});

test('认不出的键落到 ask（失败即拒绝，不默认放行）', () => {
  const plan = planSelfPatch({ somethingNew: 1 }, { selfAdjust: 'default' });
  assert.deepEqual(plan.ask, ['somethingNew']);
});

test('pickPatch 只挑出指定的键，值原样保留', () => {
  const patch = { a: 1, b: false, c: 3 };
  assert.deepEqual(pickPatch(patch, ['a', 'c']), { a: 1, c: 3 });
  assert.deepEqual(pickPatch(patch, ['zzz']), {});
});

test('「以后都行」把她答应过的项记成可直接改，并切到 custom', () => {
  const prefs = { selfAdjust: 'default' };
  const next = alwaysPatch(prefs, ['sound', 'sizeIndex']);
  assert.equal(next.selfAdjust, 'custom');
  assert.equal(next.selfAdjustCustom.sound, true);
  assert.equal(next.selfAdjustCustom.scale, true);   // sizeIndex → scale
  assert.equal(next.selfAdjustCustom.figure, true);  // 原本就允许的项保持
  // 之后同样的 patch 不再需要问
  assert.deepEqual(planSelfPatch({ sound: false }, next).ask, []);
});

/* --------------------------------------------------- 回答的解读 */

const TEXTS = { yes: '可以', always: '以后都行', no: '不用了' };

test('readConsent：点按钮按下标判定', () => {
  assert.equal(readConsent({ index: 0, text: '' }, TEXTS), 'yes');
  assert.equal(readConsent({ index: 1, text: '' }, TEXTS), 'always');
  assert.equal(readConsent({ index: 2, text: '' }, TEXTS), 'declined');
});

test('readConsent：打字回答必须与选项说法完全一致才算数', () => {
  assert.equal(readConsent({ index: -1, text: '可以' }, TEXTS), 'yes');
  assert.equal(readConsent({ index: -1, text: ' 以后都行 ' }, TEXTS), 'always');
  assert.equal(readConsent({ index: -1, text: '不用了' }, TEXTS), 'declined');
  // 模糊同意不算同意——这正是最容易出错的地方
  assert.equal(readConsent({ index: -1, text: '可以吧，不过别改太多' }, TEXTS), 'no-answer');
  assert.equal(readConsent({ index: -1, text: '好' }, TEXTS), 'no-answer');
});

test('readConsent：没答（超时 / Esc / 纯净模式）与拒绝要分开', () => {
  assert.equal(readConsent(null, TEXTS), 'no-answer');
  assert.equal(readConsent(undefined, TEXTS), 'no-answer');
  assert.equal(readConsent({ index: -1, text: '' }, TEXTS), 'no-answer');
});

/* ------------------------ 回归：v1.9.0 的「pet_set 一律被拒」 ---------- */

test('regression：只改 roam/fps/trail/状态气泡时，默认档不该触发任何提问', () => {
  // v1.9.0 把 7 个 ask 类键**无条件**列进判据，于是这条合法请求也被整条拒绝
  const plan = planSelfPatch(
    { roamIndex: 2, fpsIndex: 1, trail: true, statusBubble: false },
    { selfAdjust: 'default' },
  );
  assert.deepEqual(plan.ask, [], '这些项都属于「她自己的」，不该问');
  assert.equal(plan.allowed.length, 4);
});

test('regression：默认档下改 sound 仍要问（这条边界要留着）', () => {
  assert.deepEqual(planSelfPatch({ sound: true }, { selfAdjust: 'default' }).ask, ['sound']);
});

/* ------------------------------------------- pet_set 工具的四种结果 */

/** 造一个只有 pet_set 需要的假通道。 */
const petTools = (command) => createPetTools({
  channel: { command, get online() { return true; } },
  getPetState: () => ({ connected: true, mode: 'idle', x: 0, scheme: 'deepseek-maid' }),
  getCuaPolicy: () => null,
  getDesktop: () => null,
});

test('pet_set：需要问的项被拒绝时如实回报 declined，且不谎报成功', async () => {
  const tools = petTools(async () => ({ ok: false, reason: 'declined' }));
  const res = await tools.set.execute({ sound: true });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'declined');
  assert.match(res.message, /said no/);
  assert.match(res.message, /Do not retry/);
});

test('pet_set：off 档如实说是设置拦下的，并指出去哪里改', async () => {
  const tools = petTools(async () => ({ ok: false, reason: 'self-adjust-off' }));
  const res = await tools.set.execute({ sound: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'self-adjust-off');
  assert.match(res.message, /what she may change/);
});

test('pet_set：部分改成功时，回执分开说改了什么、没同意什么', async () => {
  const tools = petTools(async () => ({ ok: true, applied: { roamIndex: 1 }, refused: ['sound'] }));
  const res = await tools.set.execute({ roam: 1, sound: true });
  assert.equal(res.ok, true);
  assert.match(res.message, /roaming occasional/);
  assert.match(res.message, /did not agree to sounds on/);
});

test('pet_set：页面什么都没写下去时按失败回报', async () => {
  const tools = petTools(async () => ({ ok: true, applied: {}, refused: [] }));
  const res = await tools.set.execute({ roam: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'nothing-applied');
});
