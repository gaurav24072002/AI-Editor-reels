#!/usr/bin/env python3
"""rembg_frames.py <dir> — remove background from every PNG in <dir>, in place.
Usage: python3 rembg_frames.py cutout/frames
Progress: one JSON line per batch on stdout: {"done": n, "total": n, "ms": avg}
"""
import sys, os, time, glob, json
from PIL import Image
from rembg import remove, new_session

d = sys.argv[1]
files = sorted(glob.glob(os.path.join(d, "*.png")))
if not files:
    print(json.dumps({"error": "no pngs in " + d})); sys.exit(1)

session = new_session("u2net")
t0 = time.time()
n = len(files)
for i, f in enumerate(files):
    img = Image.open(f).convert("RGB")
    out = remove(img, session=session, post_process_mask=True)
    out.save(f)  # RGBA in place
    if (i + 1) % 25 == 0 or i + 1 == n:
        el = time.time() - t0
        print(json.dumps({"done": i + 1, "total": n, "ms": round(el / (i + 1) * 1000)}), flush=True)
print(json.dumps({"ok": True, "total": n, "sec": round(time.time() - t0, 1)}), flush=True)
