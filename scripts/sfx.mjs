#!/usr/bin/env node
/*
 * Sound effects — generated LOCALLY and deterministically with FFmpeg
 * (no API needed). Three short cues:
 *   whoosh.wav  0.38s  sweep 280→3200 Hz, exp decay — used on cuts
 *   pop.wav     0.18s  190 Hz sine burst — hook/cta card in
 *   ding.wav    0.30s  1.18 kHz ping — end
 * Output: jobs/<id>/sfx/{whoosh,pop,ding}.wav
 *
 * Usage: node scripts/sfx.mjs <jobId>
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { jobDir, run, FFMPEG, report } from "./lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }
const sfxDir = path.join(d, "sfx");
await fsp.mkdir(sfxDir, { recursive: true });

const mk = (file, filter, dur) =>
  run(FFMPEG(), ["-nostdin", "-y", "-f", "lavfi", "-i", `aevalsrc=${filter}:d=${dur}`,
    "-ar", "44100", "-ac", "2", path.join(sfxDir, file)]);

await report(id, "sfx", "running", "synthesizing cues locally…");
const whoosh = `0.55*(sin(2*PI*(280+3000*t)*t))*exp(-5.2*t)+0.12*sin(2*PI*95*t)*exp(-14*t)`;
const pop = `0.7*sin(2*PI*190*t)*exp(-22*t)`;
const ding = `0.5*sin(2*PI*1180*t)*exp(-9*t)+0.2*sin(2*PI*1770*t)*exp(-12*t)`;

const results = [];
for (const [file, f, dur] of [["whoosh.wav", whoosh, 0.38], ["pop.wav", pop, 0.18], ["ding.wav", ding, 0.30]]) {
  const r = await mk(file, f, dur);
  if (r.code !== 0) results.push(file + ":FAIL");
}
if (results.length) { await report(id, "sfx", "failed", results.join(", ")); process.exit(1); }
await report(id, "sfx", "done", "whoosh · pop · ding (local synthesis)");
console.log(JSON.stringify({ sfx: ["whoosh.wav", "pop.wav", "ding.wav"] }));
process.exit(0);
