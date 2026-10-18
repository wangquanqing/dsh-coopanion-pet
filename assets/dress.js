/**
 * 装扮面板：换配色、换服装。
 *
 * 形象包把装扮定义为两条轴（`model.json` 的 `schemes` 与 `outfits`），
 * 组合成一个 `scheme` 字符串 `配色-服装` 交给渲染内核。切换时会重新加载
 * 那一套纹理并上传到 WebGL，因此面板上给个「正在换」的反馈。
 *
 * 面板挂在桌宠旁边，可拖动标题栏移动；关闭后记住位置。
 *
 * 文案走 i18n.js；配色名（DeepSeek、Claude…）是品牌名，不翻译。
 */

import { t } from './i18n.js';

/** 各套配色的显示名与主色（主色用于色块，取自 model.json 的 accent）。 */
const SCHEMES = [
  { id: 'deepseek', name: 'DeepSeek', accent: '#4D6BFE' },
  { id: 'harness', name: 'Harness', accent: '#555555' },
  { id: 'chatgpt', name: 'ChatGPT', accent: '#303030' },
  { id: 'claude', name: 'Claude', accent: '#D97757' },
  { id: 'gemini', name: 'Gemini', accent: '#4285F4' },
  { id: 'qwen', name: 'Qwen', accent: '#7F69F0' },
  { id: 'kimi', name: 'Kimi', accent: '#007CFF' },
  { id: 'minimax', name: 'MiniMax', accent: '#D92D7A' },
];

/** 两套服装。`cape` 是冬装。 */
const OUTFITS = [
  { id: 'maid', key: 'outfit.maid' },
  { id: 'cape', key: 'outfit.cape' },
];

/**
 * 建装扮面板。
 *
 * `deps`：`{ getScheme(), setScheme(id), onPref(key, value) }`。
 *   `setScheme` 返回 Promise（换装要加载纹理）。
 */
export function createDress(deps) {
  const { getScheme, setScheme, onPref } = deps;

  const root = document.createElement('div');
  root.className = 'cpn-dress';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('dress.aria'));

  root.innerHTML = `
    <header class="cpn-dress-head">
      <span class="cpn-dress-title">${t('dress.title')}</span>
      <button type="button" class="cpn-dress-close" aria-label="${t('dress.close')}">×</button>
    </header>
    <div class="cpn-dress-body">
      <div class="cpn-dress-row">
        <span class="cpn-dress-label">${t('dress.scheme')}</span>
        <div class="cpn-dress-swatches" data-group="scheme"></div>
      </div>
      <div class="cpn-dress-row">
        <span class="cpn-dress-label">${t('dress.outfit')}</span>
        <div class="cpn-dress-chips" data-group="outfit"></div>
      </div>
    </div>
    <p class="cpn-dress-hint" hidden>${t('dress.busy')}</p>
  `;

  const swatches = root.querySelector('[data-group="scheme"]');
  const chips = root.querySelector('[data-group="outfit"]');
  const hint = root.querySelector('.cpn-dress-hint');

  /** 当前选择，从 `getScheme()` 解析（形如 `deepseek-maid`）。 */
  let scheme = 'deepseek', outfit = 'maid';

  function parse(id) {
    const [a, b] = String(id ?? '').split('-');
    return {
      scheme: SCHEMES.some((s) => s.id === a) ? a : SCHEMES[0].id,
      outfit: OUTFITS.some((o) => o.id === b) ? b : OUTFITS[0].id,
    };
  }

  for (const s of SCHEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cpn-swatch';
    b.dataset.id = s.id;
    b.title = s.name;
    b.setAttribute('aria-label', t('dress.schemeAria', { name: s.name }));
    b.innerHTML = `<i style="background:${s.accent}"></i><span>${s.name}</span>`;
    b.addEventListener('click', () => apply({ scheme: s.id }));
    swatches.appendChild(b);
  }

  for (const o of OUTFITS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cpn-chip';
    b.dataset.id = o.id;
    b.textContent = t(o.key);
    b.addEventListener('click', () => apply({ outfit: o.id }));
    chips.appendChild(b);
  }

  /** 换一套，并把选择落到内核与偏好里。 */
  async function apply(patch) {
    const next = { ...parse(`${scheme}-${outfit}`), ...patch };
    const id = `${next.scheme}-${next.outfit}`;
    if (id === `${scheme}-${outfit}`) return;
    /**
     * **先试再落盘**：纹理加载失败或形象包不认这个 id 时，若照旧把偏好写成
     * 新值，下次开页面还会去恢复这个坏值，于是「一直坏着」——用户以为换过了，
     * 实际每次都在失败（实测确认过的问题）。
     */
    const prevScheme = scheme;
    const prevOutfit = outfit;
    scheme = next.scheme;
    outfit = next.outfit;
    paint();
    hint.hidden = false;
    try {
      await setScheme(id, { fade: 0.4 });
    } catch (error) {
      console.warn('[dsh-coopanion-pet] 换装失败：', error);
      // 退回原来的装扮，且**不落盘**
      scheme = prevScheme;
      outfit = prevOutfit;
      paint();
      hint.hidden = true;
      return;
    }
    hint.hidden = true;
    onPref('scheme', id);
  }

  /** 把选中态画到按钮上。 */
  function paint() {
    for (const b of swatches.children) b.classList.toggle('on', b.dataset.id === scheme);
    for (const b of chips.children) b.classList.toggle('on', b.dataset.id === outfit);
  }

  /* ---------- 拖动 ---------- */

  let drag = null;
  const head = root.querySelector('.cpn-dress-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cpn-dress-close')) return;
    const r = root.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = Math.max(8, Math.min(e.clientX - drag.dx, window.innerWidth - root.offsetWidth - 8));
    const y = Math.max(8, Math.min(e.clientY - drag.dy, window.innerHeight - root.offsetHeight - 8));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = 'auto';
    e.preventDefault();
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    head.releasePointerCapture?.(e.pointerId);
    // 记住位置
    onPref('dressPos', { x: parseInt(root.style.left, 10), y: parseInt(root.style.top, 10) });
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  root.querySelector('.cpn-dress-close').addEventListener('click', () => hide());

  /* ---------- 显示与隐藏 ---------- */

  function show(anchor, pos) {
    const parsed = parse(getScheme());
    scheme = parsed.scheme;
    outfit = parsed.outfit;
    paint();
    root.hidden = false;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      root.style.left = `${pos.x}px`;
      root.style.top = `${pos.y}px`;
      root.style.right = 'auto';
    } else {
      // 默认摆在她上方，靠边时自动收进来
      const w = root.offsetWidth, h = root.offsetHeight;
      const x = Math.max(8, Math.min((anchor?.x ?? window.innerWidth / 2) - w / 2, window.innerWidth - w - 8));
      const y = Math.max(8, (anchor?.y ?? window.innerHeight) - h - 130);
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
      root.style.right = 'auto';
    }
  }

  function hide() {
    root.hidden = true;
  }

  return {
    root,
    show,
    hide,
    apply,
    get visible() { return !root.hidden; },
    dispose() { root.remove(); },
  };
}

