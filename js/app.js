import { ACTS, FRAME_LABEL, STYLE_LABEL, TALK_GROUP, TALK_TIP, loadLibrary, makeShotList, makeCutaways, makeTalkList, splitScript, swapShot, roomOf } from './shots.js';
import { saveTake, updateTake, listTakes, listTakeInfo, deleteTake, deleteProject, askToKeepStorage } from './store.js';
import { speak, beep, unlockAudio, setVoiceEnabled, stopSpeaking, setAudioMode } from './voice.js';
import { loadFaceChecker, faceCheckerReady, findFaceInVideo } from './face.js';
import { GRAY_W, ZONES, EYE_LINE, EYE_LINE_TITLE, zoneFor, frameStats, regionMean, globalShift, judgeTake, liveHint } from './checks.js';
import { coachingOn, coachTake, getKey, setKey, testKey } from './coach.js';

const $ = (id) => document.getElementById(id);
const COUNTDOWN = 3; // always 3-2-1 before recording
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny DOM helper: h('div', {class: 'x'}, 'text', child)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const EXAMPLES = [
  "student who's always tired tries a new sleep routine",
  'busy mum finally starts meal prepping',
  'chronic procrastinator tries a focus routine',
  'the skincare routine that fixed my dull skin',
  'paying off my credit card in 6 months',
];

const state = {
  project: store.get('broll.project', null), // { id, topic, script, mode, shuffle, lists: { broll: [...], talking: [...] } }
  settings: { voice: true, platform: 'tiktok', zones: true, textBox: true, grid: false, eyeLine: true, titleAbove: false, ...store.get('broll.settings', {}) },
  homeMode: 'broll',
  takeInfo: [],
  current: 0,
  facing: 'environment',
  // Which camera each mode uses (remembered). Talking starts on the front
  // camera so you can see yourself; Flip switches to the sharper back one.
  facingBy: { broll: 'environment', talking: 'user', ...store.get('broll.facing', {}) },
  stream: null,
  phase: 'idle', // idle | countdown | recording | stopping | review
  takeToken: 0,
  motionAsked: false,
  clipsReturn: 'home',
};
setVoiceEnabled(state.settings.voice);

const saveProject = () => store.set('broll.project', state.project);
const mode = () => state.project?.mode || 'broll';
const talking = () => mode() === 'talking';
const curShots = () => state.project.lists[mode()];
const shotAt = (i) => curShots()[i];
const kindOf = (m) => (m === 'talking' ? 'talk' : 'broll');
const groups = () => (talking() ? [TALK_GROUP] : ACTS);
const actOf = (key) => (key === 'talk' ? TALK_GROUP : ACTS.find((a) => a.key === key) || { key, name: key, blurb: '' });
const actNumber = (key) => ACTS.findIndex((a) => a.key === key) + 1;
const takeKind = (t) => t.kind || 'broll';
const isDone = (i) => state.takeInfo.some((t) => takeKind(t) === kindOf(mode()) && t.shotIndex === i && t.shotId === shotAt(i).id);
const zone = () => zoneFor(state.settings.platform);
const ordinal = (n) => { const t = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (t[(v - 20) % 10] || t[v] || t[0]); };
const firstUndone = (from = 0) => {
  const n = curShots().length;
  for (let k = 0; k < n; k++) { const i = (from + k) % n; if (!isDone(i)) return i; }
  return -1;
};

async function refreshTakeInfo() {
  state.takeInfo = state.project ? await listTakeInfo(state.project.id).catch(() => []) : [];
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ screens
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  if (id !== 'film') leaveFilm();
  window.scrollTo(0, 0);
}

function dotsFor(container, { interactive = false } = {}) {
  container.replaceChildren();
  groups().forEach((act) => {
    const group = h('div', { class: 'dot-group' });
    curShots().forEach((s, i) => {
      if (s.act !== act.key) return;
      const cls = ['dot', isDone(i) && 'done', interactive && i === state.current && 'current'].filter(Boolean).join(' ');
      const el = h(interactive ? 'button' : 'span', {
        class: cls, 'data-act': s.act, role: 'listitem',
        'aria-label': `Shot ${i + 1}${isDone(i) ? ', done' : ''}`,
        onclick: interactive ? () => goToShot(i) : null,
      });
      group.append(el);
    });
    container.append(group);
  });
}

// ------------------------------------------------------------------ home
function setSeg(el, value) { for (const b of el.children) b.classList.toggle('on', b.dataset.v === value); }

function renderHome() {
  show('home');
  updateSettingsLabels();
  $('examples').replaceChildren(...EXAMPLES.map((ex) =>
    h('button', { class: 'chip', onclick: () => { $('topic').value = ex; } }, ex)));
  setHomeMode(state.homeMode);
  const p = state.project;
  $('resume').hidden = !p;
  if (p) {
    $('resume-topic').textContent = p.topic;
    dotsFor($('resume-dots'));
  }
}

function setHomeMode(m) {
  state.homeMode = m;
  setSeg($('home-mode'), m);
  $('home-sub').textContent = m === 'talking'
    ? "One line is enough. I'll plan your talking-to-camera takes, with the hook filmed last."
    : "One line is enough. I'll plan 9 shots in 3 acts and talk you through each one.";
  $('script-help').textContent = m === 'talking'
    ? 'One take per line. Your first line is the hook: you film it last, when your voice is warmed up.'
    : 'Say it, show it: one quick cutaway (0.5–1 s in the edit) per line, showing what the line says.';
}

async function makeList() {
  const script = $('script').value.trim();
  const topic = $('topic').value.trim() || splitScript(script)[0] || '';
  if (!topic) { $('topic').focus(); toast('Type one line about your video first'); return; }
  if (state.project && state.takeInfo.length) {
    const n = state.takeInfo.length;
    const ok = confirm(`Start a new video? This clears the ${n} clip${n === 1 ? '' : 's'} from "${state.project.topic}" off this app. Save the ones you want to your phone first.`);
    if (!ok) return;
    await deleteProject(state.project.id);
  }
  state.project = {
    id: `p${Date.now()}`, topic, script, shuffle: 0, mode: state.homeMode, createdAt: Date.now(),
    lists: { broll: script ? makeCutaways(topic, script, 0) : makeShotList(topic, 0), talking: makeTalkList(topic, script) },
  };
  saveProject();
  await refreshTakeInfo();
  $('topic').value = '';
  $('script').value = '';
  renderList();
}

// Projects from before talking-to-camera mode had one list.
function upgradeProject(p) {
  if (!p) return p;
  if (!p.lists) p.lists = { broll: p.shots || [], talking: makeTalkList(p.topic, p.script || '') };
  delete p.shots;
  if (!p.mode) p.mode = 'broll';
  return p;
}

// ------------------------------------------------------------------ shot list
function setMode(m) {
  if (!state.project || mode() === m) return;
  state.project.mode = m;
  saveProject();
}

function shotTags(s, i) {
  const talk = s.kind === 'talk';
  return h('div', { class: 'tags' },
    h('span', { class: 'feel' }, s.feeling),
    h('span', { class: 'tag' }, talk ? `At least ${s.hold}s` : `Hold ${s.hold}s`),
    talk ? h('span', { class: 'tag' }, `Goes ${ordinal(s.videoOrder + 1)} in the video`) : h('span', { class: 'tag style' }, STYLE_LABEL[s.style] || FRAME_LABEL[s.frame] || s.style),
    !talk && s.line != null ? h('span', { class: 'tag' }, 'Use 0.5–1 s') : null,
    !talk && s.line == null && s.frame !== 'detail' ? h('span', { class: 'tag' }, FRAME_LABEL[s.frame] || s.frame) : null);
}

