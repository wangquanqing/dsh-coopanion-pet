/**
 * The Coo pack's entry (figure.json here): Coo's body for the figure frame, the kit's body
 * (web/kit/body.js) drawn by cooFigure. Its dress-up picks are the skin's own fields (palette and
 * the four accessory slots, with their colour channels), so `scheme` is not used.
 */
import { COO_CSS, cooFigure, normalizeSkin, skinCss } from './coo.js';

export function createCooBody(base, { kit, host }) {
  const start = { ...host.start, skin: normalizeSkin(host.start?.skin) };
  const body = kit.createBody({ ...host, start }, { figure: cooFigure(), css: COO_CSS, skinCss: (s) => skinCss(s) });
  const set = body.set;
  // the skin comes from the World's config as it was saved; unknown values fall back to Coo's defaults
  body.set = (s) => set(s.skin ? { ...s, skin: normalizeSkin(s.skin) } : s);
  return body;
}
