/**
 * 界面文案的多语言表。
 *
 * 只覆盖插件自己的固定文案（按钮、菜单、面板、状态词）。桌宠说的话由调用方
 * 给（Agent 的 pet_say、用户的输入），不在这里翻译。
 *
 * 语言取自偏好里的 lang：auto（默认）跟随浏览器语言，其余为显式选择。
 * 文案函数每次调用都重新解析一次偏好——设置面板改完立刻重挂桌宠，
 * 但模块本身是缓存的，只有每次取值才拿得到新语言。
 *
 * 为什么不用 DSH 的 locale 服务：探针实测（dsh 0.2.0-rc.2）显示客户端插件的
 * apply 运行时拿不到 locale，只有 slots/connection/loader/modules。
 */

const PREFS_KEY = 'dsh-coopanion-pet:prefs';

/** 支持的语言。新增一门语言只要往 DICT 里加一列。 */
export const LANGS = ['zh', 'en'];

const DICT = {
  zh: {
    'lang.auto': '自动',

    'size.0': '小',
    'size.1': '中',
    'size.2': '大',
    'roam.0': '安静',
    'roam.1': '随意',
    'roam.2': '活跃',
    'fps.0': '省电',
    'fps.1': '平衡',
    'fps.2': '流畅',

    'tool.say': '让她说句话',
    'tool.face': '换个表情',
    'tool.act': '做个动作',
    'tool.walk': '走两步',
    'tool.dress': '装扮',
    'tool.sleep': '睡觉 / 叫醒',
    'tool.bar': '桌宠操作',

    'menu.dress': '装扮…',
    'menu.statusOn': '开启状态气泡',
    'menu.statusOff': '关闭状态气泡',
    'menu.soundOn': '开启音效',
    'menu.soundOff': '关闭音效',
    'menu.size': '体型：{v}',
    'menu.roam': '漫游：{v}',
    'menu.fps': '帧率：{v}',
    'menu.trailOn': '开启走路足迹',
    'menu.trailOff': '关闭走路足迹',
    'menu.home': '回到原位',
    'menu.hide': '隐藏桌宠',

    'dress.title': '装扮',
    'dress.close': '关闭',
    'dress.scheme': '配色',
    'dress.outfit': '服装',
    'dress.busy': '正在换装…',
    'dress.aria': '装扮',
    'dress.schemeAria': '配色：{name}',
    'outfit.maid': '女仆装',
    'outfit.cape': '冬装',

    'status.read': '正在看文件',
    'status.write': '正在写文件',
    'status.search': '正在查找',
    'status.run': '正在跑命令',
    'status.work': '正在忙',
    'status.wait': '正在等你',
    'status.listen': '正在听',
    'status.speak': '正在朗读',
    'status.screen': '正在看屏幕',
    'status.control': '正在操作电脑',
    'status.aria': '正在工作',

    'settings.intro': '一只住在界面下沿的桌宠。形象与动画来自 Coopanion。',
    'settings.enabled': '显示桌宠',
    'settings.enabledHint': '关掉后页面里不再出现她',
    'settings.statusBubble': '状态气泡',
    'settings.statusBubbleHint': '她头顶显示「正在看文件」「正在跑命令」',
    'settings.sound': '音效',
    'settings.soundHint': '全部为合成音，不含音频素材',
    'settings.trail': '走路足迹',
    'settings.trailHint': '她走动时身后留一串渐隐的点',
    'settings.fps': '帧率',
    'settings.fpsHint': '省电档静止 12fps、活动 30fps；平衡静止 24fps；流畅跟随屏幕',
    'settings.size': '体型',
    'settings.roam': '漫游',
    'settings.lang': '语言',
    'settings.langHint': '改完立即重挂桌宠',

    'bubble.own': '说点别的…',
    'bubble.send': '发送',

    'pet.line1': '我在这儿呢。',
    'pet.line2': '需要我帮你看点什么吗？',
    'pet.line3': '这会儿挺安静的。',
    'pet.line4': '你忙你的，我不打扰。',
    'pet.line5': '要不要休息一下？',
    'pet.bye': '那我先躲起来，下次见。',
  },
  en: {
    'lang.auto': 'Auto',

    'size.0': 'Small',
    'size.1': 'Medium',
    'size.2': 'Large',
    'roam.0': 'Calm',
    'roam.1': 'Free',
    'roam.2': 'Busy',
    'fps.0': 'Eco',
    'fps.1': 'Balanced',
    'fps.2': 'Smooth',

    'tool.say': 'Say something',
    'tool.face': 'Change expression',
    'tool.act': 'Do a move',
    'tool.walk': 'Walk a bit',
    'tool.dress': 'Dress up',
    'tool.sleep': 'Sleep / wake',
    'tool.bar': 'Pet actions',

    'menu.dress': 'Dress up…',
    'menu.statusOn': 'Show status bubble',
    'menu.statusOff': 'Hide status bubble',
    'menu.soundOn': 'Turn sound on',
    'menu.soundOff': 'Turn sound off',
    'menu.size': 'Size: {v}',
    'menu.roam': 'Roaming: {v}',
    'menu.fps': 'Frame rate: {v}',
    'menu.trailOn': 'Show walk trail',
    'menu.trailOff': 'Hide walk trail',
    'menu.home': 'Back to start',
    'menu.hide': 'Hide the pet',

    'dress.title': 'Dress up',
    'dress.close': 'Close',
    'dress.scheme': 'Colours',
    'dress.outfit': 'Outfit',
    'dress.busy': 'Changing…',
    'dress.aria': 'Dress up',
    'dress.schemeAria': 'Colours: {name}',
    'outfit.maid': 'Maid',
    'outfit.cape': 'Winter cape',

    'status.read': 'Reading a file',
    'status.write': 'Writing a file',
    'status.search': 'Searching',
    'status.run': 'Running a command',
    'status.work': 'Working',
    'status.wait': 'Waiting for you',
    'status.listen': 'Listening',
    'status.speak': 'Reading out loud',
    'status.screen': 'Looking at the screen',
    'status.control': 'Operating the computer',
    'status.aria': 'Working',

    'settings.intro': 'A desktop pet living on the bottom edge. Artwork and animation from Coopanion.',
    'settings.enabled': 'Show the pet',
    'settings.enabledHint': 'Off hides her from the page',
    'settings.statusBubble': 'Status bubble',
    'settings.statusBubbleHint': 'Shows \u201cReading a file\u201d, \u201cRunning a command\u201d above her head',
    'settings.sound': 'Sound',
    'settings.soundHint': 'All synthesised, no audio assets',
    'settings.trail': 'Walk trail',
    'settings.trailHint': 'Leaves fading dots behind her while she walks',
    'settings.fps': 'Frame rate',
    'settings.fpsHint': 'Eco: 12fps idle, 30fps active; Balanced: 24fps idle; Smooth: follows the screen',
    'settings.size': 'Size',
    'settings.roam': 'Roaming',
    'settings.lang': 'Language',
    'settings.langHint': 'Takes effect at once, she is remounted',

    'bubble.own': 'Say something else…',
    'bubble.send': 'Send',

    'pet.line1': 'I am right here.',
    'pet.line2': 'Want me to take a look at something?',
    'pet.line3': 'It is quiet right now.',
    'pet.line4': 'Go ahead, I will stay out of the way.',
    'pet.line5': 'How about a break?',
    'pet.bye': 'I will hide for now, see you next time.',
  },
};

