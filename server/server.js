#!/usr/bin/env node
/*
 * 11 Second Edit — local server.
 * Zero npm dependencies (node:http only). Serves the UI, the job API,
 * media for the composition, and the exported MP4.
 *
 * Rules honored here:
 *  - The original video is NEVER modified: it is hard-linked (or copied,
 *    as last resort) into jobs/<id>/media/ and only ever read.
 *  - API keys stay in the process environment, never in job files.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  readFcState, fcRunSteps, fcSnapshot, fcDropSnapshot, fcUndo, fcRedo, fcUndoState,
  fcResetHistory, fcImportOne, fcSeqOp, fcSession, TSPS,
} from "../scripts/fc-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const JOBS = path.join(ROOT, "jobs");
const PORT = Number(process.env.PORT || 8481);

fs.mkdirSync(JOBS, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || body instanceof Uint8Array;
  res.writeHead(code, Object.assign({ "Content-Length": isBuf ? body.length : Buffer.byteLength(String(body)) }, headers));
  res.end(isBuf ? body : String(body));
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj, null, 2), { "Content-Type": "application/json" }); }
function readBody(req) {
  return new Promise((res, rej) => {
    let d = "";
    req.on("data", c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on("end", () => res(d));
    req.on("error", rej);
  });
}
async function readJsonBody(req) {
  const d = await readBody(req);
  try { return JSON.parse(d || "{}"); } catch { return null; }
}
function safeJoin(base, p) {
  const rel = String(p).replace(/^\/+/, "");
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep) && full !== base) return null;
  return full;
}
async function jobDir(id) {
  if (!/^[a-z0-9-]{4,40}$/.test(id)) return null;
  const d = path.join(JOBS, id);
  if (fs.existsSync(path.join(d, "state.json"))) return d;
  return null;
}
async function loadState(d) { return JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8")); }
async function saveState(d, st) { await fsp.writeFile(path.join(d, "state.json"), JSON.stringify(st, null, 2)); }
async function setJobStatus(id, status) {
  const d = await jobDir(id); if (!d) return;
  const st = await loadState(d);
  st.status = status;
  st.updatedAt = new Date().toISOString();
  await saveState(d, st);
}

/* ================================================================== *
 * Automatic editor engine
 * Jobs run the full pipeline WITHOUT any Claude session. One worker per
 * job (serial queue), so a re-render can never clobber an in-flight run.
 * ================================================================== */
const workers = new Map(); // jobId -> { running, queue, pid }
function launchJob(id, mode) {
  let w = workers.get(id);
  if (!w) { w = { running: false, queue: [], pid: null }; workers.set(id, w); }
  if (w.running) {
    // A run is in flight. Allow exactly ONE queued follow-up (so an AI edit
    // applied mid-render gets picked up), but never let button-mashing pile
    // up a stack of redundant ~10-min re-renders.
    if (w.queue.length < 1) { w.queue.push(mode); console.log(JSON.stringify({ queued: id, mode })); }
    return;
  }
  const m = w.queue.length ? w.queue.shift() : mode;
  w.running = true;
  const logFile = path.join(JOBS, id, `auto-edit-${m}-${Date.now()}.log`);
  // Open the log fd and hand it straight to the child: the pipeline never
  // depends on the server staying alive (no EPIPE if the server restarts mid-render).
  const logFd = fs.openSync(logFile, "a");
  const pid = spawn(process.execPath, [path.join(ROOT, "scripts", "auto-edit.mjs"), id, m], {
    cwd: ROOT, stdio: ["ignore", logFd, logFd], detached: true,
  });
  pid.unref();
  fs.closeSync(logFd); // child inherited it; drop the server's copy
  w.pid = pid;
  console.log(JSON.stringify({ launched: id, mode: m, pid: pid.pid, log: logFile }));
  pid.on("exit", (code) => {
    w.running = false; w.pid = null;
    console.log(JSON.stringify({ finished: id, mode: m, code }));
    if (w.queue.length) launchJob(id, null); // next queued run
  });
}

/* FilmCraft editor workers: build / ai / export for a job share ONE engine
   lock — concurrent filmcraft processes don't see each other's changes, so
   only one may run per job at a time. */