function renderList() {
  show('list');
  const p = state.project;
  $('list-topic').textContent = p.topic;
  setSeg($('list-mode'), mode());
  $('shuffle').hidden = talking() || !!p.script;
  const shots = curShots();
  const faceless = shots.filter((s) => !s.face).length;
  $('list-note').textContent = talking()
    ? "Film them in this order. The hook comes last on purpose: your voice is warmed up by then, and the first 2 seconds decide whether people keep watching."
    : p.script
      ? `Say it, show it: one quick cutaway per line of your script. Record 5 seconds of each, then use 0.5–1 s of it over that line. ${faceless} of ${shots.length} don't need your face.`
      : `${faceless} of ${shots.length} shots don't show your face. Most good videos are 55–75% shots without a face. Shot 1 is your visual hook.`;
  const acts = groups().map((act) => {
    const idx = shots.map((s, i) => [s, i]).filter(([s]) => s.act === act.key);
    if (!idx.length) return null;
    return h('section', { class: 'act', 'data-act': act.key },
      h('div', { class: 'act-head' },
        act.key === 'talk' ? null : h('span', { class: 'act-num' }, `Act ${actNumber(act.key)}`),
        h('span', { class: 'act-name' }, act.name)),
      h('p', { class: 'act-blurb' }, act.blurb),
      idx.map(([s, i]) => h('article', { class: 'shot', 'data-act': s.act },
        h('div', { class: 'shot-top' },
          h('div', { class: 'shot-place' }, h('span', { class: `num${isDone(i) ? ' done' : ''}` }, isDone(i) ? '✓' : String(i + 1)),
            s.kind === 'talk' ? (s.role === 'hook' ? 'The hook' : `Take ${i + 1}`) : cap(s.place)),
          s.kind === 'talk' ? null : h('button', { class: 'swap', onclick: () => swap(i) }, 'Swap')),
        s.line != null ? h('p', { class: 'line' }, `Line ${s.lineIndex + 1}: “${s.line}”`) : null,
        h('p', {}, s.action),
        shotTags(s, i),
        s.why ? h('p', { class: 'why' }, s.why) : null,
        h('p', { class: 'tip' }, h('b', {}, 'Tip: '), s.tip))));
  }).filter(Boolean);
  $('acts').replaceChildren(...acts);
  const started = state.takeInfo.some((t) => takeKind(t) === kindOf(mode()));
  $('start-film').textContent = started ? 'Keep filming' : 'Start filming';
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function swap(i) {
  const p = state.project;
  const shots = curShots();
  shots[i] = swapShot(p.topic, shots, i);
  saveProject();
  renderList();
}

function shuffleAll() {
  const p = state.project;
  if (state.takeInfo.length && !confirm('Shuffle the whole list? Clips you already kept stay in your clips.')) return;
  p.shuffle = (p.shuffle || 0) + 1;
  p.lists.broll = makeShotList(p.topic, p.shuffle);
  saveProject();
  renderList();
}

// ------------------------------------------------------------------ motion sensor
const motionSamples = [];
function onMotion(e) {
  const r = e.rotationRate;
  if (!r || (r.alpha == null && r.beta == null && r.gamma == null)) return;
  if (state.phase !== 'recording') return;
  const rate = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
  motionSamples.push({ t: (performance.now() - state.recStart) / 1000, rate });
}

// Phone tilt, for "is the phone at eye level?". How far the camera points
// up (+) or down (-) in degrees; null unless the phone is upright.
const tiltSamples = [];
let lastTilt = { value: null, at: 0 };
function onOrientation(e) {
  if (e.beta == null) return;
  const upright = e.beta > 30 && e.beta < 150 && Math.abs(e.gamma || 0) < 35;
  // Upright facing you, beta is 90. Leaning back (beta < 90) points the
  // front camera up and the back camera down.
  const value = upright ? (state.facing === 'user' ? 90 - e.beta : e.beta - 90) : null;
  lastTilt = { value, at: performance.now() };
  if (state.phase === 'recording' && value != null) tiltSamples.push(value);
}
const currentTilt = () => (performance.now() - lastTilt.at < 1500 ? lastTilt.value : null);

// Must be called straight from a tap (iPhone asks for permission once for
// both motion and tilt).
function askMotion() {
  if (state.motionAsked) return;
  state.motionAsked = true;
  const D = window.DeviceMotionEvent, O = window.DeviceOrientationEvent;
  const listen = () => { addEventListener('devicemotion', onMotion); addEventListener('deviceorientation', onOrientation); };
  const ask = (typeof D?.requestPermission === 'function' && D.requestPermission.bind(D)) || (typeof O?.requestPermission === 'function' && O.requestPermission.bind(O));
  if (ask) ask().then((res) => { if (res === 'granted') listen(); }).catch(() => {});
  else listen();
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* fine */ }
}

// ------------------------------------------------------------------ filming
const video = $('video');
const grayCanvas = document.createElement('canvas');
const grayCtx = grayCanvas.getContext('2d', { willReadFrequently: true });
let idleTimer = null;

function enterFilm(index) {
  state.current = Math.max(0, index);
  state.facing = state.facingBy[mode()] || 'environment';
  show('film');
  $('film').dataset.mode = mode();
  renderShot();
  updateSettingsLabels();
  startCamera();
  loadFaceChecker();
  keepAwake();
  clearInterval(idleTimer);
  idleTimer = setInterval(idleCheck, 700);
}

function leaveFilm() {
  clearInterval(idleTimer);
  idleTimer = null;
  if (state.phase === 'countdown') cancelTake();
  if (state.phase === 'recording') stopRecording();
  stopSpeaking();
  stopCamera();
}

function renderShot() {
  const s = shotAt(state.current);
  const n = curShots().length;
  const talk = s.kind === 'talk';
  $('shot-num').textContent = `${talk ? 'Take' : 'Shot'} ${state.current + 1} of ${n}`;
  $('shot-act').textContent = talk ? 'Talking' : actOf(s.act).name;
  $('shot-place').textContent = talk ? (s.role === 'hook' ? 'The hook' : `Goes ${ordinal(s.videoOrder + 1)}`) : cap(s.place);
  $('shot-line').hidden = s.line == null;
  $('shot-line').textContent = s.line != null ? `Line ${s.lineIndex + 1}: “${s.line}”` : '';
  $('shot-action').textContent = s.action;
  $('shot-feel').textContent = s.feeling;
  $('shot-hold').textContent = talk ? `At least ${s.hold}s` : `Hold ${s.hold}s`;
  $('shot-frame').textContent = talk ? 'Tap stop when you finish' : (STYLE_LABEL[s.style] || FRAME_LABEL[s.frame] || s.frame);
  $('shot-tip').textContent = talk ? [s.why, TALK_TIP].filter(Boolean).join(' ') : s.tip;
  $('shot-card').dataset.act = s.act;
  $('prev').disabled = state.current === 0;
  $('next').disabled = state.current === n - 1;
  renderGuides();
  dotsFor($('dots'), { interactive: true });
  setHint(null);
}

// Overlays on the live preview: danger zones, text box, eye line, thirds.
function renderGuides() {
  const st = state.settings;
  const s = state.project && $('film').hidden === false ? shotAt(state.current) : null;
  const talk = s?.kind === 'talk';
  const z = zone();
  const g = $('guides');
  g.classList.toggle('mirror', state.facing === 'user');
  $('dz-top').style.height = `${z.top * 100}%`;
  $('dz-bottom').style.height = `${z.bottom * 100}%`;
  $('dz-right').style.width = `${z.right * 100}%`;
  $('dz-right').style.top = `${z.top * 100}%`;
  $('dz-right').style.bottom = `${z.bottom * 100}%`;
  $('dz-name').textContent = `${z.name} (approx.)`;
  for (const id of ['dz-top', 'dz-bottom', 'dz-right']) $(id).hidden = !st.zones;
  const title = talk && st.titleAbove;
  $('text-box').hidden = !st.textBox;
  $('title-box').hidden = !st.textBox || !title;
  $('title-box').style.top = `${(z.top + 0.01) * 100}%`;
  $('title-box').style.height = `${Math.max(0.06, EYE_LINE_TITLE - 0.17 - z.top) * 100}%`;
  $('eye-line').hidden = !(talk && st.eyeLine);
  $('eye-line').style.top = `${(title ? EYE_LINE_TITLE : EYE_LINE) * 100}%`;
  $('grid').hidden = !st.grid;
}

function goToShot(i) {
  if (state.phase !== 'idle') return;
  state.current = i;
  renderShot();
}

function camMsg(text) {
  $('cam-msg').hidden = !text;
  $('cam-msg').textContent = text || '';
}

