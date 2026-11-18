#!/usr/bin/env node
/* Ensures playwright-core is available (small package, no browser download —
 * we drive the system Chrome). Usage: node scripts/setup-render-deps.mjs */
import fs from "node:fs";
import path from "node:path";
import { run, ROOT } from "./lib.mjs";

if (fs.existsSync(path.join(ROOT, "node_modules", "playwright-core", "package.json"))) {
  console.log("playwright-core already present");
  process.exit(0);
}
console.log("installing playwright-core…");
const r = await run("npm", ["install", "--no-audit", "--no-fund", "playwright-core"], { timeout: 10 * 60 * 1000 });
if (r.code !== 0) {
  console.error("npm install failed:\n" + r.err.slice(-400));
  process.exit(1);
}
console.log("playwright-core ready — render will use the system Chrome (set CHROME_PATH to override).");
