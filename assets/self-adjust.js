/**
 * 66：她自己能改什么——上游 `selfAdjust` 的四级模式与两级权限。
 *
 * **为什么单独一个模块**：这段判定决定「她能不能不问你就改」，是最不能出错的地方，
 * 而它藏在浏览器插件的闭包里没法单独验。抽成纯函数之后，喂一份偏好就能把
 * 四种模式、每一个键钉死（见 `docs/code-review.md` 的 D14）。
 *
 * 上游（`src/self.ts` + `src/config.ts` 的 `SELF_DEFAULT`）把设置项分两级：
 *
 * - `self`：直接改；
 * - `ask`：先在气泡里问人，答应才改。
 *
 * 默认划分（`default` 档）是——**她自己的外观与习惯可以直接改；碰到你的屏幕、
 * 耳朵与称呼的要先问**：
 *
 * | self | ask |
 * | --- | --- |
 * | figure、scheme、roam、snoreSeconds | sound、scale、bubbleSize、fontSize、theme、hoverButtons、user |
 *
 * 四级模式：
 *
 * - `off`：什么都不许她改（全部按 ask 处理，问了也不改——由调用方按「拒绝」收尾）；
 * - `default`：上面那张表；
 * - `any`：都可以直接改；
 * - `custom`：逐项看 `selfAdjustCustom`；**没写的项按 `default` 那张表**（上游同义）。
 *
 * 与上游的差异：本插件另有 5 项上游没有「能让她自己调」的对应项
 * （`statusBubble`、`trail`、`fps`、`sounds`、`glow`），
 * 按同一把尺子归位——**她的**（头顶状态气泡、走路足迹、帧率）算 self；
 * **你的**（六类音效开关、屏幕光晕）算 ask。
 */

/** 四种模式，与上游同名同义。 */
export const SELF_MODES = ['off', 'default', 'any', 'custom'];

/**
 * 会被这套权限管的键（她自己能改的东西）。
 *
 * 前 11 个与上游 `SELF_KEYS` **同名同序**；后 5 个是本插件独有的。
 */
export const SELF_KEYS = [
  // —— 与上游一致 ——
  'figure', 'scheme', 'roam', 'snoreSeconds', 'sound', 'scale', 'bubbleSize', 'fontSize',
  'theme', 'hoverButtons', 'user',
  // —— 本插件独有 ——
  'statusBubble', 'trail', 'fps', 'sounds', 'glow',
];

/**
 * `default` 档下，哪些项可以直接改。
 *
 * 前 11 个与上游 `SELF_DEFAULT` **逐项相同**（审查时逐字节核对过
 * `src/config.ts:85`）；后 5 个按同一判据补——见文件头的说明。
 */
export const DIRECT_BY_DEFAULT = {
  figure: true, scheme: true, roam: true, snoreSeconds: true,
  sound: false, scale: false, bubbleSize: false, fontSize: false, theme: false,
  hoverButtons: false, user: false,
  statusBubble: true, trail: true, fps: true, sounds: false, glow: false,
};

/**
 * 不受这套权限约束的键。
 *
 * `selfAdjust` / `selfAdjustCustom` 是**边界本身**——改它不该被它自己拦住。
 * `confirmed` 是 v1.9.0 留下的旧口子，已废弃；留着这一条是为了让旧调用
 * 传进来时不会反而触发一次提问。
 */
const EXEMPT = new Set(['selfAdjust', 'selfAdjustCustom', 'confirmed']);

/**
 * `set` 命令里的 patch 键 → 权限键。
 *
 * 大部分同名；不同名的三处是历史命名（`roamIndex` 是三档序号、
 * `sizeIndex` 是体型档位、`fpsIndex` 是帧率档位）。
 * **没列出来的键原样当权限键**——查不到就落到 ask（失败即拒绝）。
 */
export const PATCH_TO_SELF = {
  figure: 'figure',
  scheme: 'scheme',
  roamIndex: 'roam',
  snoreSeconds: 'snoreSeconds',
  sound: 'sound',
  sounds: 'sounds',
  sizeIndex: 'scale',
  scale: 'scale',
  bubbleSize: 'bubbleSize',
  fontSize: 'fontSize',
  theme: 'theme',
  hoverButtons: 'hoverButtons',
  user: 'user',
  statusBubble: 'statusBubble',
  trail: 'trail',
  fpsIndex: 'fps',
  glow: 'glow',
};

/** patch 键对应的界面文案键（提问时列给人看）。 */
export const LABEL_KEY = {
  figure: 'settings.figure',
  scheme: 'dress.scheme',
  roamIndex: 'settings.roam',
  snoreSeconds: 'settings.snoreSeconds',
  sound: 'settings.sound',
  sounds: 'settings.sounds',
  sizeIndex: 'settings.size',
  scale: 'settings.scale',
  bubbleSize: 'settings.bubbleSize',
  fontSize: 'settings.fontSize',
  theme: 'settings.theme',
  hoverButtons: 'settings.hoverButtons',
  user: 'settings.user',
  statusBubble: 'settings.statusBubble',
  trail: 'settings.trail',
  fpsIndex: 'settings.fps',
  glow: 'settings.glow',
};

