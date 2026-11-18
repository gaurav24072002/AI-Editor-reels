#!/usr/bin/env node
/*
 * Blocks until the user clicks "Edit Video" in the browser.
 * Prints the job as JSON and exits 0. The Claude Code session (following
 * SKILL.md) runs this in the foreground and proceeds when it returns.
 *
 * Usage: node scripts/wait-for-job.mjs [--timeout-sec 7200]
 */
import fs from "node:fs";
import path from "node:path";
import { JOBS } from "./lib.mjs";

const timeoutSec = (() => {
  const i = process.argv.indexOf("--timeout-sec");
  return i !== -1 ? Number(process.argv[i + 1]) : 0;
})();
const deadline = timeoutSec ? Date.now() + timeoutSec * 1000 : 0;

// jobs that existed before we started are not "the" job
const seen = new Set();
try {
  for (const n of fs.readdirSync(JOBS)) {
    if (n !== "inbox" && fs.existsSync(path.join(JOBS, n, "state.json"))) seen.add(n);
  }
} catch { /* jobs/ may not exist yet */ }

function findPending() {
  let names = [];
  try { names = fs.readdirSync(JOBS); } catch { return null; }
  for (const n of names) {
    if (n === "inbox" || seen.has(n)) continue;
    const f = path.join(JOBS, n, "state.json");
    if (!fs.existsSync(f)) continue;
    try {
      const st = JSON.parse(fs.readFileSync(f, "utf8"));
      if (st.status === "pending" || st.status === "editing") return { id: n, state: st };
    } catch { /* keep looking */ }
  }
  return null;
}

let job = findPending();
while (!job) {
  if (deadline && Date.now() > deadline) {
    console.error(JSON.stringify({ error: "timed out waiting for a job" }));
    process.exit(2);
  }
  await new Promise(r => setTimeout(r, 800));
  job = findPending();
}

// a moment for the job dir to settle
await new Promise(r => setTimeout(r, 400));
const full = JSON.parse(fs.readFileSync(path.join(JOBS, job.id, "state.json"), "utf8"));
console.log(JSON.stringify({ jobId: job.id, job: full }, null, 2));
process.exit(0);
