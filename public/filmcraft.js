/* ================================================================
   FilmCraft NLE — Premiere-style editor, driven by the local
   FilmCraft engine through /api/jobs/<id>/fc/*.
   Time in the API is SECONDS (the lib normalizes ticks); keyframe
   ops are the exception (raw ticks in, clip-relative seconds out).
   ================================================================ */
(() => {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const TSPS = 254016000000; // ticks per second (engine unit)
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const tc = (t) => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${(s < 10 ? "0" : "") + s.toFixed(1)}s`;
  };

  const st = {
    id: null,
    S: null,          // latest /fc/state
    sel: null,        // {clip, track, kind, name}
    ph: 0,            // playhead (seconds)
    pps: null,        // px per second (null = fit)
    snap: true,
    phase: "none",    // none | building | rendering | ready | failed
    ai: [],
    playing: false,
    stale: false,     // edited since last Render
    frameSeq: 0,
    wired: false,
    fxCatalog: null,  // [{name, id, kind}]
  };

  /* ---------- api ---------- */
  async function api(p, o) {
    const r = await fetch(p, o);
    let j = null;
    try { j = await r.json(); } catch { /* binary or empty */ }
    return { ok: r.ok, status: r.status, j };
  }
  const base = () => `/api/jobs/${st.id}/fc`;
  async function refresh() {
    const r = await api(`${base()}/state`);
    if (!r.ok) return null;
    st.S = r.j;
    return r.j;
  }
  /** Apply an edit (one undo step). Returns true on success. */
  async function edit(steps, { ripple = false, label = "edit" } = {}) {
    if (!st.S?.busy) setBusy(true);
    const r = await api(`${base()}/edit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps, ripple, label }),
    });
    setBusy(false);
    if (r.j && r.j.state) st.S = r.j.state;
    const bad = r.j && r.j.results?.filter(x => !x.ok);
    if (!r.ok || bad?.length) {
      const msg = r.j?.error || bad?.map(b => `${b.id}: ${b.error}`).join(" · ").slice(0, 160) || "edit failed";
      note("⚠ " + msg, true);
      if (bad?.length === steps.length) { await refresh(); renderAll(); return false; }
    }
    markStale();
    renderAll();
    requestFrame();
    return true;
  }
  async function undoRedo(kind) {
    const r = await api(`${base()}/${kind}`, { method: "POST" });
    if (r.j && r.j.state) { st.S = r.j.state; markStale(); renderAll(); requestFrame(); }
    return !!r.ok;
  }
  function markStale() { if (st.phase === "ready") st.stale = true; }
  let noteTimer = null;
  function note(msg, bad = false) {
    const el = $("#fcChip");
    el.textContent = msg;
    el.className = "fc-chip " + (bad ? "err" : "busy");
    clearTimeout(noteTimer);
    noteTimer = setTimeout(chip, 4000);
  }
  function chip(msg) {
    const el = $("#fcChip");
    const map = { ready: "ready", building: "building FilmCraft project…", rendering: "rendering MP4…", failed: "failed", none: st.stale ? "edited — Render to refresh the preview" : "ready" };
    el.textContent = map[st.phase] || "idle" + (msg ? " — " + msg : "");
    el.className = "fc-chip " + ({ ready: "ok", building: "busy", rendering: "busy", failed: "err" }[st.phase] || "");
  }
  function setBusy(b) { if (st.S) st.S.busy = b; $$("#fcEditor .fc-btn, #fcEditor select").forEach(e => { if (!e.closest(".fc-ai-res")) e.disabled = b && !["fcPlay", "fcStepB", "fcStepF", "fcToStart"].includes(e.id); }); }

  /* ---------- selection ---------- */
  function findClip(clipId) {
    const seq = st.S?.sequence; if (!seq) return null;
    for (const kind of ["video", "audio"])
      for (const t of seq[kind])
        for (const c of t.clips)
          if (String(c.id) === String(clipId)) return { clip: c, track: t, kind };
    return null;
  }
  function select(clipId) {
    const f = findClip(clipId);
    st.sel = f ? { clipId, clip: f.clip, track: f.track, kind: f.kind } : null;
    renderSelection(); renderInspector(); renderAiScope();
  }
  function selName() {
    if (!st.sel) return null;
    const m = (st.S?.media || []).find(x => x.id === st.sel.clip.item);
    return m?.name || `clip ${st.sel.clipId}`;
  }

  /* ---------- entry ---------- */
  async function openFilmCraft(id) {
    if (st.id && st.id !== id) { try { $("#fcVid").pause(); } catch { } $("#fcVid").removeAttribute("src"); }
    st.id = id; st.sel = null; st.ai = []; st.ph = 0; st.stale = false;
    const sec = $("#fcEditor");
    sec.classList.remove("hidden");
    sec.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!st.wired) wire();
    chip();
    if (!st.S || st.S._id !== id) await enter(id);
    else { renderAll(); requestFrame(); }
  }
  async function enter(id) {
    st.S = await refresh();
    if (!st.S) {
      setPhase("building", "no FilmCraft project yet — building…");
      const ok = await ensureBuilt();
      if (!ok) return;
      st.S = await refresh();
    }
    st.S._id = id;
    st.ph = st.S.sequence?.playhead || 0;
    if (!st.fxCatalog) {
      const r = await api(`/api/jobs/${id}/fc/effects`);
      if (r.ok && r.j?.effects) st.fxCatalog = (Array.isArray(r.j.effects) ? r.j.effects : []).map(e => ({ name: e.name, id: e.id, kind: e.kind }));
    }
    setPhase("ready");
    renderAll();
    loadMonitor();
    requestFrame();
  }
  function setPhase(p, msg) { st.phase = p; chip(msg); }

  async function ensureBuilt() {
    const m = await api(`/api/jobs/${st.id}/filmcraft/manifest`);
    if (m.ok && m.j?.clips?.length) return true;
    setPhase("building", "building…");
    let r = await api(`/api/jobs/${st.id}/filmcraft/build`, { method: "POST" });
    if (r.status === 409) { /* already running */ }
    else if (!r.ok) { setPhase("failed", r.j?.error || "build failed"); return false; }
    for (let i = 0; i < 240; i++) {
      await new Promise(res => setTimeout(res, 2500));
      const mm = await api(`/api/jobs/${st.id}/filmcraft/manifest`);
      if (mm.ok && mm.j?.clips?.length) return true;
    }
    const s = await api(`/api/jobs/${st.id}/filmcraft/status`);
    setPhase("failed", s.j?.build?.error || "build timed out");
    return false;
  }

  /* ---------- render (export) ---------- */
  async function renderMp4() {
    if (st.phase === "rendering") return;
    setPhase("rendering");
    const has = (await api(`/api/jobs/${st.id}/filmcraft/export`, { method: "HEAD" })).status === 200;
    if (!has) {
      const r = await api(`/api/jobs/${st.id}/filmcraft/export`, { method: "POST" });
      if (r.status !== 409 && !r.ok) { setPhase("failed", r.j?.error || "render failed"); return; }
    }
    for (let i = 0; i < 300; i++) {
      await new Promise(res => setTimeout(res, 2500));
      const s = await api(`/api/jobs/${st.id}/filmcraft/status`);
      if (s.j?.export?.state === "done") break;
      if (s.j?.export?.state === "failed") { setPhase("failed", s.j.export.error || "render failed"); return; }
    }
    setPhase("ready");
    st.stale = false;
    loadMonitor();
    chip();
  }

  /* ---------- bins ---------- */
  function renderBins() {
    const host = $("#fcBinList");
    host.innerHTML = "";
    const media = st.S?.media || [];
    if (!media.length) host.innerHTML = '<div class="fc-empty">no media yet — import one below</div>';
    for (const f of media) {
      const el = document.createElement("div");
      el.className = "fc-bin-item";
      el.draggable = true;
      const isVid = ["Movie", "Video"].includes(f.kind);
      const isImg = ["Image", "Still"].includes(f.kind);
      const isAud = ["AudioOnly", "Audio"].includes(f.kind) || /\.(wav|mp3|m4a|ogg|flac)$/i.test(f.name || "");
      const lead = `<span class="ic">${isAud ? "🎵" : isImg ? "🖼️" : isVid ? "🎬" : "🎞️"}</span>`;
      el.innerHTML = `${lead}<span class="nm"><b>${esc(f.name)}</b><small>${esc(f.kind)}${f.dur ? " · " + tc(f.dur) : ""}${f.w ? ` · ${f.w}×${f.h}` : ""}</small></span>
        <button class="add" title="place at playhead">＋</button>`;
      el.querySelector(".add").onclick = (e) => { e.stopPropagation(); placeMedia(f); };
      el.ondblclick = () => placeMedia(f);
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/x-fc-media", JSON.stringify({ item: f.id, kind: isAud ? "a" : "v" }));
        e.dataTransfer.effectAllowed = "copy";
      });
      host.appendChild(el);
    }
  }
  async function placeMedia(f, trackAlias = null, atSec = null) {
    const seq = st.S?.sequence; if (!seq) return;
    const isAud = f.kind === "AudioOnly" || ["wav", "mp3", "m4a", "ogg", "flac"].some(x => (f.name || "").toLowerCase().endsWith("." + x));
    const pools = isAud ? seq.audio : seq.video;
    const want = trackAlias || (pools.find(t => t.alias === (isAud ? "A1" : "V1")) || pools[0])?.alias;
    if (!want) { note("no track to place on", true); return; }
    const t = atSec != null ? atSec : st.ph;
    const ok = await edit([{ id: "timeline.place", params: { item: f.id, track: want, time: { seconds: t } } }], { label: "place " + f.name });
    if (ok) { st.ph = Math.max(st.ph, t + 1); renderTimeline(); requestFrame(); }
  }

  /* ---------- sequences ---------- */
  function renderSeqs() {
    const sel = $("#fcSeqSel");
    const cur = sel.value;
    sel.innerHTML = (st.S?.sequences || []).map(s => `<option value="${s.id}" ${s.id === st.S.active ? "selected" : ""}>${esc(s.name)} (${s.w}×${s.h}@${s.fps})</option>`).join("");
    if (cur) sel.value = cur;
    $("#fcTlName").textContent = st.S?.sequence?.name || "—";
    $("#fcProjName").textContent = "11 Second Edit";
  }
  async function switchSeq(id) {
    const r = await api(`${base()}/seq`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open", item: Number(id) }) });
    if (!r.ok) { note(r.j?.error || "could not open sequence", true); return; }
    if (r.j.state) st.S = r.j.state;
    st.sel = null; st.ph = st.S?.sequence?.playhead || 0;
    markStale(); renderAll(); requestFrame();
  }
  async function newSeq() {
    const name = prompt("New sequence name", (st.S?.sequence?.name || "Sequence") + " — cut 2");
    if (name == null) return;
    const s = st.S?.sequence;
    const r = await api(`${base()}/seq`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "new", name, width: s?.w || 1080, height: s?.h || 1920, fps: s?.fps || 30 }) });
    if (!r.ok) { note(r.j?.error || "new sequence failed", true); return; }
    if (r.j.state) st.S = r.j.state;
    st.sel = null; st.ph = 0; markStale(); renderAll(); requestFrame();
  }

  /* ---------- timeline geometry ---------- */
  const tlScroll = () => $("#fcTlScroll");
  const fitPps = () => {
    const dur = Math.max(st.S?.sequence?.dur || 1, 4);
    st.pps = Math.max(6, Math.min(240, (tlScroll().clientWidth - 24) / dur));
  };
  const t2x = (t) => t * (st.pps || 10);
  const x2t = (x) => Math.max(0, x / (st.pps || 10));
  function ppsStep() {
    const target = 70 / (st.pps || 10);           // aim ~70px between labels
    for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60]) if (s >= target) return s;
    return 60;
  }
  const clipName = (c) => (st.S?.media || []).find(m => m.id === c.item)?.name || (c.name || "clip");

  function renderTimeline() {
    const seq = st.S?.sequence;
    const grid = $("#fcTlGrid");
    const heads = $("#fcTlHeads");
    if (!seq) { grid.innerHTML = ""; heads.innerHTML = ""; return; }
    if (st.pps == null) fitPps();
    const W = Math.ceil(t2x(seq.dur)) + 48;
    grid.style.width = W + "px";
    // ruler
    const step = ppsStep();
    let ticks = "";
    for (let t = 0; t <= seq.dur + 0.001; t = Math.round((t + step) * 100) / 100)
      ticks += `<div class="tick" style="left:${t2x(t)}px"><span>${tc(t)}</span></div>`;
    let rows = "";
    const clipCls = (kind, alias, i) => kind === "video" ? (alias === "V1" ? "v1" : alias === "V2" ? "v2" : "v3") : (alias === "A1" ? "aa" : alias === "A2" ? "ab" : "ac");
    for (const kind of ["video", "audio"]) {
      for (const t of seq[kind]) {
        rows += `<div class="fc-trackrow ${kind === "audio" ? "aud" : ""} ${t.enabled ? "" : "off"}" data-track="${t.alias}" data-kind="${kind}" style="width:${W}px">`;
        t.clips.forEach(c => {
          const w = Math.max(6, t2x(c.dur) - 1);
          rows += `<div class="fc-clip ${clipCls(kind, t.alias)} ${c.enabled ? "" : "off"} ${st.sel?.clipId === c.id ? "sel" : ""}"
            data-clip="${c.id}" data-track="${t.alias}" data-kind="${kind}"
            style="left:${t2x(c.start)}px;width:${w}px">
            <span class="cl-nm">${esc(clipName(c))}${c.effects.length ? `<span class="cl-fx">•${c.effects.length}</span>` : ""}</span>
            <span class="hd l" title="trim in"></span><span class="hd r" title="trim out"></span></div>`;
        });
        rows += `</div>`;
      }
    }
    grid.innerHTML = `<div class="fc-ruler" id="fcRuler" style="width:${W}px">${ticks}</div>` + rows;
    // track heads
    heads.innerHTML = seq.video.map(t => `<div class="fc-thead"><div class="nm"><i style="background:${t.alias === "V1" ? "var(--fc-v1)" : t.alias === "V2" ? "var(--fc-v2)" : "var(--fc-v3)"}"></i>${esc(t.name)}</div>
      <div class="ctl"><button data-t="${t.alias}" data-f="enabled" class="${t.enabled ? "on" : ""}" title="show/hide">E</button><button data-t="${t.alias}" data-f="locked" class="${t.locked ? "on" : ""}" title="lock">🔒</button></div></div>`).join("") +
      seq.audio.map(t => `<div class="fc-thead aud"><div class="nm"><i style="background:${t.alias === "A1" ? "var(--fc-a1)" : "var(--fc-a2)"}"></i>${esc(t.name)}</div>
      <div class="ctl"><button data-t="${t.alias}" data-f="enabled" class="${t.enabled ? "on" : ""}" title="show/hide">E</button><button data-t="${t.alias}" data-f="muted" class="mute ${t.muted ? "on" : ""}" title="mute">M</button><button data-t="${t.alias}" data-f="solo" class="${t.solo ? "on" : ""}" title="solo">S</button></div></div>`).join("");
    updatePlayhead();
  }
  function updatePlayhead() {
    const seq = st.S?.sequence;
    const ph = $("#fcPlayhead");
    const scroll = tlScroll();
    if (!seq) { ph.style.display = "none"; return; }
    ph.style.display = "";
    ph.style.left = t2x(Math.min(st.ph, seq.dur)) + "px";
    const dur = seq.dur;
    $("#fcTcNow").textContent = tc(st.ph);
    $("#fcTcEnd").textContent = tc(dur);
    const sc = $("#fcScrub");
    sc.max = Math.round(dur * 1000);
    if (document.activeElement !== sc) sc.value = Math.round(st.ph * 1000);
  }
  function renderSelection() {
    $$("#fcTlGrid .fc-clip").forEach(el => el.classList.toggle("sel", el.dataset.clip === st.sel?.clipId));
  }

  /* ---------- snap ---------- */
  function snapTime(t, skipClipId) {
    if (!st.snap) return t;
    const seq = st.S?.sequence;
    const cands = [0, st.ph, seq?.dur || 0];
    for (const kind of ["video", "audio"])
      for (const tr of (seq?.[kind] || []))
        for (const c of tr.clips)
          if (c.id !== skipClipId) { cands.push(c.start); cands.push(c.start + c.dur); }
    let best = t, bestD = 6 / (st.pps || 10);   // 6px threshold in seconds
    for (const c of cands) { const d = Math.abs(c - t); if (d < bestD) { best = c; bestD = d; } }
    return best;
  }

  /* ---------- timeline edits ---------- */
  function splitAtPlayhead() {
    if (!st.sel) return edit([{ id: "timeline.razor", params: { time: Math.round(st.ph * TSPS) } }], { label: "split" });
    return edit([{ id: "timeline.razor", params: { time: Math.round(st.ph * TSPS), clip: st.sel.clipId } }], { label: "split clip" });
  }
  function rippleDelete() {
    if (!st.sel) { note("select a clip first", true); return; }
    const id = st.sel.clipId;
    const ok = edit([{ id: "edit.rippleDelete", params: { clips: [id] } }], { ripple: true, label: "ripple delete" });
    if (ok) { st.sel = null; renderAll(); }
  }
  function addTrack(kind) {
    edit([{ id: "sequence.addTracks", params: kind === "v" ? { video: 1 } : { audio: 1 } }], { label: "add " + kind + " track" });
  }
  async function setTrackProp(track, field, on) {
    const r = await api(`${base()}/edit`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps: [{ id: "timeline.setTrack", params: { track, [field]: on } }], label: "track " + field }) });
    if (r.j?.state) st.S = r.j.state;
    renderAll();
  }
  function trimClip(clipId, edge, deltaSec) {
    if (Math.abs(deltaSec) < 0.02) { renderAll(); return; }
    edit([{ id: "timeline.trim", params: { clip: clipId, edge, mode: "regular", delta: Math.round(deltaSec * TSPS) } }], { label: "trim " + edge });
  }
  function moveClip(clipId, track, atSec) {
    edit([{ id: "timeline.move", params: { moves: [{ clip: clipId, track, time: { seconds: Math.max(0, atSec) } }], insert: false } }], { label: "move clip" });
  }

  /* ---------- drag interactions ---------- */
  let drag = null;
  function gridX(e) {
    const g = $("#fcTlGrid");
    const r = g.getBoundingClientRect();
    return e.clientX - r.left;
  }
  function onTlMouseDown(e) {
    const hd = e.target.closest(".hd");
    const clipEl = e.target.closest(".fc-clip");
    const ruler = e.target.closest("#fcRuler");
    if (ruler) { setPhFromX(gridX(e), e); return; }
    if (!clipEl) return;
    const clipId = clipEl.dataset.clip;
    select(clipId);
    if (hd) {
      const c = st.sel.clip;
      drag = { mode: "trim", clipId, edge: hd.classList.contains("l") ? "in" : "out", x0: gridX(e), origStart: c.start, origDur: c.dur, minDur: 0.05 };
    } else if (e.target.closest(".cl-nm") || !e.shiftKey) {
      drag = { mode: "move", clipId, x0: gridX(e), y0: e.clientY, origStart: st.sel.clip.start, origTrack: st.sel.track.alias, kind: st.sel.kind, moved: false };
    }
    if (drag) {
      e.preventDefault();
      document.addEventListener("mousemove", onTlMouseMove);
      document.addEventListener("mouseup", onTlMouseUp);
    }
  }
  function onTlMouseMove(e) {
    if (!drag) return;
    const dx = gridX(e) - drag.x0;
    if (drag.mode === "trim") {
      drag.dx = dx;
      renderAll(); // cheap; shows snapped width via preview below
      const c = findClip(drag.clipId)?.clip; if (!c) return;
      // preview: draw a ghost on the clip's handles
      const el = $(`#fcTlGrid .fc-clip[data-clip="${drag.clipId}"]`); if (!el) return;
      const w = el.getBoundingClientRect().width;
      if (drag.edge === "out") el.style.width = Math.max(6, w + dx) + "px";
      else el.style.left = Math.min(t2x(c.start + c.dur) - 6, t2x(c.start) + dx) + "px", el.style.width = Math.max(6, w - dx) + "px";
      return;
    }
    if (drag.mode === "move") {
      drag.moved = true;
      drag.dx = dx;
      const el = $(`#fcTlGrid .fc-clip[data-clip="${drag.clipId}"]`);
      if (el) el.style.left = t2x(drag.origStart) + dx + "px";
      // hover target track
      $$("#fcTlGrid .fc-trackrow").forEach(r => r.classList.toggle("drop-target", false));
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".fc-trackrow");
      if (under && under.dataset.kind === drag.kind && under.dataset.track !== drag.origTrack) under.classList.add("drop-target");
    }
  }
  function onTlMouseUp(e) {
    document.removeEventListener("mousemove", onTlMouseMove);
    document.removeEventListener("mouseup", onTlMouseUp);
    const d = drag; drag = null;
    if (!d) return;
    if (typeof d.dx !== "number") return; // bare click (no drag) → no-op
    if (d.mode === "trim") {
      const c = findClip(d.clipId)?.clip; if (!c) return;
      const dSec = d.dx / (st.pps || 10);
      if (d.edge === "out") trimClip(d.clipId, "out", Math.max(-(c.dur - d.minDur), dSec));
      else trimClip(d.clipId, "in", Math.min(dSec, c.dur - d.minDur));
      return;
    }
    if (d.mode === "move" && d.moved && Math.abs(d.dx) > 3) {
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".fc-trackrow");
      const track = (under && under.dataset.kind === d.kind) ? under.dataset.track : d.origTrack;
      moveClip(d.clipId, track, snapTime(d.origStart + d.dx / (st.pps || 10), d.clipId));
    }
  }
  function setPhFromX(x, e) {
    st.ph = x2t(x);
    updatePlayhead();
    requestFrame();
  }

  /* ---------- inspector ---------- */
  const selClip = () => st.sel?.clip || null;
  function getEff(name) { return selClip()?.effects.find(e => e.effect === name) || null; }
  function paramOf(name, p) { const e = getEff(name); return e?.params?.[p] || null; }
  async function ensureEffect(effectName) {
    const c = selClip(); if (!c) return false;
    if (c.effects.some(e => e.effect === effectName)) return true;
    return await edit([{ id: "effects.apply", params: { clips: [st.sel.clipId], effect: effectName } }], { label: "apply " + effectName });
  }
  /** Write a param: animated → keyframe at playhead; static → plain set. */
  function writeParam(effectName, param, value) {
    const c = selClip(); if (!c) return;
    const p = paramOf(effectName, param);
    const animated = Array.isArray(p?.keyframes) && p.keyframes.length > 0;
    if (animated) {
      const rel = Math.max(0, Math.min(st.ph - c.start, c.dur));
      edit([{ id: "effects.setKeyframe", params: { clip: st.sel.clipId, effect: effectName, param, mediaTime: Math.round(rel * TSPS), value } }], { label: "kf " + param });
    } else {
      edit([{ id: "effects.setParam", params: { clip: st.sel.clipId, effect: effectName, param, value } }], { label: param });
    }
  }
  function kfList(effectName, param) {
    return (paramOf(effectName, param)?.keyframes) || null;
  }
  function kfControls(effectName, param, unit = "") {
    const kfs = kfList(effectName, param);
    if (!kfs) return `<button class="fc-btn fc-kf-add" data-kfadd="${effectName}:${param}" title="key this at the playhead">🔑 key @ ▶</button>`;
    const rows = kfs.map(k => `<div class="fc-kfrow"><span class="kt">${k.t.toFixed(2)}s</span>
      <input type="number" step="any" value="${JSON.stringify(k.v).replace(/"/g, "")}" data-kfv="${effectName}:${param}:${k.t.toFixed(3)}">
      <button data-kfdel="${effectName}:${param}:${k.t.toFixed(3)}" title="delete key">✕</button></div>`).join("");
    return `<div class="fc-kfrow" style="background:transparent;border:none;color:var(--fc-dim);padding:2px 0">🔑 ${kfs.length} keyframe${kfs.length > 1 ? "s" : ""} — edit values, or:</div>${rows}
      <button class="fc-btn fc-kf-add" data-kfadd="${effectName}:${param}">🔑 key @ ▶</button>`;
  }
  function slider(label, effectName, param, { min, max, step, unit = "" } = {}) {
    const c = selClip();
    const p = paramOf(effectName, param);
    const v = p?.value ?? p?.keyframes?.[0]?.v ?? null;
    const num = typeof v === "number" ? v : (Array.isArray(v) ? null : (p != null && typeof p !== "object" ? Number(p) || 0 : null));
    return `<div class="fc-ctl"><div class="lbl"><span>${label}${unit ? " (" + unit + ")" : ""}</span><b data-live>${num != null ? num : "—"}</b></div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${num != null ? Math.max(min, Math.min(max, num)) : (min + max) / 2}"
        data-param="${effectName}:${param}" data-min="${min}" data-max="${max}">
      <div style="margin-top:4px;display:flex;gap:6px;align-items:center">${kfControls(effectName, param)}</div></div>`;
  }
  function xySlider(label, effectName, param, { min, max, step } = {}) {
    const v = paramOf(effectName, param)?.value;
    const x = v?.x ?? v?.[0] ?? 0, y = v?.y ?? v?.[1] ?? 0;
    return `<div class="fc-ctl"><div class="lbl"><span>${label}</span><b>${Math.round(x)}, ${Math.round(y)}</b></div>
      <div class="numrow"><label>X</label><input type="number" value="${Math.round(x)}" data-param="${effectName}:${param}:x" data-min="${min}" data-max="${max}">
      <label>Y</label><input type="number" value="${Math.round(y)}" data-param="${effectName}:${param}:y" data-min="${min}" data-max="${max}"></div></div>`;
  }
  function clipCard() {
    const c = selClip(); if (!c) return "";
    return `<div class="fc-clipcard"><b>${esc(selName() || "clip")}</b>
      <small>in ${c.sourceIn.toFixed(2)}s → out ${(c.sourceIn + c.dur).toFixed(2)}s · timeline ${c.start.toFixed(2)}–${(c.start + c.dur).toFixed(2)}s · ${c.dur.toFixed(2)}s${c.speed !== 1 ? " · " + c.speed + "×" : ""}${c.effects.length ? " · " + c.effects.length + " effect(s)" : ""}</small></div>`;
  }
  function fxPane() {
    const c = selClip();
    if (!c) return '<div class="fc-empty">Select a clip to edit its motion, opacity & effects.</div>';
    const motion = getEff("motion");
    const op = getEff("opacity");
    const fxList = c.effects.map((e, i) => `<div class="fc-fxitem ${e.enabled ? "" : "off"}"><span class="dot"></span>
      <small>${esc(e.effect)}${Object.keys(e.params).length ? " · " + Object.keys(e.params).length + " params" : ""}</small>
      <button data-fxtoggle="${i}" title="enable/disable">${e.enabled ? "ON" : "OFF"}</button>
      <button class="del" data-fxdel="${i}" title="remove effect">✕</button></div>`).join("") || '<div class="fc-empty" style="padding:4px">no effects yet</div>';
    const catalog = (st.fxCatalog || []).filter(e => e.kind === "Video" && !c.effects.some(x => x.effect === e.name)).slice(0, 30);
    return `${clipCard()}
      <div class="fc-sect"><h5>Motion ${motion ? "" : '<button class="fc-btn fc-kf-add" data-ensure="motion" style="float:right">＋ add</button>'}</h5>
        ${motion ? slider("Scale %", "motion", "scale", { min: 10, max: 400, step: 1 }) + slider("Rotation °", "motion", "rotation", { min: -180, max: 180, step: 1 }) + xySlider("Position (px)", "motion", "position", { min: -2000, max: 2000 }) : '<div class="fc-empty">apply Motion to pan / zoom / rotate</div>'}</div>
      <div class="fc-sect"><h5>Opacity</h5>${op ? slider("Opacity %", "opacity", "opacity", { min: 0, max: 100, step: 1 }) : '<div class="fc-empty" style="display:flex;justify-content:space-between;align-items:center">fade this clip in/out <button class="fc-btn fc-kf-add" data-ensure="opacity">＋ add</button></div>'}</div>
      <div class="fc-sect"><h5>Effects</h5><div class="fc-fxlist">${fxList}</div>
        <div style="margin-top:8px;display:flex;gap:6px"><select id="fcFxPick" style="flex:1;background:var(--fc-panel3);color:var(--fc-text);border:1px solid var(--fc-line);border-radius:6px;padding:4px;font:inherit;font-size:11.5px">${catalog.map(e => `<option value="${esc(e.name)}">${esc(e.name)}</option>`).join("")}</select>
        <button class="fc-btn" id="fcFxAdd">Apply</button></div></div>`;
  }
  function colorPane() {
    const c = selClip();
    if (!c) return '<div class="fc-empty">Select a clip to grade it (Lumetri).</div>';
    const lu = getEff("lumetri");
    if (!lu) return `${clipCard()}<div class="fc-sect"><h5>Color — Lumetri</h5><div class="fc-empty" style="display:flex;justify-content:space-between;align-items:center;gap:8px">grade this clip <button class="fc-btn primary" data-ensure="lumetri">＋ Add Lumetri</button></div></div>`;
    return `${clipCard()}<div class="fc-sect"><h5>Lumetri — Basic</h5>
      ${slider("Exposure", "lumetri", "exposure", { min: -2, max: 2, step: 0.02 })}
      ${slider("Contrast", "lumetri", "contrast", { min: -100, max: 100, step: 1 })}
      ${slider("Saturation %", "lumetri", "saturation", { min: 0, max: 300, step: 1 })}
      ${slider("Temperature", "lumetri", "temperature", { min: -100, max: 100, step: 1 })}
      ${slider("Tint", "lumetri", "tint", { min: -100, max: 100, step: 1 })}
      ${slider("Shadows", "lumetri", "shadows", { min: -100, max: 100, step: 1 })}
      ${slider("Highlights", "lumetri", "highlights", { min: -100, max: 100, step: 1 })}</div>
      <div class="fc-sect"><h5>Quick looks</h5><div class="fc-chips">
        <button data-look="bw">black & white</button><button data-look="warm">warm</button><button data-look="cool">cool</button><button data-look="punchy">punchy</button></div></div>`;
  }
  function audioPane() {
    const c = selClip();
    if (!c) return '<div class="fc-empty">Select a clip to adjust its audio.</div>';
    const vol = getEff("volume");
    const pan = getEff("panner");
    return `${clipCard()}<div class="fc-sect"><h5>Audio</h5>
      ${vol ? slider("Level dB", "volume", "level", { min: -40, max: 12, step: 0.5, unit: "dB" }) : '<div class="fc-empty" style="display:flex;justify-content:space-between;align-items:center">volume control <button class="fc-btn" data-ensure="volume">＋ add</button></div>'}
      ${pan ? slider("Pan", "panner", "balance", { min: -100, max: 100, step: 1 }) : '<div class="fc-empty" style="display:flex;justify-content:space-between;align-items:center">stereo pan <button class="fc-btn" data-ensure="panner">＋ add</button></div>'}
      <div class="fc-hint" style="margin-top:6px">🔑 key @ ▶ animates the value from the playhead — drag the playhead and push values to draw a ramp.</div></div>`;
  }
  function textPane() {
    const c = selClip();
    if (!c) return '<div class="fc-empty">Select a clip to add or edit a text overlay.</div>';
    const s = st.S?.sequence;
    return `${clipCard()}<div class="fc-sect"><h5>Text overlay</h5>
      <div class="fc-ctl"><div class="lbl"><span>Text</span></div><input type="text" id="fcTextVal" placeholder="e.g. Follow for more" style="width:100%;background:#14161c;color:var(--fc-text);border:1px solid var(--fc-line);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px"></div>
      <div class="fc-ctl"><div class="lbl"><span>Size</span><b id="fcTextSzB">110 px</b></div><input type="range" id="fcTextSz" min="40" max="300" step="5" value="110"></div>
      <div class="fc-ctl"><div class="lbl"><span>Position</span></div>
        <div class="fc-chips"><button data-ttextpos="top" class="fc-btn">top</button><button data-ttextpos="center" class="fc-btn">center</button><button data-ttextpos="bottom" class="fc-btn">bottom</button></div></div>
      <button class="fc-btn primary fc-ai-apply" id="fcTextApply">＋ Add text to clip</button>
      <div class="fc-hint" style="margin-top:8px">spans the selected clip (${c.start.toFixed(1)}–${(c.start + c.dur).toFixed(1)}s)</div></div>`;
  }
  let stTab = "ai";
  function renderInspector() {
    const panes = { ai: "", fx: fxPane, color: colorPane, audio: audioPane, text: textPane };
    if (stTab === "fx") $("#fcPaneFx").innerHTML = fxPane();
    if (stTab === "color") $("#fcPaneColor").innerHTML = colorPane();
    if (stTab === "audio") $("#fcPaneAudio").innerHTML = audioPane();
    if (stTab === "text") $("#fcPaneText").innerHTML = textPane();
  }

  /* ---------- AI pane ---------- */
  function renderAiScope() {
    const el = $("#fcAiSel");
    if (st.sel) {
      const c = st.sel.clip;
      el.innerHTML = `editing <b>${esc(selName())}</b> · ${c.start.toFixed(1)}–${(c.start + c.dur).toFixed(1)}s on ${st.sel.track.alias}`;
    } else {
      el.innerHTML = "no clip selected — the AI will work on the <b>whole sequence</b>";
    }
  }
  function renderAiRes() {
    const host = $("#fcAiRes");
    if (!st.ai?.length) { host.innerHTML = ""; return; }
    host.innerHTML = st.ai.slice(-6).reverse().map(r => `<div class="it ${r.status === "done" ? "ok" : r.status === "failed" ? "bad" : "wait"}">
      <b>${r.status === "done" ? "✔ done" : r.status === "failed" ? "✕ " + esc(r.result?.error || "failed") : "⏳ " + (r.status || "working") + "…"}</b>
      ${esc(r.instruction)}${r.result?.detail ? `<small>${esc(String(r.result.detail).slice(0, 160))}</small>` : ""}</div>`).join("");
  }
  async function aiApply() {
    const ins = $("#fcAiText").value.trim();
    if (!ins) return;
    const c = st.sel?.clip;
    const body = { instruction: ins };
    if (st.sel) { body.clip = st.sel.clipId; body.t0 = c.start; body.t1 = c.start + c.dur; }
    else { body.t0 = st.ph; body.t1 = Math.min((st.S?.sequence?.dur) || st.ph + 2, st.ph + 2); }
    const r = await api(`/api/jobs/${st.id}/filmcraft/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok && r.status !== 409) { note(r.j?.error || "could not queue AI edit", true); return; }
    $("#fcAiText").value = "";
    note("AI edit queued — working…");
    aiPoll();
  }
  function aiPoll() {
    if (st.aiTimer) return;
    const tick = async () => {
      st.aiTimer = null;
      const r = await api(`/api/jobs/${st.id}/filmcraft/ai`);
      if (r.ok && r.j?.requests) {
        st.ai = r.j.requests;
        renderAiRes();
        const pending = st.ai.some(x => ["pending", "running"].includes(x.status));
        if (pending) st.aiTimer = setTimeout(tick, 3000);
        else {
          const last = st.ai[st.ai.length - 1];
          if (last?.status === "done") { note("AI edit applied"); markStale(); await refresh(); renderAll(); }
        }
      }
    };
    st.aiTimer = setTimeout(tick, 3000);
  }

  /* ---------- monitor / preview ---------- */
  let hasMp4 = false, frameSeq = 0, frameTimer = null;
  async function loadMonitor() {
    const vid = $("#fcVid"), img = $("#fcFrame"), ov = $("#fcOverlay");
    vid.pause?.();
    const r = await api(`/api/jobs/${st.id}/filmcraft/export`, { method: "HEAD" });
    hasMp4 = r.status === 200;
    if (hasMp4) {
      vid.src = `/api/jobs/${st.id}/filmcraft/export?inline=1`;
      vid.style.display = ""; img.style.display = "none"; ov.style.display = "none";
    } else {
      vid.removeAttribute("src"); vid.style.display = "none"; img.style.display = "none";
      ov.style.display = "flex";
      ov.innerHTML = '<div>🎬 no rendered preview yet</div><div class="fc-hint" style="margin:0">press <b>⬇ Render</b> to bake this edit into an MP4,<br>or scrub the timeline for single frames</div>';
      requestFrame();
    }
  }
  function requestFrame() {
    if (hasMp4) return;
    const my = ++frameSeq;
    const fire = async () => {
      try {
        const r = await fetch(`/api/jobs/${st.id}/filmcraft/frame?t=${st.ph.toFixed(2)}`);
        if (!r.ok || my !== frameSeq) return;
        const b = await r.blob();
        const img = $("#fcFrame"), ov = $("#fcOverlay");
        img.src = URL.createObjectURL(b);
        img.style.display = ""; ov.style.display = "none";
      } catch { /* frame render still busy */ }
    };
    clearTimeout(frameTimer);
    frameTimer = setTimeout(fire, 350);
  }

  /* ---------- transport ---------- */
  function setPh(t) {
    const dur = st.S?.sequence?.dur || 0;
    st.ph = Math.max(0, Math.min(t, dur));
    updatePlayhead();
    if (hasMp4) { try { $("#fcVid").currentTime = st.ph; } catch { } }
    requestFrame();
  }
  function togglePlay() {
    const vid = $("#fcVid");
    if (!hasMp4) { note("Render first to play — or scrub for frames", true); return; }
    if (vid.paused) { vid.play(); st.playing = true; } else { vid.pause(); st.playing = false; }
    vid.onplay = () => { $("#fcPlay").textContent = "⏸"; $("#fcPlay").classList.add("on"); };
    vid.onpause = () => { $("#fcPlay").textContent = "▶"; $("#fcPlay").classList.remove("on"); };
    vid.ontimeupdate = () => { if (Math.abs(vid.currentTime - st.ph) > 0.15) { st.ph = vid.currentTime; updatePlayhead(); } };
  }

  /* ---------- import ---------- */
  async function importFiles(list) {
    for (const f of list) {
      note(`importing ${f.name}…`);
      const up = await api(`/api/upload?name=${encodeURIComponent(f.name)}&kind=broll`, { method: "POST", body: f });
      if (!up.ok) { note("upload failed: " + (up.j?.error || up.status), true); continue; }
      const imp = await api(`${base()}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: up.j.path }) });
      if (!imp.ok) { note("import failed: " + (imp.j?.error || "no project yet — run a build first"), true); continue; }
      if (imp.j.state) st.S = imp.j.state;
    }
    await refresh();
    renderBins();
    chip();
  }
  async function importPath() {
    const p = $("#fcImportPath").value.trim();
    if (!p) return;
    const imp = await api(`${base()}/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) });
    if (!imp.ok) { note("import failed: " + (imp.j?.error || "check the path"), true); return; }
    if (imp.j.state) st.S = imp.j.state;
    $("#fcImportPath").value = "";
    await refresh();
    renderBins();
  }

  /* ---------- zoom ---------- */
  function zoom(factor) {
    const cur = st.pps || fitPps() || 40;
    st.pps = Math.max(4, Math.min(480, cur * factor));
    const sc = tlScroll();
    const ratio = sc.scrollLeft / Math.max(1, sc.scrollWidth);
    renderTimeline();
    sc.scrollLeft = ratio * sc.scrollWidth;
  }

  /* ---------- renderAll / wiring ---------- */
  function renderAll() {
    if (!st.S) return;
    renderSeqs(); renderBins(); renderTimeline();
    renderInspector(); renderAiScope(); renderAiRes();
    const u = st.S.undo;
    $("#fcUndo").disabled = u ? !u.canUndo : true;
    $("#fcRedo").disabled = u ? !u.canRedo : true;
    chip();
  }
  function wire() {
    st.wired = true;
    const on = (id, ev, fn) => { const el = $("#" + id); if (el) el.addEventListener(ev, fn); };
    // toolbar
    on("fcUndo", "click", () => undoRedo("undo"));
    on("fcRedo", "click", () => undoRedo("redo"));
    on("fcSplit", "click", splitAtPlayhead);
    on("fcRippleDel", "click", rippleDelete);
    on("fcSnap", "click", (e) => { st.snap = !st.snap; e.currentTarget.classList.toggle("on", st.snap); });
    on("fcAddV", "click", () => addTrack("v"));
    on("fcAddA", "click", () => addTrack("a"));
    on("fcSeqSel", "change", (e) => switchSeq(e.target.value));
    on("fcNewSeq", "click", newSeq);
    on("fcZoomIn", "click", () => zoom(1.3));
    on("fcZoomOut", "click", () => zoom(1 / 1.3));
    on("fcZoomFit", "click", () => { st.pps = null; renderTimeline(); });
    on("fcRebuild", "click", async () => {
      chip("rebuilding from 11 Second Edit cuts…");
      const r = await api(`/api/jobs/${st.id}/filmcraft/build`, { method: "POST" });
      if (r.status === 409) { note("already building…", true); return; }
      for (let i = 0; i < 120; i++) {
        await new Promise(res => setTimeout(res, 2500));
        if ((await refresh())?.sequence) break;
      }
      setPhase("ready"); st.sel = null; renderAll(); loadMonitor();
    });
    on("fcRender", "click", renderMp4);
    // bins
    on("fcImportBtn", "click", () => $("#fcImportFile").click());
    on("fcImportFile", "change", (e) => { importFiles([...e.target.files]); e.target.value = ""; });
    on("fcImportPathGo", "click", importPath);
    on("fcImportPath", "keydown", (e) => { if (e.key === "Enter") importPath(); });
    // transport
    on("fcToStart", "click", () => setPh(0));
    on("fcStepB", "click", () => setPh(st.ph - 1));
    on("fcStepF", "click", () => setPh(st.ph + 1));
    on("fcPlay", "click", togglePlay);
    on("fcScrub", "input", (e) => setPh(Number(e.target.value) / 1000));
    // timeline: pointer + drop + track-head buttons (delegated, once)
    $("#fcTlGrid").addEventListener("mousedown", onTlMouseDown);
    $("#fcTlHeads").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-t]");
      if (!b) return;
      const pool = st.S.sequence[b.dataset.t.startsWith("V") ? "video" : "audio"];
      const t = pool.find(x => x.alias === b.dataset.t);
      if (!t) return;
      const cur = b.dataset.f === "enabled" ? t.enabled : !!t[b.dataset.f];
      setTrackProp(b.dataset.t, b.dataset.f, !cur);
    });
    const grid = $("#fcTlGrid");
    grid.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-fc-media")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    grid.addEventListener("drop", async (e) => {
      const raw = e.dataTransfer.getData("text/x-fc-media");
      if (!raw) return;
      e.preventDefault();
      const { item, kind } = JSON.parse(raw);
      const row = e.target.closest?.(".fc-trackrow") || e.target.closest("#fcTlGrid")?.querySelector(".fc-trackrow");
      const t = snapTime(x2t(gridX(e)), null);
      const track = row?.dataset?.track || (kind === "a" ? "A1" : "V1");
      const ok = await edit([{ id: "timeline.place", params: { item, track, time: { seconds: t } } }], { label: "drop media" });
      if (ok) requestFrame();
    });
    // inspector (delegated: sliders, keyframes, buttons)
    const insp = $("#fcEditor");
    insp.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.param && t.type === "range") {
        const b = t.closest(".fc-ctl")?.querySelector("[data-live]");
        if (b) b.textContent = (+t.value).toFixed(t.step === "any" ? 3 : (t.step.includes(".") ? 2 : 0));
      }
      if (t.id === "fcTextSz") { const b = $("#fcTextSzB"); if (b) b.textContent = t.value + " px"; }
    });
    insp.addEventListener("change", async (e) => {
      const t = e.target;
      if (t.dataset.param) {
        const [eff, param, axis] = t.dataset.param.split(":");
        const val = axis ? Number(t.value) : (t.type === "number" ? Number(t.value) : +t.value);
        if (axis) { // X/Y of a vec param: read the partner input
          const sib = t.closest(".numrow").querySelector(`[data-param="${eff}:${param}:${axis === "x" ? "y" : "x"}"]`);
          const cur = paramOf(eff, param)?.value || {};
          const pair = axis === "x" ? [val, Number(sib?.value ?? cur.y ?? 0)] : [Number(sib?.value ?? cur.x ?? 0), val];
          return writeParam(eff, param, pair); // [x,y] — the engine's native vec form
        }
        writeParam(eff, param, val);
      }
      if (t.dataset.kfv) {
        const [eff, param, ts] = t.dataset.kfv.split(":");
        edit([{ id: "effects.setKeyframe", params: { clip: st.sel.clipId, effect: eff, param, mediaTime: Math.round(parseFloat(ts) * TSPS), value: Number(t.value) } }], { label: "kf value" });
      }
      const kd = e.target.dataset?.kfdel;
      if (kd) {
        const [eff, param, ts] = kd.split(":");
        edit([{ id: "effects.deleteKeyframe", params: { clip: st.sel.clipId, effect: eff, param, mediaTime: Math.round(parseFloat(ts) * TSPS) } }], { label: "del kf" });
      }
    });
    insp.addEventListener("click", async (e) => {
      const k = e.target.closest("[data-kfadd]");
      if (k && st.sel) {
        const [eff, param] = k.dataset.kfadd.split(":");
        const c = st.sel.clip;
        if (st.ph < c.start - 0.01 || st.ph > c.start + c.dur + 0.01) { note("playhead is outside the clip — move it inside to key", true); return; }
        await ensureEffect(eff);
        const ok = await edit([{ id: "effects.addKeyframe", params: { clip: st.sel.clipId, effect: eff, param, time: Math.round(st.ph * TSPS) } }], { label: "add kf" });
        if (ok) writeParam(eff, param, Number($(`[data-param="${eff}:${param}"]`)?.value || paramOf(eff, param)?.value || 0));
        return;
      }
      const en = e.target.closest("[data-ensure]");
      if (en && st.sel) { await ensureEffect(en.dataset.ensure); return; }
      const tog = e.target.closest("[data-fxtoggle]");
      if (tog) {
        const i = +tog.dataset.fxtoggle;
        edit([{ id: "effects.toggleEnabled", params: { clip: st.sel.clipId, index: i } }], { label: "fx toggle" });
        return;
      }
      const del = e.target.closest("[data-fxdel]");
      if (del) {
        const i = +del.dataset.fxdel;
        const nm = st.sel.clip.effects[i]?.effect;
        edit([{ id: "effects.remove", params: { clip: st.sel.clipId, index: i } }], { label: "remove " + (nm || "fx") });
        return;
      }
      if (e.target.id === "fcFxAdd" && st.sel) {
        const nm = $("#fcFxPick").value;
        if (nm) { const ok = await ensureEffect(nm); if (ok) renderInspector(); }
        return;
      }
      const lk = e.target.closest("[data-look]");
      if (lk && st.sel) {
        const L = {
          bw: [["black_white", null]],
          warm: [["lumetri", "temperature", 35], ["lumetri", "saturation", 115]],
          cool: [["lumetri", "temperature", -30], ["lumetri", "contrast", 10]],
          punchy: [["lumetri", "contrast", 25], ["lumetri", "saturation", 130], ["lumetri", "vibrance", 30]],
        }[lk.dataset.look] || [];
        if (lk.dataset.look === "bw") { await ensureEffect("black_white"); return; }
        const ok = await ensureEffect("lumetri");
        if (!ok) return;
        for (const [, p, v] of L) {
          const r = await edit([{ id: "effects.setParam", params: { clip: st.sel.clipId, effect: "lumetri", param: p, value: v } }], { label: "look " + p });
          if (!r) break;
        }
        return;
      }
      if (e.target.id === "fcTextApply" && st.sel) {
        const txt = ($("#fcTextVal").value || "").trim() || "Text";
        const size = +$("#fcTextSz").value;
        const pos = e.target.dataset.pos || "top";
        const s = st.S.sequence;
        const c = st.sel.clip;
        const py = pos === "top" ? s.h * 0.12 : pos === "center" ? s.h * 0.5 : s.h * 0.86;
        await edit([{ id: "graphics.newText", params: { text: txt, position: [s.w / 2, py], size, seconds: c.dur, clip: st.sel.clipId, time: Math.round(c.start * TSPS) } }], { label: "text overlay" });
        return;
      }
      const tp = e.target.closest("[data-ttextpos]");
      if (tp) { const btns = $$("[data-ttextpos]"); btns.forEach(b => b.classList.toggle("on", b === tp)); applyTextPos = tp.dataset.ttextpos; return; }
      // tabs
      const tab = e.target.closest(".fc-tabs button");
      if (tab) {
        stTab = tab.dataset.pane;
        $$("#fcEditor .fc-tabs button").forEach(b => b.classList.toggle("on", b === tab));
        $$("#fcEditor .fc-pane").forEach(p => p.classList.remove("on"));
        $(`#fcPane${stTab[0].toUpperCase()}${stTab.slice(1)}`).classList.add("on");
        renderInspector();
        return;
      }
      if (e.target.id === "fcAiApply" || e.target.closest("#fcAiApply")) { aiApply(); return; }
      // quick chips
      const chipb = e.target.closest("#fcAiChips button");
      if (chipb) { $("#fcAiText").value = chipb.textContent; return; }
    });
    // keyboard
    document.addEventListener("keydown", (e) => {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) return;
      if (!$("#fcEditor").classList.contains("hidden")) {
        if (e.code === "Space") { e.preventDefault(); togglePlay(); }
        else if (e.key === "s" || e.key === "S") splitAtPlayhead();
        else if (e.key === "Delete" || e.key === "Backspace") rippleDelete();
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undoRedo("undo"); }
        else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); undoRedo("redo"); }
        else if (e.key === "+" || e.key === "=") zoom(1.25);
        else if (e.key === "-") zoom(1 / 1.25);
        else if (e.key === "ArrowLeft") setPh(st.ph - (e.shiftKey ? 5 : 0.1));
        else if (e.key === "ArrowRight") setPh(st.ph + (e.shiftKey ? 5 : 0.1));
        else if (e.key === "Home") setPh(0);
        else if (e.key === "End") setPh(st.S?.sequence?.dur || 0);
      }
    });
    // AI chips
    $("#fcAiChips").innerHTML = ["zoom in on my face", "quieter", "add label: Follow", "warm grade", "black & white", "cut this clip", "add a whoosh on every cut"].map(c => `<button>${c}</button>`).join("");
  }

  let applyTextPos = "top";
  window.__fc = { openFilmCraft, state: st };
})();
