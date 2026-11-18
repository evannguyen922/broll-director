# B-roll director

A phone web app that directs you while you film b-roll for UGC videos. You type what your video is about, it plans 9 shots in 3 acts (struggle, grind, win), reads each direction out loud, records the take, checks it, and tells you in one sentence what to fix.

**Open it on your iPhone:** https://evannguyen922.github.io/broll-director/

Everything happens on your phone. Clips are never uploaded.

## How to use it

1. Open the link in Safari on your iPhone. Tip: tap Share → **Add to Home Screen** so it opens like an app (this also stops Safari from clearing your clips if you don't open it for a week).
2. Type one line about your video, for example "student who's always tired tries a new sleep routine", and tap **Make my shot list**.
3. Look over the 9 shots. Tap **Swap** on any shot you don't like, or **Shuffle** for a whole new list.
4. Tap **Start filming**. Allow the camera when Safari asks (and motion, which is used to check the phone is steady).
5. Prop the phone up and tap the red button. It reads the direction out loud, counts down, records for the hold time, and stops on its own.
6. It tells you **Good shot, saved** or **Do it again** with one thing to fix. You can always **Keep it anyway**.
7. When you're done, open **My clips** (the grid icon at the top right). Tap a clip to play it, then **Save to my phone**. In the share sheet pick **Save Video** and it goes to your Photos, ready for CapCut. **Save all** saves every clip at once.

If you can't hear the voice, turn the volume up and check the silent switch. You can change the countdown (3, 5 or 10 seconds) and turn the voice off from the line under the record button.

## What's built (v1)

- **Shot list from a built-in library.** 72 placeholder shots (24 per act) in `shots.json`. The app picks 9 that fit your topic: it looks for words like "tired", "budget" or "skincare", favours shots about your main theme, and mixes rooms and shot sizes (wide, waist up, close up, hands).
- **Shot cards** with the place in your home, what to do in one sentence, the feeling it should read as, a filming tip, how long to hold, and the shot size.
- **Filming screen** for portrait iPhone: shot card on top, camera preview (back camera, Flip for the front one), a big record button, countdown, the direction read out loud, a "Text goes here" guide at the top of the frame, and a live hint ("Step back", "Too dark", "Framing looks good") before you record.
- **Take checks**, all done on the phone:
  - **Framing**: Google's MediaPipe Face Landmarker finds your face and checks it's the right size for the shot and that there's room above your head for text.
  - **Light**: too dark, blown out, or backlit (face much darker than the room).
  - **Steadiness**: the phone's motion sensor; if that isn't allowed, it measures whether the whole picture is sliding around.
  - **Length**: at least the hold time.
- **Progress dots** for the 9 shots, coloured by act. Tap a dot to jump to that shot.
- **Your clips**: grid of every kept clip, grouped by act and then by room, with its mood label. Tap to play, save one clip, one act, or all. Files are named like `03-struggle-desk-foggy.mp4` so they sort in order in CapCut.
- Clips are stored in the browser's own storage on your phone (IndexedDB). Video is recorded without sound (b-roll gets music in the edit, and using the mic on iPhone makes the voice directions much quieter).

## Swapping in your own shots

All shots live in **`shots.json`**. Nothing else needs to change. Each shot looks like this:

```json
{
  "id": "s1",
  "act": "struggle",
  "place": "kitchen counter",
  "action": "Lean on the counter, run both hands through your hair, and let out a long breath.",
  "feeling": "heavy",
  "tip": "Prop the phone at chest height about two steps back.",
  "hold": 5,
  "frame": "medium",
  "face": true,
  "cam": "propped",
  "themes": ["general", "mind", "energy"]
}
```

- `act`: `struggle`, `grind` or `win`. Keep at least 3 per act.
- `frame`: `wide`, `medium` (waist up), `close`, or `detail` (hands only, no face check).
- `face`: `true` if your face should be visible. `cam`: `propped` or `handheld` (handheld gets a looser steadiness check).
- `themes`: which topics the shot suits. `general` fits any video. The words that switch on each theme are in `themeWords` in the same file.
- New places: add them to `rooms` so clips group under the right room.
- Give every shot its own `id`.

Anything missing gets a sensible default, so a typo won't break the app. Shot lists you've already made keep their own copy of each shot, so changing the file never breaks a video you're halfway through.

## Files

| File | What it is |
| --- | --- |
| `index.html` | All the screens |
| `styles.css` | The look |
| `shots.json` | The shot library (edit this) |
| `js/app.js` | Screens, camera, recording, saving |
| `js/shots.js` | Picks 9 shots for your topic |
| `js/checks.js` | Framing, light, steadiness and length checks |
| `js/face.js` | Loads the face finder |
| `js/voice.js` | Reads directions out loud, countdown beeps |
| `js/store.js` | Saves clips on the phone |
| `tests/` | Automatic tests (below) |

Plain HTML and JavaScript, no build step. GitHub Pages serves the folder as it is.

## Tests

`tests/run.sh` opens the app in a headless Chrome with a fake camera (built from a sample portrait photo) and checks the whole flow: making a list, swapping, recording, the review, progress dots, the clip grid, playback, and storage. It also feeds five takes that should get specific answers: a well-framed take is accepted, and too tight, too dark, shaky, and stopped-too-early takes each get the right fix.

```bash
cd tests && npm install && npx playwright install chromium && sh run.sh
```

## Known limits

- The face finder is built for faces fairly close to the camera. In wide shots from across the room it may not spot you, so wide shots only get the framing check when it does (it never fails you for that).
- The first time you film, the face finder downloads (about 10 MB) and takes a few seconds. Until it's ready, framing isn't checked.
- Safari can clear website storage if you don't open the site for about a week. Adding it to your Home Screen avoids that, but save clips to Photos when you finish anyway.
- Saving many long clips at once can be too much for the iPhone share sheet. If that happens, use **Save these** per act.
- The "feeling" is direction for you; v1 doesn't check whether the take actually reads that way.

## What's next

- **Laptop monitor**: open the app on a laptop and see the phone's live camera, so you can check framing from across the room.
- **Claude writes the shot list from your script**, instead of picking from the library.
- **Claude looks at a frame of each take** and says what mood it reads as, compared with the feeling you were going for.
- Your own proven shots in `shots.json` in place of the placeholders.
