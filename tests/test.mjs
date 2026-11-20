import { chromium, webkit } from 'playwright';
import fs from 'fs';
const FEEDS = new URL('./.work/feeds/', import.meta.url).pathname;
const OUT = new URL('./.work/screens/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const URL_ = process.env.APP || 'http://127.0.0.1:8765/';
const lib = JSON.parse(fs.readFileSync(new URL('../shots.json', import.meta.url), 'utf8'));
const pick = (...ids) => ids.map((id) => lib.shots.find((s) => s.id === id));
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// Stand-in for the iPhone share sheet: records what would be shared.
// __shareMode: 'all' (several files at once), 'single' (one at a time), 'none' (no share sheet).
const shareStub = () => {
  window.__shared = [];
  window.__shareMode = 'all';
  const files = (d) => (d && d.files) || [];
  navigator.canShare = (d) => window.__shareMode === 'all' || (window.__shareMode === 'single' && files(d).length === 1);
  navigator.share = async (d) => {
    if (!navigator.canShare(d)) throw new DOMException('Not allowed', 'NotAllowedError');
    window.__shared.push(files(d).map((f) => ({ name: f.name, type: f.type, size: f.size })));
  };
};

async function open(feed, init) {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${FEEDS}${feed}.mjpeg`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(shareStub);
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/^(INFO|W[0-9]|I[0-9])/.test(m.text())) errors.push(m.text()); });
  await page.goto(URL_);
  return { browser, page, errors };
}

async function waitFaceReady(page) {
  await page.waitForFunction(() => {
    const h = document.querySelector('#hint');
    return !h.hidden && !/Getting|Loading/.test(h.textContent);
  }, null, { timeout: 60000 });
  return page.textContent('#hint span');
}

async function readReview(page) {
  await page.waitForSelector('#review:not([hidden])', { timeout: 40000 });
  return page.evaluate(() => ({
    title: document.querySelector('#verdict-title').textContent,
    fix: document.querySelector('#verdict-fix').textContent,
    checks: [...document.querySelectorAll('#checks li')].map((li) => `${li.className}:${li.querySelector('.lbl').textContent}=${li.querySelector('.nt').textContent}`),
  }));
}

// ---------- 1. Full walk-through ----------
{
  const { browser, page, errors } = await open('good', { fn: () => localStorage.setItem('broll.settings', JSON.stringify({ voice: true })) });
  await page.waitForSelector('#home:not([hidden])');
  await page.screenshot({ path: `${OUT}01-home.png` });
  await page.fill('#topic', "student who's always tired tries a new sleep routine");
  await page.click('#make');
  await page.waitForSelector('#list:not([hidden])');
  const list = await page.$$eval('.shot', (els) => els.map((e) => `${e.dataset.act} | ${e.querySelector('.shot-place').textContent.replace(/^\d/, '')} | ${e.querySelector('p').textContent} | ${e.querySelector('.feel').textContent}`));
  ok('Shot list has 9 shots', list.length === 9, '');
  ok('3 per act', ['struggle', 'grind', 'win'].every((a) => list.filter((l) => l.startsWith(a)).length === 3));
  console.log(list.map((l) => '   ' + l).join('\n'));
  const mix = await page.evaluate(() => { const s = window.brollDirector.state.project.lists.broll; return { faceless: s.filter((x) => !x.face).length, first: s[0].style, styles: [...new Set(s.map((x) => x.style))] }; });
  ok('55-75% of shots are without your face', mix.faceless >= 5 && mix.faceless <= 7, `${mix.faceless} of 9 faceless`);
  ok('Shot 1 is a visual hook, and shots come in different kinds', mix.first === 'visual-hook' && mix.styles.length >= 5, mix.styles.join(', '));
  ok('Each card says which kind of shot it is', /Visual hook/.test(await page.textContent('.shot >> nth=0')));
  ok('Default hold is 5 s', await page.evaluate(() => window.brollDirector.state.project.lists.broll.every((s) => s.hold === 5)));
  await page.screenshot({ path: `${OUT}02-list.png` });
  const before = await page.textContent('.shot:nth-of-type(1) p');
  await page.click('.act >> nth=0 >> .swap >> nth=0');
  const after = await page.textContent('.act >> nth=0 >> .shot >> nth=0 >> p');
  ok('Swap changes a shot', before !== after);
  await page.click('#start-film');
  await page.waitForSelector('#film:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#cam-msg').hidden && document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  ok('Camera preview starts', await page.evaluate(() => document.querySelector('#video').videoWidth > 0));
  // Danger zones and the text box on the preview
  const zoneBox = () => page.evaluate(() => {
    const f = document.querySelector('#cam-frame').getBoundingClientRect();
    const r = (id) => { const e = document.getElementById(id); if (e.hidden) return null; const b = e.getBoundingClientRect(); return { top: (b.top - f.top) / f.height, h: b.height / f.height, w: b.width / f.width }; };
    return { top: r('dz-top'), bottom: r('dz-bottom'), right: r('dz-right'), text: r('text-box'), label: document.querySelector('#dz-name').textContent };
  });
  const z1 = await zoneBox();
  ok('Danger zones show on the preview (TikTok: top 8%, bottom 22%, right 12%)', z1.top && Math.abs(z1.top.h - 0.08) < 0.01 && Math.abs(z1.bottom.h - 0.22) < 0.01 && Math.abs(z1.right.w - 0.12) < 0.01 && /approx/.test(z1.label), JSON.stringify(z1.label));
  ok('Text box sits in the middle, clear of the zones', z1.text && z1.text.top > 0.4 && z1.text.top + z1.text.h < 0.78);
  await page.click('#open-guides');
  await page.click('#seg-platform button[data-v=shorts]');
  const z2 = await zoneBox();
  await page.click('#seg-zones button[data-v=off]');
  const z3 = await zoneBox();
  await page.screenshot({ path: `${OUT}03b-guides.png` });
  await page.click('#seg-zones button[data-v=on]');
  await page.click('#seg-platform button[data-v=tiktok]');
  await page.click('#guides-done');
  ok('Picking Shorts changes the zones', Math.abs(z2.bottom.h - 0.24) < 0.01 && /Shorts/.test(z2.label), z2.label);
  ok('Danger zones can be turned off and on', z3.top === null && z3.bottom === null && z3.text !== null);
  const shot = await page.evaluate(() => window.brollDirector.state.project.lists.broll[0]);
  if (shot.frame !== 'detail') {
    const hint = await waitFaceReady(page).catch(() => 'no hint');
    console.log('   live hint before recording:', hint);
  }
  await page.screenshot({ path: `${OUT}03-film.png` });
  const q = await page.evaluate(() => ({ chip: document.querySelector('#quality').textContent, w: document.querySelector('#video').videoWidth, h: document.querySelector('#video').videoHeight, s: window.brollDirector.state.stream.getVideoTracks()[0].getSettings() }));
  ok('Camera quality is shown on the preview', q.chip.length > 0, `"${q.chip}" (${q.w} × ${q.h}, fake camera; asked for up to 4K/30)`);
  ok('No countdown setting any more', await page.evaluate(() => !document.querySelector('#seg-countdown')));
  await page.click('#rec');
  await page.waitForSelector('#count:not([hidden])', { timeout: 30000 });
  const firstCount = await page.textContent('#count');
  await page.screenshot({ path: `${OUT}04-countdown.png` });
  ok('Countdown is 3-2-1 (after the direction is read)', firstCount === '3', `starts at ${firstCount}`);
  await page.waitForSelector('#rec-badge:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}05-recording.png` });
  const rv = await readReview(page);
  console.log('   take 1 verdict:', JSON.stringify(rv));
  ok('Review appears after the take', !!rv.title);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}06-review.png` });
  await page.click('#rv-save');
  const shared1 = await page.evaluate(() => window.__shared.at(-1));
  ok('Save to Photos after a take opens the share sheet with one MP4 file', shared1?.length === 1 && /\.mp4$/.test(shared1[0].name) && /mp4/.test(shared1[0].type) && shared1[0].size > 1000, JSON.stringify(shared1));
  if (/Do it again/.test(rv.title)) { await page.click('#rv-keep'); await page.waitForTimeout(500); }
  const dotsDone = await page.$$eval('#dots .dot.done', (d) => d.length);
  ok('Progress dot fills after a kept take', dotsDone === 1, `${dotsDone} done`);
  await page.click('#rv-next');
  await page.waitForTimeout(500);
  const cur = await page.textContent('#shot-num');
  ok('Next shot moves on', /^Shot 2 of 9/.test(cur), cur);
  // record a second shot quickly (keep anyway if flagged)
  await page.click('#rec');
  const rv2 = await readReview(page);
  console.log('   take 2 verdict:', JSON.stringify(rv2));
  if (/Do it again/.test(rv2.title)) await page.click('#rv-keep');
  await page.waitForTimeout(300);
  await page.click('#rv-next');
  await page.click('#film-clips');
  await page.waitForSelector('#clips:not([hidden])');
  await page.waitForSelector('.clip img', { timeout: 10000 });
  const tiles = await page.$$eval('.clip', (els) => els.map((e) => e.querySelector('.mood').textContent));
  const rooms = await page.$$eval('.room', (els) => els.map((e) => e.textContent));
  ok('Clips grid shows both kept clips with mood labels', tiles.length === 2, `${tiles.join(', ')} | rooms: ${rooms.join(', ')}`);
  await page.screenshot({ path: `${OUT}07-clips.png` });
  ok('Every clip in the grid has its own Save to Photos button', (await page.$$('.tile-save')).length === 2);
  await page.click('#save-all');
  const sharedAll = await page.evaluate(() => window.__shared.at(-1));
  ok('Save all shares every clip in one go when Safari allows it', sharedAll?.length === 2 && sharedAll.every((f) => /\.mp4$/.test(f.name)), sharedAll?.map((f) => f.name).join(', '));
  await page.evaluate(() => { window.__shareMode = 'single'; });
  await page.click('#save-all');
  await page.waitForSelector('#save-queue:not([hidden])');
  const q1 = await page.textContent('#queue-next');
  await page.click('#queue-next');
  await page.click('#queue-next');
  const qDone = await page.textContent('#queue-title');
  const singles = await page.evaluate(() => window.__shared.slice(-2).map((x) => x.length));
  await page.click('#queue-done');
  ok('Otherwise it saves one at a time, a tap per clip', q1 === 'Save clip 1 of 2' && qDone === 'All saved' && singles.join() === '1,1', `${q1} -> ${qDone}`);
  await page.evaluate(() => { window.__shareMode = 'none'; });
  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.click('.tile-save >> nth=0');
  const download = await dl;
  const toastText = await page.textContent('#toast');
  ok('Without a share sheet it downloads and says it lands in the Files app', !!download && /Files app/.test(toastText), `${download?.suggestedFilename()} | ${toastText}`);
  await page.evaluate(() => { window.__shareMode = 'all'; });
  // Edit plan
  await page.click('#open-plan');
  await page.waitForSelector('#plan:not([hidden])');
  const plan = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.plan-clip')].map((r) => r.querySelector('.plan-label').textContent + (r.classList.contains('missing') ? ' (not filmed)' : '')),
    items: [...document.querySelectorAll('#plan-list .tick-text')].map((t) => t.textContent),
  }));
  console.log('   plan:', plan.rows.slice(0, 3).join(' / '));
  ok('Edit plan lists the clips in order', plan.rows.length === 9 && /Visual hook/.test(plan.rows[0]) && plan.rows.filter((r) => !/not filmed/.test(r)).length === 2, `${plan.rows.length} rows`);
  const want = [/hook as text in the middle/, /under 2 seconds/, /every 1–3 seconds.*110–120%/, /Cut every 1–2 seconds/, /transcript.*breaths/, /1–3 words/, /same caption font/i, /danger zones/, /under 10 seconds/, /under 60 seconds.*1:00/, /quotable/, /loop back/, /Music low/, /ending clip/, /1080 × 1920/];
  const missing = want.filter((re) => !plan.items.some((t) => re.test(t)));
  ok('Edit plan has every checklist item', missing.length === 0, missing.length ? `missing ${missing.join(' ')}` : `${plan.items.length} tick boxes`);
  await page.click('#plan-list .tick >> nth=0');
  await page.click('#plan-list .tick >> nth=3');
  await page.screenshot({ path: `${OUT}07b-plan.png`, fullPage: true });
  await page.click('#plan-back');
  await page.waitForSelector('#clips:not([hidden])');
  await page.click('#clips-plan');
  const kept = await page.evaluate(() => ({ n: document.querySelectorAll('#plan-list input:checked').length, p: document.querySelector('#plan-progress').textContent }));
  ok('Edit plan ticks are saved on the phone', kept.n === 2, kept.p);
  await page.click('#plan-back');
  await page.waitForSelector('#clips:not([hidden])');
  await page.click('.clip >> nth=0');
  await page.waitForSelector('#player:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#player-video').readyState >= 1, null, { timeout: 10000 });
  const dur = await page.evaluate(() => document.querySelector('#player-video').duration);
  ok('Clip plays back from the phone storage', dur > 0, `duration ${dur}`);
  await page.screenshot({ path: `${OUT}08-player.png` });
  const fileNames = await page.evaluate(async () => {
    const m = await import('./js/store.js');
    const p = window.brollDirector.state.project;
    const t = await m.listTakes(p.id);
    return t.map((x) => `${x.blob.type} ${(x.blob.size / 1024).toFixed(0)}KB`);
  });
  ok('Clips saved in IndexedDB', fileNames.length === 2, fileNames.join(', '));
  const prefers = await page.evaluate(() => {
    const real = MediaRecorder.isTypeSupported;
    MediaRecorder.isTypeSupported = () => true;
    const r = [window.brollDirector.pickMime(false), window.brollDirector.pickMime(true)];
    MediaRecorder.isTypeSupported = real;
    return r;
  });
  ok('The recorder asks for MP4 with H.264 first (what Photos accepts)', prefers[0] === 'video/mp4;codecs=avc1' && prefers[1] === 'video/mp4;codecs=avc1,mp4a.40.2', prefers.join(' | '));
  console.log(`   (this test browser recorded ${fileNames[0].split(' ')[0]}: open-source Chromium has no H.264 encoder; Safari's engine is checked at the end)`);
  // reload: everything still there
  await page.reload();
  await page.waitForSelector('#resume:not([hidden])');
  const resumeDots = await page.$$eval('#resume-dots .dot.done', (d) => d.length);
  ok('After reload, progress is remembered', resumeDots === 2);
  await page.screenshot({ path: `${OUT}09-home-resume.png` });
  ok('No page errors (walk-through)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// ---------- 2. Verdict scenarios on a waist-up shot ----------
const project = { id: 'ptest', topic: 'test', shuffle: 0, shots: pick('s1', 's2', 's3', 'g1', 'g2', 'g3', 'w1', 'w2', 'w3') };
const init = { fn: (p) => { localStorage.setItem('broll.project', JSON.stringify(p)); localStorage.setItem('broll.settings', JSON.stringify({ voice: false })); }, arg: project };
const scenarios = [
  { feed: 'good', expect: /Good shot, saved/, fixRe: /./, name: 'Well framed take is accepted' },
  { feed: 'tight', expect: /Do it again/, fixRe: /Too tight, no room above your head, step back a little/, name: 'Too tight / no headroom is caught' },
  { feed: 'dark', expect: /Do it again/, fixRe: /Too dark/, name: 'Too dark is caught' },
  { feed: 'shaky', expect: /Do it again/, fixRe: /Too shaky/, name: 'Shaky camera is caught' },
  { feed: 'good', expect: /Do it again/, fixRe: /Too short/, name: 'Stopping early is caught', stopAfter: 2000 },
];
for (const sc of scenarios) {
  const { browser, page, errors } = await open(sc.feed, init);
  await page.click('#resume-film');
  await page.waitForFunction(() => document.querySelector('#cam-msg').hidden && document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  const hint = await waitFaceReady(page).catch(() => 'no hint');
  await page.click('#rec');
  if (sc.stopAfter) {
    await page.waitForSelector('#rec-badge:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(sc.stopAfter);
    await page.click('#rec');
  }
  const rv = await readReview(page);
  const pass = sc.expect.test(rv.title) && sc.fixRe.test(rv.fix);
  ok(sc.name, pass, `hint "${hint}" → ${rv.title}: ${rv.fix}`);
  if (!pass) console.log('     checks:', rv.checks.join(' ; '));
  await page.screenshot({ path: `${OUT}10-verdict-${sc.feed}${sc.stopAfter ? '-short' : ''}.png` });
  if (errors.length) ok(`No page errors (${sc.feed})`, false, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// ---------- 2b. The framing message fits inside the preview on small iPhones ----------
for (const vp of [{ width: 375, height: 667, name: 'iPhone SE' }, { width: 390, height: 844, name: 'iPhone 14' }]) {
  const { browser, page } = await open('good', init);
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.click('#resume-film');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  const fit = await page.evaluate(() => {
    const hint = document.querySelector('#hint');
    hint.hidden = false; hint.querySelector('span').textContent = 'Loading framing check…';
    const a = hint.getBoundingClientRect(), b = document.querySelector('#cam-frame').getBoundingClientRect();
    const span = hint.querySelector('span');
    return { inside: a.left >= b.left - 0.5 && a.right <= b.right + 0.5, notClipped: span.scrollWidth <= span.clientWidth + 1, hint: Math.round(a.width), frame: Math.round(b.width) };
  });
  await page.screenshot({ path: `${OUT}13-hint-${vp.width}.png` });
  ok(`Framing message fits on ${vp.name}`, fit.inside && fit.notClipped, `message ${fit.hint}px wide in a ${fit.frame}px preview`);
  const foot = await page.evaluate(() => { const r = document.querySelector('.film-foot').getBoundingClientRect(); return r.right <= innerWidth + 0.5 && document.querySelector('.film-foot').scrollWidth <= document.querySelector('.film-foot').clientWidth + 1; });
  ok(`Bottom buttons fit on ${vp.name}`, foot);
  await browser.close();
}

// ---------- 2c. Use a clip from my Photos ----------
const clipCases = [
  { file: 'clip-good', expect: /Good shot, saved/, fixRe: /./, name: 'Clip from Photos: good clip is accepted and saved' },
  { file: 'clip-dark', expect: /Do it again/, fixRe: /Too dark/, name: 'Clip from Photos: dark clip is caught' },
  { file: 'clip-short', expect: /Do it again/, fixRe: /Too short/, name: 'Clip from Photos: too-short clip is caught' },
  { file: 'clip-sideways', expect: /Do it again/, fixRe: /sideways/, name: 'Clip from Photos: sideways clip is caught' },
  { file: 'clip-4k', expect: /Good shot, saved/, fixRe: /./, name: 'Clip from Photos: 4K clip is checked and saved', quality: /4K \(2160 × 3840\)/ },
];
for (const cc of clipCases) {
  const { browser, page, errors } = await open('good', init);
  await page.click('#resume-film');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  const path = `${FEEDS}${cc.file}.webm`;
  const t0 = Date.now();
  await page.setInputFiles('#photo-input', path);
  await page.waitForSelector('#checking:not([hidden])', { timeout: 5000 }).catch(() => {});
  const rv = await readReview(page);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const rq = await page.textContent('#review-quality');
  const pass = cc.expect.test(rv.title) && cc.fixRe.test(rv.fix) && (!cc.quality || cc.quality.test(rq));
  ok(cc.name, pass, `${rv.title}: ${rv.fix} | ${rq} | checked in ${secs}s`);
  if (!pass) console.log('     checks:', rv.checks.join(' ; '));
  await page.screenshot({ path: `${OUT}14-${cc.file}.png` });
  if (/Good shot/.test(rv.title)) {
    // The saved file is the original, byte for byte.
    const orig = fs.readFileSync(path);
    const saved = await page.evaluate(async () => {
      const m = await import('./js/store.js');
      const t = (await m.listTakes(window.brollDirector.state.project.id)).at(-1);
      const u = new Uint8Array(await t.blob.arrayBuffer());
      let sum = 0; for (let i = 0; i < u.length; i += 997) sum = (sum + u[i] * (i % 251 + 1)) % 1e9;
      return { size: u.length, sum, type: t.blob.type, name: t.originalName, source: t.source };
    });
    let sum = 0; for (let i = 0; i < orig.length; i += 997) sum = (sum + orig[i] * (i % 251 + 1)) % 1e9;
    ok(`${cc.file}: saved file is the untouched original`, saved.size === orig.length && saved.sum === sum && saved.source === 'photos', `${(saved.size / 1e6).toFixed(1)} MB, ${saved.type}`);
    await page.click('#rv-next');
    await page.click('#film-clips');
    await page.waitForSelector('.clip');
    const fname = await page.evaluate(() => window.brollDirector.clipFiles().map((f) => f.name));
    ok(`${cc.file}: saves with its own file type`, fname.every((n) => n.endsWith('.webm')), fname.join(', '));
  }
  if (errors.length) ok(`No page errors (${cc.file})`, false, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// ---------- 2d. Script: say it, show it ----------
const SCRIPT = "I paid off $8,000 in six months.\nI was always broke by the 20th.\nI started tracking every coffee.\nThen I moved money to savings on payday.\nNow I actually sleep at night.";
{
  const { browser, page, errors } = await open('good');
  await page.waitForSelector('#home:not([hidden])');
  await page.fill('#topic', 'paying off my credit card');
  await page.click('#add-script');
  await page.fill('#script', SCRIPT);
  await page.click('#make');
  await page.waitForSelector('#list:not([hidden])');
  const cut = await page.$$eval('.shot', (els) => els.map((e) => `${e.querySelector('.line')?.textContent} -> ${e.querySelectorAll('p')[1].textContent}`));
  console.log(cut.map((l) => '   ' + l).join('\n'));
  ok('Script makes one cutaway per line (say it, show it)', cut.length === 5 && cut.every((c, i) => c.startsWith(`Line ${i + 1}:`)), `${cut.length} cutaways`);
  ok('Cutaways say to use 0.5-1 s of each', (await page.$$eval('.shot .tag', (t) => t.filter((x) => /0\.5–1 s/.test(x.textContent)).length)) === 5);
  await page.screenshot({ path: `${OUT}15-script-cutaways.png`, fullPage: true });
  if (errors.length) ok('No page errors (script)', false, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// ---------- 2e. Talking to camera ----------
{
  const { browser, page, errors } = await open('talk', { fn: () => localStorage.setItem('broll.settings', JSON.stringify({ voice: false })) });
  await page.waitForSelector('#home:not([hidden])');
  await page.click('#home-mode button[data-v=talking]');
  await page.fill('#topic', 'paying off my credit card');
  await page.click('#add-script');
  await page.fill('#script', SCRIPT);
  await page.click('#make');
  await page.waitForSelector('#list:not([hidden])');
  const takes = await page.$$eval('.shot', (els) => els.map((e) => e.innerText.replace(/\n+/g, ' | ')));
  console.log(takes.map((l) => '   ' + l.slice(0, 150)).join('\n'));
  ok('Talking takes: hook is filmed last, with the reason why', /The hook/.test(takes.at(-1)) && /voice is warmed up/.test(takes.at(-1)) && takes.length === 5, `${takes.length} takes`);
  ok('Talking tips are on every card', takes.every((t) => /FaceTiming a friend/.test(t) && /first sentence fast/.test(t) && /no pauses/.test(t)));
  await page.screenshot({ path: `${OUT}16-talk-list.png`, fullPage: true });
  await page.click('#start-film');
  await page.waitForFunction(() => document.querySelector('#cam-msg').hidden && document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  const hint = await waitFaceReady(page).catch(() => 'no hint');
  const live = await page.evaluate(() => ({
    mic: window.brollDirector.state.stream.getAudioTracks().length,
    eye: !document.querySelector('#eye-line').hidden && document.querySelector('#eye-line').style.top,
  }));
  ok('Talking to camera records your voice too', live.mic === 1);
  ok('Eye line guide sits a third of the way down', /33\.3/.test(live.eye), live.eye);
  ok('Live hint on a well-framed talking shot', /look good/.test(hint), hint);
  await page.screenshot({ path: `${OUT}17-talk-film.png` });
  await page.click('#rec');
  await page.waitForSelector('#listen:not([hidden])', { timeout: 5000 });
  const breath = await page.textContent('#listen');
  await page.waitForSelector('#count:not([hidden])', { timeout: 8000 });
  const count = await page.textContent('#count');
  ok('Before a talking take: "Take a deep breath", then 3-2-1', /Take a deep breath/.test(breath) && count === '3', `${breath} then ${count}`);
  await page.waitForSelector('#rec-badge:not([hidden])', { timeout: 8000 });
  const hold = await page.evaluate(() => window.brollDirector.state.project.lists.talking[0].hold);
  await page.waitForTimeout(hold * 1000 + 1500);
  ok('Talking takes keep recording until you tap stop', await page.evaluate(() => !document.querySelector('#rec-badge').hidden));
  await page.click('#rec');
  const rv = await readReview(page);
  console.log('   talking take:', JSON.stringify(rv));
  ok('Well-framed talking take is accepted', /Good shot, saved/.test(rv.title), `${rv.title}: ${rv.fix}`);
  ok('Talking take is checked for eye level too', rv.checks.some((c) => /Eye level/.test(c)), rv.checks.join(' ; '));
  const bg = await page.evaluate(() => ({ shown: !document.querySelector('#bg-check').hidden, ticks: [...document.querySelectorAll('#bg-check .tick-text')].map((t) => t.textContent) }));
  ok('Without a Claude key, the background is a quick checklist', bg.shown && bg.ticks.length === 4 && /6 feet/.test(bg.ticks[0]) && /pajama/.test(bg.ticks[3]), bg.ticks.join(' | '));
  const type = await page.evaluate(() => window.brollDirector.pendingFile?.type);
  await page.click('#rv-save');
  const shared = await page.evaluate(() => window.__shared.at(-1));
  ok('Talking take is recorded with sound and saves to Photos as an .mp4', /mp4/.test(type) && /mp4a|opus/.test(type) && /^talk-02-line\.mp4$/.test(shared?.[0]?.name), `${type} | ${shared?.[0]?.name}`);
  await page.screenshot({ path: `${OUT}18-talk-review.png`, fullPage: true });
  await page.click('#rv-next');
  await page.click('#film-clips');
  await page.waitForSelector('.clip');
  await page.click('#open-plan');
  await page.waitForSelector('#plan:not([hidden])');
  const rows = await page.$$eval('.plan-clip .plan-label', (els) => els.map((e) => e.textContent));
  console.log('   talking plan:', rows.join(' / '));
  ok('Edit plan puts the hook first, then each part with its b-roll', /The hook/.test(rows[0]) && /Visual hook|Cut to/.test(rows[1]) && rows.some((r) => /part 1/.test(r)), rows.slice(0, 4).join(' / '));
  const hookItem = await page.textContent('#plan-list .tick-text >> nth=0');
  ok('Edit plan prints your hook to put on screen', /“I paid off \$8,000 in six months\.”/.test(hookItem), hookItem);
  await page.screenshot({ path: `${OUT}19-talk-plan.png`, fullPage: true });
  ok('No page errors (talking)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// ---------- 2f. Talking-to-camera checks ----------
const talkTake = { kind: 'talk', act: 'talk', place: 'talking to camera', style: 'talk', frame: 'talk', face: true, cam: 'propped', themes: ['general'], id: 'tt1', role: 'line', videoOrder: 1, action: 'Say: “This is a test.”', say: 'This is a test.', feeling: 'warm', hold: 2, tip: '' };
const talkProject = { id: 'ptalk', topic: 'test', script: '', shuffle: 0, mode: 'talking', lists: { broll: pick('s1', 's2', 's3'), talking: [talkTake] } };
const talkCases = [
  { feed: 'talk', expect: /Good shot, saved/, fixRe: /./, name: 'Talking: eyes on the top third, good size, centred = accepted' },
  { feed: 'talk-close', expect: /Do it again/, fixRe: /^Step back a little, your face is too big\.$/, name: 'Talking: face over 45% wide = "Step back a little"' },
  { feed: 'talk-low', expect: /Do it again/, fixRe: /eyes are too low.*a third of the way down/, name: 'Talking: eyes too low in the frame' },
  { feed: 'talk-edge', expect: /Do it again/, fixRe: /like and comment buttons/, name: 'Talking: face under the like / comment buttons' },
  { feed: 'talk-backlit', expect: /Do it again/, fixRe: /window behind you, turn around and face the window/, name: 'Talking: window behind you' },
  { feed: 'talk-halfdark', expect: /Do it again/, fixRe: /Half your face is dark, turn a little toward the light/, name: 'Talking: half your face is dark' },
  { feed: 'talk', tilt: 68, expect: /Do it again/, fixRe: /Raise the phone to eye level/, name: 'Talking: phone tilted up = "Raise the phone to eye level"' },
  { feed: 'good', title: true, expect: /Do it again/, fixRe: /Frame looser so your title fits above your head/, name: 'Talking: title above your head needs a looser frame' },
];
for (const tc of talkCases) {
  const { browser, page, errors } = await open(tc.feed, {
    fn: ([p, tilt, title]) => {
      localStorage.setItem('broll.project', JSON.stringify(p));
      localStorage.setItem('broll.settings', JSON.stringify({ voice: false, titleAbove: title }));
      // Pretend the phone's tilt sensor reports this (front camera: under 90 = pointing up).
      if (tilt) setInterval(() => window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta: tilt, gamma: 0, alpha: 0 })), 100);
    },
    arg: [talkProject, tc.tilt || 0, !!tc.title],
  });
  await page.click('#resume-film');
  await page.waitForFunction(() => document.querySelector('#cam-msg').hidden && document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  const hint = await waitFaceReady(page).catch(() => 'no hint');
  await page.click('#rec');
  await page.waitForSelector('#rec-badge:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(2800);
  await page.click('#rec');
  const rv = await readReview(page);
  const pass = tc.expect.test(rv.title) && tc.fixRe.test(rv.fix);
  ok(tc.name, pass, `hint "${hint}" -> ${rv.title}: ${rv.fix}`);
  if (!pass) console.log('     checks:', rv.checks.join(' ; '));
  await page.screenshot({ path: `${OUT}20-${tc.feed}${tc.tilt ? '-tilt' : ''}${tc.title ? '-title' : ''}.png` });
  if (errors.length) ok(`No page errors (${tc.feed})`, false, errors.slice(0, 3).join(' | '));
  await browser.close();
}

// ---------- 3. Claude coaching (Claude's server is stood in for; no real key) ----------
const speechSpy = () => {
  window.__spoken = [];
  const s = window.speechSynthesis;
  if (s) s.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 60); };
};
async function coachRun({ feed, reply, label }) {
  const initCoach = {
    fn: ([p, key]) => {
      localStorage.setItem('broll.project', JSON.stringify(p));
      localStorage.setItem('broll.settings', JSON.stringify({ voice: true }));
      localStorage.setItem('broll.claudeKey', key);
    },
    arg: [project, 'sk-ant-test-key'],
  };
  const { browser, page, errors } = await open(feed, initCoach);
  await page.evaluate(speechSpy);
  const sent = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    sent.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON?.() });
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill(reply(req));
  });
  await page.click('#resume-film');
  await page.waitForFunction(() => document.querySelector('#cam-msg').hidden && document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  await waitFaceReady(page).catch(() => {});
  await page.click('#rec');
  await page.waitForSelector('#review:not([hidden])', { timeout: 40000 });
  const thinking = await page.textContent('#coach-line');
  await page.waitForFunction(() => !document.querySelector('#coach').classList.contains('thinking'), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() => ({
    title: document.querySelector('#verdict-title').textContent,
    reads: document.querySelector('#coach-reads').textContent,
    line: document.querySelector('#coach-line').textContent,
    spoken: window.__spoken.slice(),
  }));
  await page.screenshot({ path: `${OUT}11-coach-${label}.png` });
  return { browser, page, errors, sent, thinking, shown };
}
const json = (status, obj) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
const goodReply = () => json(200, {
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: JSON.stringify({ reads_as: 'confident, not heavy', coaching: 'This reads confident, not heavy. Drop your shoulders and let your head hang before the breath.' }) }],
  usage: { input_tokens: 1400, output_tokens: 120 },
});
{
  const r = await coachRun({ feed: 'good', reply: goodReply, label: 'ok' });
  const msg = r.sent.find((s) => s.url.endsWith('/v1/messages'));
  const b = msg?.body || {};
  const img = b.messages?.[0]?.content?.find((c) => c.type === 'image');
  ok('Coaching shows "Looking at your take…" while Claude works', /Looking at your take/.test(r.thinking), r.thinking);
  ok('One frame is sent as a JPEG photo', img?.source?.media_type === 'image/jpeg' && img.source.data.length > 10000, img ? `${Math.round(img.source.data.length * 0.75 / 1024)} KB` : 'no image');
  ok('Request uses Claude Sonnet 5.5, low effort, JSON reply, refusal fallback',
    b.model === 'claude-sonnet-5-5' && b.output_config?.effort === 'low' && b.output_config?.format?.type === 'json_schema' && b.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(msg.headers['anthropic-beta'] || ''),
    `${b.model}, effort ${b.output_config?.effort}, beta ${msg?.headers['anthropic-beta']}`);
  ok('Key is sent only to Anthropic, as a browser call', msg?.headers.authorization === 'Bearer sk-ant-test-key' && msg?.headers['anthropic-dangerous-direct-browser-access'] === 'true');
  ok('Shot details and check results go along with the frame', /Feeling it should read as: heavy/.test(JSON.stringify(b)) && /Automatic checks/.test(JSON.stringify(b)));
  ok("Claude's note is shown", /reads confident/.test(r.shown.line) && /confident, not heavy/.test(r.shown.reads), `${r.shown.reads} | ${r.shown.line}`);
  ok("Headline is spoken, then Claude's note", r.shown.spoken.at(-2) === 'Good shot, saved.' && /Drop your shoulders/.test(r.shown.spoken.at(-1) || ''), JSON.stringify(r.shown.spoken.slice(-2)));
  // Claude's note is saved with the clip
  await r.page.click('#rv-next');
  await r.page.click('#film-clips');
  await r.page.waitForSelector('.clip');
  await r.page.click('.clip >> nth=0');
  const info = await r.page.textContent('#player-action');
  ok("Claude's note is saved with the clip", /Claude: reads as confident, not heavy/.test(info), info.replace(/\n/g, ' / '));
  ok('No page errors (coaching)', r.errors.length === 0, r.errors.slice(0, 3).join(' | '));
  await r.browser.close();
}
{
  const r = await coachRun({ feed: 'dark', reply: () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), label: 'badkey' });
  ok('A bad key gets a plain message', /key didn't work/.test(r.shown.line), r.shown.line);
  ok('Without Claude you still hear what to fix', /Too dark/.test(r.shown.spoken.at(-1) || ''), r.shown.spoken.at(-1));
  await r.browser.close();
}
{
  // Talking to camera: Claude also checks the background
  const initTalkCoach = {
    fn: ([p, key]) => {
      localStorage.setItem('broll.project', JSON.stringify(p));
      localStorage.setItem('broll.settings', JSON.stringify({ voice: true }));
      localStorage.setItem('broll.claudeKey', key);
    },
    arg: [talkProject, 'sk-ant-test-key'],
  };
  const { browser, page, errors } = await open('talk', initTalkCoach);
  await page.evaluate(speechSpy);
  let body = null;
  await page.route('https://api.anthropic.com/**', async (route) => {
    body = route.request().postDataJSON?.();
    await route.fulfill(json(200, {
      id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ reads_as: 'warm and easy', coaching: 'You come across warm. Lean in a touch and hit the first word harder.', background_depth: 'flat wall', move_out_of_shot: ['shoes', 'laundry basket'], do_not_film: ['pajama pants: film from the waist up'] }) }],
      usage: { input_tokens: 1500, output_tokens: 140 },
    }));
  });
  await page.click('#resume-film');
  await page.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  await waitFaceReady(page).catch(() => {});
  await page.click('#rec');
  await page.waitForSelector('#rec-badge:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(2800);
  await page.click('#rec');
  await page.waitForSelector('#review:not([hidden])', { timeout: 40000 });
  await page.waitForFunction(() => !document.querySelector('#coach').classList.contains('thinking'), null, { timeout: 30000 });
  const bgText = await page.textContent('#bg-check');
  const props = Object.keys(body?.output_config?.format?.schema?.properties || {});
  ok('Talking coaching asks Claude about the background', props.includes('background_depth') && props.includes('move_out_of_shot') && props.includes('do_not_film') && /background/i.test(body?.system || ''), props.join(', '));
  ok("Claude's background check is shown: depth, clutter, what not to film", /Flat wall right behind you/.test(bgText) && /Move out of shot: shoes, laundry basket/.test(bgText) && /Pajama pants: film from the waist up/.test(bgText), bgText);
  await page.screenshot({ path: `${OUT}21-talk-coach.png`, fullPage: true });
  ok('No page errors (talking coaching)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}
{
  // Settings: paste a key and check it
  const { browser, page } = await open('good');
  await page.route('https://api.anthropic.com/**', (route) => route.fulfill(
    route.request().headers().authorization === 'Bearer sk-ant-good'
      ? json(200, { id: 'claude-sonnet-5-5', type: 'model', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z' })
      : json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })));
  await page.click('#home-settings');
  await page.fill('#coach-key', 'hello');
  await page.click('#coach-save');
  const notKey = await page.textContent('#coach-status');
  await page.fill('#coach-key', 'sk-ant-wrong');
  await page.click('#coach-save');
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#coach-status').textContent));
  const wrong = await page.textContent('#coach-status');
  page.once('dialog', (d) => d.accept());
  await page.click('#coach-remove');
  await page.click('#settings-done');
  await page.click('#home-settings');
  await page.fill('#coach-key', 'sk-ant-good');
  await page.click('#coach-save');
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#coach-status').textContent));
  const good = await page.textContent('#coach-status');
  const pill = await page.textContent('#coach-pill');
  await page.screenshot({ path: `${OUT}12-settings-coach.png` });
  ok('Settings rejects text that is not a key', /starts with sk-ant-/.test(notKey), notKey);
  ok('Settings reports a wrong key', /didn't work/.test(wrong), wrong);
  ok('Settings accepts a working key and turns coaching on', /Key works/.test(good) && pill === 'On', `${good} | ${pill}`);
  await browser.close();
}

// ---------- 4. Safari's engine (WebKit): records H.264 MP4 ----------
// No fake camera in WebKit, so it records a drawn picture (and a tone for
// the talking-to-camera case) with the app's own format choice.
{
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_);
  await page.waitForSelector('#home:not([hidden])');
  const rec = await page.evaluate(async () => {
    const out = {};
    for (const withAudio of [false, true]) {
      const mime = window.brollDirector.pickMime(withAudio);
      const c = document.createElement('canvas'); c.width = 360; c.height = 640;
      const g = c.getContext('2d');
      const stream = c.captureStream(30);
      let ac;
      if (withAudio) {
        ac = new AudioContext();
        const osc = ac.createOscillator(); const dest = ac.createMediaStreamDestination();
        osc.connect(dest); osc.start();
        stream.addTrack(dest.stream.getAudioTracks()[0]);
      }
      const r = new MediaRecorder(stream, { mimeType: mime });
      const chunks = []; r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise((res) => { r.onstop = res; });
      r.start();
      const t0 = performance.now();
      while (performance.now() - t0 < 1200) { g.fillStyle = `hsl(${(performance.now() / 5) % 360},60%,50%)`; g.fillRect(0, 0, 360, 640); await new Promise((res) => setTimeout(res, 33)); }
      r.stop(); await done;
      if (ac) ac.close();
      const blob = new Blob(chunks, { type: r.mimeType });
      const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
      const text = String.fromCharCode(...head.slice(0, 4096));
      out[withAudio ? 'talking' : 'broll'] = { asked: mime, got: r.mimeType, bytes: blob.size, ftyp: text.slice(4, 8), avc1: /avc1/.test(String.fromCharCode(...head)), mp4a: /mp4a/.test(String.fromCharCode(...head)) };
    }
    return out;
  });
  console.log('   WebKit recording:', JSON.stringify(rec));
  ok("Safari's engine records b-roll as MP4 with H.264", rec.broll.ftyp === 'ftyp' && rec.broll.avc1 && rec.broll.bytes > 1000, `${rec.broll.got}, ${rec.broll.bytes} bytes`);
  ok("Safari's engine records talking takes as MP4 with H.264 and AAC sound", rec.talking.ftyp === 'ftyp' && rec.talking.avc1 && rec.talking.mp4a && rec.talking.bytes > 1000, `${rec.talking.got}, ${rec.talking.bytes} bytes`);
  ok('No page errors (WebKit)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
