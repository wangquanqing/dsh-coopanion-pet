/**
 * Coo, the built-in figure: its drawing (a C-shaped body with two ring eyes and two short legs),
 * its palettes and accessories, and the skin that picks them. The Coo pack (figure.js here) draws
 * with it inside the figure frame; the pages use it for the menu's avatar, the dressing page's
 * tiles and the colours of their own bubbles and buttons, which follow Coo's palette.
 *
 * Coordinates: logo units, facing right, ground at y=256 (the kit's space, web/kit/body.js).
 */
import { DROP, FACES, LEG_W, STAND, f, heartD } from '../kit/body.js';

const EYES = [[113, 117], [163, 117]];
const BODY_W = 36;
const pol = (a, r) => [128 + r * Math.cos(a * Math.PI / 180), 128 - r * Math.sin(a * Math.PI / 180)];
const pt = p => `${f(p[0])} ${f(p[1])}`;

function cPath(gt, gb) {
  return `M${pt(pol(gt, 84))}A84 84 0 1 0 ${pt(pol(-gb, 84))}`;
}
function ellipse(cx, cy, rx, ry) {
  if (ry < 1.6) return `M${f(cx - rx)} ${f(cy)}L${f(cx + rx)} ${f(cy)}`;
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}
function eyePath(e, cx, cy) {
  cx += e.dx || 0; cy += e.dy || 0;
  switch (e.shape) {
    case 'ring': return ellipse(cx, cy, e.rx, e.ry);
    case 'lid': return e.ry < 1.6 ? `M${f(cx - 16)} ${f(cy)}L${f(cx + 16)} ${f(cy)}` : `M${f(cx - 16)} ${f(cy)}A16 ${f(e.ry)} 0 0 0 ${f(cx + 16)} ${f(cy)}Z`;
    case 'up': return `M${f(cx - 15)} ${f(cy + 6)}Q${f(cx)} ${f(cy - 17)} ${f(cx + 15)} ${f(cy + 6)}`;
    case 'down': return `M${f(cx - 15)} ${f(cy - 3)}Q${f(cx)} ${f(cy + 15)} ${f(cx + 15)} ${f(cy - 3)}`;
    case 'gt': return `M${f(cx - 10)} ${f(cy - 13)}L${f(cx + 11)} ${f(cy)}L${f(cx - 10)} ${f(cy + 13)}`;
    case 'lt': return `M${f(cx + 10)} ${f(cy - 13)}L${f(cx - 11)} ${f(cy)}L${f(cx + 10)} ${f(cy + 13)}`;
    case 'heart': return heartD(cx, cy, e.s);
    case 'spiral': {
      let d = '';
      const max = Math.PI * 4.4;
      for (let i = 0; i <= 44; i++) {
        const a = max * i / 44, r = 2 + 15 * i / 44;
        d += (i ? 'L' : 'M') + f(cx + r * Math.cos(a + e.rot)) + ' ' + f(cy + r * Math.sin(a + e.rot));
      }
      return d;
    }
  }
  return '';
}

/* ---------- accessories ----------
   Solid shapes first; lines only where a piece is a line (band, stalk, frame), never thinner than 10.
   Every part is painted through a color channel: c-<slot>-main / c-<slot>-acc. The names people see
   are in figure.json (palettes and accessories) and the pages' tables (`color.<id>`). */
