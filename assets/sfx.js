/**
 * 桌宠的声音：全部用 Web Audio 合成，不带任何音频素材，因此不增加包体积。
 *
 * 声音按类别分（`SOUND_KINDS`），每类可以单独静音。身体自己会点名要声音
 * （走路、被抓住、表情），页面也在关键处点名（说话、界面动作）。
 *
 * 移植自 Coopanion 的 `web/sound.js`，去掉形象包自带音频文件那条支路
 * （本插件只用合成音），并把存储键改为本插件的命名空间。
 */

/** 每个声音属于哪一类；一类可以单独静音（`configure`）。 */
export const SOUND_KINDS = {
  move: ['step', 'skid', 'jump', 'land', 'whoosh', 'chirps', 'shake', 'nod', 'spin', 'shiver', 'dance', 'look'],
  touch: ['grab', 'squeak', 'purr', 'poke'],
  face: ['happy', 'wink', 'love', 'surprised', 'angry', 'sad', 'shy', 'yawn'],
  snore: ['snore'],
  talk: ['babble', 'blub'],
  ui: ['tick', 'pop', 'sparkle', 'select'],
};

const KIND_OF = Object.fromEntries(
  Object.entries(SOUND_KINDS).flatMap(([kind, names]) => names.map((n) => [n, kind])),
);

const STORAGE_KEY = 'dsh-coopanion-pet:sound';

/**
 * 建一个音效播放器。所有 `play` 调用在音频上下文解锁前都是空操作：
 * 浏览器的自动播放策略要求先有一次用户手势。
 */
