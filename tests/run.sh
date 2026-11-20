#!/bin/sh
# Runs the app in a headless browser with a fake camera and checks every verdict.
# Needs Node. First time: npm install && npx playwright install chromium webkit
set -e
cd "$(dirname "$0")"
mkdir -p .work/feeds .work/screens
( cd .. && python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 ) &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1
# A sample portrait from Google's MediaPipe test assets gives the face checker a real face.
[ -f .work/portrait.jpg ] || curl -sSfL -o .work/portrait.jpg https://storage.googleapis.com/mediapipe-assets/portrait.jpg
node gen-frames.mjs .work/portrait.jpg .work/feeds
node test.mjs
