#!/usr/bin/env node
/*
 * ai-edit-apply.mjs — applies queued "AI edit" requests (from the editor UI:
 * a selected time range + a natural-language instruction) onto the job's
 * decisions.json / transcript.json. Called by auto-edit.mjs in --ai mode,
 * before compose + render.
 *
 * Intents it understands (keyword based, order matters — first match wins):
 *   green screen / background   → bgReplace (rembg cutout over green or color)
 *   b-roll / overlay / over my head / picture-in-picture → b-roll or a motion chip
 *   motion graphics / burst / sparkle / particles        → burst overlay
 *   pulse / ring / echo                                    → pulse overlay
 *   sweep / underline / line                               → sweep overlay
 *   chip / label / sticker / "text …"                      → pop-in chip
 *   zoom / punch in / closer / tighter                     → zoom cut at the range
 *   cut / remove / delete / trim                           → cut the words in range
 *   new hook / hook: X                                     → set hook text
 *   cta / follow: X / call to action                        → set CTA text
 *   captions off / hide captions                            → disable captions
 *   quieter / louder                                        → voice volume
 *   slower / faster                                         → (noted; needs a re-cut — flagged)
 *   anything else                                           → flagged "needs-review" (kept for a human/Claude pass)
 *
 * Writes: decisions.json (updated), ai-requests.json (statuses), and
 *         bgreplace-requested (flag file read by auto-edit.mjs).
 *
 * Usage: node scripts/ai-edit-apply.mjs <jobId>
 */
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { jobDir, report } from "./lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const reqFile = path.join(d, "ai-requests.json");
const reqs = fs.existsSync(reqFile) ? JSON.parse(await fsp.readFile(reqFile, "utf8")) : [];
const pending = reqs.filter(r => r.status === "pending");
if (!pending.length) { console.log("[ai-apply] nothing pending"); process.exit(0); }

let dec = {};
try { dec = JSON.parse(await fsp.readFile(path.join(d, "decisions.json"), "utf8")); } catch { /* first edit */ }
let tr = null;
try { tr = JSON.parse(await fsp.readFile(path.join(d, "transcript.json"), "utf8")); } catch { /* not transcribed yet */ }

let st = null; // {segments, wordTL, duration} — lazily derived from CURRENT cuts
async function timeline() {
  if (!tr) return null;
  const mod = await import("../public/planlib.js");
  const PlanLib = mod.default || mod;
  const stNow = JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8"));
  const cuts = new Set(dec.extraCutWords || []);
  for (const r of dec.cutRanges || []) for (let i = r[0]; i <= r[1]; i++) cuts.add(i);
  try { const sil = JSON.parse(await fsp.readFile(path.join(d, "silence_cuts.json"), "utf8")); for (const i of sil) if (!new Set(dec.excludeSilence || []).has(i)) cuts.add(i); } catch {}
  try { const fil = JSON.parse(await fsp.readFile(path.join(d, "filler_cuts.json"), "utf8")); for (const i of fil) if (!new Set(dec.excludeFillers || []).has(i)) cuts.add(i); } catch {}
  return PlanLib.deriveAll(tr.words, { cuts: { words: [...cuts] }, aspect: stNow.aspect || "9:16" });
}