/** 装扮面板的样式。 */
export const DRESS_CSS = `
.cpn-dress {
  position: fixed; z-index: 48; width: 246px;
  border-radius: 14px; background: var(--cpn-surface, #fff);
  border: 1.5px solid var(--cpn-line, #E2DFE8);
  box-shadow: 0 12px 32px var(--cpn-shadow, rgba(27,22,38,.2));
  color: var(--cpn-text, #1B1626);
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans", sans-serif;
  font-size: 13px;
  pointer-events: auto;
  animation: cpn-dress-in .18s ease-out;
}
.cpn-dress[hidden] { display: none; }
@keyframes cpn-dress-in { from { opacity: 0; transform: translateY(6px) } }

.cpn-dress-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 10px 7px 13px; cursor: grab;
  border-bottom: 1px solid var(--cpn-line, #E2DFE8);
}
.cpn-dress-head:active { cursor: grabbing; }
.cpn-dress-title { font-weight: 600; font-size: 13px; }
.cpn-dress-close {
  display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 50%; background: transparent;
  color: var(--cpn-muted, #6A6577); font-size: 16px; line-height: 1; cursor: pointer;
}
.cpn-dress-close:hover { color: var(--cpn-text, #1B1626); background: var(--cpn-line, #E2DFE8); }

.cpn-dress-body { display: flex; flex-direction: column; gap: 10px; padding: 11px 13px 13px; }
.cpn-dress-row { display: flex; flex-direction: column; gap: 6px; }
.cpn-dress-label { font-size: 11.5px; color: var(--cpn-muted, #6A6577); }

.cpn-dress-swatches { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.cpn-swatch {
  display: flex; align-items: center; gap: 6px; padding: 5px 7px;
  border: 1.5px solid var(--cpn-line, #E2DFE8); border-radius: 9px;
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  cursor: pointer; transition: border-color .14s;
}
.cpn-swatch:hover { border-color: var(--cpn-muted, #6A6577); }
.cpn-swatch.on { border-color: var(--cpn-eye, #00A870); }
.cpn-swatch i { flex: none; width: 11px; height: 11px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(0,0,0,.14); }
.cpn-swatch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cpn-dress-chips { display: flex; gap: 6px; }
.cpn-chip {
  flex: 1; padding: 5px 0; border: 1.5px solid var(--cpn-line, #E2DFE8);
  border-radius: 9px; background: transparent; color: inherit;
  font: inherit; font-size: 12px; cursor: pointer; transition: border-color .14s;
}
.cpn-chip:hover { border-color: var(--cpn-muted, #6A6577); }
.cpn-chip.on { border-color: var(--cpn-eye, #00A870); }

.cpn-dress-hint { margin: 0; padding: 0 13px 11px; font-size: 11.5px; color: var(--cpn-muted, #6A6577); }
.cpn-dress-hint[hidden] { display: none; }
`;