function layoutFrame() {
  const box = document.querySelector('.cam').getBoundingClientRect();
  const ar = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16;
  let hgt = box.height, wid = hgt * ar;
  if (wid > box.width - 24) { wid = box.width - 24; hgt = wid / ar; }
  const f = $('cam-frame');
  f.style.width = `${Math.round(wid)}px`;
  f.style.height = `${Math.round(hgt)}px`;
  f.style.aspectRatio = 'auto';
}
addEventListener('resize', () => { if (!$('film').hidden) layoutFrame(); });

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    camMsg(window.isSecureContext ? "This browser can't use the camera. Open the link in Safari." : 'The camera only works on the https:// link.');
    return;
  }
  camMsg('Starting the camera…');
  const want = { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  // Talking to camera needs your voice; b-roll is filmed silent (it gets
  // music in the edit, and the mic makes the spoken directions quieter).
  const withMic = talking();
  setAudioMode(withMic ? 'play-and-record' : 'playback');
  const mic = withMic ? { echoCancellation: false, noiseSuppression: true, autoGainControl: true } : false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: mic });
  } catch (err) {
    if (withMic && err.name === 'NotAllowedError') {
      // Camera allowed but microphone blocked: film without sound and say so.
      try { stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false }); toast('The microphone is blocked, so these takes will have no sound. Allow it in Safari\'s website settings.', 5000); } catch { /* fall through */ }
    }
    if (!stream && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: mic }); } catch (e2) { err = e2; }
    }
    if (!stream) {
      camMsg(err.name === 'NotAllowedError'
        ? "Camera is blocked. In Safari, tap the aA button in the address bar, then Website Settings, set Camera to Allow, and reload."
        : `The camera didn't start (${err.name || 'unknown error'}). Close other camera apps and reload.`);
      return;
    }
  }
  if ($('film').hidden) { stream.getTracks().forEach((t) => t.stop()); return; }
  await bestQuality(stream.getVideoTracks()[0]);
  state.stream = stream;
  // The preview shows only the picture, so your voice is never played back.
  video.srcObject = stream.getAudioTracks().length ? new MediaStream(stream.getVideoTracks()) : stream;
  $('cam-frame').classList.toggle('mirror', state.facing === 'user');
  try { await video.play(); } catch { /* autoplay with muted is allowed */ }
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  layoutFrame();
  camMsg(null);
  showQuality();
  renderGuides();
}

// Ask the camera for the most it can do, up to 4K at 30 frames a second,
// in a 16:9 shape (which the phone turns upright for portrait).
async function bestQuality(track) {
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : null;
    const s = track.getSettings();
    if (!caps || !caps.width?.max || !caps.height?.max) return;
    const long = Math.min(3840, Math.max(caps.width.max, caps.height.max));
    const short = Math.round((long * 9) / 16);
    const upright = (s.height || 0) > (s.width || 0);
    const w = upright ? short : long, h = upright ? long : short;
    if (w * h <= (s.width || 0) * (s.height || 0)) return;
    await track.applyConstraints({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } });
  } catch (e) {
    console.warn('Could not raise camera quality', e);
  }
}

const qualityName = (w, h) => {
  const s = Math.min(w, h);
  return s >= 2160 ? '4K' : s >= 1440 ? '1440p' : s >= 1080 ? '1080p' : s >= 720 ? '720p' : `${s}p`;
};

// What the camera is actually giving us (this is what gets recorded).
function cameraQuality() {
  const s = state.stream?.getVideoTracks()[0]?.getSettings?.() || {};
  const w = video.videoWidth || s.width || 0, h = video.videoHeight || s.height || 0;
  return { w, h, fps: s.frameRate ? Math.round(s.frameRate) : null };
}

function showQuality() {
  const q = cameraQuality();
  const el = $('quality');
  el.hidden = !q.w;
  el.textContent = q.w ? `${qualityName(q.w, q.h)}${q.fps ? ` · ${q.fps} fps` : ''}` : '';
  el.title = q.w ? `${q.w} × ${q.h}` : '';
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
}

function flipCamera() {
  if (state.phase !== 'idle') return;
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  state.facingBy[mode()] = state.facing;
  store.set('broll.facing', state.facingBy);
  startCamera();
}

// Grab one frame (from the camera, or from a clip) and measure it.
function sample({ withFace, source = video }) {
  const vw = source.videoWidth, vh = source.videoHeight;
  if (!vw || !vh) return null;
  const gw = GRAY_W, gh = Math.round(GRAY_W * vh / vw);
  if (grayCanvas.width !== gw || grayCanvas.height !== gh) { grayCanvas.width = gw; grayCanvas.height = gh; }
  grayCtx.drawImage(source, 0, 0, gw, gh);
  const stats = frameStats(grayCtx.getImageData(0, 0, gw, gh));
  const face = withFace ? findFaceInVideo(source) : undefined;
  let faceLuma = null, bgLuma = null, halfRatio = null;
  if (face && face.found) {
    faceLuma = regionMean(stats.gray, gw, gh, face);
    // Left and right halves of the face (split at the nose, eyes to chin),
    // and the room around you.
    const band = { top: face.top + face.height * 0.25, bottom: face.bottom - face.height * 0.08 };
    const l = regionMean(stats.gray, gw, gh, { ...band, left: face.left, right: face.noseX });
    const r = regionMean(stats.gray, gw, gh, { ...band, left: face.noseX, right: face.right });
    if (l != null && r != null && Math.max(l, r) > 0) halfRatio = Math.min(l, r) / Math.max(l, r);
    const a = Math.min(0.8, Math.max(0, (face.right - face.left) * (face.bottom - face.top)));
    if (faceLuma != null) bgLuma = (stats.mean - faceLuma * a) / (1 - a);
  }
  return { ...stats, face: face === undefined ? null : face, faceLuma, bgLuma, halfRatio };
}

function setHint(hint) {
  const el = $('hint');
  if (!hint) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('good', !!hint.good);
  el.querySelector('span').textContent = hint.short;
}

function idleCheck() {
  if (state.phase !== 'idle' || !state.stream || !$('review').hidden || document.hidden) return;
  const s = shotAt(state.current);
  const smp = sample({ withFace: s.frame !== 'detail' && faceCheckerReady() });
  if (!smp) return;
  const hint = liveHint(s, smp, { zone: zone(), titleAbove: state.settings.titleAbove, tilt: currentTilt() });
  if (!hint && s.frame !== 'detail' && !faceCheckerReady()) setHint({ short: 'Loading framing check…', good: false });
  else setHint(hint);
}

function directionText(i) {
  const s = shotAt(i);
  if (s.kind === 'talk') return `Take ${i + 1}. ${s.action}`;
  return `Shot ${i + 1}. ${cap(s.place)}. ${s.action} It should feel ${s.feeling}.`;
}

function setRecUI() {
  const busy = ['countdown', 'recording', 'checking'].includes(state.phase);
  $('rec').classList.toggle('busy', state.phase === 'countdown' || state.phase === 'recording');
  $('rec').disabled = state.phase === 'checking';
  $('rec').setAttribute('aria-label', state.phase === 'recording' ? 'Stop' : state.phase === 'countdown' ? 'Cancel' : 'Record');
  for (const id of ['flip', 'say', 'prev', 'next', 'film-back', 'film-clips', 'from-photos', 'open-guides', 'open-settings']) $(id).disabled = busy;
  if (!busy) { $('prev').disabled = state.current === 0; $('next').disabled = state.current === curShots().length - 1; }
  $('rec-badge').hidden = state.phase !== 'recording';
  if (state.phase !== 'recording') $('ring-fg').style.strokeDashoffset = 289;
}

function onRecTap() {
  askMotion();
  unlockAudio();
  keepAwake();
  if (state.phase === 'idle') runTake();
  else if (state.phase === 'countdown') cancelTake();
  else if (state.phase === 'recording') stopRecording();
}

async function runTake() {
  if (!state.stream) { toast("The camera isn't on yet"); return; }
  const token = ++state.takeToken;
  state.phase = 'countdown';
  setRecUI();
  setHint(null);
  if (shotAt(state.current).kind === 'talk') {
    // Talking to camera: a breath first, then the countdown.
    $('listen').textContent = 'Take a deep breath.';
    $('listen').hidden = false;
    const said = speak('Take a deep breath.');
    await Promise.all([said, sleep(2600)]);
    $('listen').hidden = true;
    if (token !== state.takeToken) return;
  } else if (state.settings.voice) {
    $('listen').textContent = 'Listen…';
    $('listen').hidden = false;
    await speak(directionText(state.current));
    $('listen').hidden = true;
    if (token !== state.takeToken) return;
  }
  for (let n = COUNTDOWN; n > 0; n--) {
    $('count').textContent = n;
    $('count').hidden = false;
    beep(740, 110);
    await sleep(1000);
    if (token !== state.takeToken) return;
  }
  $('count').hidden = true;
  startRecording();
}

function cancelTake() {
  state.takeToken++;
  stopSpeaking();
  $('count').hidden = true;
  $('listen').hidden = true;
  state.phase = 'idle';
  setRecUI();
}

// MP4 (H.264) first: it's what iPhone Photos accepts. WebM only if the
// browser can't record MP4 at all.
function pickMime(withAudio) {
  if (!window.MediaRecorder) return null;
  const options = withAudio
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return options.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}

let rec = null, chunks = [], samples = [], prevGray = null, tick = 0;
let sampleTimer = null, stopTimer = null, thumbTimer = null, rafId = null, thumbBlob = null, frameBlob = null;

