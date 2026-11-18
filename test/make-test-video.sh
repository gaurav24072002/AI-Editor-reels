#!/bin/bash
# Synthetic test footage: 24s talking-head-ish clip (color bars + counter)
# with a steady tone, so the full pipeline (transcribe can be stubbed) can be
# exercised without a real camera.
set -e
FF=${FFMPEG_PATH:-$HOME/tools/ffmpeg/ffmpeg}
OUT=${1:-test/footage.mp4}
mkdir -p "$(dirname "$OUT")"
"$FF" -nostdin -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30" \
  -f lavfi -i "sine=frequency=220:sample_rate=44100" \
  -t 24 -vf "scale=1920:1080" -c:v libx264 -preset veryfast -crf 23 -c:a aac -shortest "$OUT"
echo "wrote $OUT"
