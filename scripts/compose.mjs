#!/usr/bin/env node
/*
 * Compose the final plan.json — DETERMINISTIC. No AI in this script.
 * Claude's creative decisions arrive via jobs/<id>/decisions.json (written
 * by the Claude Code session per SKILL.md); everything else is data-driven.
 *
 * Reads:  state.json, transcript.json, silence_cuts.json?, filler_cuts.json?,
 *         decisions.json?, enhanced.wav?, music.mp3?, sfx/?
 * Writes: jobs/<id>/plan.json
 *
 * Usage: node scripts/compose.mjs <jobId>
 */
import fsp from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { jobDir, report, readJsonSafe, mediaUrl } from "./lib.mjs";
import PlanLib from "../public/planlib.js";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const state = JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8"));
const tr = JSON.parse(await fsp.readFile(path.join(d, "transcript.json"), "utf8"));
const feat = state.features || {};
const dec = await readJsonSafe(path.join(d, "decisions.json"), {});

// ---------- cuts (word-index based; never mid-word) ----------
const cutWords = new Set();
const addRange = (a, b) => { for (let i = Math.max(0, a); i <= Math.min(tr.words.length - 1, b); i++) cutWords.add(i); };

// bad takes / false starts / repeats — Claude's judgment (ranges of word indices)
if (feat.removeBadTakes) {
  for (const r of dec.cutRanges || []) {
    if (Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0]) addRange(r[0], r[1]);
  }
  for (const i of dec.extraCutWords || []) if (Number.isFinite(i)) cutWords.add(i);
}

// silences (deterministic candidates, Claude may veto)
if (feat.removeSilences) {
  const sil = await readJsonSafe(path.join(d, "silence_cuts.json"), []);
  const veto = new Set(dec.excludeSilence || []);
  for (const i of sil) if (!veto.has(i)) cutWords.add(i);
}

// fillers (deterministic candidates, Claude may veto)
if (feat.removeFillers) {
  const fil = await readJsonSafe(path.join(d, "filler_cuts.json"), []);
  const veto = new Set(dec.excludeFillers || []);
  for (const i of fil) if (!veto.has(i)) cutWords.add(i);
}

// safety: never cut so much that the video is under 3s
{
  const kept = tr.words.filter((_, i) => !cutWords.has(i));
  if (kept.length && kept[kept.length - 1].end - kept[0].start < 3) {
    cutWords.clear(); // extreme case: drop all auto-cuts, keep the take intact
  }
}

const cuts = { words: [...cutWords].sort((a, b) => a - b), ranges: [] };

// ---------- derive timeline (via the SAME planlib the preview/render use) ----------
const st = PlanLib.deriveAll(tr.words, { cuts, aspect: state.aspect });
const duration = st.duration;

// ---------- b-roll placement ----------
const broll = [];
if (feat.broll && state.brollFiles && state.brollFiles.length) {
  for (const b of dec.broll || []) {
    let tlStart = null;
    if (Number.isFinite(b.tlStart)) tlStart = b.tlStart;
    else if (Number.isFinite(b.afterWord)) {
      const w = st.wordTL.find(x => x.i === b.afterWord);
      if (w) tlStart = w.start;
    }
    if (tlStart == null) continue;
    broll.push({
      file: mediaUrl(id, b.clip && state.brollFiles.includes(b.clip) ? b.clip : state.brollFiles[(b.index != null ? b.index : broll.length) % state.brollFiles.length]),
      tlStart: Math.max(0, tlStart),
      dur: Math.min(Number(b.dur) || 2.5, Math.max(0.8, duration - tlStart - 0.2)),
      style: b.style === "inset" ? "inset" : "cover",
    });
  }
  if (!broll.length) {
    // default: first clip over the hook moment, second (if any) mid-video
    const spots = [0.4, duration * 0.55];
    for (let i = 0; i < Math.min(state.brollFiles.length, 2); i++) {
      broll.push({ file: mediaUrl(id, state.brollFiles[i]), tlStart: spots[i], dur: 2.4, style: i === 0 ? "cover" : "inset" });
    }
  }
}

// ---------- zoom cuts ----------
let zooms = [];
if (feat.zooms) {
  const segIdx = new Set();
  // word-index based (preferred — Claude knows word indices from the transcript)
  if (Array.isArray(dec.zoomAtWords)) {
    for (const wi of dec.zoomAtWords) {
      if (!Number.isFinite(wi)) continue;
      for (const s of st.segments) {
        if (wi >= 0 && wi < tr.words.length && tr.words[wi].start >= s.srcStart && tr.words[wi].start <= s.srcEnd) {
          segIdx.add(st.segments.indexOf(s));
          break;
        }
      }
    }
  }
  // raw segment indices (fallback)
  for (const i of dec.zoomSegs || []) if (Number.isInteger(i) && i >= 0 && i < st.segments.length) segIdx.add(i);
  zooms = [...segIdx].sort((a, b) => a - b);
  if (!zooms.length) {
    // default: punch-in on the first 2 content beats
    const candidates = st.segments.map((s, i) => i).filter(i => i > 0 && i < 4);
    zooms = candidates.slice(0, 2);
  }
}

// ---------- audio ----------
const hasEnhanced = fsSync.existsSync(path.join(d, "enhanced.wav"));
const audioSource = (feat.enhanceAudio && hasEnhanced) ? "enhanced" : "base";

// ---------- music ----------
let music = null;
if (feat.music && fsSync.existsSync(path.join(d, "music.mp3"))) {
  music = { file: mediaUrl(id, "music.mp3"), volume: Number(dec.musicVolume) || 0.18 };
}

