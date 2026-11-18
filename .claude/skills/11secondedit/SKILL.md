---
name: 11secondedit
description: One-click AI video editor. Starts a local web app, you pick footage + toggles and click Edit Video, then edit the talking-head clip into a finished 9:16 (or 16:9) Reel with cuts, captions, hook, CTA, b-roll, zooms, music and SFX.
---

# 11 Second Edit — you are the editor

You (Claude Code) are the human-in-the-loop's editor. A local Node server hosts the
browser app. The user picks footage and toggles, clicks **Edit Video**, and YOU run
the pipeline, making the editorial judgments. Everything deterministic lives in
`scripts/` — never "improvise" deterministic work (trimming math, ffmpeg, mixing)
in prose; run the scripts.

Project root: the directory containing this skill's project (`.claude/skills/11secondedit/SKILL.md`).
All commands below run from the project root.

## Ground rules (non-negotiable)

1. **Never modify the original video.** All reads go through `jobs/<id>/media/base.*`
   (a hardlink/copy the server made). All writes go to new files in `jobs/<id>/`.
2. **Never cut mid-word.** Cuts are word-index based only (`plan.cuts.words`).
3. **API keys stay in env** (`AUPHONIC_API_KEY`, `ELEVENLABS_API_KEY`). Never echo,
   log, or write them to any file.
4. If a step fails or is skipped, say so in the final summary. Never claim a step
   ran that didn't.

## 0. Toolchain

```bash
export PATH="$HOME/tools/node/bin:$PATH"   # Node 20 (installed under ~/tools)
node --version || { echo "Node missing — install: see README §Install"; exit 1; }
node scripts/setup-render-deps.mjs          # playwright-core (drives system Chrome)
```

`ffmpeg` is auto-detected by `scripts/lib.mjs` (PATH, then `~/tools/ffmpeg/ffmpeg`).
WhisperX (python) is required for transcription — if `transcribe.mjs` reports
`WHISPERX_MISSING`, stop and tell the user:
`python3 -m pip install --user whisperx` (installs torch; ~2 GB), then re-run.

## 1. Start the app and wait for the job

```bash
# reuse a running server if there is one
curl -s --max-time 2 http://127.0.0.1:8481/api/health || \
  (nohup node server/server.js > jobs/server.log 2>&1 & sleep 1; curl -s http://127.0.0.1:8481/api/health)
xdg-open http://127.0.0.1:8481 2>/dev/null || echo "Open http://127.0.0.1:8481 in your browser"
```

Then BLOCK on the job (this returns when the user clicks **Edit Video**):

```bash
node scripts/wait-for-job.mjs
```

It prints `{"jobId": "edit-xxxx", "job": {...}}`. Capture `JOB=<id>`.
If it times out / the user cancels, stop gracefully.

## 2. Pipeline (run in THIS order, reporting as you go)

