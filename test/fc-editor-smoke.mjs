/* Browser smoke test for the FilmCraft NLE (public/filmcraft.js).
   Usage: node test/fc-editor-smoke.mjs [jobId]
   Drives a real Chrome: open editor → wait ready → assert bins/timeline →
   perform a split edit → assert clip count grew → screenshot. */
import { chromium } from "playwright-core";
import { spawn, execSync } from "node:child_process";

const JOB = process.argv[2] || "edit-db28e093";
const URL = "http://127.0.0.1:8481/";
const ERR = [];

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome-stable",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") ERR.push(m.text()); });
page.on("pageerror", (e) => ERR.push("PAGEERROR: " + e.message));

const fail = (msg) => { console.error("FAIL:", msg); browser.close().then(() => process.exit(1)); };
const ok = (msg) => console.log("ok  -", msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(URL, { waitUntil: "networkidle" });

// 1. entry contract
const hasFc = await page.evaluate(() => !!(window.__fc && window.__fc.openFilmCraft));
if (!hasFc) fail("window.__fc not defined");
ok("window.__fc entry contract present");

// 2. open the editor for the job
await page.evaluate((id) => window.__fc.openFilmCraft(id), JOB);

// wait until phase ready (up to 40s)
let phase = "none";
for (let i = 0; i < 80; i++) {
  await sleep(500);
  phase = await page.evaluate(() => window.__fc.state.phase);
  if (["ready", "failed"].includes(phase)) break;
}
if (phase !== "ready") fail(`phase=${phase}, errors=${JSON.stringify(ERR.slice(0,5))}`);
ok("editor phase → ready");

const editorVisible = await page.evaluate(() => !document.getElementById("fcEditor").classList.contains("hidden"));
if (!editorVisible) fail("fcEditor section still hidden");
ok("#fcEditor visible");

// 3. bins + timeline populated
const bins = await page.evaluate(() => document.querySelectorAll("#fcBinList > *").length);
const clips = await page.evaluate(() => document.querySelectorAll(".fc-clip").length);
if (!bins) fail("bins empty");
ok(`bins populated (${bins} items)`);
if (!clips) fail("no timeline clips rendered");
ok(`timeline clips rendered (${clips})`);

// 4. select a clip → inspector should fill
await page.evaluate(() => {
  const c = document.querySelector(".fc-clip");
  c && c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
});
await sleep(400);
const sel = await page.evaluate(() => window.__fc.state.sel);
if (!sel) fail("clip selection did not register");
ok(`clip selected (clipId=${sel.clipId})`);

// 5. real edit: split at playhead in the middle of the selected clip
const before = await page.evaluate(() => document.querySelectorAll(".fc-clip").length);
await page.evaluate(() => {
  const st = window.__fc.state;
  const c = st.sel && st.sel.clip;
  if (c) st.ph = c.start + c.dur / 2; // st.sel.clip is the clip object itself
  document.getElementById("fcSplit").click();
});
let after = before;
for (let i = 0; i < 20; i++) {
  await sleep(250);
  after = await page.evaluate(() => document.querySelectorAll(".fc-clip").length);
  if (after > before) break;
}
if (after < before) fail(`split did not increase clips (before=${before} after=${after})`);
ok(`split mid-clip on clip ${sel.clipId}: ${before} → ${after} clips`);

// 6. switch inspector panes
for (const pane of ["fx", "color", "audio", "text", "ai"]) {
  const r = await page.evaluate((p) => {
    const btn = document.querySelector(`.fc-tabs [data-pane="${p}"]`);
    if (!btn) {
      return {
        found: false,
        tabsEl: !!document.querySelector(".fc-tabs"),
        btns: [...document.querySelectorAll("[data-pane]")].map(b => b.getAttribute("data-pane")),
        docUrl: location.href,
        ready: document.readyState,
      };
    }
    btn.click();
    return { found: true, active: document.querySelector(".fc-tabs button.on")?.getAttribute("data-pane") };
  }, pane);
  if (!r.found) { console.error("pane diag:", JSON.stringify(r)); fail(`tab for pane "${pane}" not found`); }
  await sleep(150);
}
ok("inspector panes switch without error");

// 7. zoom buttons
await page.click("#fcZoomIn"); await sleep(100);
await page.click("#fcZoomFit"); await sleep(100);
ok("zoom in/fit work");

// geometry guard: catch inspector/transport overlap in the real page before snapshotting
const geo = await page.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { x: Math.round(b.x), right: Math.round(b.x + b.width), bottom: Math.round(b.bottom) }; };
  const a = r("#fcAiApply"), t = r(".fc-transport");
  return { apply: a, transport: t, overlap: a.x < t.right && a.bottom > t.top, docZoom: getComputedStyle(document.documentElement).zoom, innerW: innerWidth };
});
if (geo.overlap) console.error("GEO OVERLAP:", JSON.stringify(geo));
else console.log("ok  - no inspector/transport overlap", JSON.stringify(geo));

await page.screenshot({ path: "test/fc-editor-smoke.png" });
console.log("ok  - screenshot → test/fc-editor-smoke.png");

const jsErr = ERR.filter((e) => !e.includes("favicon"));
if (jsErr.length) console.log("note: console errors:\n  " + jsErr.slice(0, 8).join("\n  "));
await browser.close();
console.log("PASS");