/** `selfAdjust` 现在读作哪一种模式（非法值按 `default`，上游同义）。 */
export function selfAdjustMode(value) {
  return SELF_MODES.includes(value) ? value : 'default';
}

/**
 * 逐项算「能不能直接改」。
 *
 * @param prefs - 只读 `selfAdjust` 与 `selfAdjustCustom`。
 * @returns 每个 `SELF_KEYS` 条目对应 true（直接改）/ false（先问）。
 */
export function directMap(prefs) {
  const mode = selfAdjustMode(prefs?.selfAdjust);
  const custom = prefs?.selfAdjustCustom ?? {};
  const out = {};
  for (const key of SELF_KEYS) {
    if (mode === 'any') out[key] = true;
    else if (mode === 'default') out[key] = DIRECT_BY_DEFAULT[key] === true;
    else if (mode === 'custom') {
      // 没写过的项回落到 default 那张表（上游同义）
      out[key] = typeof custom[key] === 'boolean' ? custom[key] === true : DIRECT_BY_DEFAULT[key] === true;
    } else out[key] = false; // off
  }
  return out;
}

/** 单个键的档位。 */
export function selfTier(prefs, key) {
  const sk = PATCH_TO_SELF[key] ?? key;
  return directMap(prefs)[sk] === true ? 'self' : 'ask';
}

/**
 * 把一次 `set` 的 patch 分成两拨：能直接改的、要先问的。
 *
 * **只看这次真的要改的键**——值为 `undefined` 的不算。这正是 v1.9.0 的缺陷所在：
 * 当时把 7 个 ask 类键**无条件**列进判据，于是只改 `roam`/`fps` 的请求
 * 也会被整条拒绝（见 `docs/code-review.md` 的 D14 与 v1.9.1 的修复记录）。
 *
 * @param patch - `set` 命令里的 patch 对象。
 * @param prefs - 偏好（只读 `selfAdjust` 与 `selfAdjustCustom`）。
 * @returns `{ allowed, ask, exempt }`，三个都是 patch 键名数组。
 */
export function planSelfPatch(patch, prefs) {
  const direct = directMap(prefs);
  const allowed = [];
  const ask = [];
  const exempt = [];
  for (const key of Object.keys(patch ?? {})) {
    if (patch[key] === undefined) continue;
    if (EXEMPT.has(key)) { exempt.push(key); continue; }
    const sk = PATCH_TO_SELF[key] ?? key;
    if (direct[sk] === true) allowed.push(key);
    else ask.push(key);
  }
  return { allowed, ask, exempt };
}

/** 从 patch 里取出一部分键。 */
export function pickPatch(patch, keys) {
  const out = {};
  for (const key of keys) if (patch[key] !== undefined) out[key] = patch[key];
  return out;
}

/**
 * 把气泡里的一个回答解读成许可结果。
 *
 * 三种「没答应」必须分清，因为调用方要说的话不同：
 *
 * - `no-answer`：没答（超时、按 Esc 关掉、纯净模式里气泡根本没弹）——
 *   不是拒绝，可以再问一次；
 * - `declined`：明确说了「不用了」——不要重试；
 * - `yes` / `always`：答应，`always` 另外还要把它记成「以后都行」。
 *
 * 判据：**优先看点了哪个按钮**（下标）；用户直接打字时，只有文字
 * **与选项说法完全一致**才算——把「可以吧，不过…」当成同意是错的。
 *
 * @param answer - `{ index, text }` 或 `null`/`undefined`（没答）。
 * @param texts - `{ yes, always, no }` 三个选项的文案（随语言变）。
 * @returns `'yes' | 'always' | 'declined' | 'no-answer'`。
 */
export function readConsent(answer, texts) {
  if (!answer) return 'no-answer';
  const index = Number.isInteger(answer.index) ? answer.index : -1;
  if (index === 0) return 'yes';
  if (index === 1) return 'always';
  if (index >= 2) return 'declined';
  const typed = String(answer.text ?? '').trim();
  if (!typed) return 'no-answer';
  if (typed === texts.yes) return 'yes';
  if (typed === texts.always) return 'always';
  if (typed === texts.no) return 'declined';
  return 'no-answer';
}

/**
 * 用户答「以后都行」之后的新偏好：切成 `custom`，把这次的键连同
 * 当前已经允许的项一起记下来（上游 `setAlways` 同义）。
 *
 * @param prefs - 当前偏好。
 * @param keys - 这次问过的 patch 键。
 */
export function alwaysPatch(prefs, keys) {
  const direct = directMap(prefs);
  const custom = { ...direct };
  for (const key of keys) custom[PATCH_TO_SELF[key] ?? key] = true;
  return { selfAdjust: 'custom', selfAdjustCustom: custom };
}
