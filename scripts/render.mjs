#!/usr/bin/env node
/*
 * Render the job to MP4.
 * Primary path:  headless Chrome (playwright-core) drives the SAME
 *                composition the browser previews (composition.html?render=1),
 *                captures each frame, pipes PNGs to FFmpeg. Then the
 *                deterministic audio mix (voice + music + sfx) is muxed in.
 * Fallback:      pure FFmpeg (segments + color) — no captions/hook/b-roll.
 *                Reported clearly so the user knows.
 *
 * NEVER touches the original video — only jobs/<id>/media/* (references/copies).
 *
 * Usage: node scripts/render.mjs <jobId>
 */
import fsp from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { jobDir, run, FFMPEG, CHROME, PORT, report } from "./lib.mjs";
import PlanLib from "../public/planlib.js";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const tr = JSON.parse(await fsp.readFile(path.join(d, "transcript.json"), "utf8"));
const plan = JSON.parse(await fsp.readFile(path.join(d, "plan.json"), "utf8"));
const st = PlanLib.deriveAll(tr.words, plan);
const duration = st.duration;
if (!(duration > 0.5)) { await report(id, "render", "failed", "nothing to render (duration " + duration + "s)"); process.exit(1); }

const silent = path.join(d, "silent.mp4");
const out = path.join(d, "out.mp4");
for (const f of [silent, out]) { if (fsSync.existsSync(f)) fsSync.unlinkSync(f); }

const W = st.W, H = st.H;
await report(id, "render", "running", `rendering ${W}x${H} @ ${PlanLib.FPS}fps · ${duration.toFixed(1)}s…`);