export const PALETTES = [
  { id: 'mint',      l: ['#1B1626', '#00A870'], d: ['#FFFFFF', '#2FD59B'] },
  { id: 'mono',      l: ['#1B1626', '#1B1626'], d: ['#FFFFFF', '#FFFFFF'] },
  { id: 'navigator', l: ['#14213A', '#1F6FE0'], d: ['#FFFFFF', '#5EA3FF'] },
  { id: 'claude',    l: ['#2A1C16', '#C9623F'], d: ['#FFFFFF', '#E58B69'] },
  { id: 'fox',       l: ['#26140F', '#DD3526'], d: ['#FFFFFF', '#FF6655'] },
  { id: 'purple',    l: ['#1D1430', '#8B3DF0'], d: ['#FFFFFF', '#B98AFF'] },
  { id: 'lemon',     l: ['#252010', '#D9B300'], d: ['#FFFFFF', '#FFE14F'] },
  // after principles of Cultist Simulator, offered with the personas of the same names (core/guide.ts): the dark
  // theme's eyes take the principle's colour on the game's wiki, the light theme's a deeper shade of the same hue
  { id: 'lantern',   l: ['#252010', '#C9A000'], d: ['#FFFFFF', '#FFE300'] },
  { id: 'grail',     l: ['#2A120F', '#E0452F'], d: ['#FFFFFF', '#FE6150'] },
  { id: 'forge',     l: ['#2A1A10', '#E06A12'], d: ['#FFFFFF', '#FF8E3E'] },
  { id: 'heart',     l: ['#2A1420', '#D9506A'], d: ['#FFFFFF', '#FE7E8B'] },
  { id: 'winter',    l: ['#12202A', '#3A9DC4'], d: ['#FFFFFF', '#BEEEFF'] },
];
export const HEADS = ['none', 'cat', 'bear', 'bunny', 'antenna', 'halo', 'tophat', 'party', 'sailor'];
export const SIDES = ['none', 'headphones', 'feather', 'earring', 'clip', 'bow'];
export const GLASSES = ['none', 'round', 'square', 'monocle'];
export const NECKS = ['none', 'bowtie', 'bell', 'scarf'];
export const HEAD_TOP = { none: 12, cat: -14, bear: -4, bunny: -34, antenna: -34, halo: -8, tophat: -28, party: -34, sailor: -20 };

/* color mapping: channel -> source. 'body' / 'eye' follow the palette; the rest are fixed accessory colors with a dark twin */
export const ACC_COLORS = [
  { id: 'mint',      l: '#00A870', d: '#2FD59B' },
  { id: 'leaf',      l: '#3C9A2C', d: '#80D46B' },
  { id: 'lemon',     l: '#D9B300', d: '#FFE14F' },
  { id: 'fox',       l: '#DD3526', d: '#FF6655' },
  { id: 'claude',    l: '#C9623F', d: '#E58B69' },
  { id: 'rose',      l: '#DB3F76', d: '#FF85AE' },
  { id: 'purple',    l: '#8B3DF0', d: '#B98AFF' },
  { id: 'navigator', l: '#1F6FE0', d: '#5EA3FF' },
  { id: 'holo',      l: '#1AA3D9', d: '#6FD3FF' },
];
export const LINKED = [{ id: 'body' }, { id: 'eye' }];
export const SLOTS = ['head', 'side', 'glasses', 'neck'];
export const SLOT_LISTS = { head: HEADS, side: SIDES, glasses: GLASSES, neck: NECKS };
export const CHANNEL_DEFAULT = { head: { main: 'body', acc: 'eye' }, side: { main: 'eye', acc: 'eye' }, glasses: { main: 'body', acc: 'eye' }, neck: { main: 'eye', acc: 'eye' } };
// side and neck pieces lie on top of the body outline: mapping them to the body color would make them vanish
export const NO_BODY = { head: false, side: true, glasses: false, neck: true };
// character pieces carry their original colors; picking one fills its channels, which stay editable afterwards
export const ITEM_COLORS = {
  sailor: { main: 'body', acc: 'navigator' },
  feather: { main: 'holo', acc: 'navigator' },
  headphones: { main: 'claude', acc: 'holo' },
};
export const ROLES = {
  cat: ['main'], bear: ['main'], bunny: ['main'], antenna: ['main', 'acc'], halo: ['acc'],
  tophat: ['main', 'acc'], party: ['main', 'acc'], round: ['main'], square: ['main'], monocle: ['main'],
  bowtie: ['main'], bell: ['main', 'acc'], scarf: ['main'], sailor: ['main', 'acc'],
  headphones: ['main', 'acc'], feather: ['main', 'acc'], earring: ['main'], clip: ['main'], bow: ['main'],
};