const results = [];
for (const r of pending) {
  const ins = String(r.instruction || "").trim();
  const t0 = Math.max(0, Number(r.t0) || 0);
  const t1 = Number(r.t1) > t0 ? Number(r.t1) : t0 + 2;
  const applied = [];
  let note = null;

  const low = ins.toLowerCase();
  const wordAt = async (t) => {
    // map timeline time → word index (kept words only)
    const tl = st || (st = await timeline());
    if (!tl) return null;
    const w = tl.wordTL.find(x => t >= x.start && t <= x.end + 0.3) || tl.wordTL.find(x => x.start >= t);
    return w ? w.i : null;
  };
  const segAt = async (t) => {
    const tl = st || (st = await timeline());
    if (!tl) return null;
    const seg = tl.segments.find(s => t >= s.tlStart && t < s.tlEnd) || tl.segments[0];
    if (!seg) return null;
    const wi = tr.words.findIndex(w => w.start >= seg.srcStart - 0.001 && w.start <= seg.srcEnd);
    return { wi, seg, tl: tl.segments.indexOf(seg) };
  };

  const m = (re) => { const x = low.match(re); return x ? x[1] : null; };

  // ---- 1. green screen / background replace
  if (/green.?screen|chroma|background|backdrop|\bbg\b/i.test(ins) && !/remove background and keep transparent only/i.test(low)) {
    const colorM = ins.match(/#[0-9a-fA-F]{6}/) || ins.match(/\b(red|green|blue|black|white|yellow|purple|orange|cyan|teal|pink)\b/i);
    const COLORS = { red: "#ef4444", green: "#00b140", blue: "#2563eb", black: "#0a0a0a", white: "#f5f5f5", yellow: "#facc15", purple: "#8b5cf6", orange: "#f97316", cyan: "#22d3ee", teal: "#14b8a6", pink: "#ec4899" };
    let color = "#00b140";
    if (colorM) color = colorM[0].startsWith("#") ? colorM[0] : (COLORS[colorM[1].toLowerCase()] || "#00b140");
    dec.bgReplace = { color, fps: 30 };
    if (fs.existsSync(path.join(d, "cutout", "index.json"))) await fsp.rm(path.join(d, "cutout"), { recursive: true, force: true }); // force fresh cutout
    applied.push(`green screen (${color}) over the whole clip`);
  } else if (/remove background|transparent/i.test(low)) {
    dec.bgReplace = { color: "#000000", fps: 30, removeOnly: true };
    if (fs.existsSync(path.join(d, "cutout", "index.json"))) await fsp.rm(path.join(d, "cutout"), { recursive: true, force: true });
    applied.push("background removed");
  }

  // ---- 2. b-roll / overlay / picture-in-picture
  if (!applied.length && /b.?roll|overlay|over my head|over the head|picture.?in.?picture|\bpip\b/i.test(low)) {
    const stNow = JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8"));
    const files = stNow.brollFiles || [];
    const inset = /head|inset|picture.?in.?picture|\bpip\b/i.test(low);
    if (files.length) {
      dec.broll = dec.broll || [];
      dec.broll.push({ clip: files[dec.broll.length % files.length], tlStart: t0, dur: Math.min(4, Math.max(1.6, t1 - t0)), style: inset ? "inset" : "cover" });
      applied.push(`b-roll ${inset ? "inset" : "full"} at ${t0.toFixed(1)}s`);
    } else {
      // no clip uploaded → a styled chip carrying the request as an on-screen label
      const label = m(/label\s*[:\-]\s*["“']?(.{2,24})/) || "🎬";
      dec.motion = dec.motion || [];
      dec.motion.push({ type: "chip", t: t0, dur: Math.max(1.8, t1 - t0), text: label, x: 0.5, y: 0.12, color: "#ffffff" });
      applied.push(`no b-roll clips in this job — added an on-screen label instead (upload b-roll in setup for real clips)`);
    }
  }

  // ---- 3. motion graphics
  if (!applied.length && /burst|sparkle|particle|confetti|pop effect/i.test(low)) {
    dec.motion = dec.motion || [];
    dec.motion.push({ type: "burst", t: t0, dur: Math.min(1.6, Math.max(0.8, t1 - t0)), color: "#ffd60a", x: 0.5, y: 0.4 });
    applied.push(`motion burst at ${t0.toFixed(1)}s`);
  } else if (!applied.length && /pulse|ring|echo|wave/i.test(low)) {
    dec.motion = dec.motion || [];
    dec.motion.push({ type: "pulse", t: t0, dur: Math.min(1.4, Math.max(0.8, t1 - t0)), color: "#22d3ee", x: 0.5, y: 0.5 });
    applied.push(`pulse rings at ${t0.toFixed(1)}s`);
  } else if (!applied.length && /sweep|underline|line (?:sweeps|goes)|highlight (?:line|bar)/i.test(low)) {
    dec.motion = dec.motion || [];
    dec.motion.push({ type: "sweep", t: t0, dur: Math.min(1.2, Math.max(0.6, t1 - t0)), color: "#ffd60a", y: 0.805 });
    applied.push(`sweep line at ${t0.toFixed(1)}s`);
  } else if (!applied.length && /motion graphic|motion effect|animation|animated/i.test(low)) {
    dec.motion = dec.motion || [];
    dec.motion.push({ type: "burst", t: t0, dur: 1.2, color: "#22d3ee", x: 0.5, y: 0.35 });
    dec.motion.push({ type: "pulse", t: t0 + 0.25, dur: 1.0, color: "#ffd60a", x: 0.5, y: 0.5 });
    applied.push(`motion combo (burst + pulse) at ${t0.toFixed(1)}s`);
  } else if (!applied.length && /(chip|label|sticker|badge)\s*[:\-]?\s*(.{2,24})?/i.test(low)) {
    const label = m(/(?:chip|label|sticker|badge)\s*[:\-]?\s*["“']?(.{2,24})/) || "🔥";
    dec.motion = dec.motion || [];
    dec.motion.push({ type: "chip", t: t0, dur: Math.max(1.8, t1 - t0), text: label, x: 0.5, y: 0.12 });
    applied.push(`label chip “${label}” at ${t0.toFixed(1)}s`);
  }

  // ---- 4. zoom
  if (!applied.length && /zoom|punch|closer|tight(er)?|in closer/i.test(low)) {
    const hit = await segAt((t0 + t1) / 2);
    if (hit && hit.wi >= 0) {
      dec.zoomAtWords = dec.zoomAtWords || [];
      if (!dec.zoomAtWords.includes(hit.wi)) dec.zoomAtWords.push(hit.wi);
      applied.push(`punch-in zoom on that moment`);
    } else note = "couldn't find a word at that time — zoom skipped";
  }

  // ---- 5. cut / remove
  if (!applied.length && tr && /\b(cut|remove|delete|drop|trim)\b/i.test(low)) {
    const cut = [];
    for (const w of tr.words) if (w.start >= t0 - 0.15 && w.start <= t1 + 0.15) cut.push(tr.words.indexOf(w));
    if (cut.length) {
      dec.extraCutWords = dec.extraCutWords || [];
      for (const i of cut) if (!dec.extraCutWords.includes(i)) dec.extraCutWords.push(i);
      applied.push(`cut ${cut.length} word(s) in that range`);
    } else note = "no words found in that range — nothing cut";
  }

  // ---- 6. hook
  if (!applied.length && /hook/i.test(low)) {
    const text = m(/hook\s*[:\-]\s*["“']?(.{4,80})/) || m(/new hook\s*[:\-]?\s*["“']?(.{4,80})/);
    if (text) { dec.hook = { text }; applied.push(`hook → “${text}”`); }
    else note = "tell me the hook text, e.g. `hook: Stop doing this`";
  }

  // ---- 7. cta
  if (!applied.length && /\b(cta|call to action|follow)\b/i.test(low)) {
    const text = m(/(?:cta|call to action)\s*[:\-]\s*["“']?(.{4,60})/) || m(/follow\s*[:\-]\s*["“']?(.{4,60})/);
    if (text) { dec.cta = { text }; applied.push(`CTA → “${text}”`); }
    else { dec.cta = { text: "Follow for more" }; applied.push("CTA → “Follow for more”"); }
  }

  // ---- 8. watermark / handle
  if (!applied.length && /watermark|\blogo\b|handle|@\w{3,}/.test(low)) {
    const text = m(/(?:watermark|logo|handle)\s*[:\-]?\s*["“']?(@?[\w.\-]{3,30})/) || (ins.match(/@[\w.\-]{3,30}/) || [null])[0];
    if (text) { dec.watermark = { text: text.startsWith("@") ? text : "@" + text }; applied.push(`watermark “${dec.watermark.text}” (top-left)`); }
    else note = "give me the handle, e.g. `watermark @yourhandle`";
  }

  // ---- 9. captions
  if (!applied.length && /caption|subtitle/i.test(low)) {
    if (/\b(off|hide|remove|no)\b/i.test(low)) { dec.captionsOff = true; applied.push("captions hidden"); }
    else { dec.captionsOff = false; applied.push("captions shown"); }
  }

  // ---- 10. volume
  if (!applied.length && /quieter|louder|volume|softer/i.test(low)) {
    dec.audioVolume = /quieter|softer/i.test(low) ? 0.75 : 1.25;
    applied.push(`voice volume → ${dec.audioVolume}`);
  }

  if (!applied.length && !note) note = "I couldn't match that to an edit — saved it for review";
  r.status = note && !applied.length ? "needs-review" : "applied";
  r.result = applied.join(" · ") || note;
  results.push(r);
}

await fsp.writeFile(path.join(d, "decisions.json"), JSON.stringify(dec, null, 2));
await fsp.writeFile(reqFile, JSON.stringify(reqs, null, 2));
const n = results.filter(r => r.status === "applied").length;
await report(id, "analyze", "done", `AI edits: ${n} applied${results.length - n ? `, ${results.length - n} flagged` : ""}`);
console.log(JSON.stringify({ pending: pending.length, applied: n, flagged: results.length - n }));
process.exit(0);
