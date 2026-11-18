/* Shared helpers for the 11 Second Edit pipeline scripts. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const JOBS = path.join(ROOT, "jobs");
export const PORT = Number(process.env.PORT || 8481);

export function findBinary(name, candidates = []) {
  // 1) env override, 2) known spots, 3) PATH
  const envKey = name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_PATH";
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const home = os.homedir();
  if (name === "ffmpeg") {
    const local = path.join(home, "tools", "ffmpeg", "ffmpeg");
    if (fs.existsSync(local)) return local;
  }
  for (const dir of (process.env.PATH || "").split(path.sep)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export const FFMPEG = () => findBinary("ffmpeg") || "ffmpeg";
export const CHROME = () => findBinary("google-chrome", ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) || "google-chrome";
export const PYTHON = () => process.env.PYTHON_PATH || "python3";

export function run(cmd, args, { input = null, timeout = 30 * 60 * 1000, env = process.env, onLine = null } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); }, timeout);
    p.stdout.on("data", (d) => {
      out += d;
      if (onLine) {
        let i;
        while ((i = out.indexOf("\n")) !== -1) {
          const line = out.slice(0, i).trim();
          out = out.slice(i + 1);
          if (line) { try { onLine(line); } catch { /* listener must not break the run */ } }
        }
      }
    });
    p.stderr.on("data", d => { err += d; });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + " " + e.message }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    if (input != null) { p.stdin.write(input); }
    p.stdin.end();
  });
}

/* ---------------- job helpers ---------------- */
export async function jobDir(id) {
  const d = path.join(JOBS, id);
  if (!/^[a-z0-9-]{4,40}$/i.test(id)) return null;
  if (fs.existsSync(path.join(d, "state.json"))) return d;
  return null;
}
export async function loadState(d) { return JSON.parse(await fsp.readFile(path.join(d, "state.json"), "utf8")); }
export async function saveState(d, st) { await fsp.writeFile(path.join(d, "state.json"), JSON.stringify(st, null, 2)); }

/** Report progress to the UI (server) AND to an events log (so it survives a server hiccup). */
export async function report(id, step, status, detail = "", extra = {}) {
  const d = path.join(JOBS, id);
  const ev = { at: new Date().toISOString(), step, status, detail, ...extra };
  try {
    await fsp.appendFile(path.join(d, "events.jsonl"), JSON.stringify(ev) + "\n");
  } catch { /* non-fatal */ }
  // local state merge (same logic as the server endpoint)
  try {
    if (fs.existsSync(path.join(d, "state.json"))) {
      const st = await loadState(d);
      st.updatedAt = ev.at;
      if (status === "failed") st.status = "failed";
      if (status === "done" && step === "finished") st.status = "done";
      if (st.status === "pending" && status === "running") st.status = "editing";
      const s = (st.steps || []).find(x => x.id === step);
      if (s) { s.status = status; if (detail) s.detail = detail; s.at = ev.at; }
      else st.steps = (st.steps || []).concat([{ id: step, label: step, status, detail, at: ev.at }]);
      if (extra.out) st.out = extra.out;
      await saveState(d, st);
    }
  } catch { /* non-fatal */ }
  // push to the browser if the server is up
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/jobs/${id}/progress`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, status, detail, ...extra }),
      signal: AbortSignal.timeout(2500),
    });
    await r.arrayBuffer();
  } catch { /* server may be down; state file is the source of truth */ }
  console.log(`[report] ${id} ${step} ${status} ${detail}`.trim());
}

/** Find the base media file inside a job (base.mp4 / base.mov / …). */
export async function baseMediaFile(d) {
  const files = await fsp.readdirSync(path.join(d, "media")).catch(() => []);
  const base = files.find(f => /^base\./.test(f));
  return base ? path.join(d, "media", base) : null;
}

/** Resolve plan media URLs for a job (absolute web paths). */
export function mediaUrl(id, file) { return `/api/jobs/${id}/media/${encodeURIComponent(file)}`; }

export async function readJsonSafe(f, fallback = null) {
  try { return JSON.parse(await fsp.readFile(f, "utf8")); } catch { return fallback; }
}
