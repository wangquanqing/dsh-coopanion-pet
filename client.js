/**
 * dsh-coopanion-pet —— 客户端半边：把 Coopanion 的桌宠画进 DSH 界面的覆盖层。
 *
 * 桌宠本体是 Coopanion 的渲染内核（assets/kit：Live2D 式 WebGL sprite rig）加鲸鱼娘形象包
 * （assets/whale：25 张身体部件纹理 + 25 张表情贴图 + model.json）。这些都是自包含的 ES 模块
 * 与静态资源，原样复制、未作修改；本文件只负责把它们挂进页面并驱动。
 *
 * 三条设计约束：
 *
 * - 不挡界面。覆盖层与其中所有元素都是 pointer-events:none，永远不是事件目标。指针处理挂在
 *   window 的捕获阶段，用桌宠的命中圆按坐标判定：只有光标真的落在她身上时才拦下事件并开始拖拽，
 *   其余每一次移动和点击都原样放行给下面的界面。这样避开了「容器要接收指针就必须挡住界面」的两难，
 *   也避开了 pointer-events 从 none 切到 auto 时浏览器不会重定向已在该位置的指针这一陷阱。
 *
 * - 不污染主题。渲染内核的 set({theme}) 会写 html 的 data-theme，与 DSH 自己的主题机制
 *   （data-ds-theme-source）冲突，因此不调用它；配色交给内核 CSS 的 prefers-color-scheme 自行判断。
 *   光标形状是唯一写进 html 的样式，且只在由本插件设置过时才清除，不覆盖界面自身的设置。
 *
 * - 失败即静默。资源或 WebGL 不可用时只留一行控制台告警，页面无残留。
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
    /** 站立地面与窗口底边的距离。 */
    const FLOOR_GAP = 8;

    const DEFAULT_PREFS = { enabled: true, scale: 0.38, roam: 'calm', startShare: 0.78 };

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

    /* ---------- 桌宠 ---------- */

    /** 加载渲染内核与鲸鱼娘形象包，建体，接指针，驱动帧循环。解析为可释放的句柄。 */
    async function startPet(prefs) {
      const kit = await import(`${ABS}kit/body.js`);
      const whale = await import(`${ABS}whale/figure.js`);

      // 形象包内部按 base 解析纹理与 model.json，必须传它自己的目录（绝对 URL）。
      const figure = await whale.createWhaleFigure(`${ABS}whale/`, {
        kit: { createRig: kit.createRig },
      });

      const root = document.createElement('div');
      root.className = 'cpn-pet-layer';

      const viewport = () => ({
        W: window.innerWidth,
        H: window.innerHeight,
        floorY: window.innerHeight - FLOOR_GAP,
        S: prefs.scale,
      });

      const body = kit.createBody(
        {
          root,
          bounds: viewport,
          emit: () => {},
          sound: () => {},
          start: { x: window.innerWidth * prefs.startShare, facing: -1, enter: 'drop' },
        },
        { figure, bounds: viewport, roam: prefs.roam },
      );

      /* ---- 帧循环 ---- */
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
          hits = body.layout()?.hit ?? [];
        } catch (error) {
          console.warn('[dsh-coopanion-pet] 帧绘制失败，桌宠已停止：', error);
          stopped = true;
          return;
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      /* ---- 指针 ----
         命中判定用渲染内核回报的圆；只有命中才拦事件，其余一律放行。 */
      const onPet = (x, y) => hits.some((c) => Math.hypot(x - c.x, y - c.y) < c.r);
      const point = (event) => ({ x: event.clientX, y: event.clientY, t: event.timeStamp });

      let dragging = false;
      /** 光标形状是否由本插件设置：避免清掉界面自己设的值。 */
      let cursorOwned = false;
      const setCursor = (value) => {
        const root = document.documentElement;
        if (value) {
          root.style.cursor = value;
          cursorOwned = true;
        } else if (cursorOwned) {
          root.style.cursor = '';
          cursorOwned = false;
        }
      };

      const onDown = (event) => {
        if (event.button !== 0 || !onPet(event.clientX, event.clientY)) return;
        dragging = true;
        body.pointer('down', point(event));
        setCursor('grabbing');
        event.preventDefault();
        event.stopPropagation();
      };
      const onMove = (event) => {
        const p = point(event);
        body.pointer('move', p);
        if (dragging) {
          setCursor('grabbing');
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        setCursor(onPet(p.x, p.y) ? 'grab' : '');
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
        setCursor('');
      };

      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      document.addEventListener('pointerleave', onLeave);

      const onResize = () => body.resize();
      window.addEventListener('resize', onResize);

      return {
        root,
        dispose() {
          stopped = true;
          cancelAnimationFrame(raf);
          setCursor('');
          window.removeEventListener('pointerdown', onDown, true);
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
          window.removeEventListener('pointercancel', onUp, true);
          document.removeEventListener('pointerleave', onLeave);
          window.removeEventListener('resize', onResize);
          try {
            body.dispose();
          } catch (error) {
            console.warn('[dsh-coopanion-pet] 释放渲染资源失败：', error);
          }
          root.remove();
        },
      };
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
