// Checks a take: framing, light, steadiness, length.
// Everything here runs on the phone.

export const GRAY_W = 96; // tiny grayscale copy of each frame for light + shake

// Brightness numbers from a small RGBA frame.
export function frameStats(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  let sum = 0, clipped = 0, crushed = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const y = (data[i] * 54 + data[i + 1] * 183 + data[i + 2] * 19) >> 8;
    gray[j] = y;
    sum += y;
    if (y >= 245) clipped++;
    if (y <= 18) crushed++;
  }
  const n = width * height;
  return { mean: sum / n, clipped: clipped / n, crushed: crushed / n, gray, w: width, h: height };
}

// Average brightness inside a box given in 0..1 units.
export function regionMean(gray, w, h, box) {
  const x0 = Math.max(0, Math.floor(box.left * w)), x1 = Math.min(w, Math.ceil(box.right * w));
  const y0 = Math.max(0, Math.floor(box.top * h)), y1 = Math.min(h, Math.ceil(box.bottom * h));
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += gray[y * w + x]; n++; }
  return n ? s / n : null;
}

// How far the whole picture moved between two frames. When the phone shakes
// everything slides together; when only you move, it doesn't.
export function globalShift(prev, cur, w, h, R = 3) {
  const m = R + 2;
  const diffAt = (dx, dy) => {
    let s = 0, n = 0;
    for (let y = m; y < h - m; y += 2) {
      for (let x = m; x < w - m; x += 2) {
        s += Math.abs(cur[y * w + x] - prev[(y + dy) * w + (x + dx)]);
        n++;
      }
    }
    return s / n;
  };
  const d0 = diffAt(0, 0);
  let best = { dx: 0, dy: 0, d: d0 };
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (!dx && !dy) continue;
      const d = diffAt(dx, dy);
      if (d < best.d) best = { dx, dy, d };
    }
  }
  const moved = (best.dx || best.dy) && d0 > 2.5 && d0 / Math.max(best.d, 0.5) > 1.2;
  return { moved: !!moved, amount: Math.hypot(best.dx, best.dy), d0 };
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// Framing rules per shot type. Face height and head position are fractions
// of the frame height (0 = top, 1 = bottom).
const FRAMING = {
  close: { tight: 0.55, small: 0.16, minHead: 0.07, maxHead: 0.45 },
  medium: { tight: 0.32, small: 0.07, minHead: 0.12, maxHead: 0.5 },
  wide: { tight: 0.2, small: 0.025, minHead: 0.1, maxHead: 0.7 },
};

const TIGHT_MSG = {
  close: 'Too tight, step back a little so your whole face fits with room around it.',
  medium: 'Too tight, step back so we see you from about the waist up.',
  wide: 'Too close for a wide shot, step back so we see more of the room.',
};

// Returns { msg, short } describing the biggest framing problem, or null.
export function framingIssue(shot, face) {
  const r = FRAMING[shot.frame];
  if (!r || !face) return null;
  const tight = face.height > r.tight;
  const noHeadroom = face.headTop < r.minHead;
  if (tight && noHeadroom) return { msg: 'Too tight, no room above your head for text, step back.', short: 'Step back' };
  if (tight) return { msg: TIGHT_MSG[shot.frame], short: 'Step back' };
  if (noHeadroom) return { msg: 'No room above your head for text, tilt the phone up a little or step back.', short: 'Leave room above your head' };
  if (face.height < r.small) return { msg: "You're too small in the frame, move a step or two closer.", short: 'Come closer' };
  if (face.headTop > r.maxHead) return { msg: 'Lots of empty space above you, tilt the phone down a little.', short: 'Tilt the phone down' };
  if (face.cx < 0.15 || face.cx > 0.85) return { msg: "You're at the edge of the frame, move toward the middle.", short: 'Move to the middle' };
  return null;
}

function lightIssue(meanM, clipM, faceLuma, shot) {
  if (meanM < 48) return { msg: 'Too dark, turn on a lamp or face a window.', short: 'Too dark' };
  if (clipM > 0.2 || meanM > 215) return { msg: 'Too bright and washed out, turn so the window is beside you, not in the shot.', short: 'Too bright' };
  if (shot.face && faceLuma != null && meanM > 90 && faceLuma < meanM * 0.55) {
    return { msg: "You're backlit, turn so the light is on your face, not behind you.", short: "You're backlit" };
  }
  return null;
}

// One quick look before recording, for the live hint on the preview.
export function liveHint(shot, sample) {
  if (!sample) return null;
  if (sample.mean < 48) return { short: 'Too dark', good: false };
  if (sample.clipped > 0.25) return { short: 'Too bright', good: false };
  if (shot.frame === 'detail') return { short: 'Ready', good: true };
  if (sample.face == null) return null; // face checker not ready
  if (!sample.face.found) {
    if (!shot.face) return { short: 'Ready', good: true };
    return shot.frame === 'wide' ? null : { short: 'Step into the frame', good: false };
  }
  const f = framingIssue(shot, sample.face);
  if (f) return { short: f.short, good: false };
  return { short: 'Framing looks good', good: true };
}

