// Turns "what my video is about" into a 9-shot list (3 acts x 3 shots).
// The shots themselves live in /shots.json so they can be swapped out
// without touching any code.

export let ACTS = [];
export let FRAME_LABEL = {};
export let STYLE_LABEL = {};
let ROOMS = {};
let THEME_WORDS = {};
let LIBRARY = [];

const FRAMES = ['wide', 'medium', 'close', 'detail'];
const STYLES = ['person', 'body', 'hands', 'macro', 'overhead', 'pov', 'low', 'wide-side', 'ultrawide', 'visual-hook'];

// Fill in anything missing from a hand-edited shot so the app never breaks.
function clean(raw, i) {
  const frame = FRAMES.includes(raw.frame) ? raw.frame : 'medium';
  const face = frame === 'detail' ? false : raw.face !== false;
  const style = STYLES.includes(raw.style) ? raw.style : frame === 'detail' ? 'hands' : face ? 'person' : 'body';
  return {
    kind: 'broll',
    id: String(raw.id || `shot-${i + 1}`),
    act: String(raw.act || 'struggle').toLowerCase(),
    place: String(raw.place || 'home').toLowerCase(),
    action: String(raw.action || '').trim(),
    feeling: String(raw.feeling || '').trim(),
    tip: String(raw.tip || '').trim(),
    hold: Number(raw.hold) > 0 ? Number(raw.hold) : 5,
    frame,
    style,
    face,
    cam: raw.cam === 'handheld' ? 'handheld' : 'propped',
    themes: Array.isArray(raw.themes) && raw.themes.length ? raw.themes.map(String) : ['general'],
  };
}

export async function loadLibrary() {
  const res = await fetch('shots.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't load shots.json (${res.status})`);
  const data = await res.json();
  ACTS = data.acts;
  FRAME_LABEL = { ...(data.frameLabels || {}), talk: 'Talking to camera' };
  STYLE_LABEL = { ...(data.styleLabels || {}), talk: 'Talking to camera' };
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
// different kinds of shot, and only one shot with your face (most good
// videos are 55-75% shots without a face: this gives 6 of 9). The very
// first shot of the video is a visual hook (a hand moving toward the lens).
function pickAct(act, themes, rand, usedStyles, first) {
  const pool = LIBRARY.filter((s) => s.act === act)
    .map((s) => ({ s, v: score(s, themes, rand) - (usedStyles.has(s.style) ? 1.2 : 0) }))
    .sort((a, b) => b.v - a.v)
    .map((x) => x.s);
  const out = [];
  const fits = (s) => !out.includes(s) && !out.some((o) => o.place === s.place || o.style === s.style);
  if (first) { const hook = pool.find((s) => s.style === 'visual-hook'); if (hook) out.push(hook); }
  const faceShot = pool.find((s) => s.face && fits(s));
  if (faceShot) out.push(faceShot);
  for (const s of pool) { if (out.length === 3) break; if (!s.face && s.style !== 'visual-hook' && fits(s)) out.push(s); }
  for (const s of pool) { if (out.length === 3) break; if (!s.face && !out.includes(s) && s.style !== 'visual-hook') out.push(s); }
  for (const s of pool) { if (out.length === 3) break; if (!out.includes(s)) out.push(s); }
  out.forEach((s) => usedStyles.add(s.style));
  // Hook first, then wide to close: it reads nicely in an edit.
  const rank = (s) => (s.style === 'visual-hook' ? -1 : FRAME_ORDER[s.frame]);
  return out.sort((a, b) => rank(a) - rank(b));
}

// Returns full copies of the shots, so a saved list keeps working even after
// shots.json changes.
export function makeShotList(topic, shuffle = 0) {
  const themes = themesFor(topic);
  const rand = rng(hash(`${topic.trim().toLowerCase()}#${shuffle}`));
  const used = new Set();
  return ACTS.flatMap((a, i) => pickAct(a.key, themes, rand, used, i === 0).map((s) => ({ ...s })));
}

// Swap one shot for another good one in the same act that isn't in the list,
// of the same sort (face for face, no face for no face, hook for hook).
export function swapShot(topic, shots, index) {
  const current = shots[index];
  if (current.kind === 'talk') return current;
  if (current.line != null) return swapCutaway(topic, shots, index);
  const themes = themesFor(topic);
  const rand = rng(hash(`${topic}#swap#${index}#${Date.now()}`));
  const used = new Set(shots.map((s) => s.id));
  const others = shots.filter((s, i) => i !== index && s.act === current.act);
  const sameSort = (s) => (current.style === 'visual-hook' ? s.style === 'visual-hook' : s.face === current.face && s.style !== 'visual-hook');
  const pool = LIBRARY.filter((s) => s.act === current.act && !used.has(s.id) && sameSort(s))
    .map((s) => ({ s, v: score(s, themes, rand) + (others.some((o) => o.place === s.place) ? -2 : 0) + (others.some((o) => o.style === s.style) ? -1.5 : 0) }))
    .sort((a, b) => b.v - a.v);
  return pool.length ? { ...pool[0].s } : current;
}

// ------------------------------------------------------------------ scripts
// Your script, one line per sentence or per line you typed.
export function splitScript(script) {
  const text = String(script || '').replace(/\r/g, '').trim();
  if (!text) return [];
  let lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) lines = text.split(/(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => l.replace(/^[-•*\d.)\s]+(?=\S)/, '')).filter((l) => /[a-z0-9]/i.test(l)).slice(0, 24);
}

