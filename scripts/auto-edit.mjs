#!/usr/bin/env node
/*
 * auto-edit.mjs — the AUTOMATIC editor. Runs the full pipeline for a job
 * with no human or Claude session needed. Launched by the server the moment
 * the user clicks "Edit Video" (and again for re-renders / AI edits).
 *
 * Modes:
 *   full      transcribe → silences → fillers → editorial decisions (rule-based)
 *             → audio → sfx → music → compose → render        (default)
 *   rerender  compose + render only (decisions.json is kept)
 *   ai        apply queued AI-edit requests (scripts/ai-edit.mjs), then
 *             compose + render
 *
 * The rule-based editorial pass is a DELIBERATE approximation of a human
 * editor: it finds false starts, picks a hook + CTA, places zooms/motion,
 * and never lies to the content. Anything it can't judge stays safe (kept).
 *
 * Usage: node scripts/auto-edit.mjs <jobId> [full|rerender|ai]
 */
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { jobDir, loadState, saveState, run, report, ROOT } from "./lib.mjs";
import PlanLib from "../public/planlib.js";

const id = process.argv[2];
const mode = process.argv[3] || "full";
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const log = (m) => console.log(`[auto] ${m}`);
async function step(script, args = [], timeout = 30 * 60 * 1000) {
  const r = await run(process.execPath, [path.join(ROOT, "scripts", script), id, ...args], { timeout });
  if (r.code !== 0) throw new Error(`${script} exited ${r.code}: ${r.err.slice(-400) || r.out.slice(-200)}`);
}

/* ================================================================== *
 * Rule-based editorial decisions (writes decisions.json)
 * ================================================================== */