function startRecording() {
  const shot = shotAt(state.current);
  if (!window.MediaRecorder) { toast("This browser can't record video"); cancelTake(); return; }
  const withAudio = state.stream.getAudioTracks().length > 0;
  const mime = pickMime(withAudio);
  // Enough bitrate for the resolution: about 12 Mbps at 1080p, up to 50 at 4K.
  const q = cameraQuality();
  const bps = Math.round(Math.min(50e6, Math.max(8e6, q.w * q.h * 6)));
  state.recQuality = q;
  try {
    rec = new MediaRecorder(state.stream, mime ? { mimeType: mime, videoBitsPerSecond: bps, ...(withAudio ? { audioBitsPerSecond: 128000 } : {}) } : undefined);
  } catch {
    rec = new MediaRecorder(state.stream);
  }
  chunks = []; samples = []; prevGray = null; tick = 0; thumbBlob = null; frameBlob = null;
  motionSamples.length = 0;
  tiltSamples.length = 0;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = finishTake;
  rec.start();
  state.recStart = performance.now();
  state.phase = 'recording';
  setRecUI();
  beep(1180, 220, 0.3);

  sampleTimer = setInterval(() => {
    const withFace = shot.frame !== 'detail' && tick % 2 === 0 && faceCheckerReady();
    tick++;
    const smp = sample({ withFace });
    if (!smp) return;
    const t = (performance.now() - state.recStart) / 1000;
    const shift = prevGray ? globalShift(prevGray, smp.gray, smp.w, smp.h) : null;
    prevGray = smp.gray;
    samples.push({ t, mean: smp.mean, clipped: smp.clipped, face: smp.face, faceLuma: smp.faceLuma, bgLuma: smp.bgLuma, halfRatio: smp.halfRatio, shift });
  }, 250);

  thumbTimer = setTimeout(captureThumb, Math.min(shot.hold / 2, 2.5) * 1000);
  // B-roll stops on its own; talking takes run until you tap stop (3 min max).
  stopTimer = setTimeout(() => stopRecording(), (shot.kind === 'talk' ? 180 : shot.hold + 1) * 1000);

  const tickUI = () => {
    if (state.phase !== 'recording') return;
    const el = (performance.now() - state.recStart) / 1000;
    $('rec-time').textContent = `${el.toFixed(1)}s`;
    $('ring-fg').style.strokeDashoffset = String(289 * (1 - Math.min(1, el / shot.hold)));
    rafId = requestAnimationFrame(tickUI);
  };
  tickUI();
}

// One frame from the middle of the take: a small one for the clip grid and
// a sharper one for Claude to look at.
function grabStills(source = video) {
  const vw = source.videoWidth, vh = source.videoHeight;
  if (!vw) return Promise.resolve({ still: null, thumb: null });
  const big = document.createElement('canvas');
  const scale = Math.min(1, 1024 / Math.max(vw, vh));
  big.width = Math.round(vw * scale); big.height = Math.round(vh * scale);
  big.getContext('2d').drawImage(source, 0, 0, big.width, big.height);
  const c = document.createElement('canvas');
  c.width = 360; c.height = Math.round(360 * vh / vw);
  c.getContext('2d').drawImage(big, 0, 0, c.width, c.height);
  const toBlob = (cv, qty) => new Promise((r) => cv.toBlob(r, 'image/jpeg', qty));
  return Promise.all([toBlob(big, 0.85), toBlob(c, 0.82)]).then(([still, thumb]) => ({ still, thumb }));
}
function captureThumb() {
  grabStills().then(({ still, thumb }) => { frameBlob = still; thumbBlob = thumb; });
}

function stopRecording() {
  if (state.phase !== 'recording') return;
  state.phase = 'stopping';
  state.duration = (performance.now() - state.recStart) / 1000;
  clearInterval(sampleTimer); clearTimeout(stopTimer); clearTimeout(thumbTimer); cancelAnimationFrame(rafId);
  if (!thumbBlob) captureThumb();
  beep(880, 90); setTimeout(() => beep(880, 90), 160);
  setRecUI();
  try { rec.stop(); } catch { finishTake(); }
}

let pending = null;

// ------------------------------------------------------------------ clips from Photos
function pickFromPhotos() {
  if (state.phase !== 'idle') return;
  unlockAudio();
  $('photo-input').value = '';
  $('photo-input').click();
}

function showChecking(fraction, sub) {
  $('checking').hidden = fraction == null;
  if (fraction == null) return;
  $('checking-bar').style.width = `${Math.round(fraction * 100)}%`;
  $('checking-sub').textContent = sub || '';
}

const once = (el, ev, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
  el.addEventListener(ev, () => { clearTimeout(t); resolve(); }, { once: true });
  el.addEventListener('error', () => { clearTimeout(t); reject(el.error || new Error('video error')); }, { once: true });
});

async function seekTo(v, t) {
  if (Math.abs(v.currentTime - t) < 0.001) return;
  const done = once(v, 'seeked', 8000);
  v.currentTime = t;
  await done;
}

// Some files don't say how long they are until you jump to the end.
async function clipDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  await seekTo(v, 1e7).catch(() => {});
  const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime;
  await seekTo(v, 0).catch(() => {});
  return d;
}

const typeFromName = (name) => (/\.mov$/i.test(name) ? 'video/quicktime' : /\.webm$/i.test(name) ? 'video/webm' : 'video/mp4');

// Runs the same checks as a live take on a clip you filmed with the Camera
// app, then files it under the current shot. The file itself is kept
// untouched, so it keeps its full quality.
async function checkImported(file) {
  if (state.phase !== 'idle') return;
  const shot = shotAt(state.current);
  state.phase = 'checking';
  setRecUI();
  setHint(null);
  showChecking(0, 'Opening the clip…');
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(v);
  const url = URL.createObjectURL(file);
  try {
    v.src = url;
    await once(v, 'loadeddata', 20000);
    // iPhone only paints frames once playback has started.
    try { await v.play(); v.pause(); } catch { /* muted, so allowed */ }
    const duration = await clipDuration(v);
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !duration) throw new Error('no video');

    if (shot.frame !== 'detail' && !faceCheckerReady()) {
      showChecking(0.02, 'Getting the framing check ready…');
      await Promise.race([loadFaceChecker(), sleep(15000)]);
    }
    // Look at evenly spaced moments; at each, compare with a frame 0.2 s
    // later to see whether the picture is sliding (shake).
    const start = Math.min(0.5, duration * 0.15);
    const end = Math.max(start, duration - 0.8);
    const n = Math.max(6, Math.min(16, Math.round((end - start) * 2)));
    const smp = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? start : start + ((end - start) * i) / (n - 1);
      await seekTo(v, t);
      const a = sample({ withFace: shot.frame !== 'detail' && faceCheckerReady(), source: v });
      let shift = null;
      if (t + 0.2 < duration) {
        await seekTo(v, t + 0.2);
        const b = sample({ withFace: false, source: v });
        if (a && b) shift = globalShift(a.gray, b.gray, a.w, a.h);
      }
      if (a) smp.push({ t, mean: a.mean, clipped: a.clipped, face: a.face, faceLuma: a.faceLuma, bgLuma: a.bgLuma, halfRatio: a.halfRatio, shift });
      showChecking((i + 1) / (n + 1), `${qualityName(vw, vh)} · ${duration.toFixed(1)}s`);
    }
    await seekTo(v, Math.min(duration / 2, Math.max(0, duration - 0.1)));
    const { still, thumb } = await grabStills(v);
    showChecking(1, '');

    const verdict = judgeTake({ shot, samples: smp, motion: [], duration, sideways: vw > vh, zone: zone(), titleAbove: state.settings.titleAbove });
    const type = file.type || typeFromName(file.name || '');
    await presentTake(shot, verdict, {
      blob: new Blob([file], { type }), thumb, still, duration,
      width: vw, height: vh, source: 'photos', originalName: file.name || '',
    });
  } catch (err) {
    console.warn('Could not check the clip', err);
    state.phase = 'idle';
    setRecUI();
    toast("Couldn't open that clip. Try another one, or save it to Files first and pick it from there.", 4500);
  } finally {
    showChecking(null);
    v.removeAttribute('src'); v.load(); v.remove();
    URL.revokeObjectURL(url);
  }
}

