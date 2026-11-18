#!/usr/bin/env node
/*
 * bgreplace.mjs — background removal / green-screen compositing.
 *
 * Reads decisions.json → bgReplace: { color: "#hex", fps?: 30, removeOnly? }
 * Steps:
 *   1. extract base.* frames @30fps, 720 wide  → cutout/frames/
 *   2. rembg (u2net) per frame → RGBA PNGs (in place)
 *   3. ffmpeg: composite over the solid color @1080x1920 (or leave black)
 *      → green.mp4 (video only; voice always comes from enhanced.wav/base)
 *   4. cutout/index.json { file, color, frames, at }
 *      (compose.mjs swaps plan.baseFile to this file when present)
 *
 * Never touches the original video — reads media/base.*, writes under cutout/.
 * Usage: node scripts/bgreplace.mjs <jobId>
 */
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { jobDir, loadState, run, FFMPEG, PYTHON, report, ROOT } from "./lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const dec = fs.existsSync(path.join(d, "decisions.json"))
  ? JSON.parse(await fsp.readFile(path.join(d, "decisions.json"), "utf8")) : {};
if (!dec.bgReplace) { console.log("[bgreplace] not requested"); process.exit(0); }
if (fs.existsSync(path.join(d, "cutout", "index.json"))) {
  console.log("[bgreplace] already done"); process.exit(0);
}

const color = dec.bgReplace.color || "#00b140";
const fps = Number(dec.bgReplace.fps) || 30;
const outName = "green.mp4";

const media = (await fsp.readdir(path.join(d, "media"))).find(f => /^base\./.test(f));
if (!media) { console.error("no base media"); process.exit(2); }
const base = path.join(d, "media", media);

const cutDir = path.join(d, "cutout");
const frameDir = path.join(cutDir, "frames");
await fsp.rm(frameDir, { recursive: true, force: true });
await fsp.mkdir(frameDir, { recursive: true });

// ---- 1. extract frames (720 wide keeps rembg fast; edges are low-freq) ----
await report(id, "bgreplace", "running", `extracting frames @${fps}fps…`);
{
  const r = await run(FFMPEG(), ["-y", "-hide_banner", "-loglevel", "error", "-i", base,
    "-vf", "scale=720:-2", "-fps_mode", "cfr", "-r", String(fps),
    path.join(frameDir, "f_%05d.png")], { timeout: 10 * 60 * 1000 });
  if (r.code !== 0) throw new Error("frame extract failed: " + (r.err || r.out).slice(-300));
}
const nFrames = (await fsp.readdir(frameDir)).filter(f => f.endsWith(".png")).length;
if (!nFrames) throw new Error("no frames extracted");
const dur = nFrames / fps;
console.log(`[bgreplace] ${nFrames} frames, ${dur.toFixed(1)}s`);

// ---- 2. rembg per frame ----
await report(id, "bgreplace", "running", `removing background (${nFrames} frames)…`);
{
  const r = await run(PYTHON(), [path.join(ROOT, "scripts", "py", "rembg_frames.py"), frameDir],
    { timeout: 60 * 60 * 1000, onLine: (line) => {
        try { const j = JSON.parse(line); if (j.done && j.total && j.done % 100 < 25) console.log(`[bgreplace] cutout ${j.done}/${j.total} (${j.ms}ms/frame avg)`); } catch { /* not json */ }
    } });
  if (r.code !== 0) throw new Error("rembg failed: " + (r.err || r.out).slice(-400));
}

// ---- 3. composite over the color ----
await report(id, "bgreplace", "running", "compositing…");
{
  const filter = `[1:v]scale=1080:1920:flags=lanczos[p];[0:v][p]overlay=0:0,format=yuv420p[out]`;
  const r = await run(FFMPEG(), ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-t", dur.toFixed(3), "-i", `color=c=${color}:s=1080x1920:r=${fps}`,
    "-framerate", String(fps), "-i", path.join(frameDir, "f_%05d.png"),
    "-filter_complex", filter, "-map", "[out]", "-t", dur.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-an",
    path.join(d, outName)], { timeout: 15 * 60 * 1000 });
  if (r.code !== 0) throw new Error("composite failed: " + (r.err || r.out).slice(-300));
}

await fsp.writeFile(path.join(cutDir, "index.json"), JSON.stringify({ file: outName, color, frames: nFrames, fps, at: new Date().toISOString() }, null, 2));
await report(id, "bgreplace", "done", `background replaced with ${color}`);
console.log("[bgreplace] done → " + outName);
process.exit(0);