function splitSentences(words) {
  const ends = new Set([".", "!", "?", "…", "。", "।"]);
  const out = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(i);
    const gapNext = words[i + 1] ? words[i + 1].start - (w.end != null ? w.end : w.start) : 1.5;
    if (ends.has(w.word) || gapNext > 1.0) { if (cur.length) out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

async function autoDecide(state, tr) {
  const words = tr.words;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sentences = splitSentences(words);
  const dec = {
    cutRanges: [], extraCutWords: [],
    excludeSilence: [], excludeFillers: [],
    hook: { text: "" }, cta: { text: "" },
    zoomAtWords: [], broll: [],
    motion: [],
  };

  // ---- false starts: a sentence whose first 3 content words are repeated
  // by a later sentence within the next 45 words (the speaker restarted)
  const prefix = (idxs) => idxs.slice(0, 3).map(i => norm(words[i].word)).join(" ");
  const seen = [];
  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si];
    if (s.length < 5) continue; // too short to be a "take"
    const p = prefix(s);
    if (p.split(" ").length < 3) continue;
    const startT = words[s[0]].start, endT = words[s[s.length - 1]].end;
    if (endT - startT < 1.2) continue;
    // is the same prefix re-spoken later?
    let repeated = false;
    for (let j = si + 1; j < sentences.length && j <= si + 4; j++) {
      const t = sentences[j];
      if (t[0] - s[s.length - 1] > 45) break;
      if (prefix(t) === p && t.length >= 3) { repeated = true; break; }
    }
    if (repeated && !seen.some(x => x[0] <= s[0] && s[0] <= x[1])) {
      dec.cutRanges.push([s[0], s[s.length - 1]]);
      seen.push([s[0], s[s.length - 1]]);
    }
  }

  // ---- hook: the most compelling complete line (true to the content)
  const S = (state.settings || {});
  let hookText = (S.textHook && S.textHook.text) || "";
  if (!hookText && S.instructions && String(S.instructions).trim()) {
    // explicit user instruction may name the hook
    const m = String(S.instructions).match(/hook\s*[:\-]\s*(.{4,60})/i);
    if (m) hookText = m[1].trim().replace(/^["“]|["”]$/g, "");
  }
  if (!hookText) {
    const POWER = /secret|mistake|wrong|truth|never|always|best|worst|stop|start|finally|nobody|everyone|money|free|real|actually|because/i;
    let best = null;
    for (const s of sentences) {
      if (s.length < 3 || s.length > 14) continue;
      const text = words.slice(s[0], s[s.length] + 1).map(w => w.word).join(" ");
      let score = 6;
      if (s.length >= 4 && s.length <= 10) score += 5;
      if (POWER.test(text)) score += 4;
      if (/\d/.test(text)) score += 3;
      if (text.endsWith("?")) score += 2;          // a question hook grabs attention
      if (s[0] === 0) score += 1;                  // slight preference for the opening
      if (!best || score > best.score) best = { score, text, start: words[s[0]].start };
    }
    if (best) hookText = best.text;
  }
  dec.hook = { text: hookText };

  // ---- CTA
  const ctaText = (S.cta && S.cta.text) || "Follow for more";
  dec.cta = { text: ctaText };

  // ---- cuts set (mirror compose.mjs logic) to know the real timeline
  const cutWords = new Set(dec.extraCutWords);
  for (const r of dec.cutRanges) for (let i = r[0]; i <= r[1]; i++) cutWords.add(i);
  const add = async (f) => { try { const a = JSON.parse(await fsp.readFile(path.join(d, f), "utf8")); for (const i of a) cutWords.add(i); } catch { /* missing = fine */ } };
  if (state.features.removeSilences) await add(path.join(d, "silence_cuts.json"));
  if (state.features.removeFillers) await add(path.join(d, "filler_cuts.json"));
  const st = PlanLib.deriveAll(words, { cuts: { words: [...cutWords] }, aspect: state.aspect || "9:16" });
  const dur = st.duration;

  // ---- zooms: punch-ins at 30% / 62% / 85% beats (count by strength)
  const zStrength = (S.zooms && S.zooms.strength) || "Medium";
  const zCount = zStrength === "Subtle" ? 2 : zStrength === "Strong" ? 4 : 3;
  const beats = zCount === 4 ? [0.25, 0.5, 0.7, 0.88] : zCount === 2 ? [0.35, 0.75] : [0.3, 0.6, 0.85];
  const zoomWords = [];
  for (const b of beats) {
    const tAt = dur * b;
    const seg = st.segments.find(s => tAt >= s.tlStart && tAt < s.tlEnd);
    if (!seg) continue;
    const wi = words.findIndex(w => w.start >= seg.srcStart - 0.001 && w.start <= seg.srcEnd);
    if (wi >= 0 && !zoomWords.includes(wi)) zoomWords.push(wi);
  }
  dec.zoomAtWords = zoomWords;

  // ---- motion graphics: tech-creator polish (burst on the hook, pulse mid, sweep on the CTA)
  if ((S.sfx || state.features.sfx) !== false) {
    dec.motion = [
      { type: "burst", t: 0.25, dur: 1.1, color: "#ffd60a", x: 0.5, y: 0.32 },
      { type: "pulse", t: Math.max(0.6, dur * 0.45), dur: 0.9, color: "#22d3ee", x: 0.5, y: 0.5 },
      { type: "sweep", t: Math.max(0.4, dur - 3.1), dur: 0.9, color: "#ffd60a", y: 0.805 },
    ];
  }

  // ---- color (gentle lift; compose has its own defaults, this just nudges)
  dec.color = { brightness: 1.05, contrast: 1.08, saturation: 1.1 };

  // ---- b-roll: place uploaded clips over the hook and the mid beat
  if (state.brollFiles && state.brollFiles.length) {
    dec.broll = state.brollFiles.slice(0, 2).map((clip, i) => ({
      clip,
      tlStart: i === 0 ? 0.3 : dur * 0.5,
      dur: 2.4,
      style: i === 0 ? "cover" : "inset",
    }));
  }

  dec.musicPrompt = (S.music && S.music.style) || "subtle motivational bed";
  return { dec, st, stats: { sentences: sentences.length, cuts: cutWords.size, zooms: zoomWords.length } };
}

