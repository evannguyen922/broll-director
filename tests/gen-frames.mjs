// Builds fake-camera feeds (.mjpeg) from a portrait photo.
import { chromium } from 'playwright';
import fs from 'fs';
const [,, imgPath, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const img = 'data:image/jpeg;base64,' + fs.readFileSync(imgPath).toString('base64');
const b = await chromium.launch();
const p = await b.newPage();
p.on('console', (m) => console.log('page:', m.text()));
await p.goto('http://127.0.0.1:8765/');
const out = await p.evaluate(async (img) => {
  const face = await import('/js/face.js');
  await face.loadFaceChecker();
  const im = new Image(); im.src = img; await im.decode();
  const c0 = document.createElement('canvas'); c0.width = im.width; c0.height = im.height;
  c0.getContext('2d').drawImage(im, 0, 0);
  const f = face.findFace(c0);
  const W = 720, H = 1280;
  function compose({ faceH, faceTop, bright = 1, dx = 0, dy = 0 }) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.save(); g.translate(dx, dy);
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#9a8f84'); grad.addColorStop(1, '#5d544c');
    g.fillStyle = grad; g.fillRect(-40, -40, W + 80, H + 80);
    g.fillStyle = '#c9c2b5'; g.fillRect(40, 120, 180, 260);   // a window
    g.fillStyle = '#3b332d'; g.fillRect(480, 700, 240, 580);  // a shelf
    g.fillStyle = '#7a4f3a'; g.fillRect(0, 1050, W, 230);     // a counter
    const s = (faceH * H) / (f.height * im.height);
    const x = W / 2 - f.cx * im.width * s;
    const y = faceTop * H - f.top * im.height * s;
    g.drawImage(im, x, y, im.width * s, im.height * s);
    g.restore();
    if (bright !== 1) { g.fillStyle = `rgba(0,0,0,${1 - bright})`; g.fillRect(0, 0, W, H); }
    return c;
  }
  const scen = {
    good:  [...Array(10)].map(() => compose({ faceH: 0.17, faceTop: 0.27 })),
    tight: [...Array(10)].map(() => compose({ faceH: 0.46, faceTop: 0.04 })),
    dark:  [...Array(10)].map(() => compose({ faceH: 0.17, faceTop: 0.27, bright: 0.12 })),
    shaky: [...Array(30)].map(() => compose({ faceH: 0.17, faceTop: 0.27, dx: Math.round((Math.random() * 2 - 1) * 16), dy: Math.round((Math.random() * 2 - 1) * 16) })),
  };
  const res = { photoFace: f, check: {}, frames: {} };
  for (const [k, frames] of Object.entries(scen)) {
    const v = face.findFace(frames[0]);
    res.check[k] = v && v.found ? { height: +v.height.toFixed(3), headTop: +v.headTop.toFixed(3) } : v;
    res.frames[k] = frames.map((c) => c.toDataURL('image/jpeg', 0.85).split(',')[1]);
  }
  return res;
}, img);
console.log('face in photo:', JSON.stringify(out.photoFace));
console.log('face in feeds:', JSON.stringify(out.check));
// Video files, as if filmed with the Camera app, for "Use a clip from my Photos".
const clips = await p.evaluate(async (img) => {
  const im = new Image(); im.src = img; await im.decode();
  const face = await import('/js/face.js');
  await face.loadFaceChecker();
  const c0 = document.createElement('canvas'); c0.width = im.width; c0.height = im.height;
  c0.getContext('2d').drawImage(im, 0, 0);
  const f = face.findFace(c0);
  function draw(g, W, H, { faceH, faceTop, bright = 1 }) {
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#9a8f84'); grad.addColorStop(1, '#5d544c');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.fillStyle = '#c9c2b5'; g.fillRect(W * 0.06, H * 0.09, W * 0.25, H * 0.2);
    g.fillStyle = '#7a4f3a'; g.fillRect(0, H * 0.82, W, H * 0.18);
    const s = (faceH * H) / (f.height * im.height);
    g.drawImage(im, W / 2 - f.cx * im.width * s, faceTop * H - f.top * im.height * s, im.width * s, im.height * s);
    if (bright !== 1) { g.fillStyle = `rgba(0,0,0,${1 - bright})`; g.fillRect(0, 0, W, H); }
  }
  // fps is lower for 4K so the test browser's software encoder keeps up.
  async function record(W, H, seconds, opts, fps = 30) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    draw(g, W, H, opts);
    const stream = c.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 6e6 });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) { draw(g, W, H, opts); await new Promise((r) => setTimeout(r, 1000 / fps)); }
    rec.stop(); await done;
    const buf = await new Blob(chunks).arrayBuffer();
    let s = ''; const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  return {
    'clip-good': await record(720, 1280, 6, { faceH: 0.17, faceTop: 0.27 }),
    'clip-dark': await record(720, 1280, 6, { faceH: 0.17, faceTop: 0.27, bright: 0.12 }),
    'clip-short': await record(720, 1280, 2, { faceH: 0.17, faceTop: 0.27 }),
    'clip-sideways': await record(1280, 720, 6, { faceH: 0.3, faceTop: 0.3 }),
    'clip-4k': await record(2160, 3840, 6, { faceH: 0.17, faceTop: 0.27 }, 4),
  };
}, img);
for (const [k, b64] of Object.entries(clips)) fs.writeFileSync(`${outDir}/${k}.webm`, Buffer.from(b64, 'base64'));
console.log('clips:', Object.keys(clips).join(', '));

for (const [k, frames] of Object.entries(out.frames)) {
  fs.writeFileSync(`${outDir}/${k}.mjpeg`, Buffer.concat(frames.map((f) => Buffer.from(f, 'base64'))));
  fs.writeFileSync(`${outDir}/${k}.jpg`, Buffer.from(frames[0], 'base64'));
}
await b.close();
