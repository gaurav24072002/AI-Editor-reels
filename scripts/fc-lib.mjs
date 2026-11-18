/*
 * fc-lib.mjs — thin wrapper around filmcraft-cli for the 11 Second Edit app.
 *
 * Every job gets its own FilmCraft project at jobs/<id>/filmcraft/project.fcproj.
 * Commands run headless: `filmcraft-cli --project <p> --save exec <id> <params>`.
 * State never leaves the job dir; the original media is only ever read
 * (it lives in jobs/<id>/media/ and is never modified).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { findBinary, run, jobDir, report } from "./lib.mjs";

export const FC = () =>
  process.env.FILMCRRAFT_PATH ||
  findBinary("filmcraft-cli", ["/home/gaurav/.local/bin/filmcraft-cli"]) ||
  "filmcraft-cli";

export const fcDir = (d) => path.join(d, "filmcraft");
export const fcProjectPath = (d) => path.join(fcDir(d), "project.fcproj");
export const fcFramesDir = (d) => path.join(fcDir(d), "frames");
export const fcBuildStatusFile = (d) => path.join(d, "filmcraft-build.json");
export const fcAiQueueFile = (d) => path.join(d, "filmcraft-ai.json");
export const fcExportStatusFile = (d) => path.join(d, "filmcraft-export.json");
export const fcManifestFile = (d) => path.join(fcDir(d), "manifest.json");
export const fcSequenceFile = (d) => path.join(fcDir(d), "sequence.json");

const TSPS = 254016000000;
export { TSPS };

async function readJson(f, fallback = null) {
  try { return JSON.parse(await fsp.readFile(f, "utf8")); } catch { return fallback; }
}

async function writeJson(f, obj) {
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, JSON.stringify(obj, null, 2));
}

export { readJson, writeJson };

/** Run filmcraft-cli with any args; returns {code, out, err}. */
export async function fc(d, args, { timeout = 10 * 60 * 1000 } = {}) {
  const r = await run(FC(), args, { timeout });
  return { code: r.code, out: String(r.out || "").trim(), err: String(r.err || "").trim() };
}

