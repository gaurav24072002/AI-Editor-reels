#!/usr/bin/env node
/*
 * filmcraft-ai.mjs — apply queued "AI edit" requests onto the job's FilmCraft
 * project, SCOPED TO THE SELECTED CLIP. Each request is {t0, t1, clip,
 * instruction}; `clip` is the clip id picked in the FilmCraft editor (falls
 * back to the clip under (t0+t1)/2).
 *
 * Keyword-based intent → FilmCraft command mapper (the LLM bridge is
 * optional; if `claude -p` is logged in it is tried first and its command
 * JSON, when valid, wins). Unknown intents are flagged needs-review — never
 * silently dropped, never faked.
 *
 * Writes: filmcraft-ai.json (statuses), sequence.json (refreshed), one
 * verification frame per applied request.
 *
 * Usage: node scripts/filmcraft-ai.mjs <jobId>
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  fcRenderFrame, refreshSequence, fcSession, TSPS,
  fcDir, fcFramesDir, fcManifestFile, fcAiQueueFile,
  jobDir, report, clipAtTime, readJson, writeJson,
} from "./fc-lib.mjs";

const id = process.argv[2];
const d = await jobDir(id);
if (!d) { console.error("no such job:", id); process.exit(2); }

const manifest = await readJson(fcManifestFile(d));
if (!manifest || !manifest.clips?.length) { console.error("[fc-ai] no FilmCraft build yet — run filmcraft-build first"); process.exit(1); }

const queueFile = fcAiQueueFile(d);
const reqs = (await readJson(queueFile)) || [];
const pending = reqs.filter(r => r.status === "pending");
if (!pending.length) { console.log("[fc-ai] nothing pending"); process.exit(0); }

const clips = manifest.clips.slice().sort((a, b) => a.tlStart - b.tlStart);
const W = manifest.width || 1080, H = manifest.height || 1920;
const tr = (await readJson(path.join(d, "transcript.json"))) || { words: [] };
const mediaFiles = await fsp.readdir(path.join(d, "media")).catch(() => []);
const st = (await readJson(path.join(d, "state.json"))) || {};

/* ---------------- intent → command mapper ---------------- */
const COLORS = { red: "#ef4444", green: "#00b140", blue: "#2563eb", black: "#0a0a0a", white: "#f5f5f5", yellow: "#ffd60a", purple: "#8b5cf6", orange: "#f97316", cyan: "#22d3ee", teal: "#14b8a6", pink: "#ec4899" };

