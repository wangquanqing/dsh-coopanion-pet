/**
 * 桌宠头顶的气泡：说话（逐字显示）、提问（带选项）、状态。
 *
 * 一个气泡一次只显示一件事，新的顶掉旧的。说话可以分多段（每段一句），
 * 段与段之间留出让读者看完的停顿；文字里的标记会同时触发表情或动作。
 *
 * 摆放：气泡出现在她头顶，尾巴指向她；靠近屏幕边缘时自动收进来，
 * 气泡变宽时尾巴跟着她移动（`tailAt`）。
 *
 * 移植自 Coopanion 的 `web/pet-app.js` 的 say/ask 分支，去掉 World 协议
 * 与「应用对话」那条支路，保留打字机、标记、选项与键盘选择。
 */

import { t } from './i18n.js';

const PAUSE = /[,.!?;:…，。！？；：、]/;
const SILENT = /[\s,.!?;:…，。！？；：、「」『』()（）]/;
const TAIL_CENTER = 70, TAIL_FOLLOW = 130;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const f = (n) => Math.round(n * 10) / 10;

/** 尾巴的尖端落在气泡（宽 `bw`、左边缘在她左侧 `x`）的哪个位置。 */
function tailAt(bw, x) {
  const k = clamp((bw - TAIL_CENTER) / (TAIL_FOLLOW - TAIL_CENTER), 0, 1);
  return bw / 2 + (clamp(x, 22, bw - 22) - bw / 2) * k;
}

/**
 * 建一个气泡控制器。
 *
 * `els`：`{ bubble }` 气泡元素。
 * `deps`：`{ sfx, onTalk, onAct, onAnswer, bounds }`。
 *   `onTalk()` 每打出一个字调用一次（让她的嘴动起来）。
 *   `onAct(actions)` 播放文字里带的动作。
 *   `onAnswer(answer)` 回答了一个提问时调用（`{ index, label }` 或 `{ text }`）。
 */