/** Parse the first JSON value in a CLI stdout blob (errors print before/after JSON). */
export function parseCliJson(out) {
  if (!out) return null;
  for (const m of out.matchAll(/[\{\[]/g)) {
    const s = m.index;
    for (let e = out.length; e > s; e--) {
      try { return JSON.parse(out.slice(s, e)); } catch { /* shrink until it parses */ }
    }
  }
  return null;
}

/** exec <id> with params (object or pre-serialized JSON string), saving after. */
export async function fcExec(d, id, params = {}) {
  const argStr = typeof params === "string" ? params : JSON.stringify(params);
  const r = await fc(d, ["--project", fcProjectPath(d), "--save", "exec", id, argStr]);
  r.result = parseCliJson(r.out);
  return r;
}

/** Run a batch of {id,params} lines in ONE process (keeps undo coherent). */
export async function fcRunLines(d, lines, { timeout = 10 * 60 * 1000 } = {}) {
  const file = path.join(fcDir(d), `batch-${Date.now()}-${Math.floor(Math.random() * 1e5)}.jsonl`);
  await fsp.mkdir(fcDir(d), { recursive: true });
  await fsp.writeFile(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  const r = await fc(d, ["--project", fcProjectPath(d), "--save", "--keep-going", "--compact", "run", file], { timeout });
  await fsp.rm(file, { force: true }).catch(() => {});
  r.results = r.out.split("\n").map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return r;
}

export async function fcImport(d, file) {
  const r = await fc(d, ["--project", fcProjectPath(d), "--save", "import", file]);
  const j = parseCliJson(r.out) || {};
  r.items = Array.isArray(j.items) ? j.items : (j.item != null ? [j.item] : []);
  r.errors = j.errors || [];
  return r;
}

export async function fcInspect(d, what = "sequence") {
  const r = await fc(d, ["--project", fcProjectPath(d), "inspect", what]);
  r.result = parseCliJson(r.out);
  return r;
}

export async function fcRenderFrame(d, tSec, outPng, { scale = 1 } = {}) {
  await fsp.mkdir(path.dirname(outPng), { recursive: true });
  const args = ["--project", fcProjectPath(d), "render", "--seconds", String(tSec), "--out", outPng];
  if (scale < 1) args.push("--scale", String(scale));
  args.push("--allow-offline");
  return fc(d, args, { timeout: 2 * 60 * 1000 });
}

/** Fresh empty project at the job's fcproj path. */
export async function fcNewProject(d) {
  await fsp.rm(fcDir(d), { recursive: true, force: true });
  await fsp.mkdir(fcDir(d), { recursive: true });
  const r = await fc(d, ["--save-as", fcProjectPath(d), "exec", "file.newProject"]);
  if (r.code !== 0) r.err = (r.err || "") + " " + r.out;
  return r;
}

export async function fcStatus(d, kind) {
  const file = { build: fcBuildStatusFile, ai: fcAiQueueFile, export: fcExportStatusFile }[kind];
  return readJson(file ? file(d) : null);
}

export async function fcSetBuildStatus(d, state, extra = {}) {
  await writeJson(fcBuildStatusFile(d), { state, at: new Date().toISOString(), ...extra });
}

export async function fcSetExportStatus(d, state, extra = {}) {
  await writeJson(fcExportStatusFile(d), { state, at: new Date().toISOString(), ...extra });
}

/** Re-inspect the sequence and cache it for the UI. */
export async function refreshSequence(d) {
  const r = await fcInspect(d, "sequence");
  if (r.result) {
    const s = r.result.sequence || r.result;
    await writeJson(fcSequenceFile(d), s);
    return s;
  }
  return null;
}

/**
 * Map a timeline time (seconds) to a manifest clip {v, a, i, ...}.
 * clips: manifest clips sorted by tlStart.
 */
export function clipAtTime(clips, t) {
  return clips.find(c => t >= c.tlStart - 0.001 && t < c.tlEnd) || clips.find(c => t >= c.tlStart) || null;
}

/** Words of a clip (kept words whose source time falls in the clip's src range). */
export function wordsInRange(words, srcStart, srcEnd, max = 10) {
  const ws = words.filter(w => w.start >= srcStart - 0.001 && w.start <= srcEnd + 0.001);
  return ws.slice(0, max).map(w => w.text || w.word || "");
}

export { jobDir, report };

/* ================================================================== *
 * fcSession — ONE long-lived engine process for a burst of commands.
 *
 * IMPORTANT: separate `filmcraft-cli --save exec …` invocations do NOT see
 * each other's changes (each process edits a stale snapshot; the last save
 * wins). So any multi-command sequence — build, AI edit — must run inside a
 * single `filmcraft-cli --project … --save mcp` session. Rendering frames
 * (read-only) and single param tweaks are safe as one-shot execs.
 * ================================================================== */
export function fcSession(d, { newProject = false, timeout = 30000 } = {}) {
  const P = fcProjectPath(d);
  fs.mkdirSync(fcDir(d), { recursive: true }); // saveAs needs the dir to exist
  const args = newProject ? ["mcp"] : ["--project", P, "mcp"];
  const child = spawn(FC(), args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "", closed = false;
  const pending = new Map();
  child.stdout.on("data", (data) => {
    buf += data.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  child.on("close", () => { closed = true; for (const r of pending.values()) r({ id: -1, error: { message: "engine exited" } }); pending.clear(); });

  const send = (obj, ms = timeout) => new Promise((resolve, reject) => {
    const method = obj.method || "";
    // client→server notifications carry no id and get no response;
    // requests get a generated id and wait for the matching response.
    if (obj.id !== undefined || method.startsWith("notifications/")) {
      child.stdin.write(JSON.stringify(obj) + "\n"); resolve(); return;
    }
    const id = Math.floor(Math.random() * 1e9);
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ ...obj, id }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("mcp timeout: " + method)); } }, ms);
  });

  let ready = null;
  try {
    ready = (async () => {
      await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "11-second-edit", version: "1.0" } } });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
  } catch (e) { /* send never throws synchronously */ }

  async function call(name, args2 = {}, ms = timeout) {
    await ready;
    let r;
    try {
      r = await send({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args2 } }, ms);
    } catch (e) {
      return { ok: false, error: String(e.message || e), text: "" };
    }
    if (!r) return { ok: false, error: "no response", text: "" };
    if (r.error) return { ok: false, error: r.error.message, text: "" };
    const content = r.result?.content || [];
    const text = content.map(c => c.text || "").join("");
    let result = null; try { result = JSON.parse(text); } catch { result = text; }
    return { ok: !r.result?.isError, isError: !!r.result?.isError, result, text };
  }

  return {
    /** run one command; {ok, result, text} */
    run: (id, params = {}, ms) => call("command_run", { id, params }, ms),
    /** run many commands in order (one undo step); stopOnError default true */
    batch: (steps, { stopOnError = false } = {}, ms) => call("command_batch", { steps, stop_on_error: stopOnError }, ms),
    /** import files → {ok, result:{items:[…], errors:[…]}} */
    import: (file) => call("media_import", { paths: [file] }),
    /** persist the project (newProject → saveAs the job path). Both are
        engine commands, so they go through command_run — there is no
        top-level "file.save" MCP tool. */
    save: (ms) => call("command_run", { id: newProject ? "file.saveAs" : "file.save", params: newProject ? { path: P } : {} }, ms),
    inspect: (what = "sequence") => call(what === "project" ? "project_inspect" : "sequence_inspect", {}),
    stderr: () => stderr,
    close: () => { if (!closed) { try { child.stdin.end(); } catch { } setTimeout(() => { if (!closed) child.kill(); }, 1500).unref(); } },
  };
}