async function finishTake() {
  const shot = shotAt(state.current);
  const type = (rec && rec.mimeType) || chunks[0]?.type || 'video/mp4';
  const blob = new Blob(chunks, { type });
  rec = null;
  if (!$('film').hidden || state.phase === 'stopping') {
    // give the thumbnail a moment if it is still being made
    for (let i = 0; i < 10 && !(thumbBlob && frameBlob); i++) await sleep(50);
  }
  if ($('film').hidden) { state.phase = 'idle'; return; } // left the screen mid-take
  if (!blob.size) {
    state.phase = 'idle'; setRecUI();
    toast('Nothing was recorded, try again');
    return;
  }
  const verdict = judgeTake({ shot, samples, motion: motionSamples.slice(), duration: state.duration, zone: zone(), titleAbove: state.settings.titleAbove, tilts: tiltSamples.slice() });
  const q = state.recQuality || {};
  await presentTake(shot, verdict, {
    blob, thumb: thumbBlob, still: frameBlob, duration: state.duration,
    width: q.w, height: q.h, fps: q.fps, source: 'camera',
  });
}

// Shared by recorded takes and clips from Photos: save if good, show the
// review, ask Claude, say the result out loud.
async function presentTake(shot, verdict, media) {
  pending = {
    id: `t${Date.now()}`,
    projectId: state.project.id,
    kind: shot.kind || 'broll',
    shotIndex: state.current,
    shotId: shot.id,
    style: shot.style,
    role: shot.role,
    videoOrder: shot.videoOrder,
    say: shot.say,
    line: shot.line,
    lineIndex: shot.lineIndex,
    act: shot.act,
    place: shot.place,
    room: roomOf(shot.place),
    action: shot.action,
    feeling: shot.feeling,
    frame: shot.frame,
    hold: shot.hold,
    ok: verdict.ok,
    fix: verdict.fix,
    createdAt: Date.now(),
    saved: false,
    ...media,
  };
  state.lastVerdict = verdict;
  // Ready-made file, so "Save to Photos" can open the share sheet straight from the tap.
  pending.file = fileFor(pending, state.takeInfo.filter((t) => t.shotId === pending.shotId && takeKind(t) === pending.kind).length + 1);
  if (verdict.ok) await keepPending();
  state.phase = 'review';
  const coaching = coachingOn() && pending.still;
  pending.coachState = coaching ? 'thinking' : 'off';
  showReview(verdict);
  if (coaching) {
    // Say the headline now; Claude's note follows when it arrives.
    const headline = speak(verdict.ok ? 'Good shot, saved.' : 'Do it again.');
    getCoaching(pending, shot, verdict, headline);
  } else {
    speak(verdict.ok ? 'Good shot, saved.' : `Do it again. ${verdict.fix}`);
  }
}

async function getCoaching(take, shot, verdict, headline) {
  let note = null, failure = null;
  try {
    note = await coachTake({ frame: take.still, shot, actName: actOf(shot.act).name, verdict });
  } catch (err) {
    failure = err;
  }
  if (note) {
    Object.assign(take, { coaching: note.coaching, readsAs: note.readsAs, background: note.background || null, coachState: 'done' });
    if (take.saved) updateTake(take.id, { coaching: note.coaching, readsAs: note.readsAs, background: note.background || null }).catch(() => {});
  } else {
    Object.assign(take, { coachState: 'failed', coachError: failure?.message || "Claude coaching didn't work this time." });
  }
  if (pending !== take || $('review').hidden) return; // you already moved on
  renderReviewState(verdict);
  await headline;
  if (pending !== take || $('review').hidden) return;
  // If Claude couldn't help, you still hear what to fix.
  if (note) speak(note.coaching);
  else if (!verdict.ok) speak(verdict.fix);
}

async function keepPending() {
  try {
    await saveTake(pending);
    if (pending.coaching) await updateTake(pending.id, { coaching: pending.coaching, readsAs: pending.readsAs, background: pending.background || null });
    pending.saved = true;
    await refreshTakeInfo();
    dotsFor($('dots'), { interactive: true });
  } catch (e) {
    console.error(e);
    toast("Couldn't save the clip. Your phone may be out of space.");
  }
}

let reviewUrl = null;
function showReview(verdict) {
  if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  reviewUrl = URL.createObjectURL(pending.blob);
  const rv = $('review-video');
  rv.src = reviewUrl;
  rv.play().catch(() => {});
  $('checks').replaceChildren(...verdict.checks.map((c) => h('li', { class: c.status },
    h('span', { class: 'ic' }, c.status === 'pass' ? '✓' : c.status === 'fail' ? '!' : '–'),
    h('span', { class: 'lbl' }, c.label),
    h('span', { class: 'nt' }, c.note))));
  renderReviewState(verdict);
  const notPhotos = pending.source !== 'photos' && !isH264(pending.blob.type);
  $('review-quality').textContent = [
    pending.width ? `${pending.source === 'photos' ? 'From your Photos' : 'Recorded'} at ${qualityLine(pending)}` : '',
    pending.source === 'photos' ? 'original file' : formatName(pending.blob.type),
    notPhotos ? "This browser can't record H.264, so this clip may not save to Photos. Film in Safari on iPhone." : '',
  ].filter(Boolean).join(' · ');
  $('review').hidden = false;
}

// What the recorder actually made. iPhone Photos needs H.264 (or HEVC).
const isH264 = (type) => /avc1|avc3|h264/i.test(type) || /^video\/mp4\s*$/i.test(type || '');
const formatName = (type) => {
  if (/quicktime/.test(type)) return 'MOV';
  if (/mp4/.test(type)) return isH264(type) ? 'MP4 (H.264)' : `MP4 (${(/codecs=([a-z0-9]+)/i.exec(type) || [, 'not H.264'])[1].toUpperCase()})`;
  return /webm/.test(type) ? 'WebM' : type || '';
};

const BG_CHECKLIST = [
  ['depth', 'About 6 feet from the back wall, not right up against it'],
  ['behind', 'Something behind you: a doorway, a shelf or a lamp'],
  ['clutter', 'No bins, shoes, bags or boxes in shot'],
  ['clothes', "Nothing you don't want filmed (pajama pants? film from the waist up)"],
];

// Talking to camera: Claude's look at your background, or a quick checklist.
function renderBackground() {
  const box = $('bg-check');
  const talk = pending?.kind === 'talk';
  box.hidden = !talk;
  if (!talk) return;
  const bg = pending.background;
  if (pending.coachState === 'thinking') { box.replaceChildren(h('div', { class: 'bg-head' }, 'Background'), h('p', { class: 'muted small' }, 'Claude is looking at your background…')); return; }
  if (bg) {
    const items = [
      bg.depth === 'flat wall'
        ? h('li', { class: 'fail' }, h('span', { class: 'ic' }, '!'), 'Flat wall right behind you. Move about 6 feet from the wall, with a doorway, shelf or lamp behind you.')
        : h('li', { class: 'pass' }, h('span', { class: 'ic' }, '✓'), 'Good depth behind you.'),
      bg.move.length
        ? h('li', { class: 'fail' }, h('span', { class: 'ic' }, '!'), `Move out of shot: ${bg.move.join(', ')}.`)
        : h('li', { class: 'pass' }, h('span', { class: 'ic' }, '✓'), 'No clutter to move.'),
      ...bg.avoid.map((a) => h('li', { class: 'fail' }, h('span', { class: 'ic' }, '!'), `${cap(a)}.`)),
    ];
    box.replaceChildren(h('div', { class: 'bg-head' }, 'Background, from Claude'), h('ul', { class: 'bg-list' }, items));
    return;
  }
  const key = `broll.bg.${state.project.id}`;
  const ticked = new Set(store.get(key, []));
  box.replaceChildren(
    h('div', { class: 'bg-head' }, 'Background check'),
    h('p', { class: 'muted small' }, coachingOn() ? '' : 'Turn on Claude coaching and Claude checks this for you.'),
    h('div', { class: 'ticks' }, BG_CHECKLIST.map(([k, label]) => tickBox(`bg-${k}`, label, ticked.has(k), (on) => {
      on ? ticked.add(k) : ticked.delete(k); store.set(key, [...ticked]);
    }))));
}

function tickBox(id, label, checked, onChange) {
  const input = h('input', { type: 'checkbox', id, checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'tick', for: id }, input, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'tick-text' }, label));
}

