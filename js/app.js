import { ACTS, FRAME_LABEL, loadLibrary, makeShotList, swapShot, roomOf } from './shots.js';
import { saveTake, listTakes, listTakeInfo, deleteTake, deleteProject, askToKeepStorage } from './store.js';
import { speak, beep, unlockAudio, setVoiceEnabled, stopSpeaking } from './voice.js';
import { loadFaceChecker, faceCheckerReady, findFaceInVideo } from './face.js';
import { GRAY_W, frameStats, regionMean, globalShift, judgeTake, liveHint } from './checks.js';

const $ = (id) => document.getElementById(id);
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
  project: store.get('broll.project', null), // { id, topic, shuffle, shots: [...] }
  settings: { countdown: 5, voice: true, ...store.get('broll.settings', {}) },
  takeInfo: [],
  current: 0,
  facing: 'environment',
  stream: null,
  phase: 'idle', // idle | countdown | recording | stopping | review
  takeToken: 0,
  motionAsked: false,
  clipsReturn: 'home',
};
setVoiceEnabled(state.settings.voice);

const saveProject = () => store.set('broll.project', state.project);
const shotAt = (i) => state.project.shots[i];
const actOf = (key) => ACTS.find((a) => a.key === key) || { key, name: key, blurb: '' };
const actNumber = (key) => ACTS.findIndex((a) => a.key === key) + 1;
const isDone = (i) => state.takeInfo.some((t) => t.shotIndex === i && t.shotId === shotAt(i).id);
const firstUndone = (from = 0) => {
  const n = state.project.shots.length;
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
  ACTS.forEach((act) => {
    const group = h('div', { class: 'dot-group' });
    state.project.shots.forEach((s, i) => {
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
function renderHome() {
  show('home');
  $('examples').replaceChildren(...EXAMPLES.map((ex) =>
    h('button', { class: 'chip', onclick: () => { $('topic').value = ex; } }, ex)));
  const p = state.project;
  $('resume').hidden = !p;
  if (p) {
    $('resume-topic').textContent = p.topic;
    dotsFor($('resume-dots'));
  }
}

async function makeList() {
  const topic = $('topic').value.trim();
  if (!topic) { $('topic').focus(); toast('Type one line about your video first'); return; }
  if (state.project && state.takeInfo.length) {
    const n = state.takeInfo.length;
    const ok = confirm(`Start a new video? This clears the ${n} clip${n === 1 ? '' : 's'} from "${state.project.topic}" off this app. Save the ones you want to your phone first.`);
    if (!ok) return;
    await deleteProject(state.project.id);
  }
  state.project = { id: `p${Date.now()}`, topic, shuffle: 0, shots: makeShotList(topic, 0), createdAt: Date.now() };
  saveProject();
  await refreshTakeInfo();
  $('topic').value = '';
  renderList();
}

// ------------------------------------------------------------------ shot list
function renderList() {
  show('list');
  const p = state.project;
  $('list-topic').textContent = p.topic;
  const acts = ACTS.map((act) => {
    const idx = p.shots.map((s, i) => [s, i]).filter(([s]) => s.act === act.key);
    return h('section', { class: 'act', 'data-act': act.key },
      h('div', { class: 'act-head' },
        h('span', { class: 'act-num' }, `Act ${actNumber(act.key)}`),
        h('span', { class: 'act-name' }, act.name)),
      h('p', { class: 'act-blurb' }, act.blurb),
      idx.map(([s, i]) => h('article', { class: 'shot', 'data-act': s.act },
        h('div', { class: 'shot-top' },
          h('div', { class: 'shot-place' }, h('span', { class: `num${isDone(i) ? ' done' : ''}` }, isDone(i) ? '✓' : String(i + 1)), cap(s.place)),
          h('button', { class: 'swap', onclick: () => swap(i) }, 'Swap')),
        h('p', {}, s.action),
        h('div', { class: 'tags' },
          h('span', { class: 'feel' }, s.feeling),
          h('span', { class: 'tag' }, `Hold ${s.hold}s`),
          h('span', { class: 'tag' }, FRAME_LABEL[s.frame] || s.frame)),
        h('p', { class: 'tip' }, h('b', {}, 'Tip: '), s.tip))));
  });
  $('acts').replaceChildren(...acts);
  const started = state.takeInfo.length > 0;
  $('start-film').textContent = started ? 'Keep filming' : 'Start filming';
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function swap(i) {
  const p = state.project;
  p.shots[i] = swapShot(p.topic, p.shots, i);
  saveProject();
  renderList();
}

function shuffleAll() {
  const p = state.project;
  if (state.takeInfo.length && !confirm('Shuffle the whole list? Clips you already kept stay in your clips.')) return;
  p.shuffle = (p.shuffle || 0) + 1;
  p.shots = makeShotList(p.topic, p.shuffle);
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
// Must be called straight from a tap (iPhone asks for permission).
function askMotion() {
  if (state.motionAsked) return;
  state.motionAsked = true;
  const D = window.DeviceMotionEvent;
  if (!D) return;
  if (typeof D.requestPermission === 'function') {
    D.requestPermission().then((res) => { if (res === 'granted') addEventListener('devicemotion', onMotion); }).catch(() => {});
  } else {
    addEventListener('devicemotion', onMotion);
  }
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
  show('film');
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
  const n = state.project.shots.length;
  $('shot-num').textContent = `${state.current + 1} of ${n}`;
  $('shot-act').textContent = actOf(s.act).name;
  $('shot-place').textContent = cap(s.place);
  $('shot-action').textContent = s.action;
  $('shot-feel').textContent = s.feeling;
  $('shot-hold').textContent = `Hold ${s.hold}s`;
  $('shot-frame').textContent = FRAME_LABEL[s.frame] || s.frame;
  $('shot-tip').textContent = s.tip;
  $('shot-card').dataset.act = s.act;
  $('prev').disabled = state.current === 0;
  $('next').disabled = state.current === n - 1;
  $('text-zone').hidden = s.frame === 'detail';
  dotsFor($('dots'), { interactive: true });
  setHint(null);
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
  const want = { facingMode: { ideal: state.facing }, width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30 } };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
  } catch (err) {
    if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch (e2) { err = e2; }
    }
    if (!stream) {
      camMsg(err.name === 'NotAllowedError'
        ? "Camera is blocked. In Safari, tap the aA button in the address bar, then Website Settings, set Camera to Allow, and reload."
        : `The camera didn't start (${err.name || 'unknown error'}). Close other camera apps and reload.`);
      return;
    }
  }
  if ($('film').hidden) { stream.getTracks().forEach((t) => t.stop()); return; }
  state.stream = stream;
  video.srcObject = stream;
  $('cam-frame').classList.toggle('mirror', state.facing === 'user');
  try { await video.play(); } catch { /* autoplay with muted is allowed */ }
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  layoutFrame();
  camMsg(null);
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
}

function flipCamera() {
  if (state.phase !== 'idle') return;
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  startCamera();
}

// Grab one frame and measure it.
function sample({ withFace }) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const gw = GRAY_W, gh = Math.round(GRAY_W * vh / vw);
  if (grayCanvas.width !== gw || grayCanvas.height !== gh) { grayCanvas.width = gw; grayCanvas.height = gh; }
  grayCtx.drawImage(video, 0, 0, gw, gh);
  const stats = frameStats(grayCtx.getImageData(0, 0, gw, gh));
  const face = withFace ? findFaceInVideo(video) : undefined;
  const faceLuma = face && face.found ? regionMean(stats.gray, gw, gh, face) : null;
  return { ...stats, face: face === undefined ? null : face, faceLuma };
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
  const hint = liveHint(s, smp);
  if (!hint && s.frame !== 'detail' && !faceCheckerReady()) setHint({ short: 'Getting the framing check ready…', good: false });
  else setHint(hint);
}

function directionText(i) {
  const s = shotAt(i);
  return `Shot ${i + 1}. ${cap(s.place)}. ${s.action} It should feel ${s.feeling}.`;
}

function setRecUI() {
  const busy = state.phase === 'countdown' || state.phase === 'recording';
  $('rec').classList.toggle('busy', busy);
  $('rec').setAttribute('aria-label', state.phase === 'recording' ? 'Stop' : state.phase === 'countdown' ? 'Cancel' : 'Record');
  for (const id of ['flip', 'say', 'prev', 'next', 'film-back', 'film-clips']) $(id).disabled = busy;
  if (!busy) { $('prev').disabled = state.current === 0; $('next').disabled = state.current === state.project.shots.length - 1; }
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
  if (state.settings.voice) {
    $('listen').hidden = false;
    await speak(directionText(state.current));
    $('listen').hidden = true;
    if (token !== state.takeToken) return;
  }
  for (let n = state.settings.countdown; n > 0; n--) {
    $('count').textContent = n;
    $('count').hidden = false;
    beep(n <= 3 ? 740 : 620, 110);
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

function pickMime() {
  if (!window.MediaRecorder) return null;
  const options = ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4','video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return options.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}

let rec = null, chunks = [], samples = [], prevGray = null, tick = 0;
let sampleTimer = null, stopTimer = null, thumbTimer = null, rafId = null, thumbBlob = null;

function startRecording() {
  const shot = shotAt(state.current);
  if (!window.MediaRecorder) { toast("This browser can't record video"); cancelTake(); return; }
  const mime = pickMime();
  try {
    rec = new MediaRecorder(state.stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  } catch {
    rec = new MediaRecorder(state.stream);
  }
  chunks = []; samples = []; prevGray = null; tick = 0; thumbBlob = null;
  motionSamples.length = 0;
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
    samples.push({ t, mean: smp.mean, clipped: smp.clipped, face: smp.face, faceLuma: smp.faceLuma, shift });
  }, 250);

  thumbTimer = setTimeout(captureThumb, Math.min(shot.hold / 2, 2.5) * 1000);
  stopTimer = setTimeout(() => stopRecording(), (shot.hold + 1) * 1000);

  const tickUI = () => {
    if (state.phase !== 'recording') return;
    const el = (performance.now() - state.recStart) / 1000;
    $('rec-time').textContent = `${el.toFixed(1)}s`;
    $('ring-fg').style.strokeDashoffset = String(289 * (1 - Math.min(1, el / shot.hold)));
    rafId = requestAnimationFrame(tickUI);
  };
  tickUI();
}

function captureThumb() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const c = document.createElement('canvas');
  c.width = 360; c.height = Math.round(360 * vh / vw);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  c.toBlob((b) => { thumbBlob = b; }, 'image/jpeg', 0.82);
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

async function finishTake() {
  const shot = shotAt(state.current);
  const type = (rec && rec.mimeType) || chunks[0]?.type || 'video/mp4';
  const blob = new Blob(chunks, { type });
  rec = null;
  if (!$('film').hidden || state.phase === 'stopping') {
    // give the thumbnail a moment if it is still being made
    for (let i = 0; i < 10 && !thumbBlob; i++) await sleep(50);
  }
  if ($('film').hidden) { state.phase = 'idle'; return; } // left the screen mid-take
  if (!blob.size) {
    state.phase = 'idle'; setRecUI();
    toast('Nothing was recorded, try again');
    return;
  }
  const verdict = judgeTake({ shot, samples, motion: motionSamples.slice(), duration: state.duration });
  pending = {
    id: `t${Date.now()}`,
    projectId: state.project.id,
    shotIndex: state.current,
    shotId: shot.id,
    act: shot.act,
    place: shot.place,
    room: roomOf(shot.place),
    action: shot.action,
    feeling: shot.feeling,
    frame: shot.frame,
    hold: shot.hold,
    duration: state.duration,
    ok: verdict.ok,
    fix: verdict.fix,
    createdAt: Date.now(),
    blob,
    thumb: thumbBlob,
    saved: false,
  };
  state.lastVerdict = verdict;
  if (verdict.ok) await keepPending();
  state.phase = 'review';
  showReview(verdict);
  speak(verdict.ok ? 'Good shot, saved.' : `Do it again. ${verdict.fix}`);
}

async function keepPending() {
  try {
    await saveTake(pending);
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
  $('review').hidden = false;
}

function renderReviewState(verdict) {
  const title = $('verdict-title');
  const keptAnyway = !verdict.ok && pending.saved;
  title.textContent = keptAnyway ? 'Kept anyway' : verdict.title;
  title.className = `verdict-title ${verdict.ok ? 'good' : 'bad'}`;
  $('verdict-fix').textContent = verdict.fix;
  const remaining = firstUndone(state.current + 1);
  const nextLabel = remaining === -1 ? 'See my clips' : 'Next shot';
  const actions = $('review-actions');
  const extra = $('review-extra');
  if (pending.saved) {
    actions.replaceChildren(
      h('button', { class: 'btn primary grow', id: 'rv-next', onclick: () => closeReview('next') }, nextLabel),
      h('button', { class: 'btn grow', id: 'rv-again', onclick: () => closeReview('again') }, 'Another take'));
    extra.textContent = 'Delete this take';
    extra.onclick = async () => { await deleteTake(pending.id); await refreshTakeInfo(); closeReview('again'); toast('Take deleted'); };
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
function updateSettingsLabels() {
  $('cd-label').textContent = `${state.settings.countdown}s`;
  $('voice-label').textContent = state.settings.voice ? 'on' : 'off';
  for (const b of $('seg-countdown').children) b.classList.toggle('on', Number(b.dataset.v) === state.settings.countdown);
  for (const b of $('seg-voice').children) b.classList.toggle('on', (b.dataset.v === 'on') === state.settings.voice);
}
function setSetting(key, value) {
  state.settings[key] = value;
  store.set('broll.settings', state.settings);
  if (key === 'voice') setVoiceEnabled(value);
  updateSettingsLabels();
}

// ------------------------------------------------------------------ clips
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const extFor = (type) => (/mp4/.test(type) ? 'mp4' : /quicktime/.test(type) ? 'mov' : /webm/.test(type) ? 'webm' : 'mp4');
let clipTakes = [];
let thumbUrls = [];

function fileFor(take) {
  const sameShot = clipTakes.filter((t) => t.shotIndex === take.shotIndex);
  const n = sameShot.indexOf(take) + 1;
  const name = `${String(take.shotIndex + 1).padStart(2, '0')}-${take.act}-${slug(take.place)}-${slug(take.feeling)}${sameShot.length > 1 ? `-take${n}` : ''}.${extFor(take.blob.type)}`;
  return new File([take.blob], name, { type: take.blob.type || 'video/mp4' });
}

async function openClips(from) {
  state.clipsReturn = from;
  show('clips');
  $('clips-topic').textContent = state.project ? state.project.topic : '';
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  clipTakes = state.project ? await listTakes(state.project.id).catch(() => []) : [];
  // Ready-made files, so saving can start straight from your tap.
  clipTakes.forEach((t) => { t.file = fileFor(t); });
  renderClips();
}

function renderClips() {
  $('clips-empty').hidden = clipTakes.length > 0;
  $('save-all').disabled = clipTakes.length === 0;
  $('save-all').textContent = clipTakes.length > 1 ? `Save all ${clipTakes.length} to my phone` : 'Save to my phone';
  const groups = ACTS.map((act) => {
    const takes = clipTakes.filter((t) => t.act === act.key).sort((a, b) => a.shotIndex - b.shotIndex || a.createdAt - b.createdAt);
    if (!takes.length) return null;
    const rooms = [...new Set(takes.map((t) => t.room))];
    return h('section', { class: 'clip-act act', 'data-act': act.key },
      h('div', { class: 'clip-act-head' },
        h('div', { class: 'act-head' }, h('span', { class: 'act-num' }, `Act ${actNumber(act.key)}`), h('span', { class: 'act-name' }, act.name)),
        takes.length > 1 ? h('button', { class: 'save-act', onclick: () => shareFiles(takes.map((t) => t.file)) }, `Save these ${takes.length}`) : null),
      rooms.map((room) => h('div', {},
        h('div', { class: 'room' }, cap(room)),
        h('div', { class: 'grid' }, takes.filter((t) => t.room === room).map(tile)))));
  }).filter(Boolean);
  $('clip-groups').replaceChildren(...groups);
}

function tile(take) {
  let media;
  if (take.thumb) {
    const u = URL.createObjectURL(take.thumb);
    thumbUrls.push(u);
    media = h('img', { src: u, alt: '' });
  } else {
    media = h('div', {});
  }
  return h('button', { class: 'clip', 'data-act': take.act, 'aria-label': `Shot ${take.shotIndex + 1}, ${take.feeling}`, onclick: () => openPlayer(take) },
    media,
    h('span', { class: 'n' }, String(take.shotIndex + 1)),
    take.ok ? null : h('span', { class: 'warn', title: 'Kept anyway' }, '!'),
    h('span', { class: 'mood' }, take.feeling));
}

let playerUrl = null, playerTake = null;
function openPlayer(take) {
  playerTake = take;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(take.blob);
  const pv = $('player-video');
  pv.src = playerUrl;
  pv.play().catch(() => {});
  $('player-where').textContent = `Shot ${take.shotIndex + 1} · ${actOf(take.act).name} · ${cap(take.place)} · ${take.feeling}`;
  $('player-action').textContent = take.ok ? take.action : `${take.action} (Kept anyway: ${take.fix})`;
  $('player').hidden = false;
}
function closePlayer() {
  $('player').hidden = true;
  const pv = $('player-video');
  pv.pause(); pv.removeAttribute('src'); pv.load();
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
}

// iPhone: opens the share sheet, where "Save Video" puts clips in Photos.
async function shareFiles(files) {
  if (!files.length) return;
  if (navigator.canShare && navigator.share && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn(e);
      if (files.length > 1) { toast("That was too many at once. Try saving one act at a time.", 4000); return; }
    }
  }
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    await sleep(350);
  }
  toast(files.length > 1 ? `Downloading ${files.length} clips` : 'Downloading the clip');
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
  $('say').onclick = () => { unlockAudio(); speak(directionText(state.current)); };
  $('open-settings').onclick = () => { if (state.phase === 'idle') { updateSettingsLabels(); $('settings').hidden = false; } };
  $('settings-done').onclick = () => { $('settings').hidden = true; };
  $('settings').onclick = (e) => { if (e.target === $('settings')) $('settings').hidden = true; };
  for (const b of $('seg-countdown').children) b.onclick = () => setSetting('countdown', Number(b.dataset.v));
  for (const b of $('seg-voice').children) b.onclick = () => setSetting('voice', b.dataset.v === 'on');

  $('clips-back').onclick = () => {
    if (state.clipsReturn === 'film' && state.project) enterFilm(state.current);
    else renderHome();
  };
  $('save-all').onclick = () => shareFiles(clipTakes.map((t) => t.file));
  $('new-video').onclick = startNewVideo;
  $('player-close').onclick = closePlayer;
  $('player-save').onclick = () => playerTake && shareFiles([playerTake.file]);
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
  await refreshTakeInfo();
  renderHome();
}

boot();

// Handy for testing in a desktop browser's console.
window.brollDirector = { state, judgeTake, get samples() { return samples; } };