const STOP = new Set('a an the and or but so to of in on at for with my your our i im i\'m me you we it its is was are be been am this that these those just really very then than when what how why who not no do did does have has had get got can could would will about from up out into over more most all any every one like'.split(' '));
const stem = (w) => w.replace(/'s$/, '').replace(/(ing|ed|es|s)$/, '');
const words = (t) => String(t || '').toLowerCase().match(/[a-z']+/g)?.filter((w) => w.length > 2 && !STOP.has(w)).map(stem) || [];

// "Say it, show it": one quick cutaway (0.5-1 s in the edit) per script
// line, picked from the library to show what the line says.
function cutawayScore(shot, line, lineThemes, topicThemes, rand) {
  const lw = new Set(words(line));
  const sw = new Set(words(`${shot.action} ${shot.place}`));
  let overlap = 0; for (const w of lw) if (sw.has(w)) overlap++;
  const fit = (themes) => { const top = Math.max(1, ...Object.values(themes)); const f = shot.themes.filter((t) => themes[t]).map((t) => themes[t] / top); return f.length ? Math.max(...f) : 0; };
  return 3 * fit(lineThemes) + 1.6 * overlap + 1.2 * fit(topicThemes) + (shot.themes.includes('general') ? 0.3 : 0) + (shot.face ? -1.5 : 0) + rand() * 0.8;
}

const ACT_FOR_LINE = (i, n) => (n < 3 ? 'grind' : i < n / 3 ? 'struggle' : i < (2 * n) / 3 ? 'grind' : 'win');

export function makeCutaways(topic, script, shuffle = 0) {
  const lines = splitScript(script);
  const topicThemes = themesFor(topic);
  const rand = rng(hash(`${topic}#cut#${shuffle}`));
  const used = new Set();
  return lines.map((line, i) => {
    const act = ACT_FOR_LINE(i, lines.length);
    const lineThemes = themesFor(line);
    const ranked = LIBRARY.filter((s) => s.style !== 'visual-hook' || i === 0)
      .map((s) => ({ s, v: cutawayScore(s, line, lineThemes, topicThemes, rand) + (s.act === act ? 0.8 : 0) - (used.has(s.id) ? 4 : 0) + (i === 0 && s.style === 'visual-hook' ? 2 : 0) }))
      .sort((a, b) => b.v - a.v);
    const s = ranked[0].s;
    used.add(s.id);
    return { ...s, id: `c${i + 1}-${s.id}`, srcId: s.id, act, line, lineIndex: i };
  });
}

function swapCutaway(topic, shots, index) {
  const cur = shots[index];
  const used = new Set(shots.map((s) => s.srcId));
  const rand = rng(hash(`${topic}#cutswap#${index}#${Date.now()}`));
  const lineThemes = themesFor(cur.line), topicThemes = themesFor(topic);
  const ranked = LIBRARY.filter((s) => !used.has(s.id) && s.style !== 'visual-hook')
    .map((s) => ({ s, v: cutawayScore(s, cur.line, lineThemes, topicThemes, rand) + rand() * 1.5 }))
    .sort((a, b) => b.v - a.v);
  if (!ranked.length) return cur;
  const s = ranked[0].s;
  return { ...s, id: `c${cur.lineIndex + 1}-${s.id}`, srcId: s.id, act: cur.act, line: cur.line, lineIndex: cur.lineIndex };
}

// ------------------------------------------------------------------ talking to camera
export const TALK_GROUP = { key: 'talk', name: 'Talking to camera', blurb: 'In filming order. Each card says where it goes in the video.' };
export const TALK_TIP = "Talk like you're FaceTiming a friend. Say the first sentence fast, with more energy than normal, and no pauses.";
export const HOOK_WHY = 'Filmed last on purpose: your voice is warmed up now, and the first 2 seconds decide whether people keep watching.';
const wordCount = (t) => (String(t).match(/\S+/g) || []).length;
// About 2.8 words a second when you talk with energy.
const talkSeconds = (t) => Math.max(2, Math.ceil(wordCount(t) / 2.8));

function talkTake(o) {
  return {
    kind: 'talk', act: 'talk', place: 'talking to camera', style: 'talk', frame: 'talk',
    face: true, cam: 'propped', themes: ['general'], tip: TALK_TIP, ...o,
  };
}

// The takes, in filming order (hook last). videoOrder is where each one
// goes in the finished video (hook first).
export function makeTalkList(topic, script) {
  const lines = splitScript(script);
  if (!lines.length) {
    return [
      talkTake({ id: 'talk-background', role: 'background', videoOrder: 1, action: 'Give the background: why this matters to you, in under 10 seconds.', feeling: 'honest', hold: 5 }),
      talkTake({ id: 'talk-point', role: 'point', videoOrder: 2, action: "Say the one thing you want people to remember, like you're telling a friend.", feeling: 'warm', hold: 5 }),
      talkTake({ id: 'talk-quote', role: 'quote', videoOrder: 3, action: 'Say your one quotable line, short enough to put on screen.', feeling: 'sure', hold: 3 }),
      talkTake({ id: 'talk-ending', role: 'ending', videoOrder: 4, action: 'End with a line that leads straight back into your first sentence, so the video loops.', feeling: 'easy', hold: 3 }),
      talkTake({ id: 'talk-hook', role: 'hook', videoOrder: 0, action: 'Say your hook: the first sentence of the video, fast and with energy, in under 2 seconds.', feeling: 'high energy', hold: 2, why: HOOK_WHY }),
    ];
  }
  const [hook, ...rest] = lines;
  // One take per line; long scripts pair up short lines (up to ~30 words).
  const pairUp = rest.length > 10;
  const groups = [];
  for (let i = 0; i < rest.length; i++) {
    const g = groups.at(-1);
    if (pairUp && g && g.lines.length < 2 && wordCount([...g.lines, rest[i]].join(' ')) <= 30) { g.lines.push(rest[i]); g.to = i + 1; }
    else groups.push({ lines: [rest[i]], from: i + 1, to: i + 1 });
  }
  const takes = groups.map((g, k) => {
    const say = g.lines.join(' ');
    return talkTake({
      id: `talk-${g.from}-${hash(say).toString(36)}`, role: k === groups.length - 1 ? 'ending' : 'line', videoOrder: k + 1,
      say, lines: [g.from, g.to], action: `Say: “${say}”`, feeling: k === groups.length - 1 ? 'easy' : 'warm', hold: talkSeconds(say),
    });
  });
  takes.push(talkTake({
    id: `talk-hook-${hash(hook).toString(36)}`, role: 'hook', videoOrder: 0, say: hook, lines: [0, 0],
    action: `Say your hook: “${hook}”`, feeling: 'high energy', hold: talkSeconds(hook), why: HOOK_WHY,
  }));
  return takes;
}