function renderReviewState(verdict) {
  const title = $('verdict-title');
  const keptAnyway = !verdict.ok && pending.saved;
  title.textContent = keptAnyway ? 'Kept anyway' : verdict.title;
  title.className = `verdict-title ${verdict.ok ? 'good' : 'bad'}`;
  $('verdict-fix').textContent = verdict.fix;
  const coach = $('coach');
  const cs = pending.coachState;
  coach.hidden = cs === 'off';
  coach.className = `coach${cs === 'thinking' ? ' thinking' : cs === 'failed' ? ' failed' : ''}`;
  $('coach-reads').textContent = cs === 'done' && pending.readsAs ? `Reads as ${pending.readsAs}` : '';
  $('coach-line').textContent = cs === 'thinking' ? 'Looking at your take…'
    : cs === 'done' ? pending.coaching
      : cs === 'failed' ? pending.coachError : '';
  renderBackground();
  $('rv-save').onclick = () => shareFiles([pending.file], { single: true });
  const remaining = firstUndone(state.current + 1);
  const nextLabel = remaining === -1 ? 'See my clips' : 'Next shot';
  const actions = $('review-actions');
  const extra = $('review-extra');
  if (pending.saved) {
    actions.replaceChildren(
      h('button', { class: 'btn primary grow', id: 'rv-next', onclick: () => closeReview('next') }, nextLabel),
      h('button', { class: 'btn grow', id: 'rv-again', onclick: () => closeReview('again') }, 'Another take'));
    extra.textContent = 'Delete this take';
    extra.onclick = async () => { await deleteTake(pending.id); await refreshTakeInfo(); dotsFor($('dots'), { interactive: true }); closeReview('again'); toast('Take deleted'); };
  } else {
    actions.replaceChildren(
      h('button', { class: 'btn primary grow', id: 'rv-retry', onclick: () => closeReview('again') }, 'Try again'),
      h('button', { class: 'btn grow', id: 'rv-keep', onclick: async () => { await keepPending(); renderReviewState(verdict); toast('Kept, it’s in your clips'); } }, 'Keep it anyway'));
    extra.textContent = 'Skip to the next shot';
    extra.onclick = () => closeReview('next');
  }
}

function closeReview(where) {
  $('review').hidden = true;
  const rv = $('review-video');
  rv.pause(); rv.removeAttribute('src'); rv.load();
  if (reviewUrl) { URL.revokeObjectURL(reviewUrl); reviewUrl = null; }
  pending = null;
  state.phase = 'idle';
  setRecUI();
  stopSpeaking();
  if (where === 'next') {
    const next = firstUndone(state.current + 1);
    if (next === -1) { openClips('film'); return; }
    state.current = next;
  }
  renderShot();
}

// ------------------------------------------------------------------ settings
const GUIDE_SEGS = { 'seg-zones': 'zones', 'seg-textbox': 'textBox', 'seg-grid': 'grid', 'seg-eyeline': 'eyeLine', 'seg-title': 'titleAbove' };

function updateSettingsLabels() {
  for (const b of $('seg-voice').children) b.classList.toggle('on', (b.dataset.v === 'on') === state.settings.voice);
  for (const [id, key] of Object.entries(GUIDE_SEGS)) for (const b of $(id).children) b.classList.toggle('on', (b.dataset.v === 'on') === !!state.settings[key]);
  setSeg($('seg-platform'), state.settings.platform);
  $('guides-zone-help').textContent = (() => { const z = zone(); return `${z.name}: top ~${Math.round(z.top * 100)}%, bottom ~${Math.round(z.bottom * 100)}%, right edge ~${Math.round(z.right * 100)}%. Approximate, for a 1080 × 1920 video.`; })();
  const on = coachingOn();
  $('coach-dot').hidden = !on;
  $('home-coach').textContent = on ? 'on' : 'off, set it up';
  $('coach-pill').textContent = on ? 'On' : 'Off';
  $('coach-pill').classList.toggle('on', on);
  $('coach-add').hidden = on;
  $('coach-have').hidden = !on;
}

function coachStatus(text, kind) {
  const el = $('coach-status');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `coach-status${kind ? ` ${kind}` : ''}`;
}

async function saveCoachKey() {
  const key = $('coach-key').value.trim();
  if (!key) { coachStatus('Paste your key first.', 'bad'); return; }
  if (!/^sk-ant-/.test(key)) { coachStatus("That doesn't look like a Claude API key. It starts with sk-ant-.", 'bad'); return; }
  setKey(key);
  $('coach-key').value = '';
  await checkCoachKey();
}

async function checkCoachKey() {
  coachStatus('Checking your key…');
  const res = await testKey();
  if (res.ok) coachStatus('Key works. Claude will coach you after each take.', 'good');
  else coachStatus(res.message, 'bad');
  updateSettingsLabels();
}

function openSettings() {
  updateSettingsLabels();
  coachStatus(null);
  $('settings').hidden = false;
}
function setSetting(key, value) {
  state.settings[key] = value;
  store.set('broll.settings', state.settings);
  if (key === 'voice') setVoiceEnabled(value);
  updateSettingsLabels();
  if (!$('film').hidden) renderGuides();
}

// ------------------------------------------------------------------ clips
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const extFor = (type, name = '') => {
  const fromName = /\.([a-z0-9]{2,4})$/i.exec(name);
  if (fromName) return fromName[1].toLowerCase();
  return /quicktime/.test(type) ? 'mov' : /webm/.test(type) ? 'webm' : 'mp4';
};
const qualityLine = (t) => (t.width ? `${qualityName(t.width, t.height)} (${t.width} × ${t.height}${t.fps ? `, ${t.fps} fps` : ''})` : '');
let clipTakes = [];
let thumbUrls = [];

// File names sort in order in CapCut: talking takes in video order, then
// b-roll by shot number.
function fileFor(take, n = 1) {
  const ext = extFor(take.blob.type, take.originalName);
  const again = n > 1 ? `-take${n}` : '';
  const base = take.kind === 'talk'
    ? `talk-${String((take.videoOrder ?? take.shotIndex) + 1).padStart(2, '0')}-${take.role === 'hook' ? 'hook' : take.role || 'line'}`
    : `${String(take.shotIndex + 1).padStart(2, '0')}-${take.act}-${slug(take.place)}-${slug(take.feeling)}`;
  return new File([take.blob], `${base}${again}.${ext}`, { type: take.blob.type || 'video/mp4' });
}

async function openClips(from) {
  state.clipsReturn = from;
  show('clips');
  $('clips-topic').textContent = state.project ? state.project.topic : '';
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  clipTakes = state.project ? await listTakes(state.project.id).catch(() => []) : [];
  // Ready-made files, so saving can start straight from your tap.
  clipTakes.forEach((t) => {
    const same = clipTakes.filter((o) => o.shotId === t.shotId && takeKind(o) === takeKind(t));
    t.file = fileFor(t, same.length > 1 ? same.indexOf(t) + 1 : 1);
  });
  renderClips();
}

function renderClips() {
  const n = clipTakes.length;
  $('clips-empty').hidden = n > 0;
  $('save-all').disabled = n === 0;
  $('save-all').textContent = n > 1 ? `Save all ${n} to Photos` : 'Save to Photos';
  $('open-plan').hidden = n === 0;
  const talkTakes = clipTakes.filter((t) => takeKind(t) === 'talk').sort((a, b) => (a.videoOrder ?? 0) - (b.videoOrder ?? 0) || a.createdAt - b.createdAt);
  const talkGroup = talkTakes.length ? h('section', { class: 'clip-act act', 'data-act': 'talk' },
    h('div', { class: 'clip-act-head' },
      h('div', { class: 'act-head' }, h('span', { class: 'act-name' }, 'Talking to camera')),
      talkTakes.length > 1 ? h('button', { class: 'save-act', onclick: () => saveMany(talkTakes.map((t) => t.file)) }, `Save these ${talkTakes.length}`) : null),
    h('div', { class: 'grid' }, talkTakes.map(tile))) : null;
  const brollTakes = clipTakes.filter((t) => takeKind(t) === 'broll');
  const groupsEls = ACTS.map((act) => {
    const takes = brollTakes.filter((t) => t.act === act.key).sort((a, b) => a.shotIndex - b.shotIndex || a.createdAt - b.createdAt);
    if (!takes.length) return null;
    const rooms = [...new Set(takes.map((t) => t.room))];
    return h('section', { class: 'clip-act act', 'data-act': act.key },
      h('div', { class: 'clip-act-head' },
        h('div', { class: 'act-head' }, h('span', { class: 'act-num' }, `Act ${actNumber(act.key)}`), h('span', { class: 'act-name' }, act.name)),
        takes.length > 1 ? h('button', { class: 'save-act', onclick: () => saveMany(takes.map((t) => t.file)) }, `Save these ${takes.length}`) : null),
      rooms.map((room) => h('div', {},
        h('div', { class: 'room' }, cap(room)),
        h('div', { class: 'grid' }, takes.filter((t) => t.room === room).map(tile)))));
  }).filter(Boolean);
  $('clip-groups').replaceChildren(...[talkGroup, ...groupsEls].filter(Boolean));
}

function thumbEl(take) {
  if (!take.thumb) return h('div', {});
  const u = URL.createObjectURL(take.thumb);
  thumbUrls.push(u);
  return h('img', { src: u, alt: '' });
}

