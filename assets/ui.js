/**
 * 桌宠身边的操作界面：悬停时出现的按钮条，和右键菜单。
 *
 * 让没有 Agent 在场时也能跟她互动——点一下让她说话、换表情、做动作、
 * 走两步。按钮条出现在她身侧，靠屏幕边缘时自动换到另一侧。
 *
 * 这些元素在覆盖层里，因此自己声明 `pointer-events: auto`；窗口级的指针
 * 命中判定只在光标落在她本体上时才拦事件，所以点按钮不会被拦下。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 按钮条上的一排动作。`run` 是点了之后做什么。 */
const BUTTONS = [
  { id: 'say', icon: '💬', title: '让她说句话' },
  { id: 'face', icon: '🎭', title: '换个表情' },
  { id: 'act', icon: '🤸', title: '做个动作' },
  { id: 'walk', icon: '🚶', title: '走两步' },
  { id: 'dress', icon: '👗', title: '装扮' },
  { id: 'sleep', icon: '😴', title: '睡觉 / 叫醒' },
];

/**
 * 建操作界面。
 *
 * `els`：`{ root }` 放按钮条的容器。
 * `deps`：`{ onCommand(id), onPref(key, value), getPref(key) }`。
 */
export function createTools(els, deps) {
  const { root } = els;
  const { onCommand, onPref, getPref } = deps;

  const bar = document.createElement('div');
  bar.className = 'cpn-tools';
  bar.hidden = true;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '桌宠操作');

  const menu = document.createElement('div');
  menu.className = 'cpn-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');

  for (const b of BUTTONS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'cpn-tool';
    el.dataset.cmd = b.id;
    el.title = b.title;
    el.setAttribute('aria-label', b.title);
    el.textContent = b.icon;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onCommand(b.id);
    });
    bar.appendChild(el);
  }

  /* ---------- 菜单 ---------- */

  const MENU_ITEMS = [
    { id: 'dress', label: () => '装扮…' },
    { id: 'status', label: () => (getPref('statusBubble') === false ? '开启状态气泡' : '关闭状态气泡') },
    { id: 'sound', label: () => (getPref('sound') ? '关闭音效' : '开启音效') },
    { id: 'size', label: () => `体型：${['小', '中', '大'][getPref('sizeIndex') ?? 1]}` },
    { id: 'roam', label: () => `漫游：${['安静', '随意', '活跃'][getPref('roamIndex') ?? 0]}` },
    { id: 'sep' },
    { id: 'home', label: () => '回到原位' },
    { id: 'hide', label: () => '隐藏桌宠' },
  ];

  function buildMenu() {
    menu.innerHTML = '';
    for (const it of MENU_ITEMS) {
      if (it.id === 'sep') {
        const hr = document.createElement('div');
        hr.className = 'cpn-menu-sep';
        menu.appendChild(hr);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cpn-menu-item';
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label();
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideMenu();
        onCommand(it.id);
      });
      menu.appendChild(b);
    }
  }

  function showMenu(x, y) {
    buildMenu();
    menu.hidden = false;
    // 先显示再量尺寸，才能把它收进屏幕
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = `${clamp(x, 8, Math.max(8, window.innerWidth - w - 8))}px`;
    menu.style.top = `${clamp(y, 8, Math.max(8, window.innerHeight - h - 8))}px`;
  }

  function hideMenu() {
    menu.hidden = true;
  }

  /** 点别处、按 Esc、滚动都关掉菜单。 */
  const onDocDown = (e) => {
    if (menu.hidden) return;
    if (!menu.contains(e.target)) hideMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') hideMenu();
  };

  root.append(bar, menu);
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey);

  /* ---------- 摆放 ---------- */

  /**
   * 把按钮条摆到她身侧。
   *
   * `side` 是她身体中心与可及范围（来自渲染内核）；`visible` 由调用方判断。
   * 摆位时留出一条通往她本体的**桥接带**：按钮条不能贴着命中圆外缘，
   * 否则鼠标从她身上移向按钮条时会穿过一段既不在她身上、也不在按钮条上的
   * 空隙，可见性判定当场失效，按钮条在鼠标够到之前就消失了。
   * 因此间距取 `GAP`，并让 `over()` 把这段也算作「在按钮条一侧」。
   */
  const GAP = 10;

  /** 按钮条当前的几何，供 `over()` 判断（含桥接带）。 */
  let placed = null;

  function place(box, side, { visible }) {
    if (!visible) {
      bar.hidden = true;
      placed = null;
      return;
    }
    bar.hidden = false;
    const w = bar.offsetWidth || 200, h = bar.offsetHeight || 34;
    const reach = (side?.reach ?? 46) + GAP;
    const preferRight = side.x + reach + w <= window.innerWidth - 8;
    const left = preferRight ? side.x + reach : side.x - reach - w;
    const top = clamp(side.y - h / 2, 8, Math.max(8, window.innerHeight - h - 8));
    bar.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - w - 8))}px`;
    bar.style.top = `${top}px`;
    // 箭头指向她
    bar.dataset.side = preferRight ? 'left' : 'right';
    // 记下几何：命中判定要用到按钮条与桥接带的位置
    placed = { left: clamp(left, 8, Math.max(8, window.innerWidth - w - 8)), top, w, h, side, preferRight };
  }

  return {
    place,
    showMenu,
    hideMenu,
    get menuOpen() { return !menu.hidden; },
    /**
     * 光标是否落在按钮条 / 菜单上，**或落在她与按钮条之间的桥接带里**。
     *
     * 桥接带是必需的：没有它，鼠标从她身上移向按钮条的途中会有一段
     * 两边都不算的位置，按钮条在那时就被判为「鼠标离开」而收起来，
     * 于是永远够不到。带子横向从按钮条内侧一直延伸到她身体中心，
     * 纵向与按钮条同高。
     */
    over(x, y) {
      for (const el of [bar, menu]) {
        if (el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
      // 按钮条的可见框 + 通往她的那条带
      if (placed && !bar.hidden) {
        const { left, top, w, h, side, preferRight } = placed;
        const cy = top + h / 2;
        // 纵向放宽一点，容得下手抖
        const halfH = h / 2 + 6;
        if (y < cy - halfH || y > cy + halfH) return false;
        // 横向：从按钮条内侧边缘到她的身体中心
        const from = preferRight ? side.x : left + w;
        const to = preferRight ? left : side.x;
        if (x >= Math.min(from, to) && x <= Math.max(from, to)) return true;
      }
      return false;
    },
    dispose() {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
      bar.remove();
      menu.remove();
    },
  };
}

/** 按钮条与菜单的样式。 */
export const TOOLS_CSS = `
.cpn-tools {
  position: fixed; left: 0; top: 0; z-index: 45;
  display: flex; align-items: center; gap: 2px; padding: 4px;
  border-radius: 999px; background: var(--cpn-surface, #fff);
  border: 1.5px solid var(--cpn-line, #E2DFE8);
  box-shadow: 0 6px 18px var(--cpn-shadow, rgba(27,22,38,.16));
  pointer-events: auto;
  animation: cpn-tools-in .18s ease-out;
}
.cpn-tools[hidden] { display: none; }
@keyframes cpn-tools-in { from { opacity: 0; transform: translateY(4px) } }

.cpn-tool {
  display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 50%; background: transparent;
  font-size: 15px; line-height: 1; cursor: pointer;
  transition: background .14s, transform .14s;
}
.cpn-tool:hover { background: var(--cpn-line, #E2DFE8); transform: scale(1.12); }
.cpn-tool:active { transform: scale(.94); }

.cpn-menu {
  position: fixed; left: 0; top: 0; z-index: 46;
  display: flex; flex-direction: column; min-width: 132px; padding: 5px;
  border-radius: 12px; background: var(--cpn-surface, #fff);
  border: 1.5px solid var(--cpn-line, #E2DFE8);
  box-shadow: 0 8px 24px var(--cpn-shadow, rgba(27,22,38,.18));
  pointer-events: auto;
  animation: cpn-menu-in .16s ease-out;
}
.cpn-menu[hidden] { display: none; }
@keyframes cpn-menu-in { from { opacity: 0; transform: scale(.96) } }

.cpn-menu-item {
  font: inherit; font-size: 13px; text-align: left; padding: 6px 10px;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--cpn-text, #1B1626); cursor: pointer; white-space: nowrap;
}
.cpn-menu-item:hover { background: var(--cpn-line, #E2DFE8); }
.cpn-menu-sep { height: 1px; margin: 4px 6px; background: var(--cpn-line, #E2DFE8); }
`;
