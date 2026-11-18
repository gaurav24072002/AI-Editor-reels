#!/usr/bin/env node
/*
 * filmcraft-export.mjs — export the job's FilmCraft sequence to MP4.
 * Usage: node scripts/filmcraft-export.mjs <jobId>
 * Writes filmcraft-export.json status {state: building|rendering|done|failed, file}.
 * Output: jobs/<id>/filmcraft/out.mp4  (served via /api/jobs/<id>/filmcraft/export)
 */
import path from "node:path";
import { fc, fcDir, fcProjectPath, fcManifestFile, fcSetExportStatus, jobDir, report, readJson } from "./fc-lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const manifest = await readJson(fcManifestFile(d));
if (!manifest) { console.error("[fc-export] no build yet"); process.exit(1); }

const out = path.join(fcDir(d), "out.mp4");
await fcSetExportStatus(d, "rendering", { startedAt: new Date().toISOString(), file: `/api/jobs/${id}/filmcraft/export` });
await report(id, "filmcraft-export", "running", `rendering ${manifest.duration?.toFixed(1) ?? "?"}s sequence…`);

const r = await fc(d, ["--project", fcProjectPath(d), "export", out, "--allow-offline"], { timeout: 60 * 60 * 1000 });

if (r.code === 0) {
  await fcSetExportStatus(d, "done", { file: `/api/jobs/${id}/filmcraft/export`, at: new Date().toISOString() });
  await report(id, "filmcraft-export", "done", "FilmCraft MP4 ready");
  console.log(JSON.stringify({ ok: true, file: out }));
} else {
  await fcSetExportStatus(d, "failed", { error: (r.err || r.out).slice(0, 2000) });
  await report(id, "filmcraft-export", "failed", (r.err || r.out).slice(0, 200));
  console.error("[fc-export] FAILED:", (r.err || r.out).slice(0, 500));
  process.exit(1);
}
