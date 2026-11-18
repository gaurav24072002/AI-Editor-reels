#!/usr/bin/env node
/*
 * Report a pipeline step's progress to the browser UI.
 * Usage: node scripts/report.mjs <jobId> <stepId> <running|done|skipped|failed> [detail...]
 *        node scripts/report.mjs <jobId> finished done "out=<path>"
 *
 * Step ids: transcribe analyze silences fillers badtakes audio color zooms
 *           broll hook cta captions music sfx compose render finished
 */
import { report } from "./lib.mjs";

const [id, step, status, ...rest] = process.argv.slice(2);
if (!id || !step || !status) {
  console.error("usage: report.mjs <jobId> <stepId> <status> [detail]");
  process.exit(2);
}
const detail = rest.join(" ");
await report(id, step, status, detail);
process.exit(0);