const mount = (a, r = 96) => `translate(${pt(pol(a, r))}) rotate(${f(90 - a)})`;
const stroke = (cls, w) => `class="${cls}" fill="none" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
// solid shape with rounded corners: filled and stroked in the same channel color
const blob = (slot, ch, w) => `class="f-${slot}-${ch} c-${slot}-${ch}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;

function headBack(id, sw) {
  switch (id) {
    case 'cat':
      return [126, 82].map(a => `<path ${blob('head', 'main', 10)} transform="${mount(a)}" d="M-17 8L0 -28L17 8Z"/>`).join('');
    case 'bear':
      return [128, 80].map(a => `<circle class="f-head-main" transform="${mount(a)}" cx="0" cy="-8" r="18"/>`).join('');
    case 'bunny':
      return [[116, -10, .7], [92, 6, 1]].map(([a, off, k]) =>
        `<g transform="${mount(a)} rotate(${f(off + sw * k)})"><ellipse class="f-head-main" cx="0" cy="-28" rx="14" ry="30"/></g>`).join('');
    case 'antenna':
      return `<g transform="${mount(98)} rotate(${f(sw)})"><path ${stroke('c-head-main', 14)} d="M0 0Q5 -20 0 -38"/><circle class="f-head-acc" cx="0" cy="-50" r="12"/></g>`;
  }
  return '';
}
function headFront(id, sw, t) {
  switch (id) {
    case 'sailor':
      return `<g transform="${mount(106)} rotate(${f(sw * .2)})"><path class="f-head-main" d="M-34 3L-38 -30Q0 -40 38 -30L34 3Q0 -3 -34 3Z"/><path class="f-head-acc" d="M-37.1 -23Q0 -31 37.1 -23L36.1 -15Q0 -23 -36.1 -15ZM-35.6 -11Q0 -19 35.6 -11L34.8 -4Q0 -12 -34.8 -4Z"/></g>`;
    case 'halo':
      return `<g transform="${mount(98)}"><ellipse ${stroke('c-head-acc', 12)} cx="0" cy="${f(-28 + 3 * Math.sin(t * 2.2))}" rx="36" ry="9"/></g>`;
    case 'tophat':
      return `<g transform="${mount(104)} rotate(${f(sw * .2)})"><rect class="f-head-main" x="-40" y="-7" width="80" height="12" rx="6"/><rect class="f-head-main" x="-22" y="-48" width="44" height="46" rx="7"/><rect class="f-head-acc" x="-22" y="-20" width="44" height="10"/></g>`;
    case 'party':
      return `<g transform="${mount(110)} rotate(${f(sw * .3)})"><path ${blob('head', 'main', 8)} d="M-24 2L0 -46L24 2Z"/><circle class="f-head-acc" cx="0" cy="-55" r="11"/></g>`;
  }
  return '';
}
// Side pieces sit where an ear would be on this profile: the back of the head, around 130–172°.
function sideBack(id, sw) {
  if (id !== 'feather') return '';
  const blade = (L, w) => `M0 0C${-w} ${f(-L * .3)} ${f(-w * .8)} ${f(-L * .8)} ${f(-L * .14)} ${-L}C${f(w * .6)} ${f(-L * .75)} ${w} ${f(-L * .3)} 0 0Z`;
  return `<g transform="${mount(166, 92)} rotate(${f(sw * .6)})">` +
    `<path class="f-side-acc" transform="rotate(58)" d="${blade(66, 18)}"/>` +
    `<path class="f-side-main" transform="rotate(26)" d="${blade(56, 16)}"/>` +
    `<path class="f-side-main" d="${blade(42, 14)}"/></g>`;
}
function sideFront(id, sw) {
  switch (id) {
    case 'headphones':
      return `<path ${stroke('c-side-main', 16)} d="M${pt(pol(150, 113))}A113 113 0 0 1 ${pt(pol(76, 113))}"/>` +
        `<rect class="f-side-acc" transform="${mount(166, 98)}" x="-24" y="-17" width="48" height="34" rx="17"/>`;
    case 'earring':
      return `<g transform="translate(${pt(pol(172, 99))}) rotate(${f(sw * .8)})"><circle class="f-side-main" cx="0" cy="13" r="10"/></g>`;
    case 'clip':
      return `<rect class="f-side-main" transform="${mount(140, 86)}" x="-17" y="-6.5" width="34" height="13" rx="6.5"/>`;
    case 'bow':
      return `<g class="f-side-main" transform="${mount(132, 100)} rotate(${f(sw * .3)})"><path d="M-4 0L-24 -14Q-28 0 -24 14ZM4 0L24 -14Q28 0 24 14Z"/><circle r="7"/></g>`;
  }
  return '';
}
function glassesD(id, gx, gy) {
  // frames sit one ring-width outside the eyes so the two never touch
  const L = [113 + gx, 117 + gy], R = [163 + gx, 117 + gy], M = stroke('c-glasses-main', 10);
  switch (id) {
    case 'round':
      return `<circle ${M} cx="${f(L[0])}" cy="${f(L[1])}" r="31"/><circle ${M} cx="${f(R[0])}" cy="${f(R[1])}" r="31"/><path ${M} d="M${f(L[0] - 31)} ${f(L[1] - 6)}L62 106"/>`;
    case 'square':
      return `<rect ${M} x="${f(L[0] - 26)}" y="${f(L[1] - 22)}" width="52" height="44" rx="15"/><rect ${M} x="${f(R[0] - 26)}" y="${f(R[1] - 22)}" width="52" height="44" rx="15"/><path ${M} d="M${f(L[0] - 26)} ${f(L[1] - 6)}L62 106"/>`;
    case 'monocle':
      return `<circle ${M} cx="${f(R[0])}" cy="${f(R[1])}" r="31"/>`;
  }
  return '';
}
function neckD(id, sw) {
  switch (id) {
    case 'bowtie':
      return `<g ${blob('neck', 'main', 6)} transform="translate(176 206) rotate(-32)"><path d="M-4 0L-22 -13V13ZM4 0L22 -13V13Z"/><circle r="7"/></g>`;
    case 'bell': {
      const a = pol(-150, 84), b = pol(-60, 84);
      return `<path ${stroke('c-neck-main', 12)} d="M${pt(a)}A84 84 0 0 0 ${pt(b)}"/><g transform="translate(${pt(b)}) rotate(${f(sw * .6)})"><circle class="f-neck-acc" cx="0" cy="14" r="13"/></g>`;
    }
    case 'scarf': {
      const a = pol(-150, 84), b = pol(-72, 84), S2 = stroke('c-neck-main', 18);
      return `<path ${S2} d="M${pt(a)}A84 84 0 0 0 ${pt(b)}"/><g transform="rotate(${f(sw * .8)} ${pt(a)})"><path ${S2} d="M${pt(a)}q-12 22 -6 40"/></g>`;
    }
  }
  return '';
}

