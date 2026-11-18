import { chromium } from 'playwright';
import fs from 'fs';
const FEEDS = new URL('./.work/feeds/', import.meta.url).pathname;
const OUT = new URL('./.work/screens/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const URL_ = process.env.APP || 'http://127.0.0.1:8765/';
const lib = JSON.parse(fs.readFileSync(new URL('../shots.json', import.meta.url), 'utf8'));
const pick = (...ids) => ids.map((id) => lib.shots.find((s) => s.id === id));
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function open(feed, init) {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${FEEDS}${feed}.mjpeg`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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
  await page.screenshot({ path: `${OUT}02-list.png` });
  const before = await page.textContent('.shot:nth-of-type(1) p');
  await page.click('.act >> nth=0 >> .swap >> nth=0');
  const after = await page.textContent('.act >> nth=0 >> .shot >> nth=0 >> p');
  ok('Swap changes a shot', before !== after);
  await page.click('#start-film');
  await page.waitForSelector('#film:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#cam-msg').hidden && document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  ok('Camera preview starts', await page.evaluate(() => document.querySelector('#video').videoWidth > 0));
  const shot = await page.evaluate(() => window.brollDirector.state.project.shots[0]);
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
  if (/Do it again/.test(rv.title)) { await page.click('#rv-keep'); await page.waitForTimeout(500); }
  const dotsDone = await page.$$eval('#dots .dot.done', (d) => d.length);
  ok('Progress dot fills after a kept take', dotsDone === 1, `${dotsDone} done`);
  await page.click('#rv-next');
  await page.waitForTimeout(500);
  const cur = await page.textContent('#shot-num');
  ok('Next shot moves on', cur.startsWith('2 of 9'), cur);
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
  const names = await page.evaluate(() => [...document.querySelectorAll('.clip')].length);
  await page.screenshot({ path: `${OUT}07-clips.png` });
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
  { feed: 'tight', expect: /Do it again/, fixRe: /Too tight, no room above your head for text, step back/, name: 'Too tight / no headroom is caught' },
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

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
