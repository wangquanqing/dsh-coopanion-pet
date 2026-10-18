/**
 * dsh-coopanion-pet —— 客户端半边：把 Coopanion 的桌宠画进 DSH 界面的覆盖层，
 * 并给她气泡、声音与可点的操作界面。
 *
 * 桌宠本体是 Coopanion 的渲染内核（assets/kit：Live2D 式 WebGL sprite rig）加鲸鱼娘形象包
 * （assets/whale：25 张身体部件纹理 + 25 张表情贴图 + model.json）。这些都是自包含的 ES 模块
 * 与静态资源，原样复制、未作修改；本文件负责把它们挂进页面并驱动。
 *
 * 四条设计约束：
 *
 * - 不挡界面。覆盖层与其中所有元素都是 pointer-events:none，永远不是事件目标。指针处理挂在
 *   window 的捕获阶段，用桌宠的命中圆按坐标判定：只有光标真的落在她身上、或落在她自己弹出的
 *   按钮条与气泡上时才拦下事件，其余每一次移动和点击都原样放行给下面的界面。
 *
 * - 不污染主题。渲染内核的 set({theme}) 会写 html 的 data-theme，与 DSH 自己的主题机制
 *   （body[data-ds-dark-theme]）冲突，因此不调用它；配色由内核 CSS 与气泡 CSS 各自跟随
 *   prefers-color-scheme 与 DSH 的主题令牌。
 *
 * - 失败即静默。资源或 WebGL 不可用时只留一行控制台告警，页面无残留。
 *
 * - 声音要用户手势才响。浏览器的自动播放策略如此，因此在第一次 pointerdown 时解锁音频。
 *
 * 资源路径 BASE 必须与 index.js 的 ROUTE 一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-coopanion-pet',
  factory: (require) => {
    const React = require('react');

    /** 资源路径，与 index.js 的 ROUTE 保持一致。 */
    const ASSETS = '/api/dsh-coopanion-pet/assets/';
    /**
     * 形象包用 `new URL(相对路径, base)` 解析纹理，base 必须是绝对 URL，
     * 因此按 location 展开一次，而不是直接把路径传进去。
     */
    const ABS = new URL(ASSETS, location.href).href;

    const STYLE_ATTR = 'data-dsh-coopanion-pet';
    const PREFS_KEY = 'dsh-coopanion-pet:prefs';
    /** 状态事件流，与 index.js 的 EVENTS 保持一致。 */
    const EVENTS = '/api/dsh-coopanion-pet/events';
    /** 回传地址，与 index.js 的 REPORT 保持一致。 */
    const REPORT = '/api/dsh-coopanion-pet/report';
    /** 语音识别端点，与 index.js 的 SPEECH 保持一致（可选）。 */
    const SPEECH = '/api/dsh-coopanion-pet/speech';
    /** 语音合成端点，与 index.js 的 TTS 保持一致（可选）。 */
    const TTS = '/api/dsh-coopanion-pet/tts';
    /** 站立地面与窗口底边的距离。 */
    const FLOOR_GAP = 8;

    /**
     * 34：纯净模式。URL 的 **hash** 上带 `cpn-clean` 后，隐藏按钮条、右键菜单
     * 与气泡，只留她本体——方便 OBS/录屏抓画面。
     *
     * **为什么用 hash 而不是查询串**：实测（dsh 0.2.0-rc.2）DSH 在页面脚本执行的
     * 最早期就把 `location.search` 清空了（token 被挪走），因此 `?cpn-clean=1`
     * 根本读不到。hash 不参与服务端处理，会原样留到页面里。
     *
     * 用法：`<页面地址>#cpn-clean`（值随意，只看键在不在）。
     */
    const CLEAN = (() => {
      try {
        return /(?:^|[#&])cpn-clean(?:[=&]|$)/.test(location.hash ?? '');
      } catch (error) {
        return false;
      }
    })();

    /**
     * 体型。内核的标准值是 0.42（1 倍），这里以它为基准做倍率。
     *
     * `scale` 是**唯一真相**（连续值 0.5–10，65）；`sizeIndex` 只是右键菜单的
     * 三档快捷方式，写它的时候同时把 `scale` 设成对应倍率——两者不会互相打架。
     * 上游正是这么分的（`window.scale` 连续 + 面板三档）。
     */
    const SIZES = [0.30, 0.38, 0.48];
    /** 三档快捷方式对应的 scale 倍率。 */
    const SIZE_SCALES = [0.30 / 0.38, 1, 0.48 / 0.38];

    /**
     * 66：`selfAdjust: 'default'` 时，哪些项她可以**直接**改（其余要先问）。
     *
     * 与上游 `SELF_DEFAULT` 一致：外观与习惯可直接改；
     * 影响用户的屏幕、耳朵与称呼的，要先问。
     */
    const DEFAULT_SELF_DIRECT = ['scheme', 'roam', 'snoreSeconds', 'figure'];

    /** 62：悬停按钮条上可以放哪些动作（与 ui.js 的 BUTTONS 对应）。 */
    const HOVER_IDS = ['say', 'face', 'act', 'walk', 'dress', 'sleep'];

    /** 64：四种触摸（与内核 onEvent('touch') 的 kind 对应）。 */
    const TOUCH_KINDS = ['poke', 'pet', 'throw', 'drop'];
    /** scale 倍率 → 内核要的系数。 */
    const scaleToUnit = (s) => 0.38 * (Number.isFinite(s) && s > 0 ? s : 1);
    const ROAMS = ['calm', 'free', 'busy'];

    /**
     * 帧率档位。0 省电 / 1 平衡 / 2 流畅。
     *
     * `active` 是活动时（走动、说话、拖拽）的帧率上限，`rest` 是静止时的。
     * 0 表示跟随屏幕刷新率。静止时的动画（呼吸、眨眼、头发弹簧）本来就慢，
     * 降帧看不出来，但省下大半 CPU；活动时按屏幕刷新率画，动作才不顿。
     */
    const FPS = [
      { active: 30, rest: 12 },
      { active: 0, rest: 24 },
      { active: 0, rest: 0 },
    ];

    /** 可用的表情与动作，取自渲染内核的词表；菜单与命令行都用它。 */
    const FACES = ['neutral', 'happy', 'wink', 'love', 'shy', 'surprised', 'angry', 'sad', 'sleepy',
      'thinking', 'smug', 'pout', 'worried', 'determined', 'flustered', 'scared', 'excited', 'cry', 'confused'];
    const ACTS = ['wave', 'bow', 'jump', 'hop', 'nod', 'shake', 'spin', 'dance', 'shiver', 'flap', 'look', 'sit'];

    const DEFAULT_PREFS = {
      enabled: true,
      sizeIndex: 1,
      roamIndex: 0,
      sound: true,
      startShare: 0.78,
      scheme: 'deepseek-maid',
      statusBubble: true,
      lang: 'auto',
      trail: true,
      fpsIndex: 1,
      // 56 她怎么称呼你。空 = 不称呼（台词里不带名字）。
      user: '',
      // 57 六类声音各自的开关；58 入睡多少秒后停鼾声（0 = 一直响）
      sounds: { move: true, touch: true, face: true, snore: true, talk: true, ui: true },
      snoreSeconds: 0,
      // 59/60 气泡框与文字大小（1 = 默认）
      bubbleSize: 1,
      fontSize: 1,
      // 61 主题：auto 跟随 DSH / light / dark
      theme: 'auto',
      // 35 光晕强度（0 = 关）。上游是采样屏幕算的，这里是 CSS 近似。
      glow: 7,
      // 62 悬停按钮条上显示哪几个（最多 6 个）
      hoverButtons: ['say', 'face', 'act', 'walk', 'dress', 'sleep'],
      // 63 双击她打开一个输入框，回车发给会话
      doubleClickChat: false,
      // 64 哪些触摸唤醒她：poke 只戳 / all 全部 / none 都不 / custom 看 wakeKinds
      touchWake: 'poke',
      wakeKinds: ['poke'],
      // 65 体型倍率（0.5–10，1 = 标准）
      scale: 1,
      // 53 选定的麦克风设备 id（空 = 系统默认）
      micDevice: '',
      // 40 是否显示对话栈
      linesBubble: true,
      // 66 她自己能改什么：self 直接改 / ask 先问。默认照搬上游分级。
      selfAdjust: 'default',
      selfAdjustCustom: {
        figure: true, scheme: true, roam: true, snoreSeconds: true, sound: false,
        scale: false, bubbleSize: false, fontSize: false, theme: false,
        hoverButtons: false, user: false,
      },
    };

    const CSS = `
.cpn-pet-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.cpn-pet-layer svg.kit,.cpn-pet-layer canvas{pointer-events:none}
`;

    /* ---------- 偏好 ---------- */

    function readPrefs() {
      const out = { ...DEFAULT_PREFS };
      try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (raw !== null) Object.assign(out, JSON.parse(raw));
      } catch (error) {
        /* 偏好读不出来就用默认值。 */
      }
      return out;
    }

    /**
     * 55：输入桥**必须是模块级单例**。
     *
     * 它在两个地方被用到：`apply` 里注册进 `conversation.input.activity` 槽，
     * `startPet` 里用它填输入框。第一版两边各建了一个实例，于是
     * 「注册进槽的那个」与「用来填的那个」不是同一个对象——槽里的组件把
     * `inputActions` 存进 A，而填的时候读 B，永远拿不到。
     */
    let inputBridgeSingleton = null;

    /**
     * 需要重挂桌宠才能生效的偏好，拼成一个字符串。
     *
     * - `lang`：界面文案在模块加载时定下，只重画面板不够。
     * - `enabled`：关掉后整层要收掉，打开后要重新挂上；设置面板承诺「改完立刻生效」。
     *
     * 这里不解析具体语言（那是 i18n.js 的事），只比较偏好值本身；浏览器语言在
     * 运行期不会变，因此 `auto` 不会误触发重挂。
     */
    function readMountKey() {
      let stored = null;
      try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        stored = raw === null ? null : JSON.parse(raw);
      } catch (error) {
        stored = null;
      }
      const lang = stored?.lang ?? 'auto';
      const enabled = stored?.enabled !== false;
      return `${lang}|${enabled}`;
    }

    function writePrefs(patch) {
      const next = { ...readPrefs(), ...patch };
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch (error) {
        /* 存不下就算了，本次会话内仍然生效。 */
      }
      return next;
    }

    /* ---------- 桌宠 ---------- */

    /** 加载渲染内核、形象包、气泡、音效与操作界面，接指针，驱动帧循环。 */
    async function startPet(initialPrefs) {
      const prefs = { ...initialPrefs };

      /**
       * 从 `localStorage` 同步设置面板改过的偏好。
       *
       * 设置面板与桌宠各持一份偏好：面板写 `localStorage`，桌宠读自己的副本。
       * 每帧读 `localStorage` 太浪费，因此只在值真的变了时同步，
       * 且只同步面板能改的那几项。`apply` 里的引用都是调用时才解析，
       * 因此这个函数可以定义在它们之前。
       */
      const SYNCED = ['sizeIndex', 'roamIndex', 'sound', 'statusBubble', 'scheme', 'trail', 'fpsIndex',
        'user', 'sounds', 'snoreSeconds', 'bubbleSize', 'fontSize', 'theme', 'glow',
        'hoverButtons', 'doubleClickChat', 'touchWake', 'wakeKinds', 'scale', 'selfAdjust', 'selfAdjustCustom',
        // 43：形象也要同步——但它是「重建 body」级的改动，见下面的分支
        'figure', 'linesBubble'];
      let lastPrefsRaw = '';
      const syncPrefs = () => {
        let raw;
        try { raw = window.localStorage.getItem(PREFS_KEY) ?? ''; } catch (error) { return; }
        if (raw === lastPrefsRaw) return;
        lastPrefsRaw = raw;
        let stored;
        try { stored = JSON.parse(raw); } catch (error) { return; }
        if (!stored || typeof stored !== 'object') return;
        for (const key of SYNCED) {
          if (stored[key] === undefined || stored[key] === prefs[key]) continue;
          /**
           * **先记住旧值再写**：`figure` 分支要拿「从哪个形象换到哪个」，
           * 而 `switchFigure` 的比较基准就是 `prefs.figure` 本身。
           * 若先赋值再传新值，它会认为「已经是这个形象了」而直接返回 false
           * ——设置面板换形象就永远不生效（实测确认过的 bug）。
           */
          const prevValue = prefs[key];
          prefs[key] = stored[key];
          // 安静期间不要被偏好同步把声音打开
          if (key === 'sound') { if (!isQuiet()) sfx.set(prefs.sound); }
          else if (key === 'sizeIndex') { body.set({ bounds: viewport() }); body.resize(); }
          else if (key === 'scale') { body.set({ bounds: viewport() }); body.resize(); }
          else if (key === 'roamIndex') body.set({ roam: ROAMS[prefs.roamIndex] ?? 'calm' });
          else if (key === 'scheme') Promise.resolve(body.setScheme?.(prefs.scheme)).catch(() => {});
          else if (key === 'sounds' || key === 'snoreSeconds') applySound();
          else if (key === 'bubbleSize' || key === 'fontSize' || key === 'theme' || key === 'glow') applyLook();
          // 62：悬停按钮的集合变了，要重建按钮条（否则它还是老的）
          else if (key === 'hoverButtons') tools?.rebuild?.();
          /**
           * 43：形象变了要重建 body。
           *
           * 这里**不调 runCommand**——`runCommand` 在下面才声明，而这个回调可能
           * 先于它执行（`syncPrefs` 在帧循环里调用，而帧循环在 startPet 末尾才启动，
           * 但依赖声明顺序容易出错）。直接调 `switchFigure` 更稳。
           */
          else if (key === 'figure') {
            // 用上面记下的旧值作起点：switchFigure 会自己把 prefs.figure 改成新的
            prefs.figure = prevValue;
            switchFigure(stored[key]).catch(() => {});
          }
        }
      };

      const [kit, whale, { createSfx }, { createBubble }, { createTools, TOOLS_CSS },
        { BUBBLE_CSS }, { createStatus, STATUS_CSS }, { createDress, DRESS_CSS },
        { createTrail, TRAIL_CSS }, { createVoice, filterHallucination, toSimplified, splitSentences, joinSpeech },
        { createVoiceUi }, { createInputBridge }, { registerSpeakShortcut },
        { createLines, LINES_CSS }, { createPackBody }, { t }] = await Promise.all([
        import(`${ABS}kit/body.js`),
        import(`${ABS}whale/figure.js`),
        import(`${ABS}sfx.js`),
        import(`${ABS}bubble.js`),
        import(`${ABS}ui.js`),
        import(`${ABS}bubble.css.js`),
        import(`${ABS}status.js`),
        import(`${ABS}dress.js`),
        import(`${ABS}trail.js`),
        import(`${ABS}voice.js`),
        import(`${ABS}voice-ui.js`),
        import(`${ABS}input-bridge.js`),
        import(`${ABS}hotkey.js`),
        import(`${ABS}lines.js`),
        import(`${ABS}pack-body.js`),
        import(`${ABS}i18n.js`),
      ]);

      /**
       * 气泡、按钮条、状态与装扮面板的样式随桌宠一起挂载、一起卸载，
       * 避免污染宿主的样式表。
       *
       * **先建好、最后再挂**：`createWhaleFigure` 与后面的 `makeBody`
       * 都可能抛错（纹理缺失、WebGL 不可用）。若这里先挂上去，那两次
       * 失败会让整个 `startPet` reject，而失败路径只打一句警告、没有任何
       * 清理，于是这个 `<style>` 永久留在 head——每重挂一次再加一个
       * （实测确认过的泄漏）。
       */
      const style = document.createElement('style');
      style.setAttribute(STYLE_ATTR, 'parts');
      style.textContent = BUBBLE_CSS + TOOLS_CSS + STATUS_CSS + DRESS_CSS + TRAIL_CSS + LINES_CSS;

      // 形象包内部按 base 解析纹理与 model.json，必须传它自己的目录（绝对 URL）。
      const figure = await whale.createWhaleFigure(`${ABS}whale/`, {
        kit: { createRig: kit.createRig },
      });

      /**
       * 43：第二个内置形象 Coo。
       *
       * **按需加载**：Coo 是纯代码绘制（SVG path，无纹理，三个文件共 49KB），
       * 因此只在真的切过去时才 import——默认用鲸鱼娘的人不必为它付加载时间。
       *
       * 两者共用同一套渲染内核（`assets/kit/`）：Coo 的 `coo.js` 从
       * `../kit/body.js` 取 `DROP`/`FACES`/`LEG_W`/`STAND`/`f`/`heartD`
       * （已核对：这些导出本插件都有）。
       */
      let cooBodyFactory = null;
      const loadCooFactory = async () => {
        cooBodyFactory ??= await import(`${ABS}coo/figure.js`);
        return cooBodyFactory;
      };

      const root = document.createElement('div');
      root.className = 'cpn-pet-layer';

      /** 气泡挂在 root 之外：它用 fixed 定位，不该被覆盖层的层叠上下文限制。 */
      const bubbleEl = document.createElement('div');
      bubbleEl.className = 'cpn-bubble';
      bubbleEl.hidden = true;
      bubbleEl.setAttribute('role', 'status');
      bubbleEl.setAttribute('aria-live', 'polite');

      const sfx = createSfx();
      sfx.set(prefs.sound);

      /**
       * 57/58：六类声音各自的开关，以及入睡多久后停鼾声。
       *
       * sfx.js 本来就支持（`configure({ kinds, snoreSeconds })`），只是以前没接出来。
       */
      const applySound = () => {
        const kinds = prefs.sounds && typeof prefs.sounds === 'object' ? prefs.sounds : {};
        sfx.configure({
          kinds,
          snoreSeconds: Number.isFinite(prefs.snoreSeconds) ? Math.max(0, prefs.snoreSeconds) : 0,
        });
      };

      const viewport = () => ({
        W: window.innerWidth,
        H: window.innerHeight,
        floorY: window.innerHeight - FLOOR_GAP,
        // 65：体型以 scale 为准；sizeIndex 只是三档快捷，已在写偏好时同步进 scale
        S: scaleToUnit(prefs.scale ?? SIZE_SCALES[prefs.sizeIndex ?? 1]),
      });

      /** 最近一帧的布局，供指针判定与摆放读取。 */
      let layout = null;

      /* ---------- 位置记忆 ----------
         下次打开页面时她回到上次站的地方。存的是占窗口宽度的比例，
         这样换窗口大小也不会跑到屏幕外。拖拽、走动都会更新它。 */
      const readPos = () => {
        try {
          const raw = window.localStorage.getItem(`${PREFS_KEY}:x`);
          const n = raw === null ? NaN : Number(raw);
          return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
        } catch (error) {
          return null;
        }
      };

      /** 她该从哪儿开始：上次的位置，没有就用默认比例。 */
      const startX = () => {
        const saved = readPos();
        const share = saved ?? prefs.startShare;
        return Math.max(0, Math.min(window.innerWidth * share, window.innerWidth));
      };

      /** 把当前位置记下来。只在真的停了的时候写，避免走动时高频写盘。 */
      const rememberPos = () => {
        if (!layout) return;
        const share = Math.max(0, Math.min(layout.x / Math.max(1, window.innerWidth), 1));
        try { window.localStorage.setItem(`${PREFS_KEY}:x`, String(Math.round(share * 1000) / 1000)); } catch (error) { /* 存不下就算了 */ }
      };

      /**
       * 一段字节 → base64。
       *
       * 不用 `String.fromCharCode(...bytes)`：15 秒的录音有 48 万个字节，
       * 展开成参数会爆栈。分块转换，每块 0x8000 个字节。
       */
      function base64Of(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      }

      /** 往宿主回一条消息；失败只吞掉，不打扰用户。 */
      /**
       * 往宿主回一条消息。
       *
       * 不用 `keepalive`：桌宠的状态上报是高频的，浏览器在同一个 keepalive
       * 请求还没落地时再次发起，会把前一个取消掉（表现为 ERR_ABORTED），
       * 于是每次上报都变成「一次成功 + 一次被取消」。
       * 页面卸载时丢一条状态无所谓，因此这里只要普通 fetch。
       *
       * `must` 为真时一定发出去（用户的回答不能丢），否则在途一条就跳过——
       * 状态上报是「最新值覆盖」的语义，排队没有意义。
       */
      let reportInFlight = false;
      /**
       * 上报一条给宿主。
       *
       * @param payload - 要发的帧。
       * @param must - 真则**绕过「同时只发一条」的节流**（回执之类不能等）。
       * @param onFail - 发送失败时调用。调用方用它回滚「已上报」的记账，
       *   否则那条状态会因为「已经发过了」而永远不再发（见 reportState）。
       * @returns 是否真的发出去了（被节流跳过时为 false）。
       */
      const report = (payload, must = false, onFail = null) => {
        if (reportInFlight && !must) return false;
        reportInFlight = true;
        try {
          fetch(REPORT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => { if (onFail) onFail(); }).finally(() => { reportInFlight = false; });
        } catch (error) {
          reportInFlight = false;
          if (onFail) onFail();
        }
        return true;
      };

      /** 最近问出去的那个问题，回答回传时一并发回去，好在会话里说清是在答什么。 */
      let lastQuestion = '';
      /**
       * 正在等回答的 CUA 权限确认。
       *
       * 与普通提问的区别：确认的回答**不送回会话**（那是插件之间的问答，
       * 不是用户给模型的话），只回给正在等的那个工具调用。
       */
      /**
       * CUA 权限确认的等待槽。**带代次**：宿主侧超时后这里也要清掉，
       * 否则用户回答别的提问会被误当成确认答案（见 confirm 分支的说明）。
       */
      let pendingConfirm = null;
      /** 确认的代次，每开一次加一。 */
      let confirmEpoch = 0;
      /** 本地清理定时器。 */
      let confirmTimer = null;
      /** 与宿主侧一致的确认超时。 */
      const CONFIRM_TIMEOUT_MS = 120000;

      // 34：纯净模式下气泡也不显示——由 deps 里的钩子拦住所有显示路径
      const bubble = createBubble({ bubble: bubbleEl }, {
        // 她说的每一句都先过这里；纯净模式下直接吞掉
        silent: CLEAN,
        sfx,
        onTalk: () => body.talk(),
        onAct: (actions) => { for (const a of actions) body.do(a); },
        onAnswer: (a) => {
          // 放弃（Esc）不算回答，不回传。
          if (!a || a.dismissed) return;
          // CUA 权限确认：只回给**还在等**的那个工具调用，不送回会话
          if (pendingConfirm) {
            const yes = a.index === 0 || String(a.text ?? a.label ?? '').trim() === '可以';
            const { resolve } = pendingConfirm;
            pendingConfirm = null;   // 答完就清，避免同一槽被复用
            resolve(yes ? 'yes' : 'no');
            return;
          }
          const text = a.text !== undefined ? String(a.text) : String(a.label ?? '');
          if (!text) return;
          // 63 双击输入框：这是用户主动对她说的话，问题上下文为空
          const viaChat = pendingChat;
          pendingChat = false;
          report({
            kind: 'answer',
            text,
            via: a.text !== undefined ? 'typed' : 'option',
            question: viaChat ? '' : lastQuestion,
          }, true);
          lastQuestion = '';
        },
      });

      // 对话优先：说话或提问时状态气泡让位，因此把 bubble 的忙碌当作判据。
      const status = createStatus({ el: bubbleEl }, { busy: () => bubble.busy });

      /**
       * 语音：录音（送去宿主识别）与播放（宿主合成的音频）。
       * 两条链路都是可选的——宿主没装对应插件时端点回 501，这里静默跳过。
       */
      const voice = createVoice({
        // 录音时让她的嘴跟着音量动（53 的波形反馈也用同一个电平）
        onLevel: (level) => {
          try { body.talk(); } catch (error) { /* 未就绪就算了 */ }
          if (level > 0.06) { voiceLevel = level; }
        },
        // 录音计时：显示「正在听 3.2s」
        onTick: ({ elapsed }) => {
          voiceElapsed = elapsed;
          if (voiceState === 'recording') paintVoice();
        },
      });

      /**
       * 55：把识别结果填进 DSH 输入框。
       *
       * **必须注册进 `conversation.input.activity` 槽**才拿得到 `inputActions`
       * （`shell.overlay` 的 props 是空接口）。注册在 apply 里做，见文件末尾。
       */
      inputBridgeSingleton ??= createInputBridge(React, {
        // 55 的降级路径：槽拿不到时（官方语音插件占了那个 single 槽），
        // 把识别文本作为一条用户消息送进会话。
        submitViaHost: (text) => {
          fetch(REPORT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'speech-submit', text }),
          }).catch(() => {});
        },
      });
      const inputBridge = inputBridgeSingleton;

      /**
       * 52：按住 Shift+Space 说话。松开就识别，识别到了直接填进输入框。
       *
       * 走页面内的 keydown/keyup——**DSH 的 shortcuts 服务只有 keydown，没有 keyup**，
       * 拿不到「松开」的时机。代价：只在 DSH 页面有焦点时生效。
       */
      const voiceUi = createVoiceUi({
        record: async () => {
          // 按住期间录到松手为止；上限 15 秒兜底
          const rec = await voice.record({ seconds: 15 });
          if (rec.error) return { error: rec.error, message: rec.message };
          // 送宿主识别
          let res;
          try {
            res = await fetch(SPEECH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ audioBase64: base64Of(rec.wav) }),
            });
          } catch (error) {
            return { error: 'unreachable', message: String(error?.message ?? error) };
          }
          let out = null;
          try { out = await res.json(); } catch (error) { out = null; }
          if (!res.ok || !out?.ok) {
            return { error: out?.reason ?? `http-${res.status}`, message: out?.message };
          }
          // 49 + 50：出口这一层做幻觉过滤与繁简归一
          const text = cleanSpeech(out.text);
          return { text };
        },
        stopRecord: () => voice.stop(),
        onState: (state) => voiceUiIndicator?.(state),
        insertText: (text) => inputBridge.insert(text),
      });

      /**
       * 录音状态的显示：她头顶一个小指示（正在听 / 识别中 + 计时 + 音量条）。
       *
       * 这是**替代原计划「假流式」的方案**：实测分片识别更慢更不准
       * （见 docs/risk-verification.md），而「录的时候看得见」才是真正缺的体验。
       */
      let voiceUiIndicator = null;

      /** 录音指示器的 DOM：她头顶一个小胶囊，显示「正在听 3.2s」+ 音量条。 */
      const voiceEl = document.createElement('div');
      voiceEl.className = 'cpn-voice';
      voiceEl.hidden = true;
      voiceEl.setAttribute('aria-hidden', 'true');
      voiceEl.innerHTML = '<i class="cpn-voice-dot"></i><span class="cpn-voice-text"></span><b class="cpn-voice-bar"></b>';
      const voiceTextEl = voiceEl.querySelector('.cpn-voice-text');
      const voiceBarEl = voiceEl.querySelector('.cpn-voice-bar');
      root.appendChild(voiceEl);

      /** 指示器的状态机：idle 隐藏，recording 显示计时+音量，transcribing 显示「识别中」。 */
      let voiceState = 'idle';
      let voiceLevel = 0;
      let voiceElapsed = 0;
      voiceUiIndicator = (state) => {
        voiceState = state;
        if (state === 'idle') {
          voiceEl.hidden = true;
          voiceLevel = 0;
        } else {
          voiceEl.hidden = false;
        }
        paintVoice();
      };

      function paintVoice() {
        if (voiceState === 'recording') {
          voiceTextEl.textContent = t('voice.listening', { s: voiceElapsed.toFixed(1) });
          voiceBarEl.hidden = false;
          voiceBarEl.style.setProperty('--cpn-voice-level', String(Math.min(1, voiceLevel)));
        } else if (voiceState === 'transcribing') {
          voiceTextEl.textContent = t('voice.transcribing');
          voiceBarEl.hidden = true;
        }
        // 摆在她头顶（与气泡同一个锚点）
        if (layout) {
          const anchor = layout.bubble ?? { x: layout.x, y: 0 };
          const w = voiceEl.offsetWidth || 120;
          voiceEl.style.left = `${Math.max(8, Math.min(anchor.x - w / 2, window.innerWidth - w - 8))}px`;
          voiceEl.style.top = `${Math.max(8, anchor.y - 34)}px`;
        }
      }

      /**
       * 49/50：识别结果的出口后处理。
       *
       * 顺序是刻意的：**先繁简归一，再幻觉过滤**——归一后的字才与幻觉名单对得上
       * （名单里有简体词，如「谢谢观看」）。
       */
      function cleanSpeech(raw) {
        const simplified = toSimplified(String(raw ?? ''));
        return filterHallucination(simplified);
      }

      /**
       * 走路轨迹点。锚点取她脚底正中：布局里的 x 是身体中心，
       * y 取包围盒底边，这样点正好落在她踩过的地方。
       */
      const trail = createTrail({
        anchor: () => {
          if (!layout) return null;
          const box = layout.box;
          const y = box ? box.y + box.h : window.innerHeight - FLOOR_GAP;
          return { x: layout.x, y };
        },
      });
      root.appendChild(trail.root);

      /**
       * 40：对话栈。数据来自宿主推来的 `lines` 帧（宿主订阅 DSH 的 `session/event`）。
       *
       * 锚点取她头顶：`layout.bubble` 就是内核给的头顶位置。
       */
      const lines = createLines({
        anchor: () => {
          if (!layout) return null;
          return { x: layout.x, y: (layout.bubble?.y ?? window.innerHeight) - 6, facing: layout.facing ?? 1 };
        },
        // aria-label 也走 i18n，别硬编码中文
        t,
      });
      root.appendChild(lines.root);

      /**
       * 66：她自己能改什么（上游的 `selfAdjust` 四级）。
       *
       * - `off`：什么都不许她自己改
       * - `default`：上游默认分级——外观与习惯（scheme/roam/snoreSeconds/figure）
       *   可直接改；影响你的屏幕、耳朵与称呼的（sound/scale/bubbleSize/fontSize/
       *   theme/hoverButtons/user）要先问
       * - `any`：都可以直接改
       * - `custom`：按 `selfAdjustCustom` 逐项定
       *
       * @returns `'self'`（可直接改）或 `'ask'`（要先问）
       */
      const selfTierOf = (key) => {
        const mode = ['off', 'default', 'any', 'custom'].includes(prefs.selfAdjust)
          ? prefs.selfAdjust
          : 'default';
        if (mode === 'off') return 'ask';
        if (mode === 'any') return 'self';
        const custom = prefs.selfAdjustCustom ?? {};
        if (mode === 'custom') {
          const v = custom[key];
          return typeof v === 'boolean' ? (v ? 'self' : 'ask') : 'ask';
        }
        // default：外观与习惯可直接改，其余要先问
        return DEFAULT_SELF_DIRECT.includes(key) ? 'self' : 'ask';
      };

      /**
       * 把 59/60/61/35 四项写进 CSS 变量与 data 属性。
       *
       * 为什么用 CSS 变量而不是逐处改内联样式：气泡与按钮条的样式都在样式表里，
       * 变量是唯一能一处改、处处生效的做法，也避免每帧重算。
       */
      const applyLook = () => {
        const clamp01 = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
        root.style.setProperty('--cpn-bubble-size', String(clamp01(prefs.bubbleSize, 0.8, 1.6, 1)));
        root.style.setProperty('--cpn-font-size', String(clamp01(prefs.fontSize, 0.8, 1.6, 1)));
        const glow = clamp01(prefs.glow, 0, 16, 0);
        root.style.setProperty('--cpn-glow', String(glow));
        root.dataset.cpnGlow = glow > 0 ? 'on' : 'off';
        // 气泡是 root 之外的兄弟元素，主题属性两边都要写
        const theme = ['auto', 'light', 'dark'].includes(prefs.theme) ? prefs.theme : 'auto';
        root.dataset.cpnTheme = theme;
        bubbleEl.dataset.cpnTheme = theme;
        // 气泡的框与字大小同样吃这两个变量（它在 root 之外，得单独设）
        bubbleEl.style.setProperty('--cpn-bubble-size', String(clamp01(prefs.bubbleSize, 0.8, 1.6, 1)));
        bubbleEl.style.setProperty('--cpn-font-size', String(clamp01(prefs.fontSize, 0.8, 1.6, 1)));
      };

      /** 装扮面板换装后要更新偏好，这里先占位，下面接上 body。 */
      let dress = null;

      let tools = null;

      /**
       * 64：内核把「她被戳了 / 被摸了 / 被拎了 / 被扔了」报到这里。
       *
       * `touchWake` 决定哪些触摸唤醒她（上游语义）：poke 只戳 / all 全部 /
       * none 都不 / custom 看 wakeKinds。唤醒＝她说一句随机台词。
       *
       * 注意：内核**自己**已经把视觉反馈做了（表情、摔晕），这里只加「回应」。
       *
       * 抽成独立函数是因为**形象可以换**（43）：换形象要重建 body，
       * 而重建时要用同一套 emit 与 sound。
       */
      const hostBase = () => ({
        root,
        bounds: viewport,
        emit: (kind, detail) => {
          if (kind !== 'touch' || !detail) return;
          // 注意：这里的变量叫 `touch` 而不是 `t`——`t` 是本模块的翻译函数，
          // 用 `const t = detail.kind` 会把它遮蔽掉，随后 `t(…)` 就会抛
          // 「t is not a function」，整个客户端模块都加载不了。
          const touch = detail.kind;
          const mode = prefs.touchWake ?? 'poke';
          const wakes = mode === 'all'
            ? true
            : mode === 'poke'
              ? touch === 'poke'
              : mode === 'custom'
                ? Array.isArray(prefs.wakeKinds) && prefs.wakeKinds.includes(touch)
                : false;
          if (!wakes) return;
          // 她正忙着说话/提问时不插话
          if (bubble.busy) return;
          const lines = [1, 2, 3, 4, 5].map((i) => t(`pet.line${i}`));
          const line = lines[Math.floor(Math.random() * lines.length)];
          // 56：有称呼就带上
          bubble.say(prefs.user ? `${prefs.user}，${line}` : line);
        },
        sound: (name, kind, ...args) => sfx.play(name, kind, ...args),
        start: { x: startX(), facing: -1, enter: 'drop' },
      });

      /** 第三方形象包的清单（宿主推来）。 */
      let installedPacks = [];
      // 不在 /api 下：沙箱要读包内素材，而它不带 cookie
      const PACK_LIST = '/dsh-coopanion-pet/packs';
      const refreshPacks = async () => {
        try {
          const res = await fetch(PACK_LIST);
          const body = await res.json();
          installedPacks = Array.isArray(body?.installed) ? body.installed : [];
        } catch (error) {
          installedPacks = [];
        }
        return installedPacks;
      };
      await refreshPacks();

      /**
       * 43：按当前形象建 body。三条路：
       *
       * - `whale`：内核直接收 `opts.figure`（sprite rig）；
       * - `coo`：走它自己的 `createCooBody`（它内部调 `kit.createBody`，
       *   并带自己的 CSS 与 skin 规范化），返回的就是一个完整 body；
       * - **第三方包**：跑在沙箱 frame 里（41），用 `createPackBody` 把它
       *   包装成与内核 body 同接口的适配器。
       *
       * **换形象必须重建 body**：三者的 CSS 与 skin 形态各不相同。
       */
      async function makeBody() {
        const id = prefs.figure || 'whale';
        const host = hostBase();
        if (id === 'coo') {
          const coo = await loadCooFactory();
          return coo.createCooBody(`${ABS}coo/`, {
            kit: { createBody: kit.createBody },
            host,
          });
        }
        // 内置之外就是第三方包
        if (id !== 'whale') {
          // **先刷新列表再找**：包是刚导入的话，内存里那份还是旧的
          let pack = installedPacks.find((p) => p.id === id);
          if (!pack) {
            await refreshPacks();
            pack = installedPacks.find((p) => p.id === id);
          }
          if (!pack) throw new Error(`没有这个形象包：${id}`);
          /**
           * **给沙箱的 URL 必须是绝对的。**
           *
           * 实测：opaque origin 里 `new URL('/relative')` 会抛 `Invalid URL`——
           * 那里没有可用的 base。因此用 location.origin 拼成绝对地址。
           *
           * 路径也不在 /api 下：沙箱是 opaque origin 不带 cookie，/api 会被鉴权拦下。
           */
          const origin = location.origin;
          return createPackBody({
            id: pack.id,
            frameUrl: `${origin}/dsh-coopanion-pet/frame`,
            entryUrl: `${origin}/dsh-coopanion-pet/packs/${pack.id}/__entry.js`,
            baseUrl: `${origin}/dsh-coopanion-pet/packs/${pack.id}/`,
            // 包可以用内核建身体（多数包都这么做）
            kitUrl: `${ABS}kit/body.js`,
            exportName: pack.export ?? '',
            vocab: pack.vocab ?? [],
            start: { x: startX(), facing: -1, enter: 'drop' },
          }, {
            root,
            bounds: () => viewport(),
            viewport,
            onEvent: (kind, detail) => {
              // 触摸事件走与内置形象同一条路（64 的唤醒判据）
              if (kind !== 'touch' || !detail) return;
              const touch = detail.kind;
              const mode = prefs.touchWake ?? 'poke';
              const wakes = mode === 'all' ? true
                : mode === 'poke' ? touch === 'poke'
                  : mode === 'custom' ? (Array.isArray(prefs.wakeKinds) && prefs.wakeKinds.includes(touch))
                    : false;
              if (!wakes || bubble.busy) return;
              const lines = [1, 2, 3, 4, 5].map((i) => t(`pet.line${i}`));
              const line = lines[Math.floor(Math.random() * lines.length)];
              bubble.say(prefs.user ? `${prefs.user}，${line}` : line);
            },
            onSound: (name, kind, ...args) => sfx.play(name, kind, ...args),
            onError: (error) => console.warn('[dsh-coopanion-pet] 形象包出错：', error),
          });
        }
        return kit.createBody(host, { figure, bounds: viewport, roam: ROAMS[prefs.roamIndex] ?? 'calm' });
      }

      /** 当前 body。形象切换时会换掉，因此用 `let`。 */
      let body = await makeBody();

      // 所有可能抛错的操作（形象加载、建 body）都过去了，现在才把样式挂上去。
      document.head.appendChild(style);

      /**
       * 43：换形象。**建新的、释放旧的**——不能只换 figure（Coo 的 CSS 与 skin 形态
       * 与鲸鱼娘不同，换 figure 会让样式对不上）。
       *
       * @param id - `'whale'` 或 `'coo'`。
       * @returns 是否真的换了。
       */
      /**
       * `switchFigure` 与 `makeBody` 都用**函数声明**而不是 `const`：
       * `syncPrefs`（定义在前面）会引用它们，而 `const` 的暂时性死区
       * 按执行顺序判定——用声明式可以彻底避免这类顺序陷阱。
       */
      async function switchFigure(id) {
        const want = String(id || 'whale');
        const now = prefs.figure || 'whale';
        if (want === now) return false;
        const prev = body;
        const prevPref = prefs.figure;
        prefs.figure = want;
        try {
          const next = await makeBody();
          body = next;
          writePrefs({ figure: want });
          // 释放旧的（它会释放自己的 WebGL 上下文与样式）
          try { prev.dispose?.(); } catch (error) { /* 释放失败不影响新的 */ }
          return true;
        } catch (error) {
          // 建不起来就退回原来的，并如实回报
          prefs.figure = prevPref;
          throw error;
        }
      }

      // 56-67 的初始应用：外观、声音、主题
      applyLook();
      applySound();
      // 53：恢复上次选定的麦克风
      if (prefs.micDevice) voice.setDevice(prefs.micDevice);

      // 恢复上次的装扮（形象包不认的取值会在内核里退回默认）
      if (prefs.scheme && prefs.scheme !== DEFAULT_PREFS.scheme) {
        Promise.resolve(body.setScheme?.(prefs.scheme)).catch((error) => {
          console.warn('[dsh-coopanion-pet] 恢复装扮失败：', error);
        });
      }

      dress = createDress({
        getScheme: () => prefs.scheme,
        setScheme: (id, opts) => Promise.resolve(body.setScheme(id, opts)),
        onPref: (k, v) => { prefs[k] = v; writePrefs({ [k]: v }); },
      });
      root.appendChild(dress.root);

      /* ---------- 操作界面 ---------- */

      const pick = (list) => list[Math.floor(Math.random() * list.length)];

      /** 对她下一道命令。按钮条与右键菜单都走这里。 */
      function command(id) {
        switch (id) {
          case 'say': {
            // 文案每次现取：语言可能在设置面板里刚改过
            const lines = [1, 2, 3, 4, 5].map((i) => t(`pet.line${i}`));
            const line = pick(lines);
            // 56：有称呼就带上
            bubble.say(prefs.user ? `${prefs.user}，${line}` : line);
            break;
          }
          case 'face': {
            const face = pick(FACES);
            body.do(face);
            sfx.select();
            break;
          }
          case 'act': {
            const act = pick(ACTS);
            body.do(act);
            sfx.select();
            break;
          }
          case 'walk': {
            const x = Math.random() < 0.5
              ? window.innerWidth * (0.1 + Math.random() * 0.25)
              : window.innerWidth * (0.6 + Math.random() * 0.3);
            body.walk(x, Math.random() < 0.3);
            break;
          }
          case 'sleep': {
            if (layout?.mode === 'sleep') body.do('stand');
            else body.do('sleep');
            break;
          }
          case 'sound': {
            const next = !prefs.sound;
            prefs.sound = next;
            sfx.set(next);
            writePrefs({ sound: next });
            break;
          }
          case 'size': {
            prefs.sizeIndex = ((prefs.sizeIndex ?? 1) + 1) % SIZES.length;
            // 同步 scale：三档快捷改的就是体型本身，两者必须一致
            prefs.scale = SIZE_SCALES[prefs.sizeIndex];
            writePrefs({ sizeIndex: prefs.sizeIndex, scale: prefs.scale });
            body.set({ bounds: viewport() });
            body.resize();
            break;
          }
          case 'roam': {
            prefs.roamIndex = ((prefs.roamIndex ?? 0) + 1) % ROAMS.length;
            writePrefs({ roamIndex: prefs.roamIndex });
            body.set({ roam: ROAMS[prefs.roamIndex] });
            break;
          }
          case 'home': {
            body.place(startX(), -1);
            break;
          }
          case 'dress': {
            if (dress.visible) dress.hide();
            else dress.show(layout?.bubble ?? { x: layout?.x ?? 0, y: 0 }, prefs.dressPos);
            break;
          }
          case 'status': {
            prefs.statusBubble = !prefs.statusBubble;
            writePrefs({ statusBubble: prefs.statusBubble });
            if (!prefs.statusBubble) status.yield();
            break;
          }
          case 'trail': {
            prefs.trail = prefs.trail === false;
            writePrefs({ trail: prefs.trail });
            if (!prefs.trail) trail.clear();
            break;
          }
          case 'fps': {
            prefs.fpsIndex = ((prefs.fpsIndex ?? 1) + 1) % FPS.length;
            writePrefs({ fpsIndex: prefs.fpsIndex });
            break;
          }
          case 'hide': {
            bubble.say(t('pet.bye'));
            // 等她把话说完再落盘：显示开关一变，整层会被重挂（见 readMountKey），
            // 当场写就会把告别话切掉。
            setTimeout(() => {
              if (stopped) return;
              root.style.visibility = 'hidden';
              writePrefs({ enabled: false });
            }, 1600);
            break;
          }
          default: break;
        }
      }

      tools = createTools({ root }, {
        onCommand: command,
        onPref: (k, v) => writePrefs({ [k]: v }),
        getPref: (k) => prefs[k],
      });
      // 34：纯净模式下按钮条与菜单都不出现（元素还在，但永不显示）
      if (CLEAN) {
        tools.root?.querySelectorAll?.('.cpn-tools, .cpn-menu')?.forEach?.((el) => { el.hidden = true; });
      }
      root.appendChild(bubbleEl);

      /* ---------- 安静 ----------
         临时关掉声音、漫游与状态气泡，到时自动恢复。
         刻意不动用户的偏好（localStorage）：安静是一次性的，用户没要求改设置。 */
      /** 安静到什么时候（毫秒时间戳），0 表示没在安静。 */
      let quietUntil = 0;
      /** 安静前的音效状态，恢复时还原。 */
      let soundBeforeQuiet = null;

      const setQuiet = (ms) => {
        const now = Date.now();
        if (!ms) {
          // 立刻结束
          if (quietUntil) {
            quietUntil = 0;
            body.set({ hold: 0 });
            if (soundBeforeQuiet !== null) { prefs.sound = soundBeforeQuiet; sfx.set(soundBeforeQuiet); soundBeforeQuiet = null; }
          }
          return;
        }
        if (!quietUntil) soundBeforeQuiet = prefs.sound;
        quietUntil = now + ms;
        prefs.sound = false;
        sfx.set(false);
        // hold 的单位是秒；多给 1 秒，由 settle 负责在到点时精确结束
        body.set({ hold: Math.ceil(ms / 1000) + 1 });
      };

      /** 到点就恢复。每帧调一次，成本可忽略。 */
      const settleQuiet = () => {
        if (quietUntil && Date.now() >= quietUntil) setQuiet(0);
      };

      const isQuiet = () => quietUntil > 0;

      /* ---------- 帧循环 ---------- */

      let raf = 0, last = performance.now(), stopped = false;
      /** 帧计数，用来降低状态上报的频度。 */
      let tick = 0;
      /** 最近一帧的命中圆，供指针判定读取。 */
      let hits = [];

      /**
       * 按钮条要现在显示吗。
       *
       * 判定不能只看「这一帧光标在不在她身上」：鼠标移向按钮条的途中会短暂
       * 落在两者之间，若当场收起，按钮条永远够不到。因此：
       * - 光标在她身上、或在按钮条的可见框/桥接带里 → 立刻显示；
       * - 刚离开时给 `HIDE_GRACE` 毫秒的宽限，期间仍然显示；
       * - 拖动她、她在飞行、或右键菜单开着时让位。
       */
      const HIDE_GRACE = 700;
      let showUntil = 0;

      /** 光标是否停在她身上，或停在她自己的按钮条上。 */
      let hovering = false;
      /** 是否正在拖她。帧循环用它判断活动状态以决定帧率。 */
      let dragging = false;
      /** 最近一次指针位置，帧循环用它判断按钮条该不该出现。 */
      const lastPointer = { x: -1e4, y: -1e4 };

      const wantsTools = () => {
        if (!layout) return false;
        if (['drag', 'air'].includes(layout.mode) || tools.menuOpen) return false;
        const now = performance.now();
        const near = hovering || tools.over(lastPointer.x, lastPointer.y);
        if (near) {
          showUntil = now + HIDE_GRACE;
          return true;
        }
        return now < showUntil;
      };

      /**
       * 帧率：按偏好里的档位决定活动/静止时的上限（见 FPS）。
       *
       * 她静止时的动画（呼吸、眨眼、头发弹簧）慢，降帧看不出差别，但省下大半
       * 的 CPU。`active` 由布局的 mode、气泡忙碌与拖拽状态决定。
       * 标签页不可见时浏览器本来就不发 rAF，不必自己处理。
       *
       * 档位在设置面板里改，改动经 syncPrefs 生效，不必重挂。
       */
      const fpsOf = () => FPS[prefs.fpsIndex] ?? FPS[1];
      /** 本帧之后隔多久再画下一帧；0 表示跟着刷新率画。 */
      let dueAt = 0;
      let gapMs = 0;

      const frame = (now) => {
        if (stopped) return;
        // 还没到下一帧的时间就先跳过，但必须继续请求，否则循环会断
        if (now < dueAt - gapMs / 4) {
          raf = requestAnimationFrame(frame);
          return;
        }
        // 标签页切回或系统休眠后 dt 会很大，cap 掉，免得她一帧冲过整个屏幕。
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        try {
          body.step(dt);
          layout = body.layout();
          hits = layout?.hit ?? [];
          bubble.step(dt);
          // 安静到点就恢复
          settleQuiet();
          // 状态气泡：对话优先，所以要先问过 bubble
          if (prefs.statusBubble !== false && !isQuiet()) status.step(dt);
          else status.yield();
          bubble.place(layout?.bubble ?? { x: layout?.x ?? 0, y: 0 }, layout?.facing ?? 1);
          // 40：对话栈。她说话/提问时整体让位（那是更重要的事）
          if (prefs.linesBubble !== false) lines.step(dt, bubble.busy);
          else lines.clear();
          // 轨迹：只有真的在走动时才落点（拖拽、跳跃不算「走过」）
          if (prefs.trail !== false) {
            trail.step(dt, ['walk', 'run'].includes(layout?.mode ?? ''));
          } else {
            trail.clear();
          }
          tools.place(layout?.box, layout?.side, { visible: wantsTools() });
          // 定期把她的位置与在做什么送回宿主（内部做了去重，不会每帧都发）
          if ((tick++ & 15) === 0) reportState();
          // 她停稳后才记位置：走动时每帧写盘没有意义
          if ((tick & 31) === 0) {
            const moving = layout && ['walk', 'run', 'drag', 'air'].includes(layout.mode);
            if (!moving) rememberPos();
          }
          // 低频检查设置面板是否改过偏好
          if ((tick & 31) === 0) syncPrefs();
        } catch (error) {
          console.warn('[dsh-coopanion-pet] 帧绘制失败，桌宠已停止：', error);
          stopped = true;
          return;
        }

        // 她在走动、被拖动、说话或做事时用活动档；静下来用静止档。
        // `moving` 由内核给出（走路、跳跃、拖拽等），对话与状态气泡也算活动。
        const active = !!(layout?.moving || bubble.busy || status.active || dragging);
        const fps = fpsOf();
        const cap = active ? fps.active : fps.rest;
        gapMs = cap > 0 ? 1000 / cap : 0;
        // 落后超过一个间隔就重新对齐，避免补画一串迟到的帧
        dueAt = now - dueAt > gapMs ? now + gapMs : dueAt + gapMs;

        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      /* ---------- 与宿主的双向通道 ----------
         下行：宿主经 SSE 推状态，以及 Agent 经 pet_* 工具下发的命令。
         上行：页面 POST 回执、用户对提问的回答、桌面侧状态。
         连不上就当没有这些功能，桌宠本体不受影响。 */

      /** 执行一条来自 Agent 的命令，返回回执内容。 */
      const runCommand = async (op, args) => {
        switch (op) {
          case 'say': {
            bubble.say(String(args?.text ?? ''));
            return { ok: true };
          }
          case 'ask': {
            const options = Array.isArray(args?.options) ? args.options.map(String).slice(0, 3) : [];
            lastQuestion = String(args?.question ?? '');
            bubble.ask(lastQuestion, options, { own: args?.own !== false });
            return { ok: true };
          }
          case 'walk': {
            const x = typeof args?.x === 'number' && Number.isFinite(args.x)
              ? Math.max(0, Math.min(args.x, window.innerWidth))
              : Math.random() * window.innerWidth;
            body.walk(x, args?.run === true);
            return { ok: true };
          }
          case 'act': {
            const word = String(args?.word ?? '');
            const ok = body.do(word);
            return ok === false ? { ok: false, reason: 'unknown-word' } : { ok: true };
          }
          case 'dress': {
            const parts = String(prefs.scheme ?? 'deepseek-maid').split('-');
            const nextScheme = args?.scheme ?? parts[0] ?? 'deepseek';
            const nextOutfit = args?.outfit ?? parts[1] ?? 'maid';
            const id = `${nextScheme}-${nextOutfit}`;
            /**
             * **先试再落盘**：与 dress.js 同因——换装失败还把偏好写下去，
             * 下次开页面会继续恢复这个坏值。这里失败要如实回报，而不是
             * 吞掉错误后回 `{ ok: true }`（那会让模型以为换成了）。
             */
            try {
              await Promise.resolve(body.setScheme(id, { fade: 0.3 }));
            } catch (error) {
              return { ok: false, reason: 'dress-failed', message: String(error?.message ?? error) };
            }
            prefs.scheme = id;
            writePrefs({ scheme: id });
            return { ok: true };
          }
          case 'confirm': {
            // CUA 权限确认：用气泡问一句，两个选项。
            // 这里**不落盘、不改偏好**，只是一次性的问答。
            const question = String(args?.question ?? '').slice(0, 200);
            const choices = Array.isArray(args?.choices) ? args.choices.map(String).slice(0, 2) : [];
            if (!question || choices.length < 2) return { ok: false, reason: 'bad-confirm' };
            /**
             * **本地也要超时清理**：宿主侧的工具调用有自己的超时
             * （120s，见 index.js 的 CONFIRM_TIMEOUT_MS），到点它会按
             * 「不许」处理。但页面里这个 resolver 若一直挂着，用户之后
             * 回答**别的普通提问**时，onAnswer 会先把答案喂进这个已经没人
             * 等的 resolver，真正的回答被丢掉（实测确认过的 bug）。
             *
             * 因此这里：给每个确认一个**代次**，超时或答完都把 pendingConfirm
             * 清掉；onAnswer 只认代次仍然匹配的那一个。
             */
            const epoch = ++confirmEpoch;
            const choice = await new Promise((resolve) => {
              // 用提问气泡：用户点选项或按 1/2。她不在气泡上答就等工具侧超时。
              bubble.ask(question, choices, { own: false });
              pendingConfirm = { epoch, resolve };
              confirmTimer = setTimeout(() => {
                if (pendingConfirm?.epoch === epoch) pendingConfirm = null;
              }, CONFIRM_TIMEOUT_MS);
            });
            clearTimeout(confirmTimer);
            confirmTimer = null;
            if (pendingConfirm?.epoch === epoch) pendingConfirm = null;
            return { ok: true, choice };
          }
          case 'quiet': {
            // 安静：关音效、不走动、状态气泡让位。临时状态，不改用户偏好。
            const minutes = typeof args?.minutes === 'number' && Number.isFinite(args.minutes) ? Math.max(0, args.minutes) : 15;
            setQuiet(minutes > 0 ? minutes * 60_000 : 0);
            return { ok: true, until: quietUntil };
          }
          case 'listen': {
            // 先问宿主「你能不能听」，再决定要不要申请麦克风。
            // 顺序很重要：直接录音的话，未装语音插件时用户会先看到一次麦克风权限框，
            // 白点一次拒绝——而他拒绝完拿到的还是「没装插件」，体验很糟。
            if (!voice.supported) return { ok: false, reason: 'unsupported' };
            try {
              const probe = await fetch(SPEECH, { method: 'GET' });
              const info = await probe.json().catch(() => null);
              if (!probe.ok || !info?.available) {
                return {
                  ok: false,
                  reason: 'no-speech-plugin',
                  message: `语音输入不可用：宿主里没有装上带识别能力的插件（${info?.package ?? '@deepseek-ai/dsh-experimental-speech-to-text'}）。装好并重启后她才能听。`,
                };
              }
            } catch (error) {
              return { ok: false, reason: 'unreachable', message: String(error?.message ?? error) };
            }
            const seconds = typeof args?.seconds === 'number' && Number.isFinite(args.seconds)
              ? Math.max(0.5, Math.min(args.seconds, 15))
              : 5;
            const rec = await voice.record({ seconds });
            if (rec.error) return { ok: false, reason: rec.error, message: rec.message };
            let res;
            try {
              res = await fetch(SPEECH, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ audioBase64: base64Of(rec.wav) }),
              });
            } catch (error) {
              return { ok: false, reason: 'unreachable', message: String(error?.message ?? error) };
            }
            let out = null;
            try { out = await res.json(); } catch (error) { out = null; }
            if (!res.ok || !out?.ok) {
              return { ok: false, reason: out?.reason ?? `http-${res.status}`, message: out?.message };
            }
            // 49/50：出口这一层做繁简归一与幻觉过滤（顺序：先归一，名单才匹配得上）
            const text = cleanSpeech(out.text);
            // 55：识别到了就直接填进 DSH 输入框（用户按下说话的意图就是「说给模型听」）
            const inserted = text ? inputBridge.insert(text) : false;
            return { ok: true, text, inserted };
          }
          case 'figure': {
            /**
             * 43：换形象（whale 鲸鱼娘 / coo Coo）。
             *
             * 换形象要**重建 body**（Coo 与鲸鱼娘的 CSS 与 skin 形态不同），
             * 因此这里是「建新的、释放旧的」，而不是 `setFigure`。
             */
            const want = String(args?.figure ?? '');
            if (!['whale', 'coo'].includes(want)) {
              return { ok: false, reason: 'bad-figure', message: 'figure must be whale or coo.' };
            }
            try {
              const changed = await switchFigure(want);
              return { ok: true, figure: want, changed };
            } catch (error) {
              return { ok: false, reason: 'figure-failed', message: String(error?.message ?? error) };
            }
          }
          case 'devices': {
            // 53：列出可用麦克风。没授权时只有占位名（浏览器隐私要求）。
            const list = await voice.listDevices();
            return { ok: true, devices: list, current: voice.device ?? '' };
          }
          case 'device': {
            // 53：选定麦克风。空串 = 系统默认。
            voice.setDevice(args?.deviceId ?? '');
            writePrefs({ micDevice: voice.device });
            return { ok: true, device: voice.device };
          }
          case 'speak': {
            // 朗读一段话：宿主代理到 dsh-xiaomi-tts 的同源路由合成，页面只负责播。
            const text = String(args?.text ?? '').trim().slice(0, 500);
            if (!text) return { ok: false, reason: 'no-text' };
            let res;
            try {
              res = await fetch(TTS, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
              });
            } catch (error) {
              return { ok: false, reason: 'unreachable', message: String(error?.message ?? error) };
            }
            if (!res.ok) {
              let out = null;
              try { out = await res.json(); } catch (error) { out = null; }
              return { ok: false, reason: out?.reason ?? `http-${res.status}`, message: out?.message };
            }
            const audio = new Uint8Array(await res.arrayBuffer());
            // 不等它播完：回执只表示「合成了并开始播」，等整段念完会把工具卡住
            voice.play(audio, res.headers.get('content-type') ?? 'audio/wav');
            return { ok: true, bytes: audio.byteLength };
          }
          case 'set': {
            const patch = args?.patch ?? {};
            const applied = {};
            /**
             * 66：先过安全边界。`ask` 层的项要先问用户，答「可以」才改。
             *
             * `confirmed` 由工具侧传（它已经在气泡里问过了）；页面这边自己问
             * 会与工具侧重复。因此这里只在**没确认**时拦下并回报需要确认。
             */
            const needsAsk = (key) => selfTierOf(key) === 'ask' && patch.confirmed !== true;
            if (needsAsk('scale') || needsAsk('sound') || needsAsk('theme')
              || needsAsk('bubbleSize') || needsAsk('fontSize') || needsAsk('hoverButtons')
              || needsAsk('user')) {
              return {
                ok: false,
                reason: 'needs-approval',
                message: '这几项会影响用户的屏幕、耳朵或称呼，要先问过他才能改。',
              };
            }
            if (typeof patch.sizeIndex === 'number') {
              /**
               * **夹到合法档位**：越界（如 7）会让 `SIZE_SCALES[7]` 落到
               * 兜底值 1，于是 UI 的 `sizeLabel` 显示一个不存在的档位，
               * 而画布尺寸又像「中号」——两处对不上（实测确认过的问题）。
               */
              const n = Math.round(patch.sizeIndex);
              if (n < 0 || n >= SIZE_SCALES.length) {
                return { ok: false, reason: 'bad-size', message: `sizeIndex 应为 0–${SIZE_SCALES.length - 1}` };
              }
              prefs.sizeIndex = n;
              prefs.scale = SIZE_SCALES[n] ?? 1;
              applied.sizeIndex = prefs.sizeIndex;
              applied.scale = prefs.scale;
              body.set({ bounds: viewport() });
              body.resize();
            }
            // 65：连续体型
            if (typeof patch.scale === 'number' && Number.isFinite(patch.scale)) {
              const s = Math.min(10, Math.max(0.5, patch.scale));
              prefs.scale = s;
              applied.scale = s;
              body.set({ bounds: viewport() });
              body.resize();
            }
            if (typeof patch.roamIndex === 'number') {
              prefs.roamIndex = patch.roamIndex;
              applied.roamIndex = prefs.roamIndex;
              body.set({ roam: ROAMS[prefs.roamIndex] ?? 'calm' });
            }
            if (typeof patch.sound === 'boolean') {
              prefs.sound = patch.sound;
              applied.sound = prefs.sound;
              sfx.set(prefs.sound);
            }
            if (typeof patch.statusBubble === 'boolean') {
              prefs.statusBubble = patch.statusBubble;
              applied.statusBubble = prefs.statusBubble;
              if (!prefs.statusBubble) status.yield();
            }
            if (typeof patch.trail === 'boolean') {
              prefs.trail = patch.trail;
              applied.trail = prefs.trail;
              if (!prefs.trail) trail.clear();
            }
            if (typeof patch.fpsIndex === 'number' && FPS[patch.fpsIndex]) {
              prefs.fpsIndex = patch.fpsIndex;
              applied.fpsIndex = prefs.fpsIndex;
            }
            // 56 称呼
            if (typeof patch.user === 'string') {
              prefs.user = patch.user.slice(0, 40);
              applied.user = prefs.user;
            }
            // 57 六类声音
            if (patch.sounds && typeof patch.sounds === 'object') {
              prefs.sounds = { ...prefs.sounds, ...patch.sounds };
              applied.sounds = prefs.sounds;
              applySound();
            }
            // 58 鼾声时长
            if (typeof patch.snoreSeconds === 'number' && Number.isFinite(patch.snoreSeconds)) {
              prefs.snoreSeconds = Math.max(0, Math.round(patch.snoreSeconds));
              applied.snoreSeconds = prefs.snoreSeconds;
              applySound();
            }
            // 59/60 气泡框与字号
            for (const key of ['bubbleSize', 'fontSize']) {
              if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) {
                prefs[key] = Math.min(1.6, Math.max(0.8, patch[key]));
                applied[key] = prefs[key];
                applyLook();
              }
            }
            // 61 主题三档
            if (['auto', 'light', 'dark'].includes(patch.theme)) {
              prefs.theme = patch.theme;
              applied.theme = prefs.theme;
              applyLook();
            }
            // 35 光晕
            if (typeof patch.glow === 'number' && Number.isFinite(patch.glow)) {
              prefs.glow = Math.min(16, Math.max(0, patch.glow));
              applied.glow = prefs.glow;
              applyLook();
            }
            // 62 悬停按钮
            if (Array.isArray(patch.hoverButtons)) {
              const known = patch.hoverButtons.filter((id) => HOVER_IDS.includes(id)).slice(0, 6);
              if (known.length) {
                prefs.hoverButtons = known;
                applied.hoverButtons = known;
                tools?.rebuild?.();
              }
            }
            // 63 双击输入框
            if (typeof patch.doubleClickChat === 'boolean') {
              prefs.doubleClickChat = patch.doubleClickChat;
              applied.doubleClickChat = prefs.doubleClickChat;
            }
            // 64 触摸唤醒
            if (['poke', 'all', 'none', 'custom'].includes(patch.touchWake)) {
              prefs.touchWake = patch.touchWake;
              applied.touchWake = prefs.touchWake;
            }
            if (Array.isArray(patch.wakeKinds)) {
              const kinds = patch.wakeKinds.filter((k) => TOUCH_KINDS.includes(k));
              prefs.wakeKinds = kinds;
              applied.wakeKinds = kinds;
            }
            // 66 安全边界本身（改它不受它自己约束）
            if (['off', 'default', 'any', 'custom'].includes(patch.selfAdjust)) {
              prefs.selfAdjust = patch.selfAdjust;
              applied.selfAdjust = prefs.selfAdjust;
            }
            if (patch.selfAdjustCustom && typeof patch.selfAdjustCustom === 'object') {
              prefs.selfAdjustCustom = { ...prefs.selfAdjustCustom, ...patch.selfAdjustCustom };
              applied.selfAdjustCustom = prefs.selfAdjustCustom;
            }
            if (Object.keys(applied).length) writePrefs(applied);
            return { ok: true, applied };
          }
          default:
            return { ok: false, reason: 'unknown-op' };
        }
      };

      let events = null;
      /**
       * **命令帧要串行执行。**
       *
       * `onmessage` 是 async 的：两条命令帧会并发跑 `runCommand`，而
       * `runCommand` 里的提问槽（`lastQuestion`、`pendingChat`、
       * `pendingConfirm`）都是**单值**——后到的那条会把前一条的状态顶掉
       * （`bubble.ask` 还会直接关掉当前提问）。实测确认过：模型同时调
       * `pet_ask` 与 CUA 确认时，两个问题会互相覆盖。
       *
       * 这里用一个 Promise 队列把命令帧排队执行；其余帧（状态、对话栈）
       * 不受影响，照旧即时处理。
       */
      let commandQueue = Promise.resolve();
      try {
        events = new EventSource(EVENTS);
        events.onmessage = (e) => {
          let frame = null;
          try { frame = JSON.parse(e.data); } catch (error) { return; }
          if (!frame || typeof frame !== 'object') return;

          if (frame.type === 'command' && typeof frame.id === 'string') {
            commandQueue = commandQueue.then(async () => {
              let result;
              try {
                result = await runCommand(frame.op, frame.args ?? {});
              } catch (error) {
                result = { ok: false, reason: 'failed' };
              }
              report({ kind: 'settle', id: frame.id, result }, true);
            }).catch(() => { /* 单条失败不能把队列卡死 */ });
            return;
          }
          // 40：对话栈帧
          if (frame.type === 'lines') { lines.set(frame.lines ?? []); return; }
          // 状态帧（以及任何带 kind 的旧格式）交给状态气泡
          status.set(frame.kind ? frame : frame.status ?? { kind: 'none' });
        };
        /**
         * EventSource 自己会重连，因此不必每次报错都喊。
         * 但**完全静默是有代价的**：鉴权失败（401）或端点不存在时，
         * Agent 控制与状态气泡会静默失效，用户和模型都看不到原因。
         * 因此第一次失败打一条警告（之后交给 EventSource 自己重试）。
         */
        let sseWarned = false;
        events.onerror = () => {
          if (sseWarned) return;
          sseWarned = true;
          console.warn('[dsh-coopanion-pet] 事件流断开（状态气泡与 Agent 控制暂时不可用）；'
            + 'EventSource 会自动重连，若一直不恢复请检查登录状态与 /api/dsh-coopanion-pet/events 端点。');
        };
      } catch (error) {
        console.warn('[dsh-coopanion-pet] 事件流打不开，状态气泡与 Agent 控制不可用：', error);
      }

      /* ---------- 上报桌面侧状态 ----------
         工具要回答「她现在在哪、在做什么」，因此定期把布局与装扮送回宿主。
         她走动时 x 每帧都在变，所以位置按 10px 粒度量化；只有真正跨过一格
         或模式/装扮变了才上报，否则一次走动会发出上百条。 */
      let lastReport = '';
      const reportState = () => {
        const l = layout;
        if (!l) return;
        const payload = {
          kind: 'state',
          x: Math.round((l.x ?? 0) / 10) * 10,
          mode: String(l.mode ?? 'idle'),
          scheme: String(prefs.scheme ?? ''),
        };
        const key = `${payload.x}|${payload.mode}|${payload.scheme}`;
        if (key === lastReport) return;
        /**
         * **发送失败要回滚记账。**
         *
         * 原来先推进 `lastReport` 再发，而 `report` 在已有请求在途时会直接
         * 跳过（或 fetch 本身失败）。两种情况都会让这条状态**永远不再发**
         * ——她的位置/模式在宿主侧就停在了旧值上（实测确认过的问题）。
         */
        lastReport = key;
        report(payload, false, () => { lastReport = ''; });
      };

      /* ---------- 指针 ----------
         命中判定用渲染内核回报的圆；只有命中她本体、或她自己的界面元素时才拦事件。
         按钮条与菜单是 HTML 元素，靠它们自己的 pointer-events:auto 接收点击。 */
      const onPet = (x, y) => hits.some((c) => Math.hypot(x - c.x, y - c.y) < c.r);
      const point = (event) => ({ x: event.clientX, y: event.clientY, t: event.timeStamp });

      /** 光标形状是否由本插件设置：避免清掉界面自己设的值。 */
      let cursorOwned = false;
      const setCursor = (value) => {
        const rootEl = document.documentElement;
        if (value) {
          rootEl.style.cursor = value;
          cursorOwned = true;
        } else if (cursorOwned) {
          rootEl.style.cursor = '';
          cursorOwned = false;
        }
      };

      const onDown = (event) => {
        // 第一次手势解锁音频
        sfx.unlock();
        // 只有左键抓她；右键留给菜单
        if (event.button !== 0) return;
        if (!onPet(event.clientX, event.clientY)) return;
        dragging = true;
        body.pointer('down', point(event));
        setCursor('grabbing');
        event.preventDefault();
        event.stopPropagation();
      };

      const onMove = (event) => {
        const p = point(event);
        lastPointer.x = p.x;
        lastPointer.y = p.y;
        if (dragging) {
          body.pointer('move', p);
          setCursor('grabbing');
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const overOwnUi = tools.over(p.x, p.y);
        const on = onPet(p.x, p.y) || overOwnUi;
        if (on !== hovering) hovering = on;
        // 视线跟随；光标在她自己的按钮条上时不必转头
        if (!overOwnUi) body.pointer('move', p);
        setCursor(on ? 'grab' : '');
      };

      const onUp = (event) => {
        if (!dragging) return;
        dragging = false;
        body.pointer('up', point(event));
        setCursor(onPet(event.clientX, event.clientY) ? 'grab' : '');
        event.preventDefault();
        event.stopPropagation();
      };

      const onLeave = () => {
        if (dragging) return;
        hovering = false;
        setCursor('');
      };

      /** 双击输入框的回答是否在等（63）。声明在使用之前——`let` 有暂时性死区。 */
      let pendingChat = false;

      /**
       * 63：双击她打开一个输入框，回车后作为一条新消息发给会话。
       *
       * 与提问气泡的自填框不同：那个是**回答**她的话，这个是**主动**对她说。
       * 用 `report({kind:'answer'})` 同一条通道——宿主会把它作为新消息送回会话，
       * 语义上就是「用户说了这句话」。
       */
      const onDoubleClick = (event) => {
        if (!prefs.doubleClickChat) return;
        if (!onPet(event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        bubble.ask(t('chat.placeholder'), [], { own: true });
        // 复用提问气泡的自填框：它回车后走 onAnswer，这里把回答当「用户对她说的话」
        pendingChat = true;
        lastQuestion = '';
      };

      /** 右键菜单：在她身上或按钮条上时弹出。 */
      const onContextMenu = (event) => {
        if (CLEAN) return;
        if (!onPet(event.clientX, event.clientY) && !tools.over(event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        tools.showMenu(event.clientX, event.clientY);
      };

      /** 键盘：提问时 1–3 选项，Esc 关菜单。 */
      const onKey = (event) => {
        // 先给气泡：它管提问气泡的 1–3 选项与 Esc 放弃。
        // 顺序很重要——原来的写法在 Esc 分支里直接 return，于是气泡永远
        // 收不到 Esc，「按 Esc 放弃提问」从 v1.1 起就没生效过。
        if (bubble.handleKey(event)) { event.preventDefault(); return; }
        if (event.key === 'Escape') { tools.hideMenu(); return; }
        // 其余按键只在焦点不在输入框里时才吃
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      };

      /**
       * 补拦 `click`：浏览器在 pointerdown/pointerup 被阻止后**仍会合成 click**，
       * 而它不经过我的 pointer 处理器，会一路冒泡到下面的界面。
       * 实测（dsh 0.2.0-rc.2）：只拦 pointer 事件时，点她本体界面仍会收到 1 次 click。
       *
       * 只在她身上、或她自己的按钮条/气泡上拦；其余原样放行。
       */
      const onClick = (event) => {
        if (CLEAN) return;
        const onPetNow = onPet(event.clientX, event.clientY);
        if (!onPetNow && !tools.over(event.clientX, event.clientY)) return;
        // 在按钮条上时不拦——那是她自己的 UI，点击要真的生效
        if (tools.over(event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
      };

      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      window.addEventListener('dblclick', onDoubleClick, true);
      window.addEventListener('contextmenu', onContextMenu, true);
      window.addEventListener('keydown', onKey, true);
      document.addEventListener('pointerleave', onLeave);

      const onResize = () => { body.resize(); };
      window.addEventListener('resize', onResize);

      /* ---------- 对外的小接口（供验证与将来的 Agent 接线） ---------- */

      const api = {
        root,
        /** 让她说一段话；支持 `【表情,动作】` 与 `<表情>` 标记。 */
        say: (text) => bubble.say(text),
        /** 让她问一个问题。 */
        ask: (q, options, opts) => bubble.ask(q, options, opts),
        /** 让她做某个表情或动作。 */
        do: (word) => body.do(word),
        /** 走到窗口的某个横向位置。 */
        walk: (x, run) => body.walk(x, run),
        /** 换一套装扮（`配色-服装`，如 `claude-maid`），并记住选择。 */
        setScheme: (id, opts) => {
          prefs.scheme = String(id);
          writePrefs({ scheme: prefs.scheme });
          return Promise.resolve(body.setScheme(id, opts));
        },
        /** 打开或收起装扮面板。 */
        openDress: (open = true) => {
          if (open) dress.show(layout?.bubble ?? { x: layout?.x ?? 0, y: 0 }, prefs.dressPos);
          else dress.hide();
        },
        /** 当前的布局快照（位置、模式、包围盒）。 */
        get layout() { return layout; },
        /**
         * 当前的命中圆（只读）。
         *
         * 留着它是因为指针判定的问题**只能从这里看**：她是否可被点、按钮条该不该出现，
         * 都取决于这几个圆。验证脚本与将来的排查都靠它，比读内部状态可靠。
         */
        get hits() { return hits; },
        /** 录一段话并交给宿主识别；宿主没装语音插件时返回 `{ ok: false, reason: 'no-speech-plugin' }`。 */
        listen: (seconds) => runCommand('listen', { seconds }),
        /** 让宿主合成一段话并播出。 */
        speak: (text) => runCommand('speak', { text }),
        /** 语音能力现在可不可用（浏览器有没有麦克风 API；插件装没装要调了才知道）。 */
        get voiceReady() { return voice.supported; },
        /** 53：列出可用麦克风（设置面板用）。 */
        listDevices: () => runCommand('devices', {}),
        /** 43：换形象（whale 鲸鱼娘 / coo Coo）。返回是否真的换了。 */
        switchFigure: (id) => switchFigure(id),
        /** 43：当前形象 id。 */
        get figure() { return prefs.figure === 'coo' ? 'coo' : 'whale'; },
        /** 55：把一段文字填进 DSH 输入框（没有那个能力时返回 false）。 */
        insertText: (text) => inputBridge.insert(text),
        /**
         * 立刻把 localStorage 里的偏好拉进来。
         *
         * 帧循环本来就每 32 帧拉一次（`tick & 31`），但静止档是 12fps，
         * 32 帧 ≈ **2.7 秒**——设置面板改完滑块，她要过两秒多才有反应，
         * 用户会以为没生效（实测确认过的延迟）。面板改完直接调这个。
         */
        syncPrefs: () => syncPrefs(),
        dispose() {
          stopped = true;
          cancelAnimationFrame(raf);
          setCursor('');
          try { events?.close(); } catch (error) { /* 已经断了 */ }
          window.removeEventListener('pointerdown', onDown, true);
          window.removeEventListener('click', onClick, true);
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onUp, true);
          window.removeEventListener('dblclick', onDoubleClick, true);
          window.removeEventListener('contextmenu', onContextMenu, true);
          window.removeEventListener('keydown', onKey, true);
          document.removeEventListener('pointerleave', onLeave);
          window.removeEventListener('resize', onResize);
          tools.dispose();
          dress.dispose();
          trail.dispose();
          lines.dispose();
          /**
           * **voiceUi 也要释放**：它在 window 上挂了 keydown/keyup/blur
           * 三个监听器（Shift+Space 按住说话）。漏掉这一步的话，每次改语言
           * 或「显示桌宠」开关（readMountKey 变 → 这一层重建）都会多留
           * 三个监听器，累积下去会重复触发录音（实测确认过的泄漏）。
           */
          try { voiceUi?.dispose?.(); } catch (error) { /* 释放失败不影响其余 */ }
          bubbleEl.remove();
          style.remove();
          try {
            body.dispose();
          } catch (error) {
            console.warn('[dsh-coopanion-pet] 释放渲染资源失败：', error);
          }
          root.remove();
        },
      };

      // 验证脚本与将来的 Agent 接线用；桌面端的页面是单例，不会撞名。
      window.__dshCoopanionPet = api;
      /**
       * 55：输入桥挂到 window，供 apply 里的槽注册取用。
       *
       * 为什么绕一下：`inputBridge` 在 startPet 内创建（它要用 React，而 React 在
       * 模块工厂里），而槽注册在 apply 里做（那是 DSH 的 slots 服务可用的地方）。
       * 两处作用域不同，因此用 window 转一次手。
       */
      window.__dshCoopanionPetInput = inputBridgeSingleton;

      return api;
    }

    /**
     * 46：把 `startPet` 暴露给预览页。
     *
     * 预览页没有 DSH 的 `__ModuleLoader__`，因此不能走 `load()` 那条路。
     * 这里把它挂到 window，预览页直接调用即可——它只依赖 React（用来做最外层挂载），
     * 其余（渲染内核、气泡、装扮、SSE 通道）全是自包含的。
     */
    window.__dshCoopanionPetStart = startPet;
    /** 预览页还要读偏好。 */
    window.__dshCoopanionPetPrefs = { read: readPrefs, write: writePrefs };

    /* ---------- React 挂载点 ---------- */

    /** 挂进 `shell.overlay` 的桌宠层。挂载即加载，卸载即释放；加载期间不占位，失败只告警。 */
    function PetOverlay() {
      // 语言或显示开关一变，就把整个桌宠层重建一次（见 readMountKey）。
      // 轮询很便宜：一次 localStorage 读，一秒一次。
      const [mountKey, setMountKey] = React.useState(readMountKey);
      React.useEffect(() => {
        const timer = setInterval(() => {
          const next = readMountKey();
          setMountKey((prev) => (prev === next ? prev : next));
        }, 1000);
        return () => clearInterval(timer);
      }, []);

      const hostRef = React.useRef(null);
      React.useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        const prefs = readPrefs();
        if (!prefs.enabled) return undefined;

        let pet = null, disposed = false;
        startPet(prefs).then((made) => {
          if (disposed) {
            made.dispose();
            return;
          }
          pet = made;
          host.appendChild(made.root);
        }, (error) => {
          console.warn('[dsh-coopanion-pet] 桌宠加载失败，本页不显示：', error);
        });

        return () => {
          disposed = true;
          pet?.dispose();
          if (window.__dshCoopanionPet === pet) delete window.__dshCoopanionPet;
        };
      }, [mountKey]);
      // 锚点自身不渲染内容、不接收指针：桌宠的容器由 effect 直接创建。
      return React.createElement('div', { ref: hostRef, 'aria-hidden': true });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const el = document.createElement('style');
          el.setAttribute(STYLE_ATTR, 'css');
          el.textContent = CSS;
          document.head.appendChild(el);
          return () => el.remove();
        }, 'dsh-coopanion-pet: 样式');

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'coopanion-pet', order: 10 },
          PetOverlay,
        ));

        // 全局说话热键：走 DSH 的 shortcuts 服务（可选注入——拿不到就跳过）。
        // 用 ctx.inject 的可选形式：服务不存在时不会让整个插件加载失败。
        ctx.inject(['shortcuts'], (sctx) => {
          const shortcuts = sctx.get('shortcuts');
          if (!shortcuts || typeof shortcuts.registerFixed !== 'function') return;
          // 文案与台词都在 i18n.js 里，这里**单独导入**它——
          // 不能引用 startPet 内的 `t`：那是另一个作用域的局部变量，
          // 而这个回调在 apply 作用域里执行（第一版就是这么错的）。
          Promise.all([import(`${ABS}hotkey.js`), import(`${ABS}i18n.js`)]).then(([{ registerSpeakShortcut }, i18n]) => {
            sctx.effect(
              () => registerSpeakShortcut(shortcuts, {
                // 按下去就让她说一句。她还没加载好时静默跳过。
                speak: () => {
                  const pet = window.__dshCoopanionPet;
                  if (!pet) return;
                  const lines = [1, 2, 3, 4, 5].map((i) => i18n.t(`pet.line${i}`));
                  pet.say(lines[Math.floor(Math.random() * lines.length)]);
                },
                t: (key) => i18n.t(key),
              }),
              'dsh-coopanion-pet: 说话热键',
            );
          }).catch((error) => {
            console.warn('[dsh-coopanion-pet] 说话热键注册失败，其余功能不受影响：', error);
          });
        });

        /**
         * 55：注册进 `conversation.input.activity` 槽，只为拿到 `inputActions`。
         *
         * **必须进这个槽**——实测（见 docs/risk-verification.md）`shell.overlay` 的
         * props 是空接口，而该槽提供完整的 `inputActions`
         * （`insertText`/`setDraft`/`submit`/`captureInsertion`）以及 `sessionId`。
         *
         * UI 刻意极简（一个零尺寸锚点），因为那是输入框旁边的活动区，不该被桌宠占住。
         * 拿不到这个槽时静默跳过：55 退化成「识别结果只回报给 Agent」。
         */
        import(`${ABS}input-bridge.js`).then(({ createInputBridge: makeBridge }) => {
          // 单例：startPet 与这里必须共用同一个实例，否则槽里存下的 inputActions
          // 与填输入框时读的不是同一个对象（第一版就是这么错的）。
          inputBridgeSingleton ??= makeBridge(React, {
            submitViaHost: (text) => {
              fetch(REPORT, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind: 'speech-submit', text }),
              }).catch(() => {});
            },
          });
          window.__dshCoopanionPetInput = inputBridgeSingleton;
          /**
           * 那个槽是 **single**，官方语音输入插件也会注册它——两者只能有一个。
           * 因此这里**试一次，失败就静默降级**（走宿主的 speech-submit），
           * 不刷警告：这是预期内的情况，不是故障。
           */
          try {
            ctx.slots.inject('conversation.input.activity', () => inputBridgeSingleton.register(
              (cmd, comp) => ctx.slots.register(cmd, comp),
              'conversation.input.activity',
            ));
          } catch (error) {
            // 槽被占了：识别文本改走会话，功能不丢
            console.info('[dsh-coopanion-pet] 输入框活动区已被占用，语音结果将直接作为消息送进会话。');
          }
        }).catch((error) => {
          console.warn('[dsh-coopanion-pet] 输入框桥加载失败（语音填入不可用，其余不受影响）：', error);
        });

        // 设置面板是增强项：注册失败不影响桌宠本体。
        // 模块按需加载，避免桌宠本体等她。
        import(`${ABS}settings.js`).then(({ createSettingsSection }) => {
          const Section = createSettingsSection(React, { read: readPrefs, write: writePrefs });
          ctx.slots.inject('settings.section', () => ctx.slots.register(
            { name: 'settings.section', id: 'coopanion-pet', order: 40, label: () => '桌宠' },
            Section,
          ));
        }).catch((error) => {
          console.warn('[dsh-coopanion-pet] 设置面板注册失败，桌宠不受影响：', error);
        });
      },
    };
  },
});
