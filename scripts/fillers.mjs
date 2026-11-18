#!/usr/bin/env node
/*
 * Deterministic filler-word candidates (word indices). Claude reviews these
 * in SKILL.md and may veto any index in decisions.json.excludeFillers.
 * Writes jobs/<id>/filler_cuts.json
 *
 * Conservative list — only words that are safe to cut alone.
 * Usage: node scripts/fillers.mjs <jobId>
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { jobDir, report } from "./lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const tr = JSON.parse(await fsp.readFile(path.join(d, "transcript.json"), "utf8"));
const words = tr.words;

const SOLO = new Set(["uh", "um", "uhh", "umh", "uhum", "umm", "er", "err", "ahem", "mm", "mhm", "hmm", "oh", "okey", "okey-dokay"]);
const PHRASES = ["you know", "i mean", "like, i", "so basically"];
// user's custom filler list from the UI gear (state.settings.fillers.customList)
try {
  const st = JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8"));
  const custom = ((st.settings || {}).fillers || {}).customList || "";
  for (const piece of custom.split(",").map(s => s.trim()).filter(Boolean)) {
    const p = piece.toLowerCase().replace(/[^a-z'-]/g, "");
    if (!p) continue;
    if (p.includes(" ")) PHRASES.push(p); else SOLO.add(p);
  }
} catch { /* no settings — default list only */ }
const norm = (s) => s.toLowerCase().replace(/[^a-z'-]/g, "");

const cuts = new Set();
for (let i = 0; i < words.length; i++) {
  const w = norm(words[i].word);
  if (SOLO.has(w)) {
    // never cut a filler that is actually a content word in disguise:
    // "oh" right before a question word is usually meaningful — keep it
    if (w === "oh" && i + 1 < words.length && /^(why|how|what|when|where|who)/.test(norm(words[i + 1].word))) continue;
    cuts.add(i);
    continue;
  }
  // two-word phrases: cut both words only when adjacent in time
  for (const ph of PHRASES) {
    const parts = ph.split(" ").map(norm);
    if (norm(words[i].word) === parts[0] && i + 1 < words.length && norm(words[i + 1].word) === parts[1] &&
        words[i + 1].start - words[i].end <= 0.35) {
      cuts.add(i); cuts.add(i + 1);
      break;
    }
  }
}
// "like" as a pure filler: only when it starts a sentence AND the previous
// kept context is a pause — heuristic: previous gap > 0.5s
{
  const extra = new Set();
  for (let i = 0; i < words.length; i++) {
    if (norm(words[i].word) !== "like") continue;
    const prevGap = i > 0 ? words[i].start - (words[i - 1].end || words[i - 1].start) : 99;
    if (prevGap > 0.5 && words[i + 1] && (words[i + 1].word.match(/^[a-z]/i))) extra.add(i);
  }
  for (const i of extra) cuts.add(i);
}

const out = [...cuts].sort((a, b) => a - b);
await fsp.writeFile(path.join(d, "filler_cuts.json"), JSON.stringify(out, null, 2));
await report(id, "fillers", "done", `${out.length} filler words removed`);
console.log(JSON.stringify({ fillerCuts: out.length }));
process.exit(0);