const fcBusy = new Map(); // jobId -> true while a filmcraft-* script runs
function fcLaunch(id, script) {
  if (fcBusy.get(id)) return false;
  fcBusy.set(id, true);
  const logFile = path.join(JOBS, id, `filmcraft-${script}-${Date.now()}.log`);
  const logFd = fs.openSync(logFile, "a");
  const pid = spawn(process.execPath, [path.join(ROOT, "scripts", script + ".mjs"), id], {
    cwd: ROOT, stdio: ["ignore", logFd, logFd], detached: true,
  });
  pid.unref();
  fs.closeSync(logFd);
  pid.on("exit", () => {
    fcBusy.delete(id);
    console.log(JSON.stringify({ filmcraft: script, id, done: true }));
    // drain: an AI request queued while we were busy (409) now gets a worker
    fcDrain(id);
  });
  return true;
}
function fcDrain(id) {
  if (fcBusy.get(id)) return; // still busy — the next exit drains
  try {
    const f = path.join(JOBS, id, "filmcraft-ai.json");
    if (!fs.existsSync(f)) return;
    const reqs = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Array.isArray(reqs) && reqs.some(r => r.status === "pending")) fcLaunch(id, "filmcraft-ai");
  } catch { /* ignore */ }
}
const FC_BIN = () => process.env.FILMCRRAFT_PATH || "/home/gaurav/.local/bin/filmcraft-cli" || "filmcraft-cli";

/** Run an in-process FilmCraft op under the per-job engine lock.
 *  Refuses (409) while a worker (build/ai/export) holds the lock, and holds
 *  the lock itself so no worker can start mid-op. */
let fcFxCache = null; // effect catalog (server-lifetime cache)

async function withFcBusy(id, fn) {
  if (fcBusy.get(id)) {
    const e = new Error("a FilmCraft operation is already running for this job");
    e.status = 409;
    throw e;
  }
  fcBusy.set(id, true);
  try { return await fn(); }
  finally { fcBusy.delete(id); }
}

