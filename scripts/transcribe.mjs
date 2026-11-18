#!/usr/bin/env node
/*
 * Transcribe the job's base video with word-level timestamps.
 *  1) extract 16 kHz mono wav with FFmpeg
 *  2) run WhisperX (python) — word timestamps via whisperX.align
 *  3) write jobs/<id>/transcript.json
 *
 * Usage: node scripts/transcribe.mjs <jobId>
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jobDir, run, FFMPEG, PYTHON, report, ROOT } from "./lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

await report(id, "transcribe", "running", "extracting 16k mono audio…");

// 1) audio extraction (never touches the original file)
const media = await fsp.readdir(path.join(d, "media"));
const base = media.find(f => /^base\./.test(f));
if (!base) { await report(id, "transcribe", "failed", "no base media in job"); process.exit(1); }
const baseFile = path.join(d, "media", base);
const wav = path.join(d, "audio16k.wav");
let r = await run(FFMPEG(), ["-y", "-i", baseFile, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", wav], { timeout: 10 * 60 * 1000 });
if (r.code !== 0) { await report(id, "transcribe", "failed", "ffmpeg audio extract failed: " + r.err.slice(-200)); process.exit(1); }

// 2) whisperx — honor the job's Pro-transcription settings (language, vocabulary, censor)
const LANG = {
  "American English": "en", "British English": "en", Hindi: "hi", Punjabi: "pa",
  Spanish: "es", French: "fr", German: "de",
};
let tset = {};
try { tset = JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8")).settings?.transcribe || {}; } catch {}
const langArg = tset.language && tset.language !== "Auto-detect (multilingual)" ? (LANG[tset.language] || "") : "";
const promptArg = tset.vocab ? (tset.vocab + (tset.language === "British English" ? " British English spelling" : "")) : "";
const rawOut = path.join(d, "whisper_raw.json");
const pyScript = path.join(ROOT, "scripts", "py", "whisperx_transcribe.py");
const args = [pyScript, wav, rawOut];
if (langArg) args.push(langArg);
if (promptArg) args.push(promptArg);

await report(id, "transcribe", "running", "running WhisperX (first run downloads models)…");
r = await run(PYTHON(), args, { timeout: 60 * 60 * 1000 });
if (r.code === 3 || /WHISPERX_MISSING/.test(r.err)) {
  await report(id, "transcribe", "failed",
    "WhisperX not installed. Install with: python3 -m pip install --user whisperx  (installs torch + faster-whisper; ~2GB). Then re-run: node scripts/transcribe.mjs " + id);
  process.exit(1);
}
if (r.code !== 0) {
  await report(id, "transcribe", "failed", "whisperx failed: " + (r.err.slice(-300)).replace(/\n/g, " | "));
  process.exit(1);
}

// 3) normalize + validate
const raw = JSON.parse(await fsp.readFile(rawOut, "utf8"));
const words = (raw.words || []).filter(w => w && typeof w.word === "string" && w.word.trim() && Number.isFinite(w.start));
words.forEach((w, i) => {
  w.word = w.word.trim();
  if (!(w.end > w.start)) w.end = w.start + 0.25;
});
// Pro transcription: censor swear words (replaces the spoken word in captions)
if (tset.censor) {
  const BAD = new Set(["fuck", "fucked", "fucking", "fucks", "shit", "shits", "bitch", "bitches",
    "asshole", "bastard", "crap", "damn", "hell", "dick", "pussy", "wtf", "f u c k", "s h i t"]);
  let n = 0;
  for (const w of words) {
    const k = w.word.toLowerCase().replace(/[^a-z]/g, "");
    if (BAD.has(k)) { w.word = "*".repeat(Math.min(w.word.length, 4)); n++; }
  }
  console.error(`censored ${n} swear words`);
}
if (!words.length) {
  await report(id, "transcribe", "failed", "transcript had no words");
  process.exit(1);
}
const out = {
  language: raw.language || "en",
  duration: raw.duration || words[words.length - 1].end,
  words,
};
await fsp.writeFile(path.join(d, "transcript.json"), JSON.stringify(out, null, 2));
await report(id, "transcribe", "done", `${words.length} words · ${out.duration.toFixed(1)}s · ${out.language}`);
console.log(JSON.stringify({ transcript: path.join(d, "transcript.json"), words: words.length, duration: out.duration }));
process.exit(0);