// ---------- sfx ----------
let sfx = null;
const sfxMode = feat.sfx ? (dec.sfx || "auto") : "none";
if (sfxMode !== "none" && fsSync.existsSync(path.join(d, "sfx", "whoosh.wav"))) {
  const clips = [];
  if (sfxMode === "auto") {
    for (const s of st.segments.slice(1)) clips.push({ t: s.tlStart, clip: "whoosh.wav", vol: 0.32 });
    if (dec.hook && dec.hook.text) clips.push({ t: 0.02, clip: "pop.wav", vol: 0.5 });
    if (dec.cta && dec.cta.text) clips.push({ t: Math.max(0, duration - (dec.cta.dur || 3) + 0.05), clip: "ding.wav", vol: 0.4 });
  } else if (Array.isArray(dec.sfx)) {
    for (const c of dec.sfx) {
      if (Number.isFinite(c.t) && fsSync.existsSync(path.join(d, "sfx", c.clip || "whoosh.wav"))) {
        clips.push({ t: Math.max(0, c.t), clip: c.clip || "whoosh.wav", vol: c.vol != null ? c.vol : 0.4 });
      }
    }
  }
  if (clips.length) sfx = { clips: clips.map((c, k) => ({ ...c, idx: k, file: mediaUrl(id, "sfx/" + c.clip) })) };
}

// ---------- plan ----------
// user's fine-tuning from the UI gear modals
const S = state.settings || {};
const cap = (S.captions && S.captions.custom) ? S.captions : {};
const hookText = (S.textHook && S.textHook.text) || (dec.hook && dec.hook.text);
const hookColor = (S.textHook && S.textHook.color) || null;
const ctaText = (S.cta && S.cta.text) || (dec.cta && dec.cta.text);
const col = S.color || {};
const colorPlan = feat.color
  ? (dec.color && typeof dec.color.brightness === "number") ? dec.color
  : { brightness: (col.brightness !== false) ? 1.06 : 1.0,
      contrast: (col.brightness !== false) ? 1.08 : 1.0,
      saturation: (col.lift !== false) ? 1.12 : 1.0 }
  : null;
let baseFile = mediaUrl(id, (await fsp.readdir(path.join(d, "media"))).find(f => /^base\./.test(f)));
// green-screen / background replacement: if bgreplace.mjs produced a cutout
// composite, it REPLACES the base footage (same timeline, same length).
const cutoutIdx = await readJsonSafe(path.join(d, "cutout", "index.json"), null);
if (cutoutIdx && cutoutIdx.file && fsSync.existsSync(path.join(d, cutoutIdx.file))) {
  baseFile = mediaUrl(id, cutoutIdx.file);
}
// motion graphics (deterministic overlays; drawn by planlib drawMotion)
const motion = Array.isArray(dec.motion)
  ? dec.motion.filter(m => m && Number.isFinite(Number(m.t)) && ["burst", "pulse", "sweep", "chip"].includes(m.type))
      .map(m => ({ type: m.type, t: Number(m.t), dur: Math.min(3, Math.max(0.3, Number(m.dur) || 1)), color: m.color || null, x: m.x, y: m.y, text: m.text || "" }))
  : [];
const plan = {
  aspect: state.aspect || "9:16",
  baseFile,
  audio: { volume: Number(dec.audioVolume) || 1.0, source: audioSource, enhanced: audioSource === "enhanced" ? mediaUrl(id, "enhanced.wav") : null },
  cuts,
  hook: (feat.hook && hookText) ? { text: hookText, dur: Number(dec.hook && dec.hook.dur) || 2.6, color: hookColor } : null,
  cta: (feat.cta && ctaText) ? { text: ctaText, dur: Number(dec.cta && dec.cta.dur) || 3.0 } : null,
  zooms,
  broll,
  motion,
  color: colorPlan,
  captions: (dec.captionsOn === true || (feat.captions !== false && dec.captionsOff !== true))
    ? { enabled: true, style: "bold",
        font: cap.font || "Impact", size: Number(cap.size) || 64,
        color: cap.color || "#ffffff", outline: cap.outline !== false,
        maxWords: Math.max(1, Number(cap.minWords) || 4) }
    : { enabled: false, style: "bold" },
  music,
  sfx,
  watermark: dec.watermark
    ? (typeof dec.watermark === "string" ? { text: dec.watermark } : dec.watermark)
    : (state.settings && state.settings.watermark ? { text: state.settings.watermark } : null),
  outName: state.outName || "reel",
};
await fsp.writeFile(path.join(d, "plan.json"), JSON.stringify(plan, null, 2));

const summary = {
  segments: st.segments.length,
  durationSec: Number(duration.toFixed(2)),
  cutWords: cuts.words.length,
  hook: !!plan.hook, cta: !!plan.cta,
  broll: broll.length, zooms: zooms.length,
  audio: audioSource, music: !!music, sfx: sfx ? sfx.clips.length : 0,
  captions: plan.captions.enabled, color: !!plan.color,
};
await report(id, "compose", "done",
  `${summary.segments} segments · ${summary.durationSec}s · ${summary.cutWords} words cut` +
  (plan.hook ? " · hook" : "") + (plan.cta ? " · cta" : "") +
  (broll.length ? ` · ${broll.length} b-roll` : "") +
  (zooms.length ? ` · ${zooms.length} zooms` : "") +
  (music ? " · music" : "") + (sfx ? ` · ${sfx.clips.length} sfx` : ""));
console.log(JSON.stringify(summary));
process.exit(0);