function tile(take) {
  const talk = takeKind(take) === 'talk';
  const label = talk ? (take.role === 'hook' ? 'hook' : `take ${(take.videoOrder ?? take.shotIndex) + 1}`) : take.feeling;
  return h('div', { class: 'clip-cell' },
    h('button', { class: 'clip', 'data-act': take.act, 'aria-label': `${talk ? 'Talking take' : `Shot ${take.shotIndex + 1}`}, ${label}`, onclick: () => openPlayer(take) },
      thumbEl(take),
      h('span', { class: 'n' }, talk ? `T${(take.videoOrder ?? take.shotIndex) + 1}` : String(take.shotIndex + 1)),
      take.ok ? null : h('span', { class: 'warn', title: 'Kept anyway' }, '!'),
      h('span', { class: 'mood' }, label)),
    h('button', { class: 'tile-save', 'aria-label': 'Save to Photos', onclick: () => shareFiles([take.file], { single: true }) },
      icon('M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14')));
}

// Little helper for inline icons (SVG needs its own namespace).
function icon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

let playerUrl = null, playerTake = null;
function openPlayer(take) {
  playerTake = take;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(take.blob);
  const pv = $('player-video');
  pv.src = playerUrl;
  pv.muted = takeKind(take) !== 'talk';
  pv.play().catch(() => { pv.muted = true; pv.play().catch(() => {}); });
  $('player-where').textContent = takeKind(take) === 'talk'
    ? `Talking to camera · ${take.role === 'hook' ? 'the hook' : `goes ${ordinal((take.videoOrder ?? 0) + 1)} in the video`}`
    : `Shot ${take.shotIndex + 1} · ${actOf(take.act).name} · ${cap(take.place)} · ${take.feeling}`;
  $('player-quality').textContent = [qualityLine(take), take.source === 'photos' ? 'from your Photos, original file' : formatName(take.blob.type), take.file?.name].filter(Boolean).join(' · ');
  const lines = [take.ok ? take.action : `${take.action} (Kept anyway: ${take.fix})`];
  if (take.coaching) lines.push(`Claude: ${take.readsAs ? `reads as ${take.readsAs}. ` : ''}${take.coaching}`);
  $('player-action').textContent = lines.join('\n');
  $('player').hidden = false;
}
function closePlayer() {
  $('player').hidden = true;
  const pv = $('player-video');
  pv.pause(); pv.removeAttribute('src'); pv.load();
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
}

// ------------------------------------------------------------------ saving to Photos
// iPhone Safari can't write to Photos directly. The share sheet can: it has
// "Save Video". navigator.share must run straight from your tap, so files
// are made ready before you tap.
const canShareFiles = (files) => {
  try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files })); } catch { return false; }
};

async function shareFiles(files, { single = false } = {}) {
  if (!files.length) return 'none';
  if (canShareFiles(files)) {
    try {
      await navigator.share({ files });
      toast(files.length > 1 ? `Done. If you tapped Save ${files.length} Videos, they're in Photos.` : "Done. If you tapped Save Video, it's in Photos.");
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      console.warn(e);
      if (!single) return 'failed';
    }
  }
  downloadFiles(files);
  return 'downloaded';
}

// No share sheet (or it failed): plain downloads, which land in Files.
async function downloadFiles(files) {
  toast(`${files.length > 1 ? `Downloading ${files.length} clips` : 'Downloading'}. On iPhone they land in the Files app, in Downloads: open one and tap Share, then Save Video.`, 6500);
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    await sleep(350);
  }
}

// Save several: one share sheet with all of them if Safari allows it,
// otherwise one at a time (each needs its own tap).
async function saveMany(files) {
  if (!files.length) return;
  if (files.length === 1) { shareFiles(files, { single: true }); return; }
  if (canShareFiles(files)) {
    const res = await shareFiles(files);
    if (res !== 'failed') return;
  } else if (!canShareFiles([files[0]])) {
    downloadFiles(files);
    return;
  }
  openSaveQueue(files);
}

let queue = { files: [], i: 0 };
function openSaveQueue(files) {
  queue = { files, i: 0 };
  renderQueue();
  $('save-queue').hidden = false;
}
function renderQueue() {
  const { files, i } = queue;
  const done = i >= files.length;
  $('queue-title').textContent = done ? 'All saved' : `Save one at a time`;
  $('queue-help').textContent = done ? 'Every clip went through the share sheet. Check your Photos.' : `Safari can't save them all at once, so tap for each clip and pick Save Video. Clip ${i + 1} of ${files.length}: ${files[i].name}`;
  $('queue-next').hidden = done;
  $('queue-next').textContent = `Save clip ${i + 1} of ${files.length}`;
  $('queue-skip').hidden = done;
  $('queue-done').textContent = done ? 'Done' : 'Stop';
}
async function queueNext() {
  const f = queue.files[queue.i];
  if (!f) return;
  try { await navigator.share({ files: [f] }); queue.i++; } catch (e) { if (e.name !== 'AbortError') { downloadFiles([f]); queue.i++; } }
  renderQueue();
}

// ------------------------------------------------------------------ edit plan
// A checklist for editing in CapCut, with your clips in the order they go.
function latestTakes(kind) {
  const by = new Map();
  for (const t of clipTakes.filter((x) => takeKind(x) === kind)) {
    const k = t.shotId;
    if (!by.has(k) || (t.ok && !by.get(k).ok) || (t.ok === by.get(k).ok && t.createdAt > by.get(k).createdAt)) by.set(k, t);
  }
  return by;
}

function editOrder() {
  const p = state.project;
  const talkTakes = latestTakes('talk'), brollTakes = latestTakes('broll');
  const broll = (p.lists.broll || []).map((s, i) => ({ shot: s, i, take: brollTakes.get(s.id) }));
  const rows = [];
  const brollRow = (b) => ({ kind: 'broll', shot: b.shot, take: b.take, label: `Cut to shot ${b.i + 1}: ${STYLE_LABEL[b.shot.style] || 'b-roll'}`, detail: b.shot.line != null ? `0.5–1 s over “${b.shot.line}”` : `${b.shot.action}`, short: b.shot.line != null });
  if (talkTakes.size === 0) {
    broll.forEach((b) => rows.push(brollRow(b)));
    return rows;
  }
  const talkShots = [...(p.lists.talking || [])].sort((a, b) => a.videoOrder - b.videoOrder);
  const used = new Set();
  const hookBroll = broll.filter((b) => b.shot.style === 'visual-hook');
  const others = broll.filter((b) => b.shot.style !== 'visual-hook');
  const segs = talkShots.filter((t) => t.role !== 'hook');
  talkShots.forEach((t) => {
    rows.push({ kind: 'talk', shot: t, take: talkTakes.get(t.id), label: t.role === 'hook' ? 'The hook (talking)' : `Talking, part ${t.videoOrder}`, detail: t.say ? `“${t.say}”` : t.action });
    let mine;
    if (t.role === 'hook') mine = hookBroll.concat(others.filter((b) => b.shot.line != null && b.shot.lineIndex === 0));
    else if (others.some((b) => b.shot.line != null) && t.lines) mine = others.filter((b) => b.shot.line != null && b.shot.lineIndex >= t.lines[0] && b.shot.lineIndex <= t.lines[1]);
    else { const k = segs.indexOf(t); mine = others.filter((b, j) => Math.floor((j * segs.length) / others.length) === k); }
    mine.filter((b) => !used.has(b.i)).forEach((b) => { used.add(b.i); rows.push(brollRow(b)); });
  });
  broll.filter((b) => !used.has(b.i)).forEach((b) => rows.push(brollRow(b)));
  return rows;
}