/** One frame of the figure as SVG markup, in logo units. */
export function figure(fc, o) {
  const t = o.t, lx = o.look[0], ly = o.look[1], acc = o.acc, sw = o.swing || 0;
  let s = `<g class="ink" fill="none" stroke-width="${LEG_W}" stroke-linecap="round">`;
  for (const l of o.legs) s += `<path d="M${f(l[0])} ${f(l[1])}L${f(l[2])} ${f(l[3])}"/>`;
  s += `</g><g transform="translate(0 ${f(o.low)})">`;
  s += sideBack(acc.side, sw);
  s += headBack(acc.head, sw);
  s += `<path class="ink" fill="none" stroke-width="${BODY_W}" stroke-linecap="round" d="${cPath(fc.gap[0], fc.gap[1])}"/>`;
  s += neckD(acc.neck, sw);
  if (fc.blush > .02) {
    s += `<g class="blush" opacity="${f(fc.blush * .8)}"><ellipse cx="${f(99 + lx)}" cy="146" rx="11" ry="5.5"/><ellipse cx="${f(167 + lx)}" cy="146" rx="11" ry="5.5"/></g>`;
  }
  const close = o.eyeClose || 0;
  fc.eyes.forEach((e, i) => {
    const ee = { ...e };
    if ((ee.shape === 'ring' || ee.shape === 'lid') && o.blink) ee.ry *= (1 - o.blink);
    const cx = EYES[i][0] + lx, cy = EYES[i][1] + ly;
    const tr = close > .01 ? ` transform="translate(0 ${f(cy)}) scale(1 ${f(Math.max(.08, 1 - close) * 100) / 100}) translate(0 ${f(-cy)})"` : '';
    s += `<path class="eye" fill="none" stroke-width="${e.sw || 12}" stroke-linecap="round" stroke-linejoin="round"${tr} d="${eyePath(ee, cx, cy)}"/>`;
  });
  s += glassesD(acc.glasses, lx * .4, ly * .3);
  if (fc.brows) {
    const bx = lx * .5, by = ly * .4;
    const d = fc.brows === 'angry'
      ? `M${f(98 + bx)} ${f(88 + by)}L${f(124 + bx)} ${f(97 + by)}M${f(152 + bx)} ${f(97 + by)}L${f(178 + bx)} ${f(88 + by)}`
      : `M${f(98 + bx)} ${f(96 + by)}L${f(123 + bx)} ${f(88 + by)}M${f(153 + bx)} ${f(88 + by)}L${f(178 + bx)} ${f(96 + by)}`;
    s += `<path class="ink" fill="none" stroke-width="9" stroke-linecap="round" d="${d}"/>`;
  }
  s += sideFront(acc.side, sw);
  s += headFront(acc.head, sw, t);
  if (fc.orbit) {
    const top = HEAD_TOP[acc.head] ?? 12;
    for (let i = 0; i < 3; i++) {
      const a = t * 3.2 + i * 2.094, sn = Math.sin(a);
      s += `<circle class="eye" fill="none" stroke-width="4" cx="${f(128 + 62 * Math.cos(a))}" cy="${f(top + 12 * sn)}" r="${sn < 0 ? 5 : 7}" opacity="${sn < 0 ? .55 : 1}"/>`;
    }
  }
  if (fc.listen) {
    // sound waves drifting in toward the face
    for (let i = 0; i < 3; i++) {
      const p = (t * .9 + i / 3) % 1, r = 46 - 30 * p, a0 = -.55, a1 = .55;
      s += `<path class="eye" fill="none" stroke-width="7" stroke-linecap="round" opacity="${f(Math.sin(Math.PI * p))}" d="M${f(196 + r * Math.cos(a0))} ${f(104 + r * Math.sin(a0))}A${f(r)} ${f(r)} 0 0 1 ${f(196 + r * Math.cos(a1))} ${f(104 + r * Math.sin(a1))}"/>`;
    }
  }
  if (fc.think) {
    // three rings rising from the head, the eye's own shape
    for (let i = 0; i < 3; i++) {
      const k = ((t * .8 + i / 3) % 1);
      s += `<circle class="eye" fill="none" stroke-width="5" cx="${f(214 + 10 * i)}" cy="${f(46 - 22 * i - 6 * k)}" r="${4 + 3 * i}" opacity="${f(.4 + .6 * Math.sin(Math.PI * k))}"/>`;
    }
  }
  if (fc.sweat) s += `<path class="tearf" transform="translate(56 ${f(64 + 3 * Math.sin(t * 7))}) scale(1.3)" d="${DROP}"/>`;
  if (fc.anger) {
    const k = 1 + .12 * Math.sin(t * 10);
    s += `<g class="angry" transform="translate(210 44) scale(${f(k * 10) / 10})" fill="none" stroke-width="7" stroke-linecap="round"><path d="M-13 -4Q-4 -4 -4 -13M4 -13Q4 -4 13 -4M13 4Q4 4 4 13M-4 13Q-4 4 -13 4"/></g>`;
  }
  if (fc.bang) s += `<g transform="translate(222 30)"><path class="ink" fill="none" stroke-width="11" stroke-linecap="round" d="M0 -18V4"/><circle class="inkf" cx="0" cy="18" r="5.5"/></g>`;
  if (fc.question) s += `<g transform="translate(222 30)"><path class="ink" fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" d="M-10 -12Q-10 -24 0 -24Q11 -24 11 -13Q11 -5 0 -1V5"/><circle class="inkf" cx="0" cy="18" r="5.5"/></g>`;
  if (fc.sparkle) {
    // a twinkling four-point glint inside each eye ring
    EYES.forEach(([ex, ey], i) => {
      const k = .8 + .3 * Math.sin(t * 7 + i * 2);
      s += `<path class="eye" fill="none" stroke-width="4" stroke-linecap="round" transform="translate(${f(ex + lx)} ${f(ey + ly - 1)}) scale(${f(k)})" d="M0 -8V8M-8 0H8"/>`;
    });
  }
  if (fc.streams) {
    // tears running from each eye down the cheek
    EYES.forEach(([ex, ey], i) => {
      const w = 2 * Math.sin(t * 6 + i);
      s += `<path class="tearf" opacity=".75" d="M${f(ex + lx - 5)} ${f(ey + 6)}Q${f(ex + lx - 7 + w)} ${f(ey + 30)} ${f(ex + lx - 3)} ${f(ey + 52)}L${f(ex + lx + 5)} ${f(ey + 52)}Q${f(ex + lx + 3 + w)} ${f(ey + 30)} ${f(ex + lx + 5)} ${f(ey + 6)}Z"/>`;
    });
  }
  if (o.zmark) s += '<path class="eye" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M204 22H220L204 42H220M226 4H236L226 16H236"/>';
  return s + '</g>';
}

