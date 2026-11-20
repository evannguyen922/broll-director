// Reading directions out loud + countdown beeps.

let enabled = true;
let audioCtx;
let voice;
let audioMode = 'playback';

// 'playback' for b-roll (loudest voice), 'play-and-record' while the
// microphone is on for talking-to-camera takes.
export function setAudioMode(m) {
  audioMode = m;
  try { if (navigator.audioSession) navigator.audioSession.type = m; } catch { /* older Safari */ }
}

export function setVoiceEnabled(on) { enabled = on; if (!on) stopSpeaking(); }

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const prefer = [/premium/i, /enhanced/i, /samantha/i, /ava/i, /allison/i, /google us english/i];
  for (const re of prefer) {
    const v = voices.find((x) => re.test(x.name));
    if (v) return v;
  }
  return voices.find((v) => v.default) || voices[0] || null;
}
if ('speechSynthesis' in window) {
  voice = pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', () => { voice = pickVoice(); });
}

// Call this from a tap so iPhone lets us make sound later.
export function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (navigator.audioSession) navigator.audioSession.type = audioMode;
  } catch { /* no sound, no problem */ }
}

export function beep(freq = 880, ms = 120, volume = 0.25) {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.05);
  } catch { /* ignore */ }
}

export function stopSpeaking() {
  try { if ('speechSynthesis' in window && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel(); } catch { /* ignore */ }
}

// Resolves when speaking ends – or after a safe maximum, because some
// browsers never report the end.
export function speak(text) {
  return new Promise((resolve) => {
    if (!enabled || !('speechSynthesis' in window) || !text) return resolve();
    let finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    try {
      stopSpeaking();
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'en-US';
      u.rate = 0.98;
      u.volume = 1;
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
      const words = text.split(/\s+/).length;
      setTimeout(done, 1200 + words * 420);
    } catch { done(); }
  });
}