/** 偏好里的 lang 解析成实际语言。 */
function resolve(pref) {
  if (LANGS.includes(pref)) return pref;
  let tags = [];
  try { tags = navigator.languages ?? [navigator.language ?? '']; } catch (error) { tags = []; }
  for (const tag of tags) {
    if (/^zh\b|^zh-/i.test(tag)) return 'zh';
    if (/^en\b|^en-/i.test(tag)) return 'en';
  }
  // 其余语言先落到英文：DICT 里只有 zh/en 两列
  return 'en';
}

/** 上一次解析用的原始偏好串，用来判断要不要重新解析（一次 localStorage 读很便宜）。 */
let memoRaw = null;
let memoLang = 'zh';

/** 当前该用的语言。 */
export function currentLang() {
  let raw = '';
  try { raw = window.localStorage.getItem(PREFS_KEY) ?? ''; } catch (error) { raw = ''; }
  if (raw !== memoRaw) {
    memoRaw = raw;
    let pref = 'auto';
    try { pref = JSON.parse(raw)?.lang ?? 'auto'; } catch (error) { pref = 'auto'; }
    memoLang = resolve(pref);
  }
  return memoLang;
}

/**
 * 取一条文案。vars 里的 {name} 会被替换。
 * 语言表里没有的键返回键本身——方便一眼看出漏翻的地方。
 */
export function t(key, vars) {
  const table = DICT[currentLang()] ?? DICT.zh;
  const text = table[key] ?? DICT.zh[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])));
}

/** 体型/漫游/帧率档位的文案。 */
export const sizeLabel = (i) => t(`size.${i}`);
export const roamLabel = (i) => t(`roam.${i}`);
export const fpsLabel = (i) => t(`fps.${i}`);