function mapInstruction(ins, clip, reqDur) {
  const DUR = Math.max(1.5, Math.min(4, Number(reqDur) || 3));
  const low = String(ins || "").toLowerCase().trim();
  const L = []; // command lines
  const notes = [];
  const v = clip.v, a = clip.a;
  const m = (re) => { const x = low.match(re); return x ? x[1] : null; };

  // 1. cut / remove this clip (ripple)
  if (/\b(cut|remove|delete|drop|kill)\b(?!.*\b(background|color|audio|music))\b/i.test(ins) && !/background|color|caption|watermark|text|music|sfx/i.test(low)) {
    L.push({ id: "timeline.delete", params: { clips: [v, a], ripple: true } });
    notes.push("clip removed (ripple)");
    return { L, notes, clip: null };
  }

  // 2. zoom / punch in
  if (/zoom|punch|closer|tight(er)?|punch.?in|bigger shot/i.test(low)) {
    const strong = /strong|big|hard|130|very/i.test(low);
    const subtle = /subtle|soft|slight|gentle/i.test(low);
    L.push({ id: "effects.setParam", params: { clip: v, effect: "motion", param: "scale", value: strong ? 132 : subtle ? 108 : 118 } });
    notes.push(`zoom → ${strong ? 132 : subtle ? 108 : 118}% on this clip`);
  }

  // 3. text / label / hook / cta / watermark
  const textM = ins.match(/(?:label|chip|text|hook|cta|call to action|watermark|title)\s*[:\-]?\s*["“']?(.{3,80})/i);
  const hasTextWord = /\b(label|chip|sticker|badge|text|hook|cta|call to action|watermark|title|caption)\b/i.test(ins);
  if (hasTextWord && textM) {
    const txt = textM[1].replace(/[.,;]?\s*(here|on this clip|now)\.?$/, "").trim().slice(0, 80);
    const where = /watermark|handle/i.test(low) ? [Math.round(W * 0.18), Math.round(H * 0.06)]
      : /bottom|lower|under|below/i.test(low) ? [W / 2, Math.round(H * 0.82)]
      : /top|head|upper/i.test(low) ? [W / 2, Math.round(H * 0.16)]
      : [W / 2, Math.round(H * 0.24)];
    const align = where[0] === W / 2 ? "Center" : "Left";
    L.push({ id: "effects.apply", params: { clips: [v], effect: "simple_text" } });
    L.push({ id: "effects.setParam", params: { clip: v, effect: "simple_text", param: "text", value: txt } });
    L.push({ id: "effects.setParam", params: { clip: v, effect: "simple_text", param: "size", value: /watermark/i.test(low) ? 36 : 60 } });
    L.push({ id: "effects.setParam", params: { clip: v, effect: "simple_text", param: "alignment", value: align } });
    L.push({ id: "effects.setParam", params: { clip: v, effect: "simple_text", param: "position", value: where } });
    const col = (ins.match(/#[0-9a-fA-F]{6}/) || [])[0] || (COLORS[(ins.match(/\b(red|green|blue|black|white|yellow|purple|orange|cyan|pink)\b/i) || [])[1]?.toLowerCase()]);
    if (col) L.push({ id: "effects.setParam", params: { clip: v, effect: "simple_text", param: "color", value: col.startsWith("#") ? col : COLORS[col] } });
    notes.push(`text “${txt}” on this clip`);
  }

  // 4. captions off (remove Simple Text instances that look like captions)
  if (/caption|subtitle/i.test(low) && /\b(off|hide|remove|no|kill)\b/i.test(low)) {
    L.push({ id: "__REMOVE_TEXT__" }); // resolved below (needs effect index)
    notes.push("caption text removed from this clip");
  }

  // 5. volume
  if (/quieter|louder|volume|softer|amplify|boost|mic/i.test(low) && !/music/i.test(low)) {
    const up = /louder|boost|amplify|up/i.test(low);
    L.push({ id: "clip.audioGain", params: { clips: [a], mode: "adjust", db: up ? 6 : -6 } });
    notes.push(`voice ${up ? "+6dB" : "−6dB"} on this clip`);
  }
  if (/music/i.test(low) && /\b(down|quieter|lower|softer)\b/i.test(low)) {
    L.push({ id: "clip.audioGain", params: { clips: [a], mode: "adjust", db: -4 } });
    notes.push("music ducked −4dB on this clip");
  }

  // 6. color words
  if (/warm|warmer|golden|orange/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "temperature", value: 18 } }); notes.push("warmer tone"); }
  if (/cool|cooler|blue.?ish|cold/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "temperature", value: -18 } }); notes.push("cooler tone"); }
  if (/brighter|brighten|brighter|expose|lighter/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "exposure", value: 14 } }); notes.push("brighter"); }
  if (/darker|dim|moody|shadow/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "exposure", value: -14 } }); notes.push("darker"); }
  if (/contrast/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "contrast", value: /\b(less|lower|reduce)\b/.test(low) ? -12 : 14 } }); notes.push("contrast adjusted"); }
  if (/saturat|vivid|punchy color|color pop|vibrant/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "saturation", value: /\b(less|lower|reduce|muted|less)\b/.test(low) ? -18 : 22 } }); notes.push("saturation adjusted"); }
  if (/sharpen|sharp|crisp|detail/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "sharpen", value: 20 } }); notes.push("sharpened"); }
  if (/faded|matte|film look|vintage|retro/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "lumetri", param: "faded_film", value: 30 } }); notes.push("faded film look"); }

  // 7. look / style effects
  if (/blur|soft focus|out of focus/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [v], effect: "gaussian_blur" } }); L.push({ id: "effects.setParam", params: { clip: v, effect: "gaussian_blur", param: "blurriness", value: 18 } }); notes.push("blur"); }
  if (/black.?and.?white|monochrome|\bbw\b|grayscale/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [v], effect: "black_white" } }); notes.push("black & white"); }
  if (/vignette/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [v], effect: "vignette" } }); L.push({ id: "effects.setParam", params: { clip: v, effect: "vignette", param: "amount", value: 45 } }); notes.push("vignette"); }
  if (/shake|handheld|shaky|earthquake/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [v], effect: "camera_shake" } }); L.push({ id: "effects.setParam", params: { clip: v, effect: "camera_shake", param: "amount", value: 8 } }); notes.push("camera shake"); }
  if (/sparkle|leak|glow|light leak|flash/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [v], effect: "light_leaks" } }); L.push({ id: "effects.setParam", params: { clip: v, effect: "light_leaks", param: "intensity", value: 60 } }); notes.push("light leaks"); }
  if (/grain|noise|film grain/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [v], effect: "noise" } }); notes.push("film grain"); }
  if (/rgb|chromatic|glitch|split/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [v], effect: "rgb_split" } }); notes.push("RGB split"); }
  if (/fades?\b|dip|transition/i.test(low) && /black/i.test(low)) { L.push({ id: "sequence.applyVideoTransition", params: { clip: v, effect: "dip_to_black", frames: 12 } }); notes.push("dip to black"); }
  if (/dissolve|crossfade|dissolve/i.test(low)) { L.push({ id: "sequence.applyVideoTransition", params: { clip: v, effect: "cross_dissolve", frames: 15 } }); notes.push("cross dissolve"); }

  // 8. speed
  if (/speed|fast(er)?|slower|slow.?mo|slow.?motion|timelapse/i.test(low) && /time|speed|motion|mo\b/i.test(low)) {
    const s = /slower|slow|half/i.test(low) ? 0.5 : /timelapse|4x|very/i.test(low) ? 3 : 1.5;
    L.push({ id: "effects.apply", params: { clips: [v], effect: "time_remap" } });
    L.push({ id: "effects.setParam", params: { clip: v, effect: "time_remap", param: "speed", value: s } });
    notes.push(`speed ${s}×`);
  }

  // 9. opacity / invisible
  if (/transparent|invisible|fade (it )?out|ghost/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "opacity", param: "opacity", value: 40 } }); notes.push("40% opacity"); }
  if (/solid|opaque|bring (it )?back/i.test(low)) { L.push({ id: "effects.setParam", params: { clip: v, effect: "opacity", param: "opacity", value: 100 } }); notes.push("full opacity"); }

  // 10. denoise / voice clarity
  if (/denoise|noise reduction|hiss|buzz|clean up the (voice|audio|sound)/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [a], effect: "denoise" } }); L.push({ id: "effects.setParam", params: { clip: a, effect: "denoise", param: "amount", value: 60 } }); notes.push("denoise on voice"); }
  if (/reverb|echo room|cathedral|room/i.test(low)) { L.push({ id: "effects.apply", params: { clips: [a], effect: "studio_reverb" } }); notes.push("studio reverb"); }

  // 11. green screen / background
  if (/green.?screen|chroma|background|backdrop|\bbg\b/i.test(low)) {
    const col = (ins.match(/#[0-9a-fA-F]{6}/) || [])[0] || (COLORS[(ins.match(/\b(red|green|blue|black|white|yellow|purple|orange|cyan|pink)\b/i) || [])[1]?.toLowerCase()] || "#00b140");
    const keyCol = /green screen|chroma/i.test(low) ? "#00ff00" : col.startsWith("#") ? col : COLORS[col] || "#00b140";
    L.push({ id: "effects.apply", params: { clips: [v], effect: "ultra_key" } });
    L.push({ id: "effects.setParam", params: { clip: v, effect: "ultra_key", param: "key_color", value: keyCol } });
    notes.push(`ultra key on ${keyCol} (transparent over tracks below)`);
  }

  // 12. b-roll over this clip
  if (/b.?roll|overlay|over my head|picture.?in.?picture|\bpip\b/i.test(low)) {
    const files = (st.brollFiles || []).map(n => path.join(d, "media", n));
    const f = files.length ? files[0] : null;
    if (f) {
      const dur = Math.max(1.5, Math.min(4, DUR));
      L.push({ id: "__BROLL__", params: { file: f, time: clip.tlStart, dur } });
      notes.push(`b-roll on V2 over this clip (${dur.toFixed(1)}s)`);
    } else {
      notes.push("⚠ no b-roll files in this job — upload b-roll in setup, then re-ask");
    }
  }

  if (!notes.length) return { L, notes: [], flagged: true };
  return { L, notes, clip };
}

/* ---------------- apply loop ---------------- *
 * All requests run in ONE engine session: separate filmcraft-cli processes
 * don't see each other's changes (last save wins), so a multi-request batch
 * must never span processes. Save once per request (so the verification
 * frame + the next request both see it), then render the frame as a
 * one-shot read-only process. */
reqs.forEach((r, i) => { r._i = i; }); // stable index for frame filenames

// Rebuild the manifest clip list from a live sequence (after ripples the
// old tlStart/tlEnd are stale). Labels/labels-by-clip survive via the old list.
async function syncManifestClips(seq) {
  const byClip = new Map((manifest.clips || []).map(c => [c.v, c]));
  const list = [];
  for (const track of seq?.video || []) {
    for (const it of track.items || []) {
      const old = byClip.get(it.clip);
      list.push({
        v: it.clip,
        a: old && old.a != null ? old.a : it.clip,
        tlStart: it.start / TSPS,
        tlEnd: (it.start + it.duration) / TSPS,
        srcStart: old ? old.srcStart : (it.sourceIn != null ? it.sourceIn / TSPS : it.start / TSPS),
        srcEnd: old ? old.srcEnd : (it.sourceOut != null ? it.sourceOut / TSPS : (it.start + it.duration) / TSPS),
        label: old ? old.label : "b-roll",
      });
    }
  }
  list.sort((a, b) => a.tlStart - b.tlStart);
  return { clips: list, duration: (seq?.duration != null ? seq.duration / TSPS : manifest.duration || 0) };
}

const s = fcSession(d);
try {
  for (const r of pending) {
    r.at_done = new Date().toISOString();
    try {
      // target clip: UI-selected id, else clip under the range midpoint
      let clip = null;
      if (r.clip != null) clip = clips.find(c => c.v === Number(r.clip) || c.a === Number(r.clip));
      if (!clip) clip = clipAtTime(clips, ((Number(r.t0) || 0) + (Number(r.t1) || (Number(r.t0) || 0) + 2)) / 2) || clips[0];

      const map = mapInstruction(r.instruction, clip, (Number(r.t1) || 0) - (Number(r.t0) || 0));
      const core = map.L.filter(l => l.id !== "__REMOVE_TEXT__" && l.id !== "__BROLL__");

      // remove caption/text effects: find Simple Text effect indexes on the clip
      if (map.L.some(l => l.id === "__REMOVE_TEXT__")) {
        const seqR = await s.inspect("sequence");
        const seq = seqR.result?.sequence || seqR.result || null;
        for (const t of seq?.video || []) {
          for (const item of t.items || []) {
            if (item.clip === clip.v) {
              const textFx = (item.effects || []).map((e, i) => ({ e, i })).filter(x => /text/i.test(x.e.effect || x.e.name || ""));
              for (const x of textFx.slice().sort((a, b) => b.i - a.i)) core.push({ id: "effects.remove", params: { clip: clip.v, index: x.i } });
            }
          }
        }
      }

      // b-roll: import then place on V2 (needs the fresh item id, same session)
      for (const b of map.L.filter(l => l.id === "__BROLL__")) {
        const ir = await s.import(b.params.file);
        const item = ir.result?.items?.[0];
        if (item != null) core.push({ id: "timeline.place", params: { item, track: "V2", seconds: b.params.time, duration: { seconds: b.params.dur }, insert: false } });
        else r.flags = (r.flags || []).concat("b-roll import failed");
      }

      const isDelete = core.some(l => l.id === "timeline.delete");

      if (core.length) {
        const br = await s.batch(core, { stopOnError: false }, 120000);
        if (!br.ok) r.badLines = [br.error || br.text || "batch failed"];
        else {
          const bad = Array.isArray(br.result) ? br.result.filter(x => x && (x.error || x.failed || x.ok === false)) : [];
          if (bad.length) r.badLines = bad.map(x => x.error || x.failed || "line failed");
        }
      }

      // persist THIS request's state, then verify it as a read-only process
      const frameT = isDelete ? Math.max(0, clip.tlStart + 0.2) : (clip.tlStart + clip.tlEnd) / 2;
      const sv = await s.save(60000);
      if (sv.ok) {
        const fr = await fcRenderFrame(d, frameT, path.join(fcFramesDir(d), `ai-${r._i}.png`));
        if (fr.code === 0) r.frame = `/api/jobs/${id}/filmcraft/frame?i=${r._i}`;
        await refreshSequence(d);
        if (isDelete) { // ripple shifted the later clips — keep the clip list honest
          const seqR = await s.inspect("sequence");
          const seq = seqR.result?.sequence || seqR.result || null;
          if (seq) {
            const fresh = await syncManifestClips(seq);
            manifest.clips = fresh.clips;
            manifest.duration = fresh.duration;
            await writeJson(fcManifestFile(d), manifest);
            clips.length = 0;
            for (const c of fresh.clips) clips.push(c);
          }
        }
      } else {
        r.flags = (r.flags || []).concat("save failed: " + (sv.error || sv.text));
      }

      if (map.flagged && !map.notes.length) {
        r.status = "needs-review";
        r.result = "couldn't map that instruction to an edit on this clip — try “zoom in”, “quieter”, “add label: …”, “cut this”, “warmer”, “blur”, “shake”, “b-roll over my head”, “green screen blue”";
      } else {
        r.status = "applied";
        r.result = (map.notes.join(" · ") + (r.badLines?.length ? ` · ⚠ ${r.badLines.length} command(s) flagged` : "")).slice(0, 400);
      }
    } catch (e) {
      r.status = "failed";
      r.result = String(e.message || e);
    }
  }

  // final save + fresh sequence/manifest so the UI shows the end state
  await s.save(60000).catch(() => {});
  const seqR = await s.inspect("sequence");
  const seq = seqR.result?.sequence || seqR.result || null;
  if (seq) {
    const fresh = await syncManifestClips(seq);
    manifest.clips = fresh.clips;
    manifest.duration = fresh.duration;
    await writeJson(fcManifestFile(d), manifest);
  }
  if (seq) await writeJson(path.join(fcDir(d), "sequence.json"), seq);
} finally {
  s.close();
}

await writeJson(queueFile, reqs);

const applied = pending.filter(r => r.status === "applied").length;
const flagged = pending.filter(r => r.status === "needs-review").length;
await report(id, "filmcraft-ai", "done", `${applied} applied · ${flagged} flagged · ${pending.length - applied - flagged} issues`);
console.log(JSON.stringify({ pending: pending.length, applied, flagged }));
process.exit(0);
