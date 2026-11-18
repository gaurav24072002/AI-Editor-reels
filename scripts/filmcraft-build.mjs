#!/usr/bin/env node
/*
 * filmcraft-build.mjs — (re)build a job's FilmCraft project from its plan.
 *
 * Reads plan.json / transcript.json / decisions.json / state.json and builds
 * in ONE engine session (separate CLI invocations don't see each other's
 * changes — the last save wins):
 *
 *   newProject → newSequence (aspect+fps) → import base media →
 *   one clip per kept segment (timeline.place with sourceIn/duration, so
 *   FilmCraft holds the SAME cut list as the studio) → plan effects
 *   (Lumetri grade, zooms, hook/CTA/watermark/captions as Simple Text,
 *   sfx on A2, b-roll on V2, voice volume) → manifest the UI reads.
 *
 * Usage: node scripts/filmcraft-build.mjs <jobId>
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  fcDir, fcFramesDir, fcManifestFile, fcSequenceFile,
  fcSession, fcRenderFrame,
  jobDir, report, clipAtTime, wordsInRange, readJson, writeJson, fcSetBuildStatus,
} from "./fc-lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const plan = (await readJson(path.join(d, "plan.json"))) || {};
const st = (await readJson(path.join(d, "state.json"))) || {};
const tr = (await readJson(path.join(d, "transcript.json"))) || { words: [] };
const dec = (await readJson(path.join(d, "decisions.json"))) || {};

const aspect = st.aspect || plan.aspect || "9:16";
const [W, H] = aspect === "16:9" ? [1920, 1080] : [1080, 1920];

// ---------- timeline (single source of truth: PlanLib, same as the studio) ----------
const cuts = new Set((dec.extraCutWords || []).concat(plan.cuts?.words || []).flat());
for (const r of plan.cuts?.ranges || []) for (let i = r[0]; i <= r[1]; i++) cuts.add(i);
try { const sil = JSON.parse(await fsp.readFile(path.join(d, "silence_cuts.json"), "utf8")); for (const i of sil) if (!new Set(dec.excludeSilence || []).has(i)) cuts.add(i); } catch { }
try { const fil = JSON.parse(await fsp.readFile(path.join(d, "filler_cuts.json"), "utf8")); for (const i of fil) if (!new Set(dec.excludeFillers || []).has(i)) cuts.add(i); } catch { }

const mod = await import("../public/planlib.js");
const PlanLib = (mod.default && mod.default.deriveAll) ? mod.default : mod;
const layout = PlanLib.deriveAll(tr.words || [], { cuts: { words: [...cuts] }, aspect });
const segs = layout.segments || [];
if (!segs.length) { console.error("[fc-build] no segments — is there a transcript?"); process.exit(1); }
const duration = layout.duration || segs[segs.length - 1].tlEnd;

const mediaFiles = await fsp.readdir(path.join(d, "media")).catch(() => []);
const baseName = mediaFiles.find(f => /^base\./.test(f));
const baseFile = baseName ? path.join(d, "media", baseName) : null;
if (!baseFile) { console.error("[fc-build] no base media in job"); process.exit(1); }

await fcSetBuildStatus(d, "building");
await report(id, "filmcraft-build", "running", "building FilmCraft project…");
const log = [];
const step = (s) => { log.push(s); console.log("[fc-build] " + s); };

const clips = [];
const s = fcSession(d, { newProject: true });
try {
  // ---------- project + sequence + media (one session) ----------
  let r = await s.run("file.newProject", {});
  if (!r.ok) throw new Error("newProject: " + (r.error || r.text));
  r = await s.run("file.newSequence", { name: "11 Second Edit", width: W, height: H, fps: 30, video: 2, audio: 2 });
  if (!r.ok) throw new Error("newSequence: " + (r.error || r.text));
  step(`sequence ${W}x${H}@30 (V1 V2 A1 A2)`);

  r = await s.import(baseFile);
  const items = r.result?.items || [];
  if (!r.ok || !items.length) throw new Error("import: " + (r.error || r.text));
  const mediaItem = items[0];
  step(`imported ${baseName} (item ${mediaItem})`);

  // ---------- one clip per segment ----------
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const dur = Math.max(0.2, seg.srcEnd - seg.srcStart);
    // NOTE: `time` takes a raw ticks value; `seconds` is a TOP-LEVEL key
    // ({seconds: n} as the value is ignored → clip silently lands at t=0
    // and overwrites its neighbours). sourceIn/duration DO take {seconds: n}.
    const pr = await s.run("timeline.place", {
      item: mediaItem, track: "V1",
      seconds: seg.tlStart, sourceIn: { seconds: seg.srcStart }, duration: { seconds: dur },
      insert: false,
    });
    const ids = pr.result?.clips || pr.result?.items || [];
    if (!pr.ok || !ids.length) throw new Error(`place segment ${i}: ${pr.error || pr.text}`);
    const [v, a] = ids;
    const words = wordsInRange(tr.words || [], seg.srcStart, seg.srcEnd, 9);
    clips.push({ i, v, a: a != null ? a : v, tlStart: seg.tlStart, tlEnd: seg.tlEnd, srcStart: seg.srcStart, srcEnd: seg.srcEnd, label: words.join(" ") || `clip ${i + 1}` });
  }
  step(`${clips.length} clip(s) on V1, audio on A1`);
  const allV = clips.map(c => c.v);

  // ---------- effects (one batch) ----------
  const lines = [];
  const C = plan.color || {};
  const ZOOM = { Subtle: 108, Medium: 118, Strong: 130 }[st.settings?.zooms?.strength || "Medium"] || 118;

  // Lumetri grade on every clip
  lines.push({ id: "effects.apply", params: { clips: allV, effect: "lumetri" } });
  for (const c of clips) {
    const push = (p, v) => { if (Number.isFinite(v) && Math.abs(v) >= 0.5) lines.push({ id: "effects.setParam", params: { clip: c.v, effect: "lumetri", param: p, value: Math.round(v) } }); };
    push("exposure", (Number(C.brightness) - 1) * 60);
    push("contrast", (Number(C.contrast) - 1) * 80);
    push("saturation", (Number(C.saturation) - 1) * 120);
    push("temperature", 6);
    push("shadows", (Number(C.brightness) - 1) * 20);
    push("highlights", (Number(C.brightness) - 1) * 10);
  }

  // zooms
  for (const t of plan.zooms || []) {
    const c = clipAtTime(clips, Number(t));
    if (c) lines.push({ id: "effects.setParam", params: { clip: c.v, effect: "motion", param: "scale", value: ZOOM } });
  }

  const putText = (clip, txt, { size = 60, pos = [W / 2, Math.round(H * 0.2)], align = "Center", color = null } = {}) => {
    lines.push({ id: "effects.apply", params: { clips: [clip.v], effect: "simple_text" } });
    lines.push({ id: "effects.setParam", params: { clip: clip.v, effect: "simple_text", param: "text", value: txt } });
    lines.push({ id: "effects.setParam", params: { clip: clip.v, effect: "simple_text", param: "size", value: size } });
    lines.push({ id: "effects.setParam", params: { clip: clip.v, effect: "simple_text", param: "alignment", value: align } });
    lines.push({ id: "effects.setParam", params: { clip: clip.v, effect: "simple_text", param: "position", value: pos } });
    if (color) lines.push({ id: "effects.setParam", params: { clip: clip.v, effect: "simple_text", param: "color", value: color } });
  };

  if (plan.hook?.text) {
    putText(clips[0], String(plan.hook.text), { size: 78, pos: [W / 2, Math.round(H * 0.18)], color: plan.hook.color || null });
    step(`hook “${plan.hook.text}”`);
  }
  if (plan.cta?.text) {
    putText(clips[clips.length - 1], String(plan.cta.text), { size: 64, pos: [W / 2, Math.round(H * 0.78)] });
    step(`cta “${plan.cta.text}”`);
  }
  const wmText = plan.watermark?.text || dec.watermark?.text;
  if (wmText) putText(clips[0], String(wmText), { size: 36, pos: [Math.round(W * 0.18), Math.round(H * 0.06)], align: "Left" });

  const captionsOff = dec.captionsOff === true || plan.captions?.enabled === false;
  if (!captionsOff) {
    for (const c of clips) {
      const words = wordsInRange(tr.words || [], c.srcStart, c.srcEnd, 8);
      if (words.length) putText(c, words.join(" "), { size: 44, pos: [W / 2, Math.round(H * 0.88)] });
    }
    step("captions on clips");
  }

  // sfx → A2
  let sfxCount = 0;
  for (const sx of plan.sfx?.clips || dec.sfx?.clips || []) {
    const rel = String(sx.file || "").replace(/^\/api\/jobs\/[^/]+\//, "").replace(/^media\//, "");
    const f = path.join(d, decodeURIComponent(rel));
    if (!fs.existsSync(f)) continue;
    const ir = await s.import(f);
    const item = ir.result?.items?.[0];
    if (item == null) continue;
    const pr = await s.run("timeline.place", { item, track: "A2", seconds: Number(sx.t) || 0, insert: false });
    const aid = (pr.result?.clips || pr.result?.items || [])[0];
    if (aid != null && Number.isFinite(Number(sx.vol)) && Number(sx.vol) < 0.999)
      lines.push({ id: "clip.audioGain", params: { clips: [aid], mode: "set", db: Math.round(20 * Math.log10(Number(sx.vol))) } });
    if (pr.ok) sfxCount++;
  }
  if (sfxCount) step(`${sfxCount} sfx on A2`);

  // b-roll → V2
  let brollCount = 0;
  for (const b of plan.broll || dec.broll || []) {
    const f = path.join(d, "media", path.basename(String(b.clip || "")));
    if (!fs.existsSync(f)) continue;
    const ir = await s.import(f);
    const item = ir.result?.items?.[0];
    if (item == null) continue;
    const pr = await s.run("timeline.place", { item, track: "V2", seconds: Number(b.tlStart) || 0, duration: { seconds: Number(b.dur) || 2 }, insert: false });
    if (pr.ok) brollCount++;
  }
  if (brollCount) step(`${brollCount} b-roll clip(s) on V2`);

  // voice volume
  const vol = Number(plan.audio?.volume ?? dec.audioVolume ?? 1);
  if (Number.isFinite(vol) && Math.abs(vol - 1) > 0.01)
    for (const c of clips) if (c.a) lines.push({ id: "clip.audioGain", params: { clips: [c.a], mode: "set", db: Math.round(20 * Math.log10(vol)) } });

  if (lines.length) {
    const br = await s.batch(lines, { stopOnError: false }, 120000);
    if (!br.ok) step(`batch: ${br.error || br.text}`);
    else {
      const bad = Array.isArray(br.result) ? br.result.filter(x => x && (x.error || x.failed || x.ok === false)) : [];
      step(bad.length ? `applied ${lines.length} effect cmds (${bad.length} flagged)` : `applied ${lines.length} effect cmds`);
    }
  }

  // sequence cache (from the live session)
  const seq = await s.inspect("sequence");
  const seqJson = seq.result?.sequence || seq.result || null;
  if (seqJson) await writeJson(fcSequenceFile(d), seqJson);

  // persist BEFORE the process exits
  const sv = await s.save(60000);
  if (!sv.ok) throw new Error("save: " + (sv.error || sv.text));
  step("project saved");
} catch (e) {
  s.close();
  await fcSetBuildStatus(d, "failed", { error: String(e.message || e) });
  await report(id, "filmcraft-build", "failed", String(e.message || e));
  console.error("[fc-build] FAILED:", e.message);
  process.exit(1);
}
s.close();

// ---------- after save: manifest + verification frame ----------
try {
  const manifest = { id, aspect, width: W, height: H, duration, builtAt: new Date().toISOString(), clips, log };
  await writeJson(fcManifestFile(d), manifest);
  const t = Math.min(1, Math.max(0, duration / 2));
  const fr = await fcRenderFrame(d, t, path.join(fcFramesDir(d), "build.png"));
  step(fr.code === 0 ? `verification frame @ ${t.toFixed(1)}s ok` : `frame render: ${fr.err || fr.out}`);
  await fcSetBuildStatus(d, "done", { clips: clips.length, duration });
  await report(id, "filmcraft-build", "done", log.join(" · ").slice(0, 300));
  console.log(JSON.stringify({ ok: true, clips: clips.length, duration }));
  process.exit(0); // don't wait on any lingering engine handles
} catch (e) {
  await fcSetBuildStatus(d, "failed", { error: String(e.message || e) });
  console.error("[fc-build] post-save FAILED:", e.message);
  process.exit(1);
}
