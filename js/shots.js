// Turns "what my video is about" into a 9-shot list (3 acts x 3 shots).
// The shots themselves live in /shots.json so they can be swapped out
// without touching any code.

export let ACTS = [];
export let FRAME_LABEL = {};
let ROOMS = {};
let THEME_WORDS = {};
let LIBRARY = [];

const FRAMES = ['wide', 'medium', 'close', 'detail'];

// Fill in anything missing from a hand-edited shot so the app never breaks.
function clean(raw, i) {
  const frame = FRAMES.includes(raw.frame) ? raw.frame : 'medium';
  return {
    id: String(raw.id || `shot-${i + 1}`),
    act: String(raw.act || 'struggle').toLowerCase(),
    place: String(raw.place || 'home').toLowerCase(),
    action: String(raw.action || '').trim(),
    feeling: String(raw.feeling || '').trim(),
    tip: String(raw.tip || '').trim(),
    hold: Number(raw.hold) > 0 ? Number(raw.hold) : 5,
    frame,
    face: frame === 'detail' ? false : raw.face !== false,
    cam: raw.cam === 'handheld' ? 'handheld' : 'propped',
    themes: Array.isArray(raw.themes) && raw.themes.length ? raw.themes.map(String) : ['general'],
  };
}

export async function loadLibrary() {
  const res = await fetch('shots.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't load shots.json (${res.status})`);
  const data = await res.json();
  ACTS = data.acts;
  FRAME_LABEL = data.frameLabels || {};
  ROOMS = data.rooms || {};
  THEME_WORDS = data.themeWords || {};
  LIBRARY = (data.shots || []).map(clean).filter((s) => s.action);
  return LIBRARY.length;
}

export const roomOf = (place) => ROOMS[place] || place || 'home';

// Which themes your topic is about, and how strongly: { sleep: 2, study: 1 }
// ("tired" and "sleep" both point to sleep, so sleep counts double).
export function themesFor(topic) {
  const t = ` ${String(topic || '').toLowerCase()} `;
  const weights = {};
  for (const theme of Object.keys(THEME_WORDS)) {
    const n = THEME_WORDS[theme].filter((w) => t.includes(String(w).toLowerCase())).length;
    if (n) weights[theme] = n;
  }
  return weights;
}

// Small seeded random so the same topic gives the same list until you shuffle.
function hash(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function score(shot, themes, rand) {
  const top = Math.max(1, ...Object.values(themes));
  // How well the shot fits your main theme counts most; matching extra
  // side themes only helps a little.
  const fits = shot.themes.filter((t) => themes[t]).map((t) => themes[t] / top).sort((a, b) => b - a);
  const fit = fits.length ? 4 * fits[0] + 0.8 * (fits.length - 1) : 0;
  const general = shot.themes.includes('general') ? 0.6 : 0;
  return fit + general + rand() * 2;
}

const FRAME_ORDER = { wide: 0, medium: 1, close: 2, detail: 3 };

// Pick 3 shots for an act: best match for your topic, different places,
// a mix of framings, and at least one shot where your face is visible.
function pickAct(act, themes, rand) {
  const pool = LIBRARY.filter((s) => s.act === act)
    .map((s) => ({ s, v: score(s, themes, rand) }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.s);
  const out = [];
  for (const s of pool) {
    if (out.length === 3) break;
    if (out.some((o) => o.place === s.place)) continue;
    if (out.filter((o) => o.frame === s.frame).length >= 2) continue;
    if (s.frame === 'detail' && out.some((o) => o.frame === 'detail')) continue;
    out.push(s);
  }
  for (const s of pool) { if (out.length === 3) break; if (!out.includes(s)) out.push(s); }
  if (out.length === 3 && !out.some((s) => s.face)) {
    const faceShot = pool.find((s) => s.face && !out.includes(s));
    if (faceShot) out[2] = faceShot;
  }
  // Wide first, then closer: it reads nicely in an edit.
  return out.sort((a, b) => FRAME_ORDER[a.frame] - FRAME_ORDER[b.frame]);
}

// Returns full copies of the shots, so a saved list keeps working even after
// shots.json changes.
export function makeShotList(topic, shuffle = 0) {
  const themes = themesFor(topic);
  const rand = rng(hash(`${topic.trim().toLowerCase()}#${shuffle}`));
  return ACTS.flatMap((a) => pickAct(a.key, themes, rand).map((s) => ({ ...s })));
}

// Swap one shot for another good one in the same act that isn't in the list.
export function swapShot(topic, shots, index) {
  const current = shots[index];
  const themes = themesFor(topic);
  const rand = rng(hash(`${topic}#swap#${index}#${Date.now()}`));
  const used = new Set(shots.map((s) => s.id));
  const others = shots.filter((s, i) => i !== index && s.act === current.act);
  const pool = LIBRARY.filter((s) => s.act === current.act && !used.has(s.id))
    .map((s) => ({ s, v: score(s, themes, rand) + (others.some((o) => o.place === s.place) ? -2 : 0) }))
    .sort((a, b) => b.v - a.v);
  return pool.length ? { ...pool[0].s } : current;
}
