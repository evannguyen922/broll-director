// Face finding with Google's MediaPipe Face Landmarker, running in the browser.
// Nothing is uploaded: the library and model are downloaded once, then the
// phone does the work on its own.

const VERSION = '0.10.21';
const BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let promise = null;
let landmarker = null;

export function faceCheckerReady() { return !!landmarker; }

export function loadFaceChecker() {
  if (!promise) {
    promise = (async () => {
      const vision = await import(`${BASE}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      landmarker = await vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
      });
      return landmarker;
    })().catch((err) => {
      console.warn('Face checker could not load', err);
      promise = null; // try again next time
      return null;
    });
  }
  return promise;
}

const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true });

// Look for a face in the current video frame. The detector is built for
// faces close to the camera, so if the full frame finds nothing we also try
// zoomed-in squares (top, then middle), where a face from across the room
// looks bigger. Returns null if the checker isn't ready, {found:false} if no
// face, or the face box in 0..1 units of the whole frame.
export function findFaceInVideo(video) {
  if (!landmarker) return null;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const crops = [[0, 0, vw, vh]];
  if (vh > vw * 1.2) crops.push([0, 0, vw, vw], [0, (vh - vw) / 2, vw, vw]);
  else if (vw > vh * 1.2) crops.push([(vw - vh) / 2, 0, vh, vh]);
  for (const [sx, sy, sw, sh] of crops) {
    const scale = 384 / Math.max(sw, sh);
    work.width = Math.round(sw * scale);
    work.height = Math.round(sh * scale);
    workCtx.drawImage(video, sx, sy, sw, sh, 0, 0, work.width, work.height);
    const f = findFace(work);
    if (!f) return null;
    if (f.found) {
      const X = (x) => (sx + x * sw) / vw;
      const Y = (y) => (sy + y * sh) / vh;
      const top = Y(f.top), bottom = Y(f.bottom), height = bottom - top;
      return {
        found: true, top, bottom, height,
        left: X(f.left), right: X(f.right), cx: X(f.cx),
        width: X(f.right) - X(f.left),
        eyeY: Y(f.eyeY), noseX: X(f.noseX),
        headTop: top - height * 0.3,
      };
    }
  }
  return { found: false };
}

// Returns null if the checker isn't ready, {found:false} if no face,
// or the face box in 0..1 units of the canvas.
export function findFace(canvas) {
  if (!landmarker) return null;
  let res;
  try { res = landmarker.detect(canvas); } catch (e) { console.warn(e); return null; }
  const pts = res?.faceLandmarks?.[0];
  if (!pts || !pts.length) return { found: false };
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const height = maxY - minY; // forehead to chin
  // Corners of both eyes (MediaPipe face mesh points 33, 133, 362, 263) and the nose tip (1).
  const eyes = [33, 133, 362, 263].map((i) => pts[i]).filter(Boolean);
  const eyeY = eyes.length ? eyes.reduce((a, p) => a + p.y, 0) / eyes.length : minY + height * 0.4;
  const noseX = pts[1] ? pts[1].x : (minX + maxX) / 2;
  return {
    found: true,
    top: minY,
    bottom: maxY,
    left: minX,
    right: maxX,
    height,
    width: maxX - minX,
    eyeY,
    noseX,
    // The face mesh stops at the forehead; the top of the head is roughly
    // a third of a face-height higher.
    headTop: minY - height * 0.3,
    cx: (minX + maxX) / 2,
  };
}