/* ================================================================== *
 * NLE layer — everything the Premiere-style web editor drives.
 *
 * Two sources of truth, chosen deliberately:
 *   - readFcState(d)  → the SAVED .fcproj file. Pure file read, no engine,
 *     and the ONLY place the full keyframe arrays are available (the
 *     sequence_inspect tool reports a keyframe COUNT, not the list).
 *   - fcSession       → a live engine process, used to APPLY edits.
 *
 * Undo/redo: the engine's undo stack is per-session (a fresh session has
 * "nothing to undo" — verified), so we keep our own snapshot stack of the
 * saved .fcproj. One snapshot is taken before each mutating op.
 * ================================================================== */

const SNAPS_DIR = (d) => path.join(fcDir(d), "undo");
const SNAPS_META = (d) => path.join(fcDir(d), "undo.json");
const SNAPS_CAP = 40;

/** Decode a FilmCraft tagged value ({Float:..},{Vec2:{x,y}},{Color:[..]},…). */
export function fcDecodeVal(v) {
  if (v == null) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(fcDecodeVal);
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const k = keys[0], val = v[k];
    switch (k) {
      case "Float": case "Int": case "Bool": case "Text": case "Choice":
      case "Color": case "Curve": case "Path": case "String": case "Number":
        return val;
      case "Vec2": return { x: val.x, y: val.y };
      default: return { [k]: fcDecodeVal(val) };
    }
  }
  const out = {};
  for (const k of keys) out[k] = fcDecodeVal(v[k]);
  return out;
}

function normFcParam(p) {
  if (!p || typeof p !== "object") return { value: fcDecodeVal(p) };
  if (Array.isArray(p.keyframes) && p.keyframes.length) {
    return {
      keyframes: p.keyframes.map((kf) => ({
        t: kf.time / TSPS, v: fcDecodeVal(kf.value), // clip-relative seconds
        interp: kf.interp || kf.interpolation || "Linear",
        in: kf.in_influence ?? kf.inInfluence ?? 0.333,
        out: kf.out_influence ?? kf.outInfluence ?? 0.333,
      })),
    };
  }
  if ("value" in p) return { value: fcDecodeVal(p.value) };
  return fcDecodeVal(p);
}

