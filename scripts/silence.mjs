#!/usr/bin/env node
/*
 * Find silences with FFmpeg silencedetect and propose word-index cuts —
 * ONLY whole words that sit fully inside a silence (never mid-word).
 * Writes jobs/<id>/silence_cuts.json  (array of word indices)
 *
 * Usage: node scripts/silence.mjs <jobId> [minSilenceSec=0.45]
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { jobDir, run, FFMPEG, report } from "./lib.mjs";

const id = process.argv[2];
const minSil = Number(process.argv[3] || 0.45);
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const tr = JSON.parse(await fsp.readFile(path.join(d, "transcript.json"), "utf8"));
const words = tr.words;

const media = (await fsp.readdir(path.join(d, "media"))).find(f => /^base\./.test(f));
const base = path.join(d, "media", media);

await report(id, "silences", "running", `detecting silences ≥ ${minSil}s…`);
const r = await run(FFMPEG(), ["-nostdin", "-i", base, "-af", `silencedetect=noise=-30dB:d=${minSil}`, "-f", "null", "-"]);
if (r.code !== 0) { await report(id, "silences", "failed", "silencedetect failed"); process.exit(1); }

const silences = [];
const re = /silence_start:\s*([\d.]+).*?silence_end:\s*([\d.]+)/g;
let m;
while ((m = re.exec(r.err + " " + r.out))) silences.push([Number(m[1]), Number(m[2])]);
// also trailing silence (start with no end)
const trailing = /silence_start:\s*([\d.]+)(?!.*silence_end)/.exec(r.err + " " + r.out);
if (trailing) silences.push([Number(trailing[1]), Number(trailing[1]) + 5]);

const cuts = [];
for (const [s, e] of silences) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.start < s - 0.02 || w.end > e + 0.02) continue;
    // Guard: a word only counts as "in a silence" if there is a real pause
    // right before or after it. Low-volume speech is NOT silence — cutting it
    // would destroy real words (e.g. quiet TTS or a mic drop).
    const gapBefore = w.start - (i > 0 ? (words[i - 1].end || words[i - 1].start) : 0);
    const gapAfter = (i + 1 < words.length ? words[i + 1].start : tr.duration) - (w.end || w.start);
    if (Math.max(gapBefore, gapAfter) >= minSil) cuts.push(i);
  }
}
const unique = [...new Set(cuts)].sort((a, b) => a - b);
await fsp.writeFile(path.join(d, "silence_cuts.json"), JSON.stringify(unique, null, 2));
await report(id, "silences", "done", `${unique.length} silent words removed (${silences.length} gaps)`);
console.log(JSON.stringify({ silenceCuts: unique.length, gaps: silences.length }));
process.exit(0);