function planItems() {
  const p = state.project;
  const hook = (p.lists.talking || []).find((t) => t.role === 'hook');
  const hookText = hook?.say ? `: “${hook.say}”` : '';
  const quote = (p.lists.talking || []).find((t) => t.role === 'quote');
  const z = zone();
  const hasHookShot = (p.lists.broll || []).some((s) => s.style === 'visual-hook');
  const hasCutaways = (p.lists.broll || []).some((s) => s.line != null);
  return [
    ['Start strong', [
      ['hook-text', `First frame: your hook as text in the middle of the screen${hookText}.`],
      ['hook-fast', 'Say the hook in under 2 seconds.'],
      hasHookShot && ['visual-hook', 'Open on your visual hook: the hand moving toward the lens, in the first second.'],
    ]],
    ['Keep it moving', [
      ['new-every', 'Something new on screen every 1–3 seconds: a cut, a picture, or a punch-in to 110–120% on a key word.'],
      ['cut-dead', 'Cut every 1–2 seconds where nothing happens.'],
      ['transcript', 'Cut by the transcript: take out flubs and dead air, keep tiny breaths.'],
      hasCutaways && ['cutaways', 'Put each cutaway over the line it shows, 0.5–1 second each.'],
    ]],
    ['Captions', [
      ['cap-middle', 'Captions in the middle of the screen, 1–3 words at a time.'],
      ['cap-font', 'The same caption font in every video.'],
      ['cap-zones', `Keep captions out of the danger zones: bottom ~${Math.round(z.bottom * 100)}%, right edge ~${Math.round(z.right * 100)}%, top ~${Math.round(z.top * 100)}% (${z.name}, approximate).`],
    ]],
    ['Length', [
      ['bg-10', 'Background info under 10 seconds.'],
      ['under-60', "Whole video under 60 seconds. If it's 1:30, cut it to 1:00."],
    ]],
    ['Make them rewatch', [
      ['quote', `One quotable line, on screen as text${quote?.say ? `: “${quote.say}”` : ''}.`],
      ['loop', 'Make the end loop back into the start, so people watch it again.'],
    ]],
    ['Finish', [
      ['music', 'Music low, under your voice.'],
      ['ending', "Delete CapCut's ending clip."],
      ['export', 'Export at 1080 × 1920.'],
    ]],
  ].map(([title, items]) => [title, items.filter(Boolean)]);
}

async function openPlan() {
  if (!clipTakes.length && state.project) clipTakes = await listTakes(state.project.id).catch(() => []);
  show('plan');
  renderPlan();
}

function renderPlan() {
  const key = `broll.plan.${state.project.id}`;
  const ticked = new Set(store.get(key, []));
  const rows = editOrder();
  const fileOf = (take) => clipTakes.find((t) => t.id === take?.id)?.file;
  $('plan-clips').replaceChildren(...rows.map((r, k) => h('li', { class: `plan-clip${r.take ? '' : ' missing'}${r.kind === 'talk' ? ' talk' : ''}` },
    h('span', { class: 'plan-n' }, String(k + 1)),
    r.take ? thumbEl(r.take) : h('div', { class: 'plan-thumb-empty' }),
    h('div', { class: 'plan-text' },
      h('div', { class: 'plan-label' }, r.label),
      h('div', { class: 'plan-detail' }, r.detail),
      h('div', { class: 'plan-file' }, r.take ? (fileOf(r.take)?.name || '') : 'Not filmed yet')))));
  const sections = planItems();
  const total = sections.reduce((n, [, items]) => n + items.length, 0);
  const update = () => {
    const done = sections.reduce((n, [, items]) => n + items.filter(([k]) => ticked.has(k)).length, 0);
    $('plan-progress').textContent = `${done} of ${total} done`;
  };
  $('plan-list').replaceChildren(...sections.map(([title, items]) => h('section', { class: 'plan-sec' },
    h('h3', {}, title),
    h('div', { class: 'ticks' }, items.map(([k, label]) => tickBox(`plan-${k}`, label, ticked.has(k), (on) => {
      on ? ticked.add(k) : ticked.delete(k);
      store.set(key, [...ticked]);
      update();
    }))))));
  update();
}

async function startNewVideo() {
  const n = clipTakes.length;
  if (n && !confirm(`Start a new video? This clears these ${n} clip${n === 1 ? '' : 's'} off this app. Save the ones you want to your phone first.`)) return;
  if (state.project) await deleteProject(state.project.id);
  state.project = null;
  store.del('broll.project');
  await refreshTakeInfo();
  renderHome();
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('make').onclick = makeList;
  for (const b of $('home-mode').children) b.onclick = () => setHomeMode(b.dataset.v);
  $('add-script').onclick = () => { $('script-wrap').hidden = false; $('add-script').hidden = true; $('script').focus(); };
  for (const b of $('list-mode').children) b.onclick = () => { setMode(b.dataset.v); renderList(); };
  $('topic').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); makeList(); } });
  $('resume-film').onclick = () => { askMotion(); unlockAudio(); enterFilm(Math.max(0, firstUndone())); };
  $('resume-clips').onclick = () => openClips('home');
  $('resume-list').onclick = renderList;

  $('list-back').onclick = renderHome;
  $('shuffle').onclick = shuffleAll;
  $('start-film').onclick = () => { askMotion(); unlockAudio(); enterFilm(Math.max(0, firstUndone())); };

  $('film-back').onclick = () => { if (state.phase === 'idle') renderList(); };
  $('film-clips').onclick = () => { if (state.phase === 'idle') openClips('film'); };
  $('prev').onclick = () => goToShot(state.current - 1);
  $('next').onclick = () => goToShot(state.current + 1);
  $('rec').onclick = onRecTap;
  $('flip').onclick = flipCamera;
  $('open-guides').onclick = () => { if (state.phase === 'idle') { updateSettingsLabels(); $('guides-sheet').hidden = false; } };
  $('guides-done').onclick = () => { $('guides-sheet').hidden = true; };
  $('guides-sheet').onclick = (e) => { if (e.target === $('guides-sheet')) $('guides-sheet').hidden = true; };
  for (const [id, key] of Object.entries(GUIDE_SEGS)) for (const b of $(id).children) b.onclick = () => setSetting(key, b.dataset.v === 'on');
  for (const b of $('seg-platform').children) b.onclick = () => setSetting('platform', b.dataset.v);
  $('say').onclick = () => { unlockAudio(); speak(directionText(state.current)); };
  $('open-settings').onclick = () => { if (state.phase === 'idle') openSettings(); };
  $('home-settings').onclick = openSettings;
  $('coach-save').onclick = saveCoachKey;
  $('coach-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCoachKey(); });
  $('coach-test').onclick = checkCoachKey;
  $('coach-remove').onclick = () => {
    if (!confirm('Remove your Claude key from this phone? Coaching turns off.')) return;
    setKey('');
    coachStatus('Key removed. Coaching is off.');
    updateSettingsLabels();
  };
  $('settings-done').onclick = () => { $('settings').hidden = true; };
  $('settings').onclick = (e) => { if (e.target === $('settings')) $('settings').hidden = true; };
  $('from-photos').onclick = pickFromPhotos;
  $('photo-input').onchange = () => {
    const file = $('photo-input').files && $('photo-input').files[0];
    if (file) checkImported(file);
  };
  for (const b of $('seg-voice').children) b.onclick = () => setSetting('voice', b.dataset.v === 'on');

  $('clips-back').onclick = () => {
    if (state.clipsReturn === 'film' && state.project) enterFilm(state.current);
    else renderHome();
  };
  $('save-all').onclick = () => saveMany(clipTakes.map((t) => t.file));
  $('open-plan').onclick = openPlan;
  $('clips-plan').onclick = openPlan;
  $('plan-back').onclick = () => openClips(state.clipsReturn);
  $('plan-save-all').onclick = () => saveMany(editOrder().map((r) => r.take && clipTakes.find((t) => t.id === r.take.id)?.file).filter(Boolean));
  $('queue-next').onclick = queueNext;
  $('queue-skip').onclick = () => { queue.i++; renderQueue(); };
  $('queue-done').onclick = () => { $('save-queue').hidden = true; };
  $('new-video').onclick = startNewVideo;
  $('player-close').onclick = closePlayer;
  $('player-save').onclick = () => playerTake && shareFiles([playerTake.file], { single: true });
  $('player-delete').onclick = async () => {
    if (!playerTake || !confirm('Delete this clip? This can’t be undone.')) return;
    await deleteTake(playerTake.id);
    closePlayer();
    await refreshTakeInfo();
    openClips(state.clipsReturn);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.phase === 'recording') stopRecording();
      else if (state.phase === 'countdown') cancelTake();
    } else if (!$('film').hidden) {
      keepAwake();
      const track = state.stream?.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') startCamera();
    }
  });
}

async function boot() {
  wire();
  try {
    await loadLibrary();
  } catch (e) {
    console.error(e);
    document.body.replaceChildren(h('div', { class: 'pad' }, h('h1', { class: 'hero' }, "Couldn't load the shot library"), h('p', { class: 'sub' }, 'Check your connection and reload. If you edited shots.json, check it for a typo.')));
    return;
  }
  askToKeepStorage();
  if (state.project) { upgradeProject(state.project); saveProject(); }
  await refreshTakeInfo();
  renderHome();
}

boot();

// Handy for testing in a desktop browser's console.
window.brollDirector = { state, judgeTake, get samples() { return samples; }, clipFiles: () => clipTakes.map((t) => t.file), get pendingFile() { return pending?.file; }, editOrder: () => editOrder(), pickMime };