export function createSfx({ volume = 0.55 } = {}) {
  let ctx = null, master = null, unlocked = false, on = true, noiseBuf = null, gainValue = volume;
  let muted = new Set(), snoreSeconds = 0;

  try {
    on = localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch (error) {
    /* 读不到就用默认值（开）。 */
  }

  const R = (a, b) => a + Math.random() * (b - a);

  function ready() {
    if (!on || !unlocked || document.hidden) return null;
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = gainValue;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.1, vol = 0.2, at = 0, attack = 0.005, vib = 0, vibRate = 0, filter = 0 }) {
    const c = ready();
    if (!c) return;
    const t0 = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    if (vib) {
      const l = c.createOscillator(), lg = c.createGain();
      l.frequency.value = vibRate;
      lg.gain.value = vib;
      l.connect(lg);
      lg.connect(o.frequency);
      l.start(t0);
      l.stop(t0 + dur + 0.05);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = o;
    if (filter) {
      const bq = c.createBiquadFilter();
      bq.type = 'lowpass';
      bq.frequency.value = filter;
      o.connect(bq);
      node = bq;
    }
    node.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  function noise({ type = 'bandpass', f0 = 1000, f1 = f0, q = 1, dur = 0.2, vol = 0.15, at = 0, attack = 0.01 }) {
    const c = ready();
    if (!c) return;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = c.currentTime + at, s = c.createBufferSource(), bq = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noiseBuf;
    bq.type = type;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t0);
    bq.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(bq);
    bq.connect(g);
    g.connect(master);
    s.start(t0, Math.random() * 0.5);
    s.stop(t0 + dur + 0.03);
  }

  const tones = {
    step(run, i) {
      const k = run ? 1.25 : 1;
      tone({ f0: (i ? 520 : 440) * k, f1: (i ? 380 : 330) * k, dur: 0.06, vol: run ? 0.07 : 0.05 });
      if (run) noise({ f0: 2500, q: 0.8, dur: 0.05, vol: 0.03 });
    },
    skid() { noise({ type: 'highpass', f0: 1800, f1: 900, dur: 0.22, vol: 0.08 }); },
    jump() { tone({ type: 'triangle', f0: 200, f1: 720, dur: 0.24, vol: 0.22, vib: 40, vibRate: 22 }); },
    land(hard) {
      tone({ f0: hard ? 160 : 190, f1: 48, dur: hard ? 0.28 : 0.16, vol: hard ? 0.4 : 0.25 });
      noise({ type: 'lowpass', f0: hard ? 700 : 500, f1: 120, dur: 0.12, vol: hard ? 0.25 : 0.12 });
      if (hard) tone({ type: 'square', f0: 420, f1: 300, dur: 0.08, vol: 0.06, at: 0.02, filter: 1600 });
    },
    grab() { tone({ type: 'triangle', f0: 680, f1: 1500, dur: 0.14, vol: 0.18, vib: 60, vibRate: 30 }); },
    squeak() { tone({ type: 'triangle', f0: R(900, 1200), f1: R(1300, 1700), dur: 0.09, vol: 0.08, vib: 40, vibRate: 35 }); },
    whoosh() { noise({ f0: 300, f1: 2400, q: 1.4, dur: 0.38, vol: 0.22, attack: 0.08 }); },
    chirps() { for (let i = 0; i < 3; i++) tone({ f0: 2300 + i * 120, f1: 3200, dur: 0.06, vol: 0.06, at: i * 0.11 }); },
    shake() { for (let i = 0; i < 5; i++) tone({ type: 'square', f0: 180, f1: 160, dur: 0.05, vol: 0.05, at: i * 0.06, filter: 900 }); },
    hmm() { tone({ type: 'triangle', f0: 330, f1: 360, dur: 0.12, vol: 0.08 }); tone({ type: 'triangle', f0: 392, f1: 470, dur: 0.16, vol: 0.08, at: 0.14 }); },
    yawn() { tone({ type: 'triangle', f0: 520, f1: 240, dur: 1, vol: 0.1, vib: 12, vibRate: 5, filter: 1500, attack: 0.15 }); },
    snore() { noise({ type: 'lowpass', f0: 250, f1: 700, dur: 0.7, vol: 0.09, attack: 0.35 }); },
    purr() { tone({ type: 'sawtooth', f0: 62, f1: 58, dur: 0.9, vol: 0.08, vib: 6, vibRate: 24, filter: 320, attack: 0.1 }); },
    poke() { tone({ f0: 320, f1: 200, dur: 0.09, vol: 0.16 }); },
    shiver() { for (let i = 0; i < 8; i++) tone({ type: 'square', f0: 900, f1: 820, dur: 0.03, vol: 0.035, at: i * 0.07, filter: 2400 }); },
    look() { tones.hmm(); },
    dance() { [523, 659, 784, 659, 880].forEach((fr, i) => tone({ type: 'triangle', f0: fr, dur: 0.13, vol: 0.09, at: i * 0.15 })); },
    nod() { tone({ type: 'triangle', f0: 520, f1: 440, dur: 0.07, vol: 0.08 }); tone({ type: 'triangle', f0: 520, f1: 440, dur: 0.07, vol: 0.08, at: 0.2 }); },
    spin() { tone({ type: 'triangle', f0: 300, f1: 1200, dur: 0.3, vol: 0.12, vib: 30, vibRate: 18 }); },
    happy() { tone({ type: 'triangle', f0: 660, f1: 700, dur: 0.1, vol: 0.14 }); tone({ type: 'triangle', f0: 990, f1: 1050, dur: 0.14, vol: 0.14, at: 0.09 }); },
    wink() { tone({ f0: 1760, dur: 0.5, vol: 0.1 }); tone({ f0: 2637, dur: 0.45, vol: 0.06, at: 0.04 }); },
    love() { tone({ f0: 480, f1: 820, dur: 0.1, vol: 0.14 }); tone({ f0: 600, f1: 1000, dur: 0.12, vol: 0.14, at: 0.13 }); },
    surprised() { tone({ f0: 380, f1: 1500, dur: 0.2, vol: 0.16, vib: 15, vibRate: 12 }); },
    angry() { tone({ type: 'sawtooth', f0: 120, f1: 95, dur: 0.5, vol: 0.12, vib: 12, vibRate: 14, filter: 700 }); },
    sad() { tone({ type: 'triangle', f0: 440, f1: 392, dur: 0.3, vol: 0.13, vib: 8, vibRate: 6 }); tone({ type: 'triangle', f0: 392, f1: 262, dur: 0.55, vol: 0.13, at: 0.3, vib: 10, vibRate: 5 }); },
    shy() { tone({ f0: 1300, f1: 1600, dur: 0.07, vol: 0.07 }); tone({ f0: 1450, f1: 1750, dur: 0.07, vol: 0.06, at: 0.1 }); },
    tick() { tone({ f0: 1200, f1: 1000, dur: 0.03, vol: 0.05 }); },
    pop() { tone({ f0: 240, f1: 720, dur: 0.07, vol: 0.14 }); },
    sparkle() { [1568, 2093, 2637].forEach((fr, i) => tone({ f0: fr, dur: 0.25, vol: 0.06, at: i * 0.06 })); },
    select() { tone({ type: 'triangle', f0: 520, f1: 1040, dur: 0.1, vol: 0.12 }); },
    babble(ch) {
      const fr = 330 + (ch.codePointAt(0) % 9) * 28;
      tone({ type: 'square', f0: fr, f1: fr * R(0.85, 1.1), dur: 0.05, vol: 0.05, filter: 1800 });
    },
    blub() { tone({ f0: R(500, 700), f1: R(900, 1200), dur: 0.05, vol: 0.05 }); },
  };

  const api = {
    /** 第一次用户手势时调用：解锁音频上下文。 */
    unlock() { unlocked = true; ready(); },
    isOn: () => on,
    set(v) {
      on = v;
      try { localStorage.setItem(STORAGE_KEY, v ? 'on' : 'off'); } catch (error) { /* 存不下就算了 */ }
    },
    volume(v) { gainValue = v; if (master) master.gain.value = v; },
    /** 分类开关；`snoreSeconds` 是入睡多久后停止鼾声，0 表示一直响。 */
    configure({ kinds, snoreSeconds: s } = {}) {
      if (kinds) muted = new Set(Object.keys(SOUND_KINDS).filter((k) => kinds[k] === false));
      if (typeof s === 'number' && s >= 0) snoreSeconds = s;
    },
    /**
     * 身体点名的声音。`kind` 是身体自己的分类（移动、触碰、表情、鼾声），
     * 否则按声音名的固有分类判断。
     */
    play(name, kind, ...args) {
      const k = ['move', 'touch', 'face', 'snore'].includes(kind) ? kind : KIND_OF[name];
      if (muted.has(k)) return;
      if (k === 'snore' && snoreSeconds > 0 && args[0] > snoreSeconds) return;
      if (Object.hasOwn(tones, name)) tones[name](...args);
    },
  };

  // 页面自己的点名调用（sfx.pop()）：按固有分类静音。
  for (const name of Object.keys(tones)) {
    api[name] = (...args) => { if (!muted.has(KIND_OF[name])) tones[name](...args); };
  }

  return api;
}