/* ================================================================== *
 * Run
 * ================================================================== */
const state = await loadState(d);
const feat = state.features || {};

// ---- reflect reality in the UI: this job is now IN FLIGHT.
// A previous run may have left status "done" / finished step "done" — if we
// don't clear that, the editor looks finished while it's actually rendering,
// which reads as "stuck" and invites redundant clicks.
{
  const st2 = await loadState(d);
  if (st2.status !== "running") {
    st2.status = "running";
    for (const s of st2.steps || []) {
      if (s.id === "finished" && s.status === "done") { s.status = "pending"; s.detail = ""; s.at = null; }
    }
    st2.updatedAt = new Date().toISOString();
    await saveState(d, st2);
  }
}

if (mode === "full" || mode === "ai") {
  if (mode === "ai") await step("ai-edit-apply.mjs"); // applies queued requests, may flag bg-replace
}

if (mode === "full") {
  // 1) transcript (if we don't have one)
  if (!fs.existsSync(path.join(d, "transcript.json"))) {
    await step("transcribe.mjs", [], 60 * 60 * 1000);
  }
  // 2) deterministic cut candidates
  if (feat.removeSilences && !fs.existsSync(path.join(d, "silence_cuts.json"))) await step("silence.mjs");
  if (feat.removeFillers && !fs.existsSync(path.join(d, "filler_cuts.json"))) await step("fillers.mjs");
  // 3) editorial decisions (rule-based)
  if (!fs.existsSync(path.join(d, "decisions.json"))) {
    const tr = JSON.parse(await fsp.readFile(path.join(d, "transcript.json"), "utf8"));
    const { dec, stats } = await autoDecide(state, tr);
    await fsp.writeFile(path.join(d, "decisions.json"), JSON.stringify(dec, null, 2));
    const hookShown = dec.hook.text ? `hook “${dec.hook.text.slice(0, 44)}${dec.hook.text.length > 44 ? "…" : ""}”` : "no hook";
    await report(id, "analyze", "done", `auto-editor: ${stats.cuts} word-cuts, ${stats.zooms} zooms · ${hookShown}`);
    await report(id, "badtakes", dec.cutRanges.length ? "done" : "skipped",
      dec.cutRanges.length ? `${dec.cutRanges.length} false start(s) cut (auto)` : "no bad takes/false starts detected");
  }
  // 4) sound
  if (feat.enhanceAudio && !fs.existsSync(path.join(d, "enhanced.wav"))) await step("enhance-audio.mjs");
  if (feat.sfx && !fs.existsSync(path.join(d, "sfx", "whoosh.wav"))) await step("sfx.mjs");
  if (feat.music) await step("music.mjs"); // self-skips without a key
}

// ---- background replacement / green screen (all modes; idempotent — only
// runs when requested in decisions.json and the cutout doesn't exist yet)
{
  const decNow = JSON.parse(await fsp.readFile(path.join(d, "decisions.json"), "utf8").catch(() => "{}"));
  if (decNow.bgReplace && !fs.existsSync(path.join(d, "cutout", "index.json"))) {
    await step("bgreplace.mjs", [], 90 * 60 * 1000);
  }
}

// ---- compose + render (all modes)
await step("compose.mjs");
await step("render.mjs", [], 45 * 60 * 1000);

// ---- mark the job finished (UI flips to "done", export is available)
{
  const st = await loadState(d);
  st.status = "done";
  if (fs.existsSync(path.join(d, "out.mp4"))) st.out = path.join(d, "out.mp4");
  st.updatedAt = new Date().toISOString();
  const s = (st.steps || []).find(x => x.id === "finished");
  if (s) { s.status = "done"; s.at = st.updatedAt; } else st.steps = (st.steps || []).concat([{ id: "finished", label: "Finished", status: "done", detail: "", at: st.updatedAt }]);
  await saveState(d, st);
  await report(id, "finished", "done", "automatic edit complete");
}
log(`done (${mode})`);
process.exit(0);