const trackAlias = (name, kind) => {
  const m = /\d+/.exec(name || "");
  return m ? `${kind === "audio" ? "A" : "V"}${m[0]}` : null;
};

function normFcClip(c) {
  return {
    id: c.id, item: c.item, name: c.name,
    start: (c.start || 0) / TSPS, dur: (c.duration || 0) / TSPS, sourceIn: (c.source_in || 0) / TSPS,
    speed: c.speed ?? 1, reverse: !!c.reverse, enabled: c.enabled !== false,
    gainDb: c.gain_db ?? 0, label: c.label || null, link: c.link ?? null,
    effects: (c.effects || []).map((e, i) => ({
      index: i, effect: e.effect, enabled: e.enabled !== false,
      params: Object.fromEntries(Object.entries(e.params || {}).map(([k, v]) => [k, normFcParam(v)])),
    })),
  };
}
function normFcTrack(t, kind) {
  return {
    name: t.name, alias: trackAlias(t.name, kind), id: t.id,
    enabled: t.enabled !== false, muted: !!t.muted, solo: !!t.solo,
    locked: !!t.locked, syncLock: !!t.sync_lock ?? !!t.syncLock,
    volumeDb: t.volume_db ?? 0, pan: t.pan ?? 0,
    clips: (t.items || []).map(normFcClip),
  };
}

/** The whole NLE state from the saved .fcproj — media bin, sequences,
 *  active sequence with full keyframe data. No engine process needed. */
export async function readFcState(d) {
  const p = fcProjectPath(d);
  if (!fs.existsSync(p)) return { ok: false, error: "no FilmCraft project yet (run build first)" };
  let doc;
  try { doc = JSON.parse(await fsp.readFile(p, "utf8")); }
  catch (e) { return { ok: false, error: "cannot read project: " + e.message }; }
  const items = doc?.project?.items || {};
  const view = doc?.view || {};
  const media = [], sequences = [];
  for (const [id, v] of Object.entries(items)) {
    const kind = Object.keys(v?.kind || {})[0];
    if (kind === "Media") {
      const m = v.kind.Media;
      const info = m?.info || {};
      media.push({
        id: Number(id), name: v.name || info.name || "media", kind: info.kind || "?",
        dur: info.duration ? info.duration / TSPS : 0,
        w: info.video?.width || 0, h: info.video?.height || 0,
        fps: info.video?.frame_rate ? info.video.frame_rate.num / (info.video.frame_rate.den || 1) : 0,
        path: m?.media?.File?.path || null,
      });
    } else if (kind === "Sequence") {
      const s = v.kind.Sequence;
      const st = s?.settings || {};
      sequences.push({
        id: Number(id), name: v.name || `Sequence ${id}`,
        w: st.width || 0, h: st.height || 0,
        fps: st.frame_rate ? st.frame_rate.num / (st.frame_rate.den || 1) : 30,
      });
    }
  }
  media.sort((a, b) => a.name.localeCompare(b.name));
  const activeId = Number(view.active_sequence);
  const active = items[String(activeId)]?.kind?.Sequence || null;
  let sequence = null;
  if (active) {
    let dur = 0;
    const vt = (active.video_tracks || []).map(t => normFcTrack(t, "video"));
    const at = (active.audio_tracks || []).map(t => normFcTrack(t, "audio"));
    for (const t of [...vt, ...at]) for (const c of t.clips) dur = Math.max(dur, c.start + c.dur);
    const st = active.settings || {};
    sequence = {
      id: activeId, name: items[String(activeId)].name, w: st.width || 0, h: st.height || 0,
      fps: st.frame_rate ? st.frame_rate.num / (st.frame_rate.den || 1) : 30,
      dur, // c.start/c.dur are already seconds (normFcTrack divides ticks)
      playhead: ((view.playheads?.[String(activeId)] ?? active.playhead) || 0) / TSPS,
      masterVolumeDb: active.master_volume_db ?? 0,
      video: vt, audio: at,
    };
  }
  return { ok: true, active: activeId, open: (view.open_sequences || []).map(Number), media, sequences, sequence };
}