export function createBubble(els, deps) {
  const { bubble } = els;
  const { sfx, onTalk, onAct, onAnswer, silent } = deps;

  /** 正在显示的东西；null 表示气泡是空的。 */
  let item = null;
  const queue = [];

  /* ---------- 开与关 ---------- */

  function open(kind, html) {
    bubble.className = 'cpn-bubble ' + kind;
    bubble.innerHTML = html;
    bubble.hidden = false;
    void bubble.offsetWidth;
    bubble.classList.add('pop');
  }

  function close() {
    bubble.hidden = true;
    bubble.innerHTML = '';
    item = null;
  }

  /** 把还在排队的提问撤掉；正在显示的那条由 `ask` 决定去留。 */
  function dropQueuedAsks() {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].kind === 'ask') queue.splice(i, 1);
  }

  /* ---------- 说话 ---------- */

  /**
   * 说一段话。`text` 可以带标记：
   *   `【表情, 动作】` 立刻播，然后开始新的气泡；
   *   `<表情>` 打到那个字时播。
   * 说话不打断还没回答的提问：排在她后面。
   */
  function say(text, options = {}) {
    // 34：纯净模式（OBS/录屏抓画面）下她不出声也不出气泡
    if (silent) return;
    const beats = parseBeats(text);
    if (!beats.length) return;
    queue.push({ kind: 'say', beats, marks: options.marks || [] });
  }

  /**
   * 把一段文字切成若干段：`【…】` 是独立的一段（只播动作，不显示文字），
   * 其余按句号等切成句子。
   */
  function parseBeats(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) return [];
    const beats = [];
    // 【…】 段：只播动作
    const parts = raw.split(/(【[^】]*】)/);
    for (const part of parts) {
      if (!part) continue;
      const marker = /^【([^】]*)】$/.exec(part);
      if (marker) {
        beats.push({ actions: parseActions(marker[1]), text: '' });
        continue;
      }
      // 其余按句末标点切句，标点跟着前一句
      const sentences = part.split(/(?<=[。！？!?…；;])/).map((s) => s.trim()).filter(Boolean);
      for (const s of sentences) beats.push({ actions: [], text: s, anchors: anchorsOf(s) });
    }
    return beats;
  }

  /** `【happy, jump】` → `['happy', 'jump']`。 */
  function parseActions(s) {
    return String(s ?? '').split(/[,，、]/).map((w) => w.trim()).filter(Boolean);
  }

  /** 文字里嵌的 `<表情>`：记下它在第几个字，打到那里时播。 */
  function anchorsOf(text) {
    const anchors = [];
    const re = /<([^>]+)>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      anchors.push({ at: m.index, actions: parseActions(m[1]) });
    }
    return anchors;
  }

  /** 去掉标记后的纯文字（标记不显示）。 */
  function plain(text) {
    return String(text ?? '').replace(/<[^>]+>/g, '');
  }

  /* ---------- 提问 ---------- */

  /**
   * 问一个问题。`options` 是最多 3 个选项；`own` 为真时还给她一个自填框。
   * 回答通过 `onAnswer` 回来。
   *
   * 提问是急事：撤掉还在排队的提问，把新的插到队首，并打断正在说的话。
   */
  function ask(question, options = [], { own = true } = {}) {
    // 纯净模式下不弹提问（CUA 确认走的是 `confirm` 命令，那时不会用纯净模式）
    if (silent) return;
    dropQueuedAsks();
    if (item?.kind === 'say') close();
    queue.unshift({ kind: 'ask', question: String(question ?? ''), options, own });
  }

  /* ---------- 推进一步 ---------- */

  /** 每帧调用一次；`dt` 是秒。 */
  function step(dt) {
    if (!item && queue.length) item = queue.shift();
    if (!item) return;

    if (item.kind === 'say') stepSay(item, dt);
    else if (item.kind === 'ask') stepAsk(item, dt);
  }

  function stepSay(it, dt) {
    if (it.i === undefined || it.beatDone) {
      if (it.beatDone && it.holdUntil !== undefined && it.t < it.holdUntil) { it.t += dt; return; }
      it.i = (it.i ?? -1) + 1;
      it.t = 0;
      it.beatDone = false;
      if (it.i >= it.beats.length) { close(); return; }
      const b = it.beats[it.i];
      for (const a of b.actions || []) onAct([a]);
      it.shown = 0;
      it.acc = 0;
      it.fired = 0;
      it.text = plain(b.text);
      it.anchors = b.anchors || [];
      if (it.text) {
        open('say', '<p class="cpn-b-text"></p>');
        sfx.pop();
      } else {
        bubble.hidden = true;
      }
      return;
    }
    if (!it.text) { it.beatDone = true; it.t = 0; it.holdUntil = 0.8; return; }
    typeText(it, dt);
    if (it.shown >= it.text.length) {
      it.beatDone = true;
      const last = it.i === it.beats.length - 1;
      it.t = 0;
      it.holdUntil = last ? 1.6 + it.text.length * 0.07 : 0.9 + it.text.length * 0.03;
    }
  }

  function typeText(it, dt) {
    const p = bubble.querySelector('.cpn-b-text');
    if (!p || it.shown >= it.text.length) return;
    it.acc += dt * 20;
    while (it.acc >= 1 && it.shown < it.text.length) {
      const ch = it.text[it.shown++];
      it.acc -= PAUSE.test(ch) ? 5 : 1;
      if (!SILENT.test(ch)) { sfx.babble(ch); onTalk?.(); }
      while (it.fired < it.anchors.length && it.anchors[it.fired].at <= it.shown) {
        onAct(it.anchors[it.fired++].actions);
      }
    }
    p.textContent = it.text.slice(0, it.shown);
  }

  function stepAsk(it, dt) {
    if (it.shown === undefined) {
      open('ask', `<p class="cpn-b-text"></p><div class="cpn-b-opts" hidden></div>`);
      sfx.pop();
      it.shown = 0;
      it.acc = 0;
      it.text = plain(it.question);
    }
    if (it.shown < it.text.length) {
      it.acc += dt * 20;
      while (it.acc >= 1 && it.shown < it.text.length) {
        const ch = it.text[it.shown++];
        it.acc -= PAUSE.test(ch) ? 5 : 1;
        if (!SILENT.test(ch)) { sfx.babble(ch); onTalk?.(); }
      }
      bubble.querySelector('.cpn-b-text').textContent = it.text.slice(0, it.shown);
      return;
    }
    if (!it.optsShown) { it.optsShown = true; showOptions(it); }
  }

  function showOptions(it) {
    const box = bubble.querySelector('.cpn-b-opts');
    box.hidden = false;
    it.buttons = [];
    it.options.slice(0, 3).forEach((label, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cpn-b-opt';
      b.innerHTML = `<kbd>${i + 1}</kbd><span>${esc(label)}</span>`;
      b.addEventListener('click', () => answer(it, { index: i, label }));
      box.appendChild(b);
      it.buttons.push(b);
    });
    if (it.own) {
      const row = document.createElement('form');
      row.className = 'cpn-b-own';
      row.innerHTML = `<input type="text" maxlength="200" placeholder="${esc(t('bubble.own'))}"><button type="submit">${esc(t('bubble.send'))}</button>`;
      row.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = row.querySelector('input');
        const text = input.value.trim();
        if (text) answer(it, { text });
      });
      box.appendChild(row);
      it.input = row.querySelector('input');
    }
  }

  function answer(it, a) {
    if (it.answered) return;
    it.answered = true;
    sfx.select();
    onAnswer?.(a);
    close();
    step(0);
  }

  /* ---------- 键盘 ---------- */

  /** 提问显示时按 1–3 直接选；返回是否吃掉了这个按键。 */
  function handleKey(e) {
    if (!item || item.kind !== 'ask' || !item.optsShown) return false;
    if (e.key === 'Escape') { dismiss(); return true; }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= (item.buttons?.length ?? 0)) {
      const i = n - 1;
      answer(item, { index: i, label: item.options[i] });
      return true;
    }
    if (item.input && document.activeElement !== item.input && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      item.input.focus();
      return false;
    }
    return false;
  }

  /** 放弃当前提问。 */
  function dismiss() {
    if (item?.kind === 'ask' && !item.answered) { item.answered = true; onAnswer?.({ dismissed: true }); }
    close();
  }

  /* ---------- 摆放 ---------- */

  /** 把气泡摆到她头顶（`anchor` 是头顶位置，`facing` 是朝向）。 */
  function place(anchor, facing) {
    if (bubble.hidden) return null;
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    if (!bw) return null;
    const cx = anchor.x + (facing ?? 1) * 26;
    const left = clamp(cx - bw / 2, 10, Math.max(10, window.innerWidth - bw - 10));
    const top = Math.max(8, anchor.y - bh - 18);
    bubble.style.left = f(left) + 'px';
    bubble.style.top = f(top) + 'px';
    bubble.style.setProperty('--cpn-tail', f(tailAt(bw, anchor.x - left)) + 'px');
    return { left, top, bw, bh };
  }

  return {
    say,
    ask,
    step,
    place,
    close,
    dismiss,
    handleKey,
    /** 气泡是否正显示着东西。 */
    get busy() { return item !== null || queue.length > 0; },
    /** 当前是否有待回答的提问。 */
    get asking() { return item?.kind === 'ask' && !item.answered; },
  };
}