/** A static figure for previews and tiles. */
export function mini(face, acc, t = 0, extra = {}) {
  return figure(FACES[face].f(t), { look: [0, 0], legs: STAND, low: 0, t, blink: 0, acc, ...extra });
}

/* ---------- skin ---------- */
/**
 * The body is `figure`, the id of a figure pack (src/packs.ts; Coo's is `coo`, drawn here); `scheme` is
 * another pack's dress-up pick, Coo's picks are the fields below. Whether a pack with that id is installed
 * is the pages' to find out: an id that is not falls back to Coo there.
 */
const FIGURE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function defaultSkin() {
  return { figure: 'coo', scheme: 'deepseek', palette: 'mint', head: 'none', side: 'none', glasses: 'none', neck: 'none', colors: JSON.parse(JSON.stringify(CHANNEL_DEFAULT)) };
}
const validColor = (slot, v) => (v === 'eye' || (v === 'body' && !NO_BODY[slot]) || ACC_COLORS.some(c => c.id === v));
/** Keeps what is valid in `raw`, defaults the rest. */
export function normalizeSkin(raw) {
  const skin = defaultSkin();
  if (!raw || typeof raw !== 'object') return skin;
  if (typeof raw.figure === 'string' && FIGURE_ID.test(raw.figure)) skin.figure = raw.figure;
  // a pack lists its picks in its manifest; it falls back to its first for one it does not know
  // a pack with no picks has the empty one; the World checks a scheme against the pack's manifest
  if (typeof raw.scheme === 'string' && /^[a-z0-9-]*$/.test(raw.scheme)) skin.scheme = raw.scheme;
  if (PALETTES.some(p => p.id === raw.palette)) skin.palette = raw.palette;
  for (const slot of SLOTS) if (SLOT_LISTS[slot].includes(raw[slot])) skin[slot] = raw[slot];
  for (const slot of SLOTS) for (const ch of ['main', 'acc']) {
    const v = raw.colors?.[slot]?.[ch];
    if (validColor(slot, v)) skin.colors[slot][ch] = v;
  }
  return skin;
}
/** Picking an item: fills the character colors of pieces that carry them. */
export function wear(skin, slot, id) {
  const next = { ...skin, colors: JSON.parse(JSON.stringify(skin.colors)) };
  next[slot] = id;
  if (ITEM_COLORS[id]) Object.assign(next.colors[slot], ITEM_COLORS[id]);
  return next;
}
function channelValue(skin, slot, ch, dark) {
  const v = skin.colors[slot][ch];
  if (v === 'body') return 'var(--skin-ink)';
  if (v === 'eye') return 'var(--skin-eye)';
  const c = ACC_COLORS.find(x => x.id === v);
  return dark ? c.d : c.l;
}
/** CSS custom properties for one theme side. */
export function skinVars(skin, dark) {
  const p = PALETTES.find(x => x.id === skin.palette) || PALETTES[0];
  let s = `--skin-ink:${p[dark ? 'd' : 'l'][0]};--skin-eye:${p[dark ? 'd' : 'l'][1]};`;
  for (const slot of SLOTS) for (const ch of ['main', 'acc']) s += `--c-${slot}-${ch}:${channelValue(skin, slot, ch, dark)};`;
  return s;
}
/** A stylesheet applying `skin` under `selector`, following the page's light/dark choice. */
export function skinCss(skin, selector = 'html:root') {
  return `${selector}{${skinVars(skin, false)}}` +
    `@media (prefers-color-scheme: dark){${selector}:not([data-theme="light"]){${skinVars(skin, true)}}}` +
    `${selector}[data-theme="dark"]{${skinVars(skin, true)}}`;
}