/** Alias list for the audio tracks (A1..An) — needed to release sync locks. */
async function audioAliases(d) {
  const s = await readFcState(d);
  return (s.sequence?.audio || []).map(t => t.alias).filter(Boolean);
}

const SYNC_ERR = /would break sync|sync-?lock/i;

/**
 * Run a list of engine commands in ONE session, saving after.
 * steps: [{id, params}]  — executed in order; failures are reported, not fatal.
 * ripple: true → pre-release sync locks on audio tracks (and retry a
 *   sync-blocked step once after unlocking).
 * Returns {ok, results:[{id,ok,result,error}], error?}.
 */
export async function fcRunSteps(d, steps, { ripple = false } = {}) {
  if (!fs.existsSync(fcProjectPath(d))) return { ok: false, error: "no project to edit (run build first)" };
  const s = fcSession(d, { newProject: false });
  const results = [];
  let hardError = null;
  try {
    const doStep = async (st) => {
      const r = await s.run(st.id, st.params || {});
      const good = r.ok && !r.isError;
      return { id: st.id, ok: good, result: r.result ?? null, error: good ? null : (r.error || String(r.result) || "failed") };
    };
    const unlock = async () => {
      for (const alias of await audioAliases(d)) {
        await s.run("timeline.setTrack", { track: alias, syncLock: false });
      }
    };
    if (ripple) await unlock(); // cheap; avoids one guaranteed failure
    for (const st of steps) {
      let res = await doStep(st);
      if (!res.ok && SYNC_ERR.test(res.error || "") && ripple) {
        await unlock();
        res = await doStep(st);
      }
      results.push(res);
      if (!res.ok && !SYNC_ERR.test(res.error || "")) hardError = hardError || `${st.id}: ${res.error}`;
    }
    // Save if ANY step landed — a failed last step shouldn't drop the ones
    // that succeeded (e.g. import ok, place failed → media still in the bin).
    if (results.some(r => r.ok)) await s.save();
  } finally {
    s.close();
  }
  return { ok: !hardError, results, error: hardError || null };
}

/** Import one media file into the project (one session), return its item id. */
export async function fcImportOne(d, file) {
  if (!fs.existsSync(fcProjectPath(d))) return { ok: false, error: "no project (run build first)" };
  const s = fcSession(d, { newProject: false });
  try {
    const r = await s.import(file);
    const item = r.result?.items?.[0] ?? null;
    if (!r.ok || item == null) return { ok: false, error: r.error || String(r.result) || "import failed" };
    await s.save();
    return { ok: true, item };
  } finally { s.close(); }
}

/** Sequence management: new | open | close. */
export async function fcSeqOp(d, { action, item = null, name, width, height, fps, video, audio }) {
  if (!fs.existsSync(fcProjectPath(d)) && action !== "new") return { ok: false, error: "no project (run build first)" };
  const s = fcSession(d, { newProject: false });
  try {
    let r;
    if (action === "new") {
      r = await s.run("file.newSequence", {
        name: name || "Sequence", width: width || 1080, height: height || 1920,
        fps: fps || 30, video: video ?? 2, audio: audio ?? 2,
      });
      const id = r.result?.sequence ?? r.result?.id ?? null;
      if (!r.ok || id == null) return { ok: false, error: r.error || String(r.result) || "newSequence failed" };
      await s.run("sequence.open", { item: id });
      await s.save();
      return { ok: true, sequence: id };
    }
    if (action === "open") { r = await s.run("sequence.open", { item }); if (r.ok) await s.save(); }
    if (action === "close") { r = await s.run("sequence.close", { item }); if (r.ok) await s.save(); }
    return { ok: !!(r && r.ok), error: (r && !r.ok) ? (r.error || "failed") : null };
  } finally { s.close(); }
}

/* ---------- snapshot-based undo / redo ---------- */
async function readSnapMeta(d) {
  try { return JSON.parse(await fsp.readFile(SNAPS_META(d), "utf8")); } catch { return { undo: [], redo: [] }; }
}
async function writeSnapMeta(d, m) {
  await fsp.mkdir(SNAPS_DIR(d), { recursive: true });
  await fsp.writeFile(SNAPS_META(d), JSON.stringify(m));
}

