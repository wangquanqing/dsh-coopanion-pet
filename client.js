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

    /** 体型档位对应的系数（渲染内核的标准值是 0.42）。 */
    const SIZES = [0.30, 0.38, 0.48];
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
      const SYNCED = ['sizeIndex', 'roamIndex', 'sound', 'statusBubble', 'scheme', 'trail', 'fpsIndex'];
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
          prefs[key] = stored[key];
          // 安静期间不要被偏好同步把声音打开
          if (key === 'sound') { if (!isQuiet()) sfx.set(prefs.sound); }
          else if (key === 'sizeIndex') { body.set({ bounds: viewport() }); body.resize(); }
          else if (key === 'roamIndex') body.set({ roam: ROAMS[prefs.roamIndex] ?? 'calm' });
          else if (key === 'scheme') Promise.resolve(body.setScheme?.(prefs.scheme)).catch(() => {});
        }
      };

      const [kit, whale, { createSfx }, { createBubble }, { createTools, TOOLS_CSS },
        { BUBBLE_CSS }, { createStatus, STATUS_CSS }, { createDress, DRESS_CSS },
        { createTrail, TRAIL_CSS }, { createVoice }, { t }] = await Promise.all([
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
        import(`${ABS}i18n.js`),
      ]);

      // 气泡、按钮条、状态与装扮面板的样式随桌宠一起挂载、一起卸载，避免污染宿主的样式表。
      const style = document.createElement('style');
      style.setAttribute(STYLE_ATTR, 'parts');
      style.textContent = BUBBLE_CSS + TOOLS_CSS + STATUS_CSS + DRESS_CSS + TRAIL_CSS;
      document.head.appendChild(style);

      // 形象包内部按 base 解析纹理与 model.json，必须传它自己的目录（绝对 URL）。
      const figure = await whale.createWhaleFigure(`${ABS}whale/`, {
        kit: { createRig: kit.createRig },
      });

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

      const viewport = () => ({
        W: window.innerWidth,
        H: window.innerHeight,
        floorY: window.innerHeight - FLOOR_GAP,
        S: SIZES[prefs.sizeIndex] ?? SIZES[1],
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
      const report = (payload, must = false) => {
        if (reportInFlight && !must) return;
        reportInFlight = true;
        try {
          fetch(REPORT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {}).finally(() => { reportInFlight = false; });
        } catch (error) {
          reportInFlight = false;
        }
      };

      /** 最近问出去的那个问题，回答回传时一并发回去，好在会话里说清是在答什么。 */
      let lastQuestion = '';

      const bubble = createBubble({ bubble: bubbleEl }, {
        sfx,
        onTalk: () => body.talk(),
        onAct: (actions) => { for (const a of actions) body.do(a); },
        onAnswer: (a) => {
          // 用户回答了一个提问：送回宿主，由它作为一条新消息转给 Agent。
          // 放弃（Esc）不算回答，不回传。
          if (!a || a.dismissed) return;
          const text = a.text !== undefined ? String(a.text) : String(a.label ?? '');
          if (!text) return;
          report({ kind: 'answer', text, via: a.text !== undefined ? 'typed' : 'option', question: lastQuestion }, true);
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
        // 说话时让她的嘴动起来：录音电平没接（识别只需要能量门限），
        // 因此这里只在真有声音进来时轻推一下嘴部动画。
        onLevel: () => { try { body.talk(); } catch (error) { /* 未就绪就算了 */ } },
      });

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

      /** 装扮面板换装后要更新偏好，这里先占位，下面接上 body。 */
      let dress = null;

      let tools = null;

      const body = kit.createBody(
        {
          root,
          bounds: viewport,
          emit: () => {},
          sound: (name, kind, ...args) => sfx.play(name, kind, ...args),
          start: { x: startX(), facing: -1, enter: 'drop' },
        },
        { figure, bounds: viewport, roam: ROAMS[prefs.roamIndex] ?? 'calm' },
      );

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
            bubble.say(pick(lines));
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
            writePrefs({ sizeIndex: prefs.sizeIndex });
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
            prefs.scheme = id;
            writePrefs({ scheme: id });
            await Promise.resolve(body.setScheme(id, { fade: 0.3 })).catch(() => {});
            return { ok: true };
          }
          case 'quiet': {
            // 安静：关音效、不走动、状态气泡让位。临时状态，不改用户偏好。
            const minutes = typeof args?.minutes === 'number' && Number.isFinite(args.minutes) ? Math.max(0, args.minutes) : 15;
            setQuiet(minutes > 0 ? minutes * 60_000 : 0);
            return { ok: true, until: quietUntil };
          }
          case 'listen': {
            // 录一段话交给宿主侧的识别服务。宿主没装语音输入插件时端点回 501，
            // 这里如实回报 'no-speech-plugin'，不假装听到。
            if (!voice.supported) return { ok: false, reason: 'unsupported' };
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
            return { ok: true, text: out.text };
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
            if (typeof patch.sizeIndex === 'number') {
              prefs.sizeIndex = patch.sizeIndex;
              applied.sizeIndex = prefs.sizeIndex;
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
            if (Object.keys(applied).length) writePrefs(applied);
            return { ok: true, applied };
          }
          default:
            return { ok: false, reason: 'unknown-op' };
        }
      };

      let events = null;
      try {
        events = new EventSource(EVENTS);
        events.onmessage = async (e) => {
          let frame = null;
          try { frame = JSON.parse(e.data); } catch (error) { return; }
          if (!frame || typeof frame !== 'object') return;

          if (frame.type === 'command' && typeof frame.id === 'string') {
            let result;
            try {
              result = await runCommand(frame.op, frame.args ?? {});
            } catch (error) {
              result = { ok: false, reason: 'failed' };
            }
            report({ kind: 'settle', id: frame.id, result }, true);
            return;
          }
          // 状态帧（以及任何带 kind 的旧格式）交给状态气泡
          status.set(frame.kind ? frame : frame.status ?? { kind: 'none' });
        };
        // EventSource 自己会重连，这里只把噪音压住
        events.onerror = () => {};
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
        lastReport = key;
        report(payload);
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

      /** 右键菜单：在她身上或按钮条上时弹出。 */
      const onContextMenu = (event) => {
        if (!onPet(event.clientX, event.clientY) && !tools.over(event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        tools.showMenu(event.clientX, event.clientY);
      };

      /** 键盘：提问时 1–3 选项，Esc 关菜单。 */
      const onKey = (event) => {
        if (event.key === 'Escape') { tools.hideMenu(); return; }
        // 只在焦点不在输入框里时才吃数字键
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (bubble.handleKey(event)) event.preventDefault();
      };

      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
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
        /** 录一段话并交给宿主识别；宿主没装语音插件时返回 `{ ok: false, reason: 'no-speech-plugin' }`。 */
        listen: (seconds) => runCommand('listen', { seconds }),
        /** 让宿主合成一段话并播出。 */
        speak: (text) => runCommand('speak', { text }),
        /** 语音能力现在可不可用（浏览器有没有麦克风 API；插件装没装要调了才知道）。 */
        get voiceReady() { return voice.supported; },
        dispose() {
          stopped = true;
          cancelAnimationFrame(raf);
          setCursor('');
          try { events?.close(); } catch (error) { /* 已经断了 */ }
          window.removeEventListener('pointerdown', onDown, true);
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onUp, true);
          window.removeEventListener('contextmenu', onContextMenu, true);
          window.removeEventListener('keydown', onKey, true);
          document.removeEventListener('pointerleave', onLeave);
          window.removeEventListener('resize', onResize);
          tools.dispose();
          dress.dispose();
          trail.dispose();
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

      return api;
    }

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