/**
 * Judge a finished take.
 * samples: [{ t, mean, clipped, face: null | {found,...}, faceLuma, shift: {moved,amount} | null }]
 * motion:  [{ t, rate }]  phone rotation speed in degrees per second
 * Returns { ok, title, fix, checks: [{ key, label, status: 'pass'|'fail'|'skip', note }] }
 */
export function judgeTake({ shot, samples, motion, duration }) {
  const checks = [];
  const add = (key, label, status, note, msg) => checks.push({ key, label, status, note, msg });

  // ---- Length
  const hold = shot.hold;
  if (duration + 0.25 >= hold) add('length', 'Length', 'pass', `${duration.toFixed(1)}s, held long enough`);
  else add('length', 'Length', 'fail', `${duration.toFixed(1)}s of ${hold}s`, `Too short, hold it for the full ${hold} seconds before you stop.`);

  // ---- Framing
  const faceChecked = samples.filter((s) => s.face != null);
  const faces = faceChecked.filter((s) => s.face.found).map((s) => s.face);
  if (shot.frame === 'detail') {
    add('framing', 'Framing', 'skip', 'Hands shot, no face needed');
  } else if (faceChecked.length < 2) {
    add('framing', 'Framing', 'skip', "Face checker wasn't ready, so framing wasn't checked");
  } else if (faces.length / faceChecked.length < 0.5) {
    if (!shot.face) add('framing', 'Framing', 'skip', 'Face not needed for this one');
    // From across the room the face can be too small to spot; don't blame you for that.
    else if (shot.frame === 'wide') add('framing', 'Framing', 'skip', 'Too far away to check your face');
    else add('framing', 'Framing', 'fail', "Couldn't see your face", "I couldn't see your face, make sure you're in the frame and turned a little toward the phone.");
  } else {
    const face = {
      height: median(faces.map((f) => f.height)),
      headTop: median(faces.map((f) => f.headTop)),
      cx: median(faces.map((f) => f.cx)),
    };
    const issue = framingIssue(shot, face);
    if (issue) add('framing', 'Framing', 'fail', issue.short, issue.msg);
    else add('framing', 'Framing', 'pass', 'Good size, room above your head');
  }

  // ---- Light
  if (samples.length) {
    const meanM = median(samples.map((s) => s.mean));
    const clipM = median(samples.map((s) => s.clipped));
    const faceLumas = samples.map((s) => s.faceLuma).filter((v) => v != null);
    const issue = lightIssue(meanM, clipM, faceLumas.length >= 2 ? median(faceLumas) : null, shot);
    if (issue) add('light', 'Light', 'fail', issue.short, issue.msg);
    else add('light', 'Light', 'pass', meanM < 75 ? 'On the dark side, but usable' : 'Well lit');
  } else {
    add('light', 'Light', 'skip', 'No frames to check');
  }

  // ---- Steadiness (ignore the first half second and the last moment,
  // when you might be touching the phone)
  const handheld = shot.cam === 'handheld';
  const inWindow = (t) => t > 0.4 && t < duration - 0.7;
  const rates = motion.filter((m) => inWindow(m.t)).map((m) => m.rate);
  const shakyMsg = handheld
    ? 'Too shaky, hold the phone with both hands, elbows tucked in, and move slower.'
    : 'Too shaky, prop the phone against something solid so it stays still.';
  if (rates.length >= 6) {
    const med = median(rates), p90 = pct(rates, 0.9);
    const bad = handheld ? (med > 35 || p90 > 90) : (med > 8 || p90 > 30);
    if (bad) add('steady', 'Steadiness', 'fail', 'The phone was moving', shakyMsg);
    else add('steady', 'Steadiness', 'pass', 'Nice and still');
  } else {
    const shifts = samples.filter((s) => s.shift && inWindow(s.t)).map((s) => s.shift);
    if (shifts.length >= 3) {
      const frac = shifts.filter((s) => s.moved).length / shifts.length;
      if (frac > (handheld ? 0.7 : 0.35)) add('steady', 'Steadiness', 'fail', 'The picture was jumping', shakyMsg);
      else add('steady', 'Steadiness', 'pass', 'Nice and still');
    } else {
      add('steady', 'Steadiness', 'skip', 'Too short to check');
    }
  }

  // The one sentence: the most important problem first.
  const order = ['length', 'framing', 'light', 'steady'];
  const fails = order.map((k) => checks.find((c) => c.key === k && c.status === 'fail')).filter(Boolean);
  const ok = fails.length === 0;
  return {
    ok,
    title: ok ? 'Good shot, saved' : 'Do it again',
    fix: ok ? goodLine(shot) : fails[0].msg,
    checks: order.map((k) => checks.find((c) => c.key === k)),
  };
}

function goodLine(shot) {
  return shot.frame === 'detail'
    ? 'Light, steadiness and length all look good.'
    : 'Framing, light, steadiness and length all look good.';
}