/** Colours of Coo's drawing classes; the palette and the accessory channels come from skinCss. */
export const COO_CSS = `
:root{--skin-ink:#1B1626;--skin-eye:#00A870;--blush:#FF8FA8;--tear:#5AAEF0;--anger:#E5484D}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--skin-ink:#FFFFFF;--skin-eye:#2FD59B;--blush:#FF7F9E;--tear:#6BBDF7;--anger:#FF6369}}
:root[data-theme="dark"]{--skin-ink:#FFFFFF;--skin-eye:#2FD59B;--blush:#FF7F9E;--tear:#6BBDF7;--anger:#FF6369}
.ink{stroke:var(--skin-ink)} .inkf{fill:var(--skin-ink)} .eye{stroke:var(--skin-eye)}
.blush{fill:var(--blush)} .tearf{fill:var(--tear)} .angry{stroke:var(--anger)}
.c-head-main{stroke:var(--c-head-main, var(--skin-ink))} .c-head-acc{stroke:var(--c-head-acc, var(--skin-eye))}
.c-glasses-main{stroke:var(--c-glasses-main, var(--skin-ink))} .c-glasses-acc{stroke:var(--c-glasses-acc, var(--skin-eye))}
.c-side-main{stroke:var(--c-side-main, var(--skin-eye))} .c-side-acc{stroke:var(--c-side-acc, var(--skin-eye))}
.c-neck-main{stroke:var(--c-neck-main, var(--skin-eye))} .c-neck-acc{stroke:var(--c-neck-acc, var(--skin-eye))}
.f-head-main{fill:var(--c-head-main, var(--skin-ink))} .f-head-acc{fill:var(--c-head-acc, var(--skin-eye))}
.f-side-main{fill:var(--c-side-main, var(--skin-eye))} .f-side-acc{fill:var(--c-side-acc, var(--skin-eye))}
.f-neck-main{fill:var(--c-neck-main, var(--skin-eye))} .f-neck-acc{fill:var(--c-neck-acc, var(--skin-eye))}
`;

/**
 * Coo as the kit's figure (createPet's `opts.figure`): draws each frame into the body's group from the
 * skin the kit hands it (`frame.acc`); the bubble and the top of its box follow the head accessory.
 */
export function cooFigure() {
  let skin = defaultSkin();
  const top = () => HEAD_TOP[skin.head] ?? 12;
  return {
    draw(petG, face, frame) { petG.innerHTML = figure(face, frame); },
    setSkin(s) { if (s) skin = s; },
    get anchors() { return { tears: [[116, 136], [166, 136]], bubble: [146, top() - 8] }; },
    get extent() { return [20, Math.min(20, top()), 236, 256]; },
  };
}
