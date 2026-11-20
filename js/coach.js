// Claude as your director: after each take, one still frame goes to Claude,
// which says what the shot reads as and the one thing to change.
//
// The app has no server, so the phone calls Claude directly with your own
// API key. The key is kept only in this phone's browser storage.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.4.0/+esm';
export const MODEL = 'claude-sonnet-5-5';
const KEY_STORE = 'broll.claudeKey';

export function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } }
export function setKey(key) { try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch { /* private mode */ } }
export const coachingOn = () => !!getKey();

let sdk = null;
let cached = { key: null, client: null };

async function client() {
  const key = getKey();
  if (!key) throw new CoachError('nokey', 'Add your Claude API key in settings.');
  if (!sdk) sdk = await import(SDK_URL);
  if (cached.key !== key) {
    cached = {
      key,
      client: new sdk.default({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 25_000 }),
    };
  }
  return cached.client;
}

export class CoachError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// Turn SDK errors into one plain sentence.
function explain(err) {
  if (err instanceof CoachError) return err;
  const A = sdk?.default;
  if (A) {
    if (err instanceof A.AuthenticationError) return new CoachError('auth', "Your Claude key didn't work. Check it in settings.");
    if (err instanceof A.PermissionDeniedError) return new CoachError('auth', "Your Claude key can't use this model. Check your Anthropic account.");
    if (err instanceof A.RateLimitError) return new CoachError('busy', 'Claude is busy right now, try the next take.');
    if (err instanceof A.BadRequestError && /credit|billing|balance/i.test(err.message)) return new CoachError('billing', 'Your Anthropic account is out of credit.');
    if (err instanceof A.APIConnectionTimeoutError) return new CoachError('slow', 'Claude took too long this time.');
    if (err instanceof A.APIConnectionError) return new CoachError('offline', "Couldn't reach Claude. Check your connection.");
    if (err instanceof A.APIError) return new CoachError('api', `Claude had a problem (${err.status ?? 'error'}).`);
  }
  if (!navigator.onLine) return new CoachError('offline', "You're offline, so Claude couldn't look at this take.");
  return new CoachError('unknown', "Claude coaching didn't work this time.");
}

// Free check that the key works (looks up the model, no tokens used).
export async function testKey() {
  try {
    const c = await client();
    await c.models.retrieve(MODEL);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: explain(err).message };
  }
}

const SYSTEM = `You are a warm, decisive film director coaching one person who is filming b-roll of themselves at home on an iPhone for a short UGC video (TikTok / Reels style, vertical 9:16). They will add text captions in the middle of the frame later; the bottom fifth and the right edge get covered by the app's buttons.

You get one still frame from the middle of their take, the shot they were going for, and the results of automatic checks the phone already ran.

Reply with:
- reads_as: what the shot actually reads as emotionally, in 1 to 3 plain words (for example "tired and stuck", "calm", "a bit flat").
- coaching: one or two short sentences, spoken aloud to them from across the room. First say what the shot reads as compared with the feeling they were going for, then give the single most useful thing to change on the next take. Be concrete and physical: body, face, pace, position, light, camera placement. Under 30 words. Plain everyday words, no film jargon, no lists, no emoji, sentence case.

Rules:
- If an automatic check failed, the thing to change must fix that problem, said your way.
- If the take already works, say so and give one small optional tweak, or tell them to keep it.
- Judge only what you can see in the frame. A still can't show movement, so don't comment on motion or length unless a check flagged it.
- Talk to them as "you". Never describe their appearance, body or attractiveness; only direct the performance and the shot.`;

const TALK_SYSTEM = `You are a warm, decisive film director coaching one person who is filming themselves talking to camera at home on an iPhone for a short UGC video (TikTok / Reels style, vertical 9:16). Captions go in the middle of the frame; the bottom fifth and the right edge get covered by the app's buttons.

You get one still frame from the middle of their take, what they were saying, and the results of automatic checks the phone already ran (eye line, face size, centring, phone at eye level, light, steadiness, length).

Reply with:
- reads_as: how they come across, in 1 to 3 plain words (for example "warm and easy", "a bit stiff", "low energy").
- coaching: one or two short sentences, spoken aloud to them. Say how the take comes across, then give the single most useful thing to change on the next take. Concrete and physical: energy, eyes on the lens, posture, position, light, phone placement. Under 30 words. Plain everyday words, no film jargon, no lists, no emoji, sentence case.
- background_depth: "has depth" if there is real space behind them (roughly 6 feet or more to the back wall, with something like a doorway, shelf or lamp behind them), or "flat wall" if they are right up against a plain wall.
- move_out_of_shot: everyday clutter visible behind them that they should move out of shot, such as bins, shoes, bags, boxes, laundry, cables. Short plain names. Empty list if none.
- do_not_film: anything visible that they probably don't want on camera, such as pajama pants, a messy unmade bed, personal papers or a screen with private details. Short plain names with what to do, for example "pajama pants: film from the waist up". Empty list if none.

Rules:
- If an automatic check failed, the thing to change must fix that problem, said your way.
- If the take already works, say so and give one small optional tweak.
- Judge only what you can see in the frame. A still can't show movement or voice, so don't comment on those.
- Talk to them as "you". Never describe their appearance, body or attractiveness; only direct the performance, the framing and the room.`;