async function hardlinkOrCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) return;
  try {
    if (src.endsWith(".mp4") || src.endsWith(".mov") || src.endsWith(".webm") ||
        src.endsWith(".mp3") || src.endsWith(".wav") || src.endsWith(".m4a")) {
      fs.linkSync(src, dst); // instant, no extra disk, never touches the original
      return;
    }
  } catch { /* fall through to copy */ }
  await fsp.copyFile(src, dst);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    // ---------- job API ----------
    if (p === "/api/jobs" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body || !body.videoPath) return json(res, 400, { error: "videoPath required" });
      const vid = path.resolve(String(body.videoPath));
      if (!fs.existsSync(vid)) return json(res, 400, { error: "video file not found: " + vid });
      const id = "edit-" + crypto.randomBytes(4).toString("hex");
      const d = path.join(JOBS, id);
      fs.mkdirSync(path.join(d, "media"), { recursive: true });
      const broll = Array.isArray(body.brollPaths) ? body.brollPaths : [];
      // Never modify the original: hard-link (preferred) or copy into the job dir.
      await hardlinkOrCopy(vid, path.join(d, "media", "base" + path.extname(vid).toLowerCase() || ".mp4"));
      const brollFiles = [];
      for (let i = 0; i < broll.length; i++) {
        const src = path.resolve(String(broll[i]));
        if (!fs.existsSync(src)) continue;
        const ext = path.extname(src).toLowerCase() || ".mp4";
        const dst = path.join(d, "media", `b${i}${ext}`);
        await hardlinkOrCopy(src, dst);
        brollFiles.push(path.basename(dst));
      }
      const stepDefs = [
        ["transcribe", "Transcribe (WhisperX, word-level)"],
        ["analyze", "Analyze take (Claude: bad takes, false starts, hook, CTA)"],
      ];
      const feat = body.features || {};
      if (feat.removeSilences) stepDefs.push(["silences", "Remove silences"]);
      if (feat.removeFillers) stepDefs.push(["fillers", "Remove filler words"]);
      if (feat.removeBadTakes) stepDefs.push(["badtakes", "Remove bad takes & false starts"]);
      if (feat.enhanceAudio) stepDefs.push(["audio", "Enhance audio"]);
      if (feat.color) stepDefs.push(["color", "Auto color correction"]);
      if (feat.zooms) stepDefs.push(["zooms", "Add zoom cuts"]);
      if (feat.broll) stepDefs.push(["broll", "Place b-roll"]);
      if (feat.hook) stepDefs.push(["hook", "Write text hook"]);
      if (feat.cta) stepDefs.push(["cta", "Write call-to-action card"]);
      if (feat.captions) stepDefs.push(["captions", "Animated word-by-word captions"]);
      if (feat.music) stepDefs.push(["music", "Add background music (ElevenLabs)"]);
      if (feat.sfx) stepDefs.push(["sfx", "Add sound effects"]);
      stepDefs.push(["compose", "Compose edit plan"]);
      stepDefs.push(["render", "Render MP4 (headless Chrome + FFmpeg)"]);
      const st = {
        id,
        createdAt: new Date().toISOString(),
        status: "pending",
        videoPath: vid,
        brollFiles,
        features: feat,
        settings: body.settings || {},
        aspect: body.aspect === "16:9" ? "16:9" : "9:16",
        outName: (body.outName || "reel").replace(/[^\w\-]+/g, "_").slice(-40),
        steps: stepDefs.map(([id, label]) => ({ id, label, status: "pending", detail: "", at: null })),
      };
      await saveState(d, st);
      launchJob(id, "full"); // automatic: the pipeline starts right away, no Claude needed
      return json(res, 200, { ok: true, id, status: "editing" });
    }
    if (p === "/api/jobs" && req.method === "GET") {
      const out = [];
      for (const name of fs.readdirSync(JOBS)) {
        if (name === "inbox") continue;
        const f = path.join(JOBS, name, "state.json");
        if (fs.existsSync(f)) out.push(JSON.parse(await fsp.readFile(f, "utf8")));
      }
      out.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return json(res, 200, out);
    }

    let m;
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/state$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      return json(res, 200, await loadState(d));
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/progress$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      if (!body || !body.step) return json(res, 400, { error: "body: {step, status, detail?}" });
      const st = await loadState(d);
      st.updatedAt = new Date().toISOString();
      if (body.status === "done" && body.step === "finished") st.status = "done";
      if (body.status === "failed") st.status = "failed";
      if (st.status === "pending" && body.status === "running") st.status = "editing";
      const s = (st.steps || []).find(x => x.id === body.step);
      if (s) { s.status = body.status; if (body.detail) s.detail = body.detail; s.at = new Date().toISOString(); }
      else st.steps = (st.steps || []).concat([{ id: body.step, label: body.step, status: body.status, detail: body.detail || "", at: new Date().toISOString() }]);
      if (body.out) st.out = body.out;
      await saveState(d, st);
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/transcript$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "transcript.json");
      if (!fs.existsSync(f)) return json(res, 404, { error: "not transcribed yet" });
      return send(res, 200, await fsp.readFile(f), { "Content-Type": "application/json" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/plan$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "plan.json");
      if (!fs.existsSync(f)) return json(res, 404, { error: "not planned yet" });
      return send(res, 200, await fsp.readFile(f), { "Content-Type": "application/json" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/plan$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      if (!body) return json(res, 400, { error: "invalid json" });
      await fsp.writeFile(path.join(d, "plan.json"), JSON.stringify(body, null, 2));
      return json(res, 200, { ok: true });
    }
    // interactive transcript panel: cut / uncut a word (word index based — never mid-word)
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/word\/(\d+)\/(cut|uncut)$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const idx = Number(m[2]);
      const pf = path.join(d, "plan.json");
      let plan = fs.existsSync(pf) ? JSON.parse(await fsp.readFile(pf, "utf8")) : {};
      plan.cuts = plan.cuts || { words: [] };
      plan.cuts.words = plan.cuts.words || [];
      const has = plan.cuts.words.includes(idx);
      if (m[3] === "cut" && !has) plan.cuts.words.push(idx);
      if (m[3] === "uncut" && has) plan.cuts.words = plan.cuts.words.filter(w => w !== idx);
      plan.cuts.words.sort((a, b) => a - b);
      await fsp.writeFile(pf, JSON.stringify(plan, null, 2));
      return json(res, 200, { ok: true, cut: m[3] === "cut" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/media\/(.+)$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const rel = decodeURIComponent(m[2]);
      let f = safeJoin(path.join(d, "media"), rel);
      // Some outputs live at the JOB ROOT (enhanced.wav, music.mp3, green.mp4,
      // out.mp4, cutout/…). Serve those too — media files only, never .json/.log.
      if ((!f || !fs.existsSync(f)) && !/^\.\.|\0/.test(rel) &&
          /\.(mp4|mov|webm|mp3|wav|m4a|png|jpe?g)$/i.test(rel)) {
        const alt = safeJoin(d, rel);
        if (alt && fs.existsSync(alt)) f = alt;
      }
      if (!f || !fs.existsSync(f)) return json(res, 404, { error: "no such media" });
      return streamFile(req, res, f);
    }
    // editor's "re-render with current cuts" — sets a flag the Claude Code
    // session polls (rendering is a Claude-driven step, not a server step)
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/rerender$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      await fsp.writeFile(path.join(d, "rerender-requested"), new Date().toISOString());
      await setJobStatus(m[1], "editing");
      launchJob(m[1], "rerender"); // automatic: compose + render right away
      return json(res, 200, { ok: true, status: "rerendering" });
    }
    // AI edits: "select a section, tell it what to do". Request is queued in
    // ai-requests.json; the engine applies it (scripts/ai-edit-apply.mjs) and
    // re-renders. GET returns the queue so the UI can show status/results.
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/ai$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      const ins = String(body && body.instruction || "").trim();
      if (!ins) return json(res, 400, { error: "body: {t0, t1, instruction}" });
      const t0 = Math.max(0, Number(body.t0) || 0);
      const t1 = Number(body.t1) > t0 ? Number(body.t1) : Math.min(t0 + 2, 3600);
      const f = path.join(d, "ai-requests.json");
      const reqs = fs.existsSync(f) ? JSON.parse(await fsp.readFile(f, "utf8")) : [];
      reqs.push({ at: new Date().toISOString(), t0, t1, instruction: ins, status: "pending", result: null });
      await fsp.writeFile(f, JSON.stringify(reqs, null, 2));
      await setJobStatus(m[1], "editing");
      launchJob(m[1], "ai");
      return json(res, 200, { ok: true, id: reqs.length - 1, status: "queued" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/ai$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "ai-requests.json");
      if (!fs.existsSync(f)) return json(res, 200, { requests: [] });
      return json(res, 200, { requests: JSON.parse(await fsp.readFile(f, "utf8")) });
    }
    // editor "Ask agent" feedback: notes at timestamps; the Claude Code
    // session polls this flag, applies the notes to the plan, and re-renders
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/feedback$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      const notes = Array.isArray(body && body.notes) ? body.notes : null;
      if (!notes) return json(res, 400, { error: "body: {notes:[{ts,text}]}" });
      await fsp.writeFile(path.join(d, "feedback.json"), JSON.stringify({ at: new Date().toISOString(), notes }, null, 2));
      await fsp.writeFile(path.join(d, "feedback-requested"), new Date().toISOString());
      return json(res, 200, { ok: true, count: notes.length });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/feedback$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "feedback.json");
      if (!fs.existsSync(f)) return json(res, 200, { notes: [] });
      return send(res, 200, await fsp.readFile(f), { "Content-Type": "application/json" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/export$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const st = await loadState(d);
      const f = st.out && fs.existsSync(st.out) ? st.out : path.join(d, "out.mp4");
      if (!fs.existsSync(f)) return json(res, 404, { error: "not rendered yet" });
      const name = (st.outName || "edit") + ".mp4";
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="${name}"` });
      const rs = fs.createReadStream(f);
      rs.pipe(res);
      return;
    }

    /* ---------- FilmCraft editor endpoints (launchers defined at module
       scope — one worker per job, since concurrent engine processes clobber
       each other's saves) ---------- */
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/build$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      if (!fcLaunch(m[1], "filmcraft-build")) return json(res, 409, { error: "a FilmCraft operation is already running for this job" });
      return json(res, 200, { ok: true, status: "building" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/status$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const rd = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
      const build = rd(path.join(d, "filmcraft-build.json"));
      const ai = rd(path.join(d, "filmcraft-ai.json"), []);
      const ex = rd(path.join(d, "filmcraft-export.json"));
      const manifest = rd(path.join(d, "filmcraft", "manifest.json"));
      const reqs = Array.isArray(ai) ? ai : (ai && ai.requests || []);
      const busy = !!(reqs.some(r => r.status === "pending") || fcBusy.get(m[1]));
      return json(res, 200, {
        build, export: ex, manifest: !!manifest,
        busy,
        aiPending: reqs.filter(r => r.status === "pending").length,
        lastAi: reqs.length ? reqs[reqs.length - 1] : null,
      });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/manifest$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "filmcraft", "manifest.json");
      if (!fs.existsSync(f)) return json(res, 404, { error: "no FilmCraft build yet" });
      return send(res, 200, await fsp.readFile(f), { "Content-Type": "application/json" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/sequence$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "filmcraft", "sequence.json");
      if (!fs.existsSync(f)) return json(res, 404, { error: "no sequence yet" });
      return send(res, 200, await fsp.readFile(f), { "Content-Type": "application/json" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/ai$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      const ins = String(body && body.instruction || "").trim();
      if (!ins) return json(res, 400, { error: "body: {instruction, clip?, t0?, t1?}" });
      const f = path.join(d, "filmcraft-ai.json");
      const reqs = fs.existsSync(f) ? JSON.parse(await fsp.readFile(f, "utf8")) : [];
      const t0 = Math.max(0, Number(body.t0) || 0);
      const t1 = Number(body.t1) > t0 ? Number(body.t1) : t0 + 2;
      reqs.push({ at: new Date().toISOString(), t0, t1, clip: body.clip != null ? Number(body.clip) : null, instruction: ins, status: "pending", result: null });
      await fsp.writeFile(f, JSON.stringify(reqs, null, 2));
      if (!fcLaunch(m[1], "filmcraft-ai")) return json(res, 409, { error: "queued — the previous FilmCraft operation is still running" });
      return json(res, 200, { ok: true, id: reqs.length - 1, status: "queued" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/ai$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "filmcraft-ai.json");
      if (!fs.existsSync(f)) return json(res, 200, { requests: [] });
      return json(res, 200, { requests: JSON.parse(await fsp.readFile(f, "utf8")) });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/export$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      if (!fcLaunch(m[1], "filmcraft-export")) return json(res, 409, { error: "a FilmCraft operation is already running for this job" });
      return json(res, 200, { ok: true, status: "exporting" });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/export$/)) && (req.method === "GET" || req.method === "HEAD")) {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const f = path.join(d, "filmcraft", "out.mp4");
      if (!fs.existsSync(f)) return json(res, 404, { error: "not exported yet" });
      const st = await loadState(d);
      const name = ((st.outName || "reel") + "-filmcraft.mp4");
      // ?inline=1 → play in the monitor; default → download
      const inline = url.searchParams.get("inline") === "1";
      const size = fs.statSync(f).size;
      const heads = {
        "Content-Type": "video/mp4",
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Content-Disposition": inline ? "inline" : `attachment; filename="${name}"`,
      };
      if (req.method === "HEAD") { res.writeHead(200, heads); return res.end(); }
      res.writeHead(200, heads);
      fs.createReadStream(f).pipe(res);
      return;
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/media$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const list = (await fsp.readdir(path.join(d, "media")).catch(() => [])).map((n) => {
        try { return { name: n, size: fs.statSync(path.join(d, "media", n)).size }; } catch { return { name: n, size: 0 }; }
      });
      return json(res, 200, { media: list });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/filmcraft\/frame$/))) {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const u = url.searchParams;
      const i = u.get("i"), t = u.get("t");
      const dir = path.join(d, "filmcraft", "frames");
      fs.mkdirSync(dir, { recursive: true });
      let f = null;
      if (i != null) f = path.join(dir, `ai-${i}.png`);
      if (!f && t != null) f = path.join(dir, `t-${Math.round(Number(t) * 30)}.png`);
      if (t != null && !fs.existsSync(f || "")) {
        // render on demand (read-only; the project is always saved before this point)
        const r = await new Promise((resolve) => {
          try {
            const ch = spawn(FC_BIN(), ["--project", path.join(d, "filmcraft", "project.fcproj"), "render", "--seconds", String(Number(t) || 0), "--out", f, "--allow-offline"], { stdio: ["ignore", "pipe", "pipe"] });
            let to = setTimeout(() => { try { ch.kill("SIGKILL"); } catch {} }, 90000);
            ch.on("close", (code) => { clearTimeout(to); resolve(code); });
          } catch (e) { resolve(-1); }
        });
        if (r !== 0 || !fs.existsSync(f)) return json(res, 500, { error: "frame render failed" });
      }
      if (!f || !fs.existsSync(f)) return json(res, 404, { error: "no such frame (request ?i= or ?t=seconds)" });
      res.writeHead(200, { "Content-Type": "image/png" });
      fs.createReadStream(f).pipe(res);
      return;
    }

    /* ---------- NLE editing endpoints (Premiere-style UI) ----------
       The engine is single-process per job, so every MUTATING call runs
       under withFcBusy; state reads are plain file reads. Time in/out is
       SECONDS (the lib normalizes ticks); the UI converts back to ticks
       only where the engine demands raw ticks (razor/trim/keyframes). */
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/state$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const st = await readFcState(d);
      if (!st.ok) return json(res, 404, st);
      const undo = await fcUndoState(d);
      st.busy = !!fcBusy.get(m[1]);
      st.undo = { canUndo: undo.canUndo, canRedo: undo.canRedo, undo: undo.undo, redo: undo.redo };
      // media URLs, scoped to the job dir (never serve outside it)
      for (const mm of st.media) {
        mm.url = mm.path && mm.path.startsWith(d + path.sep)
          ? `/api/jobs/${m[1]}/fc/file?name=${encodeURIComponent(path.relative(d, mm.path))}`
          : null;
      }
      return json(res, 200, st);
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/edit$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      const steps = body && Array.isArray(body.steps) ? body.steps : null;
      if (!steps || !steps.length) return json(res, 400, { error: "body: {steps:[{id, params}], ripple?, label?}" });
      if (!steps.every(s => s && typeof s.id === "string")) return json(res, 400, { error: "each step needs an id" });
      let r;
      await withFcBusy(m[1], async () => {
        await fcSnapshot(d, body.label || steps[0].id);
        r = await fcRunSteps(d, steps, { ripple: !!body.ripple });
        if (!r.results.some(x => x.ok)) await fcDropSnapshot(d);
      });
      if (r.error) return json(res, 400, { ok: false, error: r.error, results: r.results });
      return json(res, 200, { ok: true, results: r.results, state: await readFcState(d) });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/(undo|redo)$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      let r;
      await withFcBusy(m[1], async () => { r = m[2] === "undo" ? await fcUndo(d) : await fcRedo(d); });
      if (!r.ok) return json(res, 409, r);
      return json(res, 200, { ok: true, state: await readFcState(d), undo: await fcUndoState(d) });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/history-reset$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      await withFcBusy(m[1], () => fcResetHistory(d));
      return json(res, 200, { ok: true });
    }
    // Import media into the project bin. `path` is a server-side file path
    // (e.g. from /api/upload, or a local path). Files outside the job dir
    // are hard-linked IN (originals never modified) so the bin URL works.
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/import$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      const src = body && typeof body.path === "string" ? path.resolve(body.path) : null;
      if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) return json(res, 400, { error: "body: {path} — a readable file path" });
      let file = src;
      if (!src.startsWith(d + path.sep)) {
        const ext = path.extname(src).toLowerCase() || ".bin";
        file = path.join(d, "media", `import-${Date.now()}${ext}`);
        await hardlinkOrCopy(src, file);
      }
      let r;
      await withFcBusy(m[1], async () => {
        await fcSnapshot(d, "import");
        r = await fcImportOne(d, file);
        if (!r.ok) await fcDropSnapshot(d);
      });
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
      return json(res, 200, { ok: true, item: r.item, state: await readFcState(d) });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/seq$/)) && req.method === "POST") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const body = await readJsonBody(req);
      if (!body || !["new", "open", "close"].includes(body.action)) return json(res, 400, { error: "body: {action:'new'|'open'|'close', item?, name?, width?, height?, fps?}" });
      let r;
      await withFcBusy(m[1], async () => {
        if (body.action === "new") await fcSnapshot(d, "new-sequence");
        r = await fcSeqOp(d, body);
        if (body.action === "new" && !r.ok) await fcDropSnapshot(d);
      });
      if (!r.ok) return json(res, 400, { ok: false, error: r.error || "failed" });
      return json(res, 200, { ok: true, state: await readFcState(d) });
    }
    // Serve a media file inside the job dir (bin thumbnails, waveforms…).
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/file$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      const name = decodeURIComponent(url.searchParams.get("name") || "");
      if (!/\.(mp4|mov|webm|m4v|mp3|wav|m4a|ogg|flac|png|jpe?g|tiff?)$/i.test(name) ||
          /(^|[\\/])\.\./.test(name)) return json(res, 400, { error: "not a media file" });
      const f = safeJoin(d, name);
      if (!f || !fs.existsSync(f)) return json(res, 404, { error: "no such file" });
      return streamFile(req, res, f);
    }
    // Effect catalog (for the “Add effect” picker). Cached per server.
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)\/fc\/effects$/)) && req.method === "GET") {
      const d = await jobDir(m[1]); if (!d) return json(res, 404, { error: "no such job" });
      if (fcFxCache) return json(res, 200, fcFxCache);
      const s = fcSession(d, { newProject: false });
      const r = await s.run("effects.list", { detail: false });
      s.close();
      if (!r.ok) return json(res, 500, { error: r.error || "effects.list failed" });
      fcFxCache = { ok: true, effects: r.result ?? r.text };
      return json(res, 200, fcFxCache);
    }

    // ---------- upload (from the browser UI) ----------
    if (p === "/api/upload" && req.method === "POST") {
      const name = (url.searchParams.get("name") || "upload").replace(/[^\w.\-]+/g, "_").slice(-80) || "upload";
      const kind = url.searchParams.get("kind") === "broll" ? "broll" : "base";
      const inbox = path.join(JOBS, "inbox");
      fs.mkdirSync(inbox, { recursive: true });
      const id = crypto.randomBytes(4).toString("hex");
      const ext = path.extname(name).toLowerCase() || ".bin";
      const dst = path.join(inbox, `${Date.now()}-${id}-${kind}${ext}`);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dst);
        let bytes = 0;
        req.on("data", c => { bytes += c.length; if (bytes > 8 * 1024 * 1024 * 1024) { req.destroy(); reject(new Error("file too large (8GB)")); } });
        req.on("end", () => out.end(resolve));
        req.on("error", reject);
        out.on("error", reject);
        req.pipe(out);
      });
      return json(res, 200, { ok: true, path: dst, name, kind, bytes: fs.statSync(dst).size });
    }

    if (p === "/api/health") return json(res, 200, { ok: true, service: "11-second-edit" });

    // ---------- static ----------
    if (p === "/" ) return serveStatic(res, path.join(PUBLIC, "index.html"));
    if (p.startsWith("/api/")) return json(res, 404, { error: "no such endpoint" });
    return serveStatic(res, safeJoin(PUBLIC, decodeURIComponent(p)) || null);
  } catch (e) {
    return json(res, e.status || 500, { error: String(e && e.message || e) });
  }
}
const server = http.createServer((req, res) => {
  // Request logging — quiet for polling GETs, loud for mutations, errors,
  // slow requests, and any connection the client (or network) drops mid-transfer.
  const t0 = Date.now();
  const label = (req.method || "?") + " " + req.url;
  res.on("finish", () => {
    const ms = Date.now() - t0;
    if (req.method !== "GET" || res.statusCode >= 400 || ms > 3000) {
      console.log(JSON.stringify({ req: label, status: res.statusCode, ms }));
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) console.log(JSON.stringify({ req: label, status: "ABORTED-by-client", ms: Date.now() - t0 }));
  });
  handle(req, res);
});
// Uploads of large videos can take many minutes (especially over a
// remote/VPN link). Node 18+ defaults requestTimeout to 300s, which cuts a
// stalled transfer — disable it for this app.
server.requestTimeout = 0;

function serveStatic(res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { error: "not found" });
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

/* Range-capable file streaming (needed for <video> seeking of large files). */
function streamFile(req, res, file) {
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : stat.size - 1;
    if (m[1] === "" && m[2]) { start = stat.size - Number(m[2]); end = stat.size - 1; } // suffix
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": stat.size });
    fs.createReadStream(file).pipe(res);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ ready: true, port: PORT, url: `http://127.0.0.1:${PORT}` }));
});

export { hardlinkOrCopy, JOBS };