/** Snapshot the current saved project onto the undo stack (call BEFORE a
 *  mutating op). Keeps the stack under SNAPS_CAP. */
export async function fcSnapshot(d, label) {
  const p = fcProjectPath(d);
  if (!fs.existsSync(p)) return;
  const m = await readSnapMeta(d);
  const size = fs.statSync(p).size;
  let total = m.undo.reduce((a, x) => a + (x.size || 0), 0) + size;
  while ((total > 60 * 1024 * 1024 || m.undo.length >= SNAPS_CAP) && m.undo.length) {
    const old = m.undo.shift(); // trim oldest first: bounded disk + count
    total -= old.size || 0;
    await fsp.rm(path.join(SNAPS_DIR(d), old.file), { force: true }).catch(() => {});
  }
  const file = `${Date.now()}-${Math.floor(Math.random() * 1e6)}.fcproj`;
  await fsp.mkdir(SNAPS_DIR(d), { recursive: true });
  await fsp.copyFile(p, path.join(SNAPS_DIR(d), file));
  m.undo.push({ file, at: Date.now(), label, size });
  m.redo = [];
  await writeSnapMeta(d, m);
}

async function swapBack(d, from, to) {
  const p = fcProjectPath(d);
  const snap = from.pop(); // newest snapshot (stack order)
  const tmpFile = `redo-${Date.now()}-${Math.floor(Math.random() * 1e5)}.fcproj`;
  try {
    await fsp.copyFile(p, path.join(SNAPS_DIR(d), tmpFile));
  } catch (e) {
    from.push(snap); // put the snapshot back — nothing was moved
    throw e;
  }
  to.push({ file: tmpFile, at: Date.now(), label: "pre-" + (snap.label || "op"), size: fs.statSync(p).size });
  try {
    await fsp.copyFile(path.join(SNAPS_DIR(d), snap.file), p);
    await fsp.rm(path.join(SNAPS_DIR(d), snap.file), { force: true }).catch(() => {});
  } catch (e) { // restore failed — roll everything back
    to.pop();
    from.push(snap);
    if (!fs.existsSync(p)) await fsp.copyFile(path.join(SNAPS_DIR(d), tmpFile), p);
    else await fsp.rm(path.join(SNAPS_DIR(d), tmpFile), { force: true }).catch(() => {});
    throw e;
  }
}

export async function fcUndo(d) {
  const m = await readSnapMeta(d);
  if (!m.undo.length) return { ok: false, error: "nothing to undo" };
  await swapBack(d, m.undo, m.redo);
  await writeSnapMeta(d, m);
  return { ok: true };
}
export async function fcRedo(d) {
  const m = await readSnapMeta(d);
  if (!m.redo.length) return { ok: false, error: "nothing to redo" };
  await swapBack(d, m.redo, m.undo);
  await writeSnapMeta(d, m);
  return { ok: true };
}
export async function fcUndoState(d) {
  const m = await readSnapMeta(d);
  return { ok: true, canUndo: m.undo.length > 0, canRedo: m.redo.length > 0, undo: m.undo.length, redo: m.redo.length };
}

/** Drop the most recent snapshot (used when an edit op applied nothing). */
export async function fcDropSnapshot(d) {
  const m = await readSnapMeta(d);
  const old = m.undo.pop();
  if (!old) return;
  await fsp.rm(path.join(SNAPS_DIR(d), old.file), { force: true }).catch(() => {});
  await writeSnapMeta(d, m);
}

/** Wipe the undo/redo stacks (e.g. after a rebuild replaces the project). */
export async function fcResetHistory(d) {
  const m = await readSnapMeta(d);
  for (const e of [...m.undo, ...m.redo]) {
    await fsp.rm(path.join(SNAPS_DIR(d), e.file), { force: true }).catch(() => {});
  }
  await writeSnapMeta(d, { undo: [], redo: [] });
}