// ---------------------------------------------------------------- video
async function renderViaChrome() {
  let pw;
  try { pw = await import("playwright-core"); } catch { throw new Error("NO_PLAYWRIGHT"); }
  const { chromium } = pw;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || CHROME(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--force-color-profile=srgb", `--window-size=${W},${H + 8}`],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("[page]", e.message));
    await page.goto(`http://127.0.0.1:${PORT}/composition.html?job=${id}&render=1`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(() => window.RenderAPI.ready(), { timeout: 120000 });
    const size = await page.evaluate(() => window.RenderAPI.size());
    if (size.w !== W || size.h !== H) throw new Error("composition size mismatch: " + JSON.stringify(size));

    const ff = spawn(FFMPEG(), [
      "-nostdin", "-y", "-f", "image2pipe", "-framerate", String(PlanLib.FPS), "-i", "pipe:0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-color_range", "pc", silent,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let ffErr = "";
    ff.stderr.on("data", c => { ffErr += c; });

    const frames = Math.max(1, Math.round(duration * PlanLib.FPS));
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      const t = Math.min(duration - 1 / PlanLib.FPS / 2, i / PlanLib.FPS);
      await page.evaluate((ts) => window.RenderAPI.seek(ts), t);
      const shot = await page.screenshot({ type: "png" });
      ff.stdin.write(shot);
      if (i % 30 === 0) {
        const pct = Math.round(i / frames * 100);
        await report(id, "render", "running", `frame ${i}/${frames} (${pct}%)`);
      }
    }
    ff.stdin.end();
    const code = await new Promise(res => ff.on("close", res));
    if (code !== 0) throw new Error("ffmpeg video failed: " + ffErr.slice(-400));
    console.error(`[render] video done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function renderViaFFmpegOnly() {
  // degraded: concat segments + approximate color; no overlays
  const media = (await fsp.readdir(path.join(d, "media"))).find(f => /^base\./.test(f));
  const base = path.join(d, "media", media);
  const c = plan.color || { brightness: 1, contrast: 1, saturation: 1 };
  const eq = `eq=brightness=${(c.brightness - 1).toFixed(3)}:contrast=${c.contrast.toFixed(3)}:saturation=${c.saturation.toFixed(3)}`;
  const scale = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  const parts = st.segments.map((s, i) =>
    `[0:v]trim=start=${s.srcStart.toFixed(3)}:end=${s.srcEnd.toFixed(3)},setpts=PTS-STARTPTS,${eq},${scale}[v${i}]`);
  const graph = parts.join(";") + `;${st.segments.map((_, i) => `[v${i}]`).join("")}concat=n=${st.segments.length}:v=1:a=0,format=yuv420p[outv]`;
  const r = await run(FFMPEG(), ["-nostdin", "-y", "-i", base, "-filter_complex", graph, "-map", "[outv]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-t", duration.toFixed(3), silent], { timeout: 30 * 60 * 1000 });
  if (r.code !== 0) throw new Error("ffmpeg fallback failed: " + r.err.slice(-400));
}

let degraded = false;
try {
  await renderViaChrome();
} catch (e) {
  if (String(e.message || e).includes("NO_PLAYWRIGHT")) {
    degraded = true;
    console.error("[render] playwright-core not installed → degraded FFmpeg-only render. Install with: npm i playwright-core (at project root) and re-render for captions/hook/b-roll.");
    await report(id, "render", "running", "degraded FFmpeg-only render (no captions/hook/b-roll)");
    await renderViaFFmpegOnly();
  } else {
    console.error("[render] chrome path failed:", e.message, "→ trying FFmpeg-only fallback");
    degraded = true;
    await renderViaFFmpegOnly();
  }
}

// ---------------------------------------------------------------- audio
const hasAudioPlan = st.segments.length > 0;
const voice = (plan.audio && plan.audio.enhanced && fsSync.existsSync(path.join(d, "enhanced.wav")))
  ? path.join(d, "enhanced.wav")
  : path.join(d, "media", (await fsp.readdir(path.join(d, "media"))).find(f => /^base\./.test(f)));
const music = (plan.music && fsSync.existsSync(path.join(d, "music.mp3"))) ? path.join(d, "music.mp3") : null;
const sfxFiles = (plan.sfx && plan.sfx.clips)
  ? plan.sfx.clips.map(c => path.join(d, decodeURIComponent(c.file.split("/media/")[1] || c.file))).filter(f => fsSync.existsSync(f))
  : [];

if (hasAudioPlan) {
  const ap = PlanLib.buildAudioPlan({ segments: st.segments, plan, duration });
  const inputs = ["-i", voice];
  if (music) inputs.push("-i", music);
  for (const f of sfxFiles) inputs.push("-i", f);
  // silent.mp4 is appended last; its input index = number of audio inputs + 1
  const silentIdx = 1 + (music ? 1 : 0) + sfxFiles.length;
  const r = await run(FFMPEG(), ["-nostdin", "-y", ...inputs, "-filter_complex", ap.filter_complex,
    "-i", silent, "-map", `${silentIdx}:v`, "-map", "[outa]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], { timeout: 15 * 60 * 1000 });
  if (r.code !== 0) {
    // last resort: video without mixed audio
    const r2 = await run(FFMPEG(), ["-nostdin", "-y", "-i", silent, "-c", "copy", out]);
    if (r2.code !== 0) { await report(id, "render", "failed", "audio mux failed and video-only copy failed"); process.exit(1); }
    await report(id, "render", "done", "WARNING: audio mix failed — video has no audio", { out });
  }
} else {
  const r = await run(FFMPEG(), ["-nostdin", "-y", "-i", silent, "-c", "copy", out]);
  if (r.code !== 0) { await report(id, "render", "failed", "video copy failed"); process.exit(1); }
}

// audio-only copy for the editor preview player (fast seek, small download)
{
  const mix = path.join(d, "mix.m4a");
  const r = await run(FFMPEG(), ["-nostdin", "-y", "-i", out, "-vn", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", mix], { timeout: 5 * 60 * 1000 });
  if (r.code !== 0) console.error("[render] mix.m4a extract failed — preview falls back to out.mp4 audio");
}

const sizeMb = (fsSync.statSync(out).size / 1048576).toFixed(1);
await report(id, "render", "done", `${(W / H > 1 ? "16:9" : "9:16")} · ${duration.toFixed(1)}s · ${sizeMb} MB` + (degraded ? " · DEGRADED (no overlays)" : ""), { out });
await report(id, "finished", "done", "edit complete — open the editor to review or export", { out });
console.log(JSON.stringify({ out, sizeMb, degraded }));
process.exit(0);
