#!/usr/bin/env node
/*
 * Background music via the ElevenLabs music API.
 * Deterministic fallback: none (music is inherently a generated asset) —
 * if the key is missing or the API fails, the step is SKIPPED and the edit
 * still completes without music.
 *
 * Reads the hook text / transcript summary (decisions.json.musicPrompt) for
 * the generation prompt.
 * Output: jobs/<id>/music.mp3
 *
 * Usage: node scripts/music.mjs <jobId>
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { jobDir, report, readJsonSafe } from "./lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  await report(id, "music", "skipped", "ELEVENLABS_API_KEY not set — edit continues without music");
  process.exit(0);
}

const state = JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8"));
const dec = await readJsonSafe(path.join(d, "decisions.json"), {});
const tr = await readJsonSafe(path.join(d, "transcript.json"));
const words = (tr && tr.words || []).map(w => w.word).join(" ");
const topic = words.slice(0, 220).replace(/\s+/g, " ");

const prompt = dec.musicPrompt ||
  `energetic lofi beat, motivational, clean and modern, subtle bass, fits a ${topic ? "video about: " + topic : "talking-head video"}`;

// target ~ the final video length (unknown until compose; 45s is a safe reel length, looped/trimmed later)
const targetSec = Number(dec.musicSeconds || 45);

await report(id, "music", "running", "generating music via ElevenLabs…");
const out = path.join(d, "music.mp3");
let code = 0, err = "";
let r;
for (const endpoint of [
  "https://api.elevenlabs.io/v1/music/generate",
]) {
  r = await fetch(endpoint, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg,application/json" },
    body: JSON.stringify({ prompt, length: targetSec, instrumental: true, output_format: "mp3" }),
    signal: AbortSignal.timeout(120000),
  }).catch(e => ({ status: 0, err: String(e) }));

  if (r.status === 404 || r.status === 405 || r.status === 0) { err = (r.err || r.status) + ""; continue; }
  const ct = r.headers && r.headers.get("content-type") || "";
  if (r.status >= 200 && r.status < 300) {
    if (ct.includes("json")) {
      const j = await r.json().catch(() => ({}));
      const url = j.audio_url || (j.data && j.data[0]);
      if (!url) { err = "music API returned no audio url"; continue; }
      const a = await fetch(url, { signal: AbortSignal.timeout(120000) });
      const buf = Buffer.from(await a.arrayBuffer());
      await fsp.writeFile(out, buf);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2000) await fsp.writeFile(out, buf);
    }
    if (await sizeOk(out)) {
      await report(id, "music", "done", `ElevenLabs music · ~${targetSec}s`);
      console.log(JSON.stringify({ music: out }));
      process.exit(0);
    }
    err = "music file too small";
  } else {
    const body = await r.text().catch(() => "");
    err = `HTTP ${r.status}: ${body.slice(0, 200)}`;
  }
}
await report(id, "music", "skipped", "music unavailable — " + String(err).slice(0, 140));
process.exit(0); // skipped is not a failure for the overall edit

async function sizeOk(f) {
  try { return (await fsp.stat(f)).size > 2000; } catch { return false; }
}
