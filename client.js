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
    /** 站立地面与窗口底边的距离。 */
    const FLOOR_GAP = 8;

    /** 体型档位对应的系数（渲染内核的标准值是 0.42）。 */
    const SIZES = [0.30, 0.38, 0.48];
    const ROAMS = ['calm', 'free', 'busy'];

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

      const [kit, whale, { createSfx }, { createBubble }, { createTools, TOOLS_CSS },
        { BUBBLE_CSS }, { createStatus, STATUS_CSS }, { createDress, DRESS_CSS }] = await Promise.all([
        import(`${ABS}kit/body.js`),
        import(`${ABS}whale/figure.js`),
        import(`${ABS}sfx.js`),
        import(`${ABS}bubble.js`),
        import(`${ABS}ui.js`),
        import(`${ABS}bubble.css.js`),
        import(`${ABS}status.js`),
        import(`${ABS}dress.js`),
      ]);

      // 气泡、按钮条、状态与装扮面板的样式随桌宠一起挂载、一起卸载，避免污染宿主的样式表。
      const style = document.createElement('style');
      style.setAttribute(STYLE_ATTR, 'parts');
      style.textContent = BUBBLE_CSS + TOOLS_CSS + STATUS_CSS + DRESS_CSS;
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

      const bubble = createBubble({ bubble: bubbleEl }, {
        sfx,
        onTalk: () => body.talk(),
        onAct: (actions) => { for (const a of actions) body.do(a); },
        onAnswer: () => { /* 没有 Agent 在场时，回答只是热热身。 */ },
      });

      // 对话优先：说话或提问时状态气泡让位，因此把 bubble 的忙碌当作判据。
      const status = createStatus({ el: bubbleEl }, { busy: () => bubble.busy });

      /** 装扮面板换装后要更新偏好，这里先占位，下面接上 body。 */
      let dress = null;

      let tools = null;

      const body = kit.createBody(
        {
          root,
          bounds: viewport,
          emit: () => {},
          sound: (name, kind, ...args) => sfx.play(name, kind, ...args),
          start: { x: window.innerWidth * prefs.startShare, facing: -1, enter: 'drop' },
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
            const lines = [
              '我在这儿呢。',
              '需要我帮你看点什么吗？',
              '这会儿挺安静的。',
              '你忙你的，我不打扰。',
              '要不要休息一下？',
            ];
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
            body.place(window.innerWidth * prefs.startShare, -1);
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
          case 'hide': {
            writePrefs({ enabled: false });
            bubble.say('那我先躲起来，下次见。');
            // 等她把话说完再收起来
            setTimeout(() => { if (!stopped) root.style.visibility = 'hidden'; }, 1600);
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

      /* ---------- 帧循环 ---------- */

      let raf = 0, last = performance.now(), stopped = false;
      /** 最近一帧的命中圆，供指针判定读取。 */
      let hits = [];

      const frame = (now) => {
        if (stopped) return;
        // 标签页切回或系统休眠后 dt 会很大，cap 掉，免得她一帧冲过整个屏幕。
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        try {
          body.step(dt);
          layout = body.layout();
          hits = layout?.hit ?? [];
          bubble.step(dt);
          // 状态气泡：对话优先，所以要先问过 bubble
          if (prefs.statusBubble !== false) status.step(dt);
          else status.yield();
          bubble.place(layout?.bubble ?? { x: layout?.x ?? 0, y: 0 }, layout?.facing ?? 1);
          tools.place(layout?.box, layout?.side, {
            // 按钮条只在鼠标靠近她时出现，平时不占地方
            visible: !!layout && (hovering || tools.over(lastPointer.x, lastPointer.y))
              && !['drag', 'air'].includes(layout.mode),
          });
        } catch (error) {
          console.warn('[dsh-coopanion-pet] 帧绘制失败，桌宠已停止：', error);
          stopped = true;
          return;
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      /* ---------- 状态事件流 ----------
         宿主通过 SSE 推「此刻在做什么」。客户端插件拿不到会话状态（见 index.js），
         所以状态由宿主采集后下发。连不上就当没有状态气泡，不影响桌宠。 */
      let events = null;
      try {
        events = new EventSource(EVENTS);
        events.onmessage = (e) => {
          try { status.set(JSON.parse(e.data)); } catch (error) { /* 坏帧忽略 */ }
        };
        // EventSource 自己会重连，这里只把噪音压住
        events.onerror = () => {};
      } catch (error) {
        console.warn('[dsh-coopanion-pet] 状态流打不开，状态气泡不可用：', error);
      }

      /* ---------- 指针 ----------
         命中判定用渲染内核回报的圆；只有命中她本体、或她自己的界面元素时才拦事件。
         按钮条与菜单是 HTML 元素，靠它们自己的 pointer-events:auto 接收点击。 */
      const onPet = (x, y) => hits.some((c) => Math.hypot(x - c.x, y - c.y) < c.r);
      const point = (event) => ({ x: event.clientX, y: event.clientY, t: event.timeStamp });

      /** 光标是否停在她身上，或停在她自己的按钮条上。 */
      let hovering = false;
      let dragging = false;
      /** 最近一次指针位置，帧循环用它判断按钮条该不该出现。 */
      const lastPointer = { x: -1e4, y: -1e4 };
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
        /** 换一套装扮（`配色-服装`，如 `claude-maid`）。 */
        setScheme: (id, opts) => Promise.resolve(body.setScheme(id, opts)),
        /** 打开或收起装扮面板。 */
        openDress: (open = true) => {
          if (open) dress.show(layout?.bubble ?? { x: layout?.x ?? 0, y: 0 }, prefs.dressPos);
          else dress.hide();
        },
        /** 当前的布局快照（位置、模式、包围盒）。 */
        get layout() { return layout; },
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
      }, []);
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
      },
    };
  },
});
