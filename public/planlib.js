/*
 * planlib.js — the single source of truth for how an edit is laid out and drawn.
 * Used by BOTH the browser preview (composition.html) and the headless-Chrome
 * renderer (scripts/render.mjs), so what you review is exactly what exports.
 *
 * Pure JS. No dependencies. UMD-ish: works in browser (window.PlanLib) and Node
 * (module.exports). Node requires the browser-global-free paths only
 * (deriveSegments, layoutAt, totalDuration, buildAudioPlan, wordTimeline).
 * drawFrame is browser-only (needs Canvas 2D).
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = lib;
  root.PlanLib = lib;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const FPS = 30;
  const MAX_CAPTION_WORDS = 7;

  function aspectSize(aspect) {
    return aspect === "16:9"
      ? { w: 1920, h: 1080 }
      : { w: 1080, h: 1920 }; // default 9:16
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function easeOutCubic(x) { return 1 - Math.pow(1 - clamp01(x), 3); }
  function easeOutBack(x) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(clamp01(x) - 1, 3) + c1 * Math.pow(clamp01(x) - 1, 2);
  }

  /* ------------------------------------------------------------------ *
   * Segments: the cut list is word-index based. A word is CUT if it is
   * in plan.cuts.words or inside any range in plan.cuts.ranges.
   * Segments are maximal runs of kept words with small gaps (<= GAP_SEC)
   * between consecutive kept words. We only ever cut BETWEEN words.
   * ------------------------------------------------------------------ */
  const GAP_SEC = 0.85;
  const PAD_SEC = 0.05; // pad each side so consonants are not clipped

  function isWordCut(i, cuts) {
    if (!cuts) return false;
    if (cuts.words && cuts.words.indexOf(i) !== -1) return true;
    if (cuts.ranges) {
      for (const r of cuts.ranges) {
        if (i >= r[0] && i <= r[1]) return true;
      }
    }
    return false;
  }

  function deriveSegments(words, cuts) {
    const kept = words
      .map((w, i) => ({ w, i, cut: isWordCut(i, cuts) }))
      .filter(x => !x.cut);
    const segs = [];
    let cur = null;
    let prev = null;
    for (const x of kept) {
      const canMerge =
        prev &&
        prev.i + 1 === x.i &&               // adjacent in original (nothing cut between)
        x.w.start - (prev.w.end != null ? prev.w.end : prev.w.start) <= GAP_SEC;
      if (cur && canMerge) {
        cur.srcEnd = Math.max(cur.srcEnd, x.w.end != null ? x.w.end : x.w.start + 0.2);
      } else {
        cur = {
          srcStart: Math.max(0, x.w.start - PAD_SEC),
          srcEnd: x.w.end != null ? x.w.end + PAD_SEC : x.w.start + 0.25,
        };
        segs.push(cur);
      }
      prev = x;
    }
    // drop segments too short to be usable
    const usable = segs.filter(s => s.srcEnd - s.srcStart >= 0.3);
    // assign timeline positions (no gaps between kept segments)
    let tl = 0;
    for (const s of usable) {
      s.tlStart = tl;
      tl += s.srcEnd - s.srcStart;
      s.tlEnd = tl;
    }
    return usable;
  }

  function totalDuration(segments) {
    return segments.length ? segments[segments.length - 1].tlEnd : 0;
  }

  /* Map kept words onto the timeline (for captions / transcript panel). */
  function wordTimeline(words, segments, cuts) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
      if (isWordCut(i, cuts)) continue;
      const w = words[i];
      let tl = null;
      for (const s of segments) {
        if (w.start >= s.srcStart - 0.001 && w.start <= s.srcEnd + 0.001) {
          tl = s.tlStart + (w.start - s.srcStart);
          break;
        }
      }
      if (tl != null) out.push({ i, word: w.word, start: tl, end: tl + (w.end - w.start), line: w.line != null ? w.line : -1 });
    }
    return out;
  }

  function segmentAt(segments, t) {
    for (const s of segments) if (t >= s.tlStart - 1e-6 && t < s.tlEnd) return s;
    return null;
  }

  function activeWordAt(wordTL, t) {
    let best = null;
    for (const w of wordTL) {
      if (t >= w.start - 0.03 && t < w.end + 0.03) { best = w; break; }
    }
    if (!best) { // nearest previous word within 1.2s (holds caption over pauses)
      for (let i = wordTL.length - 1; i >= 0; i--) {
        const w = wordTL[i];
        if (w.end <= t && t - w.end <= 1.2) { best = w; break; }
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * layoutAt(t): pure description of one frame. Same math in preview
   * and render. All times in seconds of the FINAL timeline.
   * ------------------------------------------------------------------ */
  function layoutAt(t, state) {
    const { segments, plan, words, wordTL, duration } = state;
    const size = aspectSize(plan.aspect || "9:16");
    const L = {
      W: size.w, H: size.h, t,
      base: null, broll: null, zoom: 1,
      color: {
        brightness: (plan.color && plan.color.brightness) || 1.0,
        contrast: (plan.color && plan.color.contrast) || 1.0,
        saturation: (plan.color && plan.color.saturation) || 1.0,
      },
      caption: null, hook: null, cta: null,
      motion: [],
      accent: ACCENT,
      watermark: null,
    };
    // One accent across the edit: the hook/brand color the user picked wins,
    // yellow is the default. Drives caption highlight, hook underline, CTA.
    if (plan.hook && plan.hook.color && plan.hook.color !== "#000000") L.accent = plan.hook.color;
    if (plan.watermark && String(plan.watermark.text || "")) L.watermark = plan.watermark;

    const seg = segmentAt(segments, t);
    if (seg) L.base = { file: plan.baseFile || "media/base.mp4", srcT: seg.srcStart + (t - seg.tlStart), segIdx: segments.indexOf(seg) };

    // b-roll overlays (absolute positions on final timeline)
    if (plan.broll) {
      for (const b of plan.broll) {
        if (t >= b.tlStart && t <= b.tlStart + b.dur) { L.broll = b; break; }
      }
    }

    // zoom cuts: punch-in at the start of flagged segments
    if (L.base && plan.zooms) {
      const local = t - (L.base ? 0 : 0); // computed below with seg
      const seg0 = segmentAt(segments, t);
      if (seg0 && plan.zooms.indexOf(segments.indexOf(seg0)) !== -1) {
        const segLocal = t - seg0.tlStart;
        const p = clamp01(1 - segLocal / 0.8); // 1 -> 0 over 0.8s
        L.zoom = 1 + 0.09 * easeOutCubic(p);
      }
    }

    // word-by-word captions: a sliding window of words around the active one
    if (plan.captions && plan.captions.enabled !== false) {
      const aw = activeWordAt(wordTL, t);
      if (aw) {
        const maxW = Math.max(1, Number(plan.captions.maxWords) || MAX_CAPTION_WORDS);
        const pos = wordTL.indexOf(aw);
        const a = Math.max(0, pos - Math.floor(maxW / 2)), b = Math.min(wordTL.length, a + maxW);
        const win = wordTL.slice(a, b);
        L.caption = {
          text: win.map(w => w.word),
          idx: pos - a,
          style: (plan.captions && plan.captions.style) || "bold",
          size: Number(plan.captions.size) || 0,       // 0 = auto (H * 0.042)
          color: plan.captions.color || "#ffffff",
          font: plan.captions.font || "",              // "" = default stack
          outline: plan.captions.outline !== false,
          wp: clamp01((t - aw.start) / Math.max(0.18, aw.end - aw.start)), // active-word progress (0→1)
        };
      }
    }

    // hook (opening title card over first seconds)
    if (plan.hook && plan.hook.text) {
      const hd = plan.hook.dur || 2.6;
      if (t < hd) {
        const p = clamp01(t / 0.45);
        L.hook = { text: plan.hook.text, pop: easeOutBack(p), fade: t > hd - 0.3 ? clamp01((hd - t) / 0.3) : 1, color: plan.hook.color || null };
      }
    }

    // call-to-action card at the end
    if (plan.cta && plan.cta.text) {
      const cd = plan.cta.dur || 3.0;
      if (t > duration - cd && duration > 0) {
        const p = clamp01((t - (duration - cd)) / 0.4);
        L.cta = { text: plan.cta.text, slide: easeOutCubic(p) };
      }
    }

    // motion graphics (burst / pulse / sweep / chip) — deterministic, time-driven
    if (plan.motion) {
      for (const mo of plan.motion) {
        const t0 = Number(mo.t) || 0, dur = Math.max(0.2, Number(mo.dur) || 1);
        if (t >= t0 && t <= t0 + dur) L.motion.push({ type: mo.type, p: (t - t0) / dur, color: mo.color || ACCENT, x: mo.x != null ? mo.x : 0.5, y: mo.y != null ? mo.y : 0.5, text: mo.text || "" });
      }
    }

    return L;
  }

  /* ------------------------------------------------------------------ *
   * drawFrame: canvas 2D rendering of a layout. Browser only.
   * ------------------------------------------------------------------ */
  function drawFrame(ctx, L, assets, plan) {
    const { W, H } = L;
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    const colorStr =
      `brightness(${L.color.brightness}) contrast(${L.color.contrast}) saturate(${L.color.saturation})`;

    // base video, cover-crop with zoom
    let v = L.base && assets.base;
    if (v && v.videoWidth) {
      ctx.save();
      ctx.filter = colorStr;
      drawCover(ctx, v, 0, 0, W, H, L.zoom);
      ctx.restore();
    }

    // b-roll over base
    if (L.broll && assets.broll && assets.broll[L.broll.file]) {
      const b = assets.broll[L.broll.file];
      if (b.videoWidth) {
        ctx.save();
        ctx.filter = colorStr;
        if (L.broll.style === "inset") {
          const mw = W * 0.78, mh = mw * (b.videoHeight / b.videoWidth);
          const mhCap = H * 0.34;
          const h = Math.min(mh, mhCap), w = h * (b.videoWidth / b.videoHeight);
          const x = (W - w) / 2, y = H * 0.06;
          ctx.globalAlpha = Math.min(1, L.broll.dur - (L.t - L.broll.tlStart) > 0.2 ? 1 : (L.broll.dur - (L.t - L.broll.tlStart)) / 0.2);
          roundRect(ctx, x, y, w, h, 18);
          ctx.clip();
          drawCover(ctx, b, x, y, w, h, 1);
          ctx.globalAlpha = 1;
          // border
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 4;
          roundRect(ctx, x, y, w, h, 18);
          ctx.stroke();
        } else {
          drawCover(ctx, b, 0, 0, W, H, 1);
        }
        ctx.restore();
      }
    }

    // readability scrim — soft top/bottom gradients over the footage (and any
    // b-roll) so captions and the hook always read, on any shot
    if (L.base || L.broll) {
      ctx.save();
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "rgba(0,0,0,0.30)");
      g.addColorStop(0.24, "rgba(0,0,0,0)");
      g.addColorStop(0.70, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.46)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // motion graphics (over the footage, under the text)
    if (L.motion && L.motion.length) drawMotion(ctx, L, W, H);

    // caption (word-by-word)
    if (L.caption) drawCaption(ctx, L, W, H);

    // hook
    if (L.hook) drawHook(ctx, L, W, H);

    // cta
    if (L.cta) drawCta(ctx, L, W, H);

    // creator watermark / handle (top layer)
    if (L.watermark) drawWatermark(ctx, L, W, H);

    ctx.restore();
  }

  function drawCover(ctx, v, x, y, w, h, zoom) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.max(w / vw, h / vh) * zoom;
    const sw = w / scale, sh = h / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.drawImage(v, sx, sy, sw, sh, x, y, w, h);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const ACCENT = "#ffd60a";

  /* Motion graphics — pure functions of (t, params), identical in preview
     and headless render. p is 0→1 across the effect's duration. */
  function drawMotion(ctx, L, W, H) {
    for (const m of L.motion) {
      const p = m.p, color = m.color || ACCENT;
      const x = (m.x != null ? m.x : 0.5) * W, y = (m.y != null ? m.y : 0.5) * H;
      ctx.save();
      if (m.type === "burst") {
        // radial particle burst with a leading flash
        if (p < 0.3) {
          ctx.globalAlpha = (0.3 - p) / 0.3 * 0.5;
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(x, y, H * 0.10 * (p / 0.3), 0, 7); ctx.fill();
        }
        const R = H * 0.24, N = 14;
        ctx.globalAlpha = Math.max(0, 1 - p);
        ctx.strokeStyle = color;
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2 + Math.sin(i * 7.3) * 0.22;
          const r0 = (H * 0.02 + R * easeOutCubic(p)) * (0.75 + 0.25 * Math.sin(i * 3.1));
          const r1 = r0 + H * 0.028 * (1 - p * 0.5);
          ctx.lineWidth = 5 * (1 - p) + 2;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
          ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
          ctx.stroke();
        }
      } else if (m.type === "pulse") {
        // concentric expanding rings
        for (let i = 0; i < 3; i++) {
          const pi = clamp01((p - i * 0.14) / 0.86);
          if (pi <= 0) continue;
          ctx.globalAlpha = (1 - pi) * 0.85;
          ctx.strokeStyle = color;
          ctx.lineWidth = 7 - 4 * pi;
          ctx.beginPath(); ctx.arc(x, y, H * 0.05 + pi * H * 0.26, 0, 7); ctx.stroke();
        }
      } else if (m.type === "sweep") {
        // highlight bar sweeping left → right, then fading
        const grow = easeOutCubic(clamp01(p / 0.7));
        const fade = p > 0.7 ? clamp01((1 - p) / 0.3) : 1;
        ctx.globalAlpha = fade;
        ctx.fillStyle = color;
        roundRect(ctx, W * 0.08, y * H - 5, W * 0.84 * grow, 10, 5);
        ctx.fill();
        if (grow < 1) { // bright head while sweeping
          ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.arc(W * 0.08 + W * 0.84 * grow, y * H, 9, 0, 7); ctx.fill();
        }
      } else if (m.type === "chip") {
        // pop-in label pill
        const pop = easeOutBack(clamp01(p / 0.35));
        const fade = p > 0.78 ? clamp01((1 - p) / 0.22) : 1;
        ctx.globalAlpha = fade;
        const fs = Math.round(H * 0.026 * pop);
        ctx.font = `800 ${fs}px 'Inter',Arial,sans-serif`;
        const txt = m.text || "•";
        const tw = ctx.measureText(txt).width;
        const pw = tw + fs * 1.6, ph = fs * 2.0;
        const cx = x, cy = y;
        ctx.fillStyle = "rgba(10,10,14,0.82)";
        roundRect(ctx, cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
        ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 3;
        roundRect(ctx, cx - pw / 2, cy - ph / 2, pw, ph, ph / 2);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(txt, cx, cy + fs * 0.05);
        ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
      }
      ctx.restore();
    }
  }

  function wrapWords(ctx, words, font, maxWidth) {
    ctx.font = font;
    const lines = [];
    let line = [];
    let width = 0;
    const space = ctx.measureText(" ").width;
    for (const w of words) {
      const ww = ctx.measureText(w).width;
      if (width + ww > maxWidth && line.length) { lines.push(line); line = [w]; width = ww; }
      else { line.push(w); width += ww + space; }
    }
    if (line.length) lines.push(line);
    return lines;
  }

  function drawCaption(ctx, L, W, H) {
    const cap = L.caption;
    const fs = cap.size ? Math.round(cap.size * (H / 1080)) : Math.round(H * 0.042);
    const fam = cap.font && cap.font !== "Impact (default)"
      ? `"${cap.font.replace(/[()]/g, "")}"`
      : cap.font === "Impact (default)" ? "Impact"
      : "'Inter','Arial Black',Arial,sans-serif";
    const font = `800 ${fs}px ${fam}`;
    const words = cap.text;
    const lines = wrapWords(ctx, words, font, W * 0.86);
    const yBase = H * 0.80;
    const lineH = fs * 1.28;
    const startY = yBase - (lines.length - 1) * lineH;
    ctx.font = font;
    ctx.textBaseline = "alphabetic";
    // figure out which wrapped-line + column holds the active word
    let col = 0;
    const activeCell = lines.reduce((acc, line, li) => {
      const n = line.length;
      if (cap.idx >= acc.col && cap.idx < acc.col + n) return { li, ci: cap.idx - acc.col };
      acc.col += n;
      return acc;
    }, { col: 0, li: -1, ci: -1 });
    let col2 = 0;
    lines.forEach((line, li) => {
      const space = ctx.measureText(" ").width;
      const total = line.reduce((a, w) => a + ctx.measureText(w).width, 0) + space * (line.length - 1);
      let x = (W - total) / 2;
      const y = startY + li * lineH;
      line.forEach((w, ci) => {
        const ww = ctx.measureText(w).width;
        const active = li === activeCell.li && ci === activeCell.ci;
        ctx.save();
        ctx.lineJoin = "round";
        if (active && cap.wp != null) {
          // active word swells slightly mid-spoken — alive, not static
          const pop = 1 + 0.09 * Math.sin(cap.wp * Math.PI);
          ctx.translate(x + ww / 2, y - fs * 0.35);
          ctx.scale(pop, pop);
          ctx.translate(-(x + ww / 2), -(y - fs * 0.35));
        }
        if (cap.outline !== false) {
          ctx.lineWidth = fs * 0.22;
          ctx.strokeStyle = "rgba(0,0,0,0.9)";
        }
        ctx.fillStyle = active ? L.accent : (cap.color || "#ffffff");
        if (active) { ctx.shadowColor = accentGlow(L.accent); ctx.shadowBlur = fs * 0.5; }
        if (cap.outline !== false) ctx.strokeText(w, x, y);
        ctx.fillText(w, x, y);
        ctx.restore();
        x += ww + space;
      });
    });
  }

  function drawHook(ctx, L, W, H) {
    const h = L.hook;
    ctx.save();
    ctx.globalAlpha = h.fade;
    const fs = Math.round(H * 0.052);
    const font = `900 ${fs}px 'Inter','Arial Black',Arial,sans-serif`;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const cy = H * 0.30;
    const lines = wrapLines(ctx, h.text, W * 0.84);
    const lineH = fs * 1.22;
    const totalH = lines.length * lineH;
    const cx = W / 2;
    // dark backing pill
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(ctx, cx - maxW / 2 - fs * 0.7, cy - totalH / 2 - fs * 0.5, maxW + fs * 1.4, totalH + fs, fs * 0.6);
    ctx.fill();
    ctx.restore();
    const scale = 0.6 + 0.4 * h.pop;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    const ink = h.color && h.color !== "#000000" ? h.color : "#ffffff";
    lines.forEach((ln, i) => {
      const y = cy - totalH / 2 + lineH * (i + 0.5);
      ctx.lineWidth = fs * 0.22;
      ctx.lineJoin = "round";
      ctx.strokeStyle = h.color === "#000000" ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.9)";
      ctx.fillStyle = ink;
      ctx.strokeText(ln, cx, y);
      ctx.fillText(ln, cx, y);
    });
    // accent underline bar — grows in with the pop (the "designed" touch)
    const barColor = (ink === L.accent) ? "#ffffff" : L.accent;
    const barW = Math.min(maxW * 0.6, W * 0.42), barH = Math.max(5, fs * 0.13);
    ctx.fillStyle = barColor;
    const bw = barW * h.pop;
    if (bw > 2) { roundRect(ctx, cx - bw / 2, cy + totalH / 2 + fs * 0.42, bw, barH, barH / 2); ctx.fill(); }
    ctx.restore();
  }

  function accentGlow(color) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(color || "");
    if (!m) return "rgba(255,214,10,0.55)";
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.55)`;
  }

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxWidth && line) { lines.push(line); line = w; }
      else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawCta(ctx, L, W, H) {
    const c = L.cta;
    ctx.save();
    const cardW = W * 0.86;
    const cardH = H * 0.16;
    const cardX = (W - cardW) / 2;
    const cardY = H * 0.84 - cardH + (1 - c.slide) * cardH * 0.6;
    ctx.globalAlpha = Math.min(1, c.slide * 1.4);
    const grad = ctx.createLinearGradient(cardX, 0, cardX + cardW, 0);
    grad.addColorStop(0, "#111827");
    grad.addColorStop(1, "#1f2937");
    ctx.fillStyle = grad;
    roundRect(ctx, cardX, cardY, cardW, cardH, cardH * 0.28);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 3;
    roundRect(ctx, cardX, cardY, cardW, cardH, cardH * 0.28);
    ctx.stroke();
    const fs = Math.round(cardH * 0.34);
    ctx.font = `800 ${fs}px 'Inter',Arial,sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = L.accent;
    const txt = c.text.length > 34 ? c.text.slice(0, 33) + "…" : c.text;
    ctx.fillText(txt, W / 2, cardY + cardH / 2);
    // accent base strip — ties the card to the rest of the edit
    ctx.fillStyle = L.accent;
    const sw = cardW * 0.32;
    roundRect(ctx, W / 2 - sw / 2, cardY + cardH - cardH * 0.09, sw, cardH * 0.055, cardH * 0.03);
    ctx.fill();
    ctx.restore();
  }

  function drawWatermark(ctx, L, W, H) {
    const wm = L.watermark;
    const fs = Math.round(H * (Number(wm.size) || 0.024));
    ctx.save();
    ctx.font = `700 ${fs}px 'Inter','Arial Black',Arial,sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const x = W * (wm.x != null ? wm.x : 0.05), y = H * (wm.y != null ? wm.y : 0.045);
    const w = ctx.measureText(wm.text).width;
    ctx.globalAlpha = wm.alpha != null ? wm.alpha : 0.92;
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    roundRect(ctx, x - fs * 0.45, y - fs * 0.38, w + fs * 0.9, fs * 1.6, fs * 0.8);
    ctx.fill();
    ctx.fillStyle = wm.color || "#ffffff";
    ctx.fillText(wm.text, x, y);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ *
   * Audio plan (Node-side). Deterministic ffmpeg filter graph.
   * ------------------------------------------------------------------ */
  function buildAudioPlan(state) {
    const { segments, plan } = state;
    const parts = [];
    let i = 0;
    for (const s of segments) {
      const ms = Math.round(s.tlStart * 1000);
      // adelay channel list is pipe-separated; ':' is the option separator
      // (adelay=8750:8750 would set the boolean option 'all'=8750 → error)
      parts.push(
        `[0:a]atrim=start=${s.srcStart.toFixed(3)}:end=${s.srcEnd.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[v${i}]`
      );
      i++;
    }
    // voice bus
    let graph = parts.join(";");
    const vol = plan.audio && plan.audio.volume != null ? plan.audio.volume : 1.0;
    graph += `;${parts.map((_, k) => `[v${k}]`).join("")}amix=inputs=${segments.length}:normalize=0,volume=${vol},alimiter=limit=0.98[vocmix]`;
    const mixers = ["[vocmix]"];
    let inputIdx = 1; // 0 = voice source
    if (plan.music && plan.music.file) {
      const mv = plan.music.volume != null ? plan.music.volume : 0.18;
      graph += `;[${inputIdx}:a]volume=${mv},atrim=0:${state.duration.toFixed(3)},asetpts=PTS-STARTPTS,alimiter=limit=0.95[mus]`;
      mixers.push("[mus]");
      inputIdx++;
    }
    if (plan.sfx && plan.sfx.clips && plan.sfx.clips.length) {
      plan.sfx.clips.forEach((c, k) => {
        const ms = Math.round(Math.max(0, c.t) * 1000);
        const cv = c.vol != null ? c.vol : 0.5;
        graph += `;[${inputIdx}:a]adelay=${ms}|${ms},volume=${cv}[s${k}]`;
        inputIdx++;
        mixers.push(`[s${k}]`);
      });
    }
    const N = mixers.length;
    graph += N === 1
      ? `;[vocmix]aformat=sample_rates=44100:channel_layouts=stereo[outa]`
      : `;${mixers.join("")}amix=inputs=${N}:normalize=0,alimiter=limit=0.95,aformat=sample_rates=44100:channel_layouts=stereo[outa]`;
    return { filter_complex: graph, nIn: inputIdx };
  }

  /* Full state object for a job: segments + word timeline + canvas size. */
  function deriveAll(words, plan) {
    const size = aspectSize((plan && plan.aspect) || "9:16");
    const cuts = (plan && plan.cuts) || null;
    const segments = deriveSegments(words, cuts);
    return {
      segments,
      wordTL: wordTimeline(words, segments, cuts),
      W: size.w, H: size.h,
      plan: plan || {},
      words: words || [],
      duration: totalDuration(segments),
    };
  }

  return {
    FPS, MAX_CAPTION_WORDS, GAP_SEC, PAD_SEC,
    aspectSize, clamp01, easeOutCubic, easeOutBack,
    isWordCut, deriveSegments, totalDuration, wordTimeline, deriveAll,
    segmentAt, activeWordAt, layoutAt, drawFrame, drawCover, roundRect,
    wrapWords, wrapLines, drawCaption, drawHook, drawCta, buildAudioPlan,
    ACCENT,
  };
});
