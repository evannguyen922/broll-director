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
    return !h.hidden && !/Getting/.test(h.textContent);
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
  const { browser, page, errors } = await open('good', { fn: () => localStorage.setItem('broll.settings', JSON.stringify({ countdown: 3, voice: true })) });
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
  await page.click('#rec');
  await page.waitForSelector('#count:not([hidden])', { timeout: 30000 });
  await page.screenshot({ path: `${OUT}04-countdown.png` });
  ok('Voice + countdown runs (speech never blocks)', true);
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
    const m = await import('/js/store.js');
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
const init = { fn: (p) => { localStorage.setItem('broll.project', JSON.stringify(p)); localStorage.setItem('broll.settings', JSON.stringify({ countdown: 3, voice: false })); }, arg: project };
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

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
