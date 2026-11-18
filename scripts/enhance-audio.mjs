#!/usr/bin/env node
/*
 * Enhance audio for the job.
 *  - With AUPHONIC_API_KEY: Auphonic cloud enhancement (denoise, EQ, loudness).
 *  - Otherwise: local FFmpeg loudnorm (EBU R128) — deterministic, offline.
 * Output: jobs/<id>/enhanced.wav  (same timebase as the original)
 *
 * Usage: node scripts/enhance-audio.mjs <jobId>
 */
import fsp from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { jobDir, run, FFMPEG, report } from "./lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const media = (await fsp.readdir(path.join(d, "media"))).find(f => /^base\./.test(f));
const base = path.join(d, "media", media);
const wav = path.join(d, "audio16k.wav");
const outWav = path.join(d, "enhanced.wav");
const key = process.env.AUPHONIC_API_KEY;

// make sure we have a workable wav (transcribe step may have made one)
if (!fsSync.existsSync(wav)) {
  const r = await run(FFMPEG(), ["-nostdin", "-y", "-i", base, "-vn", "-ac", "1", "-ar", "16000", wav]);
  if (r.code !== 0) throw new Error("could not extract audio: " + r.err.slice(-200));
}

async function localLoudnorm() {
  await report(id, "audio", "running", "local loudnorm (EBU R128) + de-noise…");
  // two-pass loudnorm for accuracy
  let r = await run(FFMPEG(), ["-nostdin", "-i", wav, "-af", "loudnorm=I=-15:TP=-1.5:LRA=1.2:print_format=json", "-f", "null", "-"], { timeout: 15 * 60 * 1000 });
  let m = r.err.match(/"input_i"\s*:\s*(-?[\d.]+)/), i2 = r.err.match(/"input_tp"\s*:\s*(-?[\d.]+)/), l = r.err.match(/"input_thresh"\s*:\s*(-?[\d.]+)/), t = r.err.match(/"input_lra"\s*:\s*([\d.]+)/),
      t2 = r.err.match(/"target_offset"\s*:\s*(-?[\d.]+)/);
  let af = "loudnorm=I=-15:TP=-1.5:LRA=1.2:print_format=json";
  if (m && i2 && l && t && t2) {
    af = `loudnorm=I=-15:TP=-1.5:LRA=1.2:measured_I=${m[1]}:measured_TP=${i2[1]}:measured_thresh=${l[1]}:measured_LRA=${t[1]}:offset=${t2[1]}:linear=true`;
  }
  r = await run(FFMPEG(), ["-nostdin", "-y", "-i", base, "-vn", "-af", `afftdn=nr=12:nf=-25,${af},aformat=sample_rates=44100:channel_layouts=stereo`, outWav], { timeout: 20 * 60 * 1000 });
  if (r.code !== 0) throw new Error("loudnorm failed: " + r.err.slice(-200));
}

async function auphonic() {
  await report(id, "audio", "running", "Auphonic cloud enhancement…");

  // 1) upload the wav
  let r = await run("curl", ["-fsS", "-u", `${key}:`, "-H", "Content-Type: application/octet-stream",
    "--data-binary", "@" + wav, "https://api.auphonic.com/v1/files"]);
  if (r.code !== 0) throw new Error("auphonic upload failed: " + (r.out + r.err).slice(0, 200));
  const file = JSON.parse(r.out);

  // 2) create asset
  r = await run("curl", ["-fsS", "-u", `${key}:`, "-H", "Content-Type: application/json",
    "-d", JSON.stringify({ name: "11secondedit", sourceFileId: file.id, presetId: "presets/denoise" }),
    "https://api.auphonic.com/v1/assets"]);
  if (r.code !== 0) throw new Error("auphonic asset failed: " + (r.out + r.err).slice(0, 200));
  const asset = JSON.parse(r.out);

  // 3) poll until ready (up to 10 min)
  let status = "pending";
  for (let i = 0; i < 60; i++) {
    await new Promise(r2 => setTimeout(r2, 10000));
    r = await run("curl", ["-fsS", "-u", `${key}:`, `https://api.auphonic.com/v1/assets/${asset.id}`]);
    status = JSON.parse(r.out).status;
    if (status === "ready") break;
    if (status === "failed" || status === "canceled") throw new Error("auphonic asset " + status);
  }
  if (status !== "ready") throw new Error("auphonic timed out");

  // 4) download processed audio
  r = await run("curl", ["-fsSL", "-u", `${key}:`, "-o", outWav,
    `https://api.auphonic.com/v1/assets/${asset.id}/files/audio/wav`]);
  if (r.code !== 0) throw new Error("auphonic download failed");
  // resample to 44.1k stereo to match the mix graph
  r = await run(FFMPEG(), ["-nostdin", "-y", "-i", outWav, "-ar", "44100", "-ac", "2", outWav + ".tmp"]);
  if (r.code !== 0) throw new Error("resample failed");
  await fsp.rename(outWav + ".tmp", outWav);
}

try {
  if (key) { try { await auphonic(); } catch (e) {
    console.error("Auphonic failed, falling back to local:", e.message);
    await localLoudnorm();
  } } else { await localLoudnorm(); }
} catch (e) {
  await report(id, "audio", "failed", String(e.message || e));
  process.exit(1);
}

const via = key ? "Auphonic cloud" : "FFmpeg loudnorm (local)";
await report(id, "audio", "done", via);
console.log(JSON.stringify({ enhanced: outWav, via }));
process.exit(0);