Every step is reported via `node scripts/report.mjs $JOB <step> <status> [detail]`
(steps also self-report inside the scripts — don't double-report a step a script owns).

### 2.1 Transcribe
```bash
node scripts/transcribe.mjs $JOB
```
Fails with `WHISPERX_MISSING` → stop with the install instruction (see §0).

### 2.2 Deterministic cut candidates (if their toggles are on)
```bash
node scripts/silence.mjs $JOB     # → silence_cuts.json   (step: silences)
node scripts/fillers.mjs $JOB     # → filler_cuts.json    (step: fillers)
```
If a toggle is off, report the step `skipped` yourself:
`node scripts/report.mjs $JOB silences skipped "toggle off"`.

### 2.3 ANALYZE — this is YOU (the editorial pass)

Read `jobs/$JOB/state.json` first — its `settings` block is the user's fine-tuning
from the UI (gear modals). Honor it in every decision:

- `settings.brand` — the template to match. When `settings.brand.template` is not `"none"`:
  - `settings.brand.name` + `settings.brand.structure` — the reel type and how it's
    structured (hook shape, cut rhythm, where b-roll/zooms land). **Follow the structure.**
  - `settings.brand.style` — target look: caption size/color, hook color, zoom count/strength,
    SFX weight, pacing, b-roll amount, music direction. The UI already pushed the concrete
    values into `settings.captions` / `settings.textHook` / `settings.zooms` / `settings.music`,
    but use `brand.style` to keep the *plan* (cut rhythm, zoom placement, hook tone) in the same spirit.
  - `public/templates/<id>.mp4` is a short sample reel of exactly this style — if in doubt about
    pacing or hook tone, grab a few frames (`ffmpeg -ss N -i … frame.png`) and look.
  - If `settings.brand.links` is also non-empty, study those links and blend the user's own
    Reels' flavor on top of the template.
- `settings.instructions.text` — explicit editor instructions; these win over your defaults.
- `settings.hook.audience` — write the hook for this audience.
- `settings.textHook.text` — if non-empty, it becomes the hook text (compose uses it); still validate it's true to the content.
- `settings.cta.text` — if non-empty, it becomes the CTA text.
- `settings.broll.aiPrompt` — what b-roll to look for; choose/upload clips that match.
- `settings.music.style` — pass through as `musicPrompt`.
- `settings.emotion.desc` — note it in the hook/zoom choices (graphics land on those beats).
- `settings.zooms.strength` — Subtle/Strong → fewer/more `zoomAtWords` (2 vs 4).
- `settings.targetLength.mode === "Specific length"` → `seconds`: cut MORE aggressively (extra bad takes, tighter hook) so the final lands near that length.
- `settings.transcribe` — already applied to the transcript (language, vocabulary, censor).
- `settings.color` — brightness/lift/white-balance checkboxes (compose maps these).

Then read `jobs/$JOB/transcript.json` in full (it's word-timestamped; read the words
in order as a flowing text with indices). Decide, and **write
`jobs/$JOB/decisions.json`** with the Write tool:

```jsonc
{
  // BAD TAKES & FALSE STARTS (step: badtakes)
  "cutRanges": [[startWordIdx, endWordIdx]],   // repeated sentences, aborted starts, stumbles
  "extraCutWords": [i],                          // any single words you want gone
  // vetoes of the deterministic candidates (optional):
  "excludeSilence": [i], "excludeFillers": [i],
  // HOOK (step: hook): 4-9 words, the most compelling line of the take.
  // It's shown as a big title over the first ~2.5s — punchy, curiosity or payoff.
  "hook": { "text": "..." },
  // CTA (step: cta): short imperative, ≤ 6 words ("Follow for daily prompts").
  "cta": { "text": "..." },
  // ZOOM CUTS (step: zooms): word indices of 2-4 key beats (punch-in on the moment).
  "zoomAtWords": [i],
  // B-ROLL (step: broll): only if the user uploaded clips (job.brollFiles).
  // Place each clip over a related moment. style: "cover" (full frame) or "inset".
  "broll": [ { "clip": "b0.mp4", "afterWord": i, "dur": 2.5, "style": "cover" } ],
  // optional: "musicPrompt": "...", "musicSeconds": 45,
  // optional: "color": { "brightness": 1.06, "contrast": 1.08, "saturation": 1.12 }
}
```

Judgment guidelines:
- False starts: the speaker restarts a sentence; cut the FIRST (worse) attempt, keep the clean one.
- Stumbles: "so as you— as you can see" → cut the aborted "so as you".
- Never cut a word that changes meaning; when unsure, keep it.
- The hook must be TRUE to the content — no fabricated claims.
- Target a final cut of roughly 15–45s for a Reel if the content allows it.

Report: `node scripts/report.mjs $JOB analyze done "N bad takes, M stumbles"` and
`node scripts/report.mjs $JOB badtakes done "<what you removed>"`.

### 2.4 Audio / music / SFX (if toggles on; each script self-reports)
```bash
node scripts/enhance-audio.mjs $JOB   # step: audio   (Auphonic if keyed, else local loudnorm)
node scripts/music.mjs $JOB           # step: music   (ElevenLabs if keyed, else skipped)
node scripts/sfx.mjs $JOB             # step: sfx     (local synthesis)
```

### 2.5 Compose (deterministic merge into plan.json)
```bash
node scripts/compose.mjs $JOB
```
It self-reports `compose`. It also maps `zoomAtWords` → segment indices.

Report the remaining creative steps (their state is now in the plan):
`color`, `zooms`, `broll`, `hook`, `cta`, `captions` → `done` with a short detail,
or `skipped "toggle off"` when off.

### 2.6 Render (headless Chrome + FFmpeg)
```bash
node scripts/render.mjs $JOB
```
Self-reports `render` and `finished`. If it exited degraded (no playwright-core),
re-run `node scripts/setup-render-deps.mjs` then re-render.

## 3. Review & iterate

- Tell the user: the browser page now shows **progress → editor** (live preview,
  timeline, transcript). Clicking words there cuts/restores them live; **Export MP4**
  downloads the render; **Re-render** writes `jobs/$JOB/rerender-requested`.
- If that flag file appears (or the user says "re-render"): re-run
  `compose.mjs $JOB` then `render.mjs $JOB` (decisions.json is preserved; the word
  cuts in plan.json come from the transcript-panel edits the server stored).
- **Ask-agent feedback**: if `jobs/$JOB/feedback-requested` appears, read
  `jobs/$JOB/feedback.json` — notes at timestamps (`{ts, text}`). Apply each note
  (edit cuts/decisions/plan accordingly — "zoom harder here" → add a zoom at that
  segment, "cut this line" → add word indices, "different hook" → rewrite hook),
  then re-run `compose.mjs $JOB` + `render.mjs $JOB`, report `finished` again, and
  delete the flag + feedback.json so they don't re-fire.
- If the user asks for changes ("shorter", "different hook"): edit `decisions.json`,
  re-run `compose.mjs` + `render.mjs`, report `finished` again.
- Keep the server running afterwards; it's cheap and the UI is the review surface.

## 4. Failure handling

- A failed step: report it `failed` (the script already does this), then continue
  with the remaining steps only if the failure is non-blocking (e.g. music skipped
  is fine; transcription failed is NOT — stop and explain).
- Always end with an honest summary: what ran, what was skipped, where `jobs/$JOB/out.mp4` is.