const TALK_SCHEMA = {
  type: 'object',
  properties: {
    reads_as: { type: 'string', description: 'How they come across, 1 to 3 words' },
    coaching: { type: 'string', description: 'One or two short spoken sentences, under 30 words' },
    background_depth: { type: 'string', enum: ['has depth', 'flat wall'] },
    move_out_of_shot: { type: 'array', items: { type: 'string' } },
    do_not_film: { type: 'array', items: { type: 'string' } },
  },
  required: ['reads_as', 'coaching', 'background_depth', 'move_out_of_shot', 'do_not_film'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    reads_as: { type: 'string', description: 'What the shot reads as, 1 to 3 words' },
    coaching: { type: 'string', description: 'One or two short spoken sentences, under 30 words' },
  },
  required: ['reads_as', 'coaching'],
  additionalProperties: false,
};

function describe({ shot, actName, verdict }) {
  const checks = verdict.checks
    .map((c) => `- ${c.label}: ${c.status === 'pass' ? 'passed' : c.status === 'fail' ? `FAILED (${c.msg || c.note})` : `not checked (${c.note})`}`)
    .join('\n');
  if (shot.kind === 'talk') {
    return `Talking-to-camera take: ${shot.role === 'hook' ? 'the hook, the very first sentence of the video (should be fast, high energy, no pauses)' : 'part of the video'}.
- What they were saying: ${shot.say || shot.action}
- Energy it should have: ${shot.feeling}

Automatic checks on this take:
${checks}

Overall: ${verdict.ok ? 'the phone accepted this take' : 'the phone asked them to do it again'}.`;
  }
  return describeBroll({ shot, actName, verdict, checks });
}

function describeBroll({ shot, actName, verdict, checks }) {
  return `The shot (act: ${actName}):
- Place: ${shot.place}
- Direction: ${shot.action}
- Feeling it should read as: ${shot.feeling}
- Kind of shot: ${shot.style || 'person'}${shot.line ? `\n- Script line it illustrates (a 0.5-1 second cutaway): ${shot.line}` : ''}
- Shot size: ${shot.frame === 'detail' ? 'close up, face not needed' : shot.frame === 'wide' ? 'wide, whole body and room' : shot.frame === 'close' ? 'close up on face' : 'waist up'}

Automatic checks on this take:
${checks}

Overall: ${verdict.ok ? 'the phone accepted this take' : 'the phone asked them to do it again'}.`;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Returns { readsAs, coaching, background? }. Throws CoachError with a plain message.
export async function coachTake({ frame, shot, actName, verdict }) {
  try {
    const c = await client();
    const talk = shot.kind === 'talk';
    const data = await blobToBase64(frame);
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      // If Claude declines for safety reasons, the API retries on a
      // fallback model automatically.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: talk ? TALK_SCHEMA : SCHEMA } },
      system: talk ? TALK_SYSTEM : SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: describe({ shot, actName, verdict }) },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') throw new CoachError('refusal', "Claude couldn't coach this one.");
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const out = JSON.parse(text);
    if (!out.coaching) throw new CoachError('empty', "Claude didn't have a note this time.");
    const note = { readsAs: String(out.reads_as || '').trim(), coaching: String(out.coaching).trim() };
    if (talk) {
      const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 5) : []);
      note.background = { depth: out.background_depth === 'flat wall' ? 'flat wall' : 'has depth', move: list(out.move_out_of_shot), avoid: list(out.do_not_film) };
    }
    return note;
  } catch (err) {
    console.warn('Coaching failed', err);
    throw explain(err);
  }
}
