/* 11 Second Edit — UI logic (vanilla JS, no deps). Replica of the 11-second-edit app. */
(() => {
  const $ = (s) => document.querySelector(s);
  const state = { videos: [], brollClips: [], jobId: null, poll: null, notes: [] };

  /* ================= option definitions =================
   * Each option: key, title, desc, default on/off, gear config (null = no gear).
   * Settings live in state.settings[key] — a plain object saved with the job.
   */
  const F = (v) => !!(v && v.on); // helper: option on?

  const OPTIONS = [
    { key: "brand", title: "Brand template",
      desc: "Pick a style — watch a sample reel of each — or point the editor at your own Reels",
      on: false, gear: {
        gallery: true,
        hint: "Hover a card to preview its sample reel. Picking one applies its caption, hook, zoom, music & SFX style to the other edits below.",
        fields: [
          { id: "links", label: "…or your own: Reel links (one per line, for the editor to study)", type: "textarea" },
        ],
      } },
    { key: "removeBadTakes", title: "Remove bad takes",
      desc: "Claude listens for false starts, flubs and stumbles and cuts them", on: true, gear: null },
    { key: "removeFillers", title: "Remove filler words",
      desc: "uh, um, like, you know… plus your own list", on: true, gear: {
        fields: [
          { id: "customList", label: "Extra words/phrases to remove (comma-separated)", type: "text",
            placeholder: "basically, actually, right" },
        ],
        hint: "Default list: uh, um, er, oh, like, you know, I mean…",
      } },
    { key: "removeSilences", title: "Cut silences & dead air",
      desc: "Pauses are removed and snapped to word boundaries — never mid-word", on: true, gear: {
        fields: [
          { id: "minGap", label: "Only cut silences longer than (seconds)", type: "number", step: 0.1, min: 0.3 },
        ],
      } },
    { key: "captions", title: "Animated captions",
      desc: "Word-by-word, bold, always-on", on: true, gear: {
        inherit: true,
        fields: [
          { id: "custom", label: "", type: "check", text: "Customize (off = style preset)" },
          { id: "font", label: "Font", type: "select",
            options: ["Impact (default)", "Montserrat ExtraBold", "Anton", "Inter Bold"] },
          { id: "size", label: "Size", type: "number", step: 1, min: 24, max: 160 },
          { id: "color", label: "Text color", type: "swatches",
            values: ["#ffffff", "#ffd60a", "#ff6b35", "#4cc9f0"] },
          { id: "outline", label: "Outline / shadow", type: "check", text: "Black outline (recommended)" },
          { id: "minWords", label: "Minimum words per caption block", type: "number", step: 1, min: 1, max: 12 },
        ],
      } },
    { key: "broll", title: "AI finds b-roll for you",
      desc: "Tell it what to look for — leave blank and the editor decides", on: false, gear: {
        fields: [
          { id: "aiPrompt", label: "What b-roll to look for?", type: "text",
            placeholder: "e.g. city skyline, coffee being poured, keyboard typing" },
        ],
        hint: "Sourced from your uploaded clips first, then from stock when available.",
      } },
    { key: "brollOwn", title: "Add my own b-roll",
      desc: "Drop clips and tell the editor when to use each one", on: false, gear: null, inline: "broll" },
    { key: "emotion", title: "Auto emotion graphics",
      desc: "Small animated bits at emotional beats — describe what you want", on: false, gear: {
        fields: [
          { id: "desc", label: "Describe the graphics", type: "textarea",
            placeholder: 'e.g. "Claude logo dancing with sunglasses when I get excited"' },
        ],
      } },
    { key: "instructions", title: "Instructions (optional)",
      desc: "Anything else the editor should know about this video", on: false, gear: {
        fields: [
          { id: "text", label: "Extra instructions for the editor", type: "textarea",
            placeholder: "e.g. keep the intro under 3 seconds, end on the laugh" },
        ],
      } },
    { key: "zooms", title: "Auto zoom cuts",
      desc: "Punch-ins on key beats", on: true, gear: {
        fields: [
          { id: "strength", label: "Zoom strength", type: "select",
            options: ["Auto (editor decides)", "Subtle", "Medium", "Strong"] },
        ],
      } },
    { key: "music", title: "Auto music track",
      desc: "Background music matched to the energy (ElevenLabs)", on: false, gear: {
        fields: [
          { id: "style", label: "Music style", type: "text",
            placeholder: "e.g. upbeat lofi, dark cinematic, none — you decide" },
        ],
      } },
    { key: "sfx", title: "AI sound effects",
      desc: "Whooshes on cuts, pops and dings on beats", on: true, gear: null },
    { key: "enhanceAudio", title: "Enhance audio",
      desc: "Loudness, clarity and noise shaping", on: true, gear: null },
    { key: "color", title: "Auto color correction",
      desc: "Make the shot look like it was graded", on: true, gear: {
        fields: [
          { id: "brightness", label: "Balance brightness & contrast", type: "check", text: "" },
          { id: "lift", label: "Lift faded colors", type: "check", text: "" },
          { id: "whiteBalance", label: "Correct white balance", type: "check", text: "" },
        ],
      } },
    { key: "hook", title: "Auto verbal hook",
      desc: "The editor picks the best first line from your take", on: true, gear: {
        fields: [
          { id: "audience", label: "Target audience", type: "text",
            placeholder: "e.g. indie developers, new founders" },
        ],
      } },
    { key: "textHook", title: "Auto text hook",
      desc: "On-screen text hook at the start", on: true, gear: {
        inherit: true,
        fields: [
          { id: "mode", label: "", type: "select",
            options: ["AI writes it from the transcript", "I write it myself"] },
          { id: "text", label: "Hook text (if you write it)", type: "text",
            placeholder: "I stopped using AI editors after this…" },
          { id: "color", label: "Text color", type: "swatches",
            values: ["#000000", "#ffffff", "#ff6b35", "#ef4444", "#22c55e", "#3b82f6"] },
        ],
      } },
    { key: "cta", title: "Call-to-action card",
      desc: "Follow / subscribe card at the end", on: true, gear: {
        fields: [
          { id: "text", label: "CTA text (blank = editor writes it)", type: "text",
            placeholder: "Follow for more like this" },
        ],
      } },
    { key: "transcribe", title: "Pro transcription",
      desc: "Language, vocabulary, censoring", on: true, gear: {
        fields: [
          { id: "language", label: "Language", type: "select",
            options: ["Auto-detect (multilingual)", "American English", "British English",
                       "Hindi", "Punjabi", "Spanish", "French", "German"] },
          { id: "vocab", label: "Custom vocabulary (comma-separated)", type: "text",
            placeholder: "e.g. WhisperX, ffmpeg, Claude Code" },
          { id: "censor", label: "Censor swear words", type: "check", text: "" },
        ],
      } },
    { key: "targetLength", title: "Target video length",
      desc: "Auto or a specific duration", on: false, gear: {
        fields: [
          { id: "mode", label: "", type: "select", options: ["Auto (editor decides)", "Specific length"] },
          { id: "seconds", label: "Target length (seconds)", type: "number", step: 1, min: 15, max: 600 },
        ],
      } },
  ];

  const DEFAULTS = {
    brand: {}, removeFillers: { customList: "" }, removeSilences: { minGap: 0.45 },
    captions: { custom: false, font: "Impact (default)", size: 64, color: "#ffffff", outline: true, minWords: 2 },
    broll: { aiPrompt: "" }, emotion: { desc: "" }, instructions: { text: "" },
    zooms: { strength: "Auto (editor decides)" }, music: { style: "" },
    color: { brightness: true, lift: true, whiteBalance: true },
    hook: { audience: "" }, textHook: { mode: "AI writes it from the transcript", text: "", color: "#ffffff" },
    cta: { text: "" },
    transcribe: { language: "Auto-detect (multilingual)", vocab: "", censor: false },
    targetLength: { mode: "Auto (editor decides)", seconds: 30 },
  };
  state.settings = JSON.parse(JSON.stringify(DEFAULTS));

  /* ================= option rows ================= */
  function optOn(key) {
    const def = OPTIONS.find(o => o.key === key);
    return state.toggles[key] !== undefined ? state.toggles[key] : !!def.on;
  }
  state.toggles = {};

  const rowsEl = $("#optRows");
  for (const opt of OPTIONS) {
    const row = document.createElement("div");
    row.className = "opt-row" + (optOn(opt.key) ? "" : " disabled");
    const sw = document.createElement("div");
    sw.className = "sw" + (optOn(opt.key) ? " on" : "");
    const main = document.createElement("div");
    main.className = "opt-main";
    main.innerHTML = `<div class="opt-t">${opt.title}</div><div class="opt-d">${opt.desc}</div>`;
    const ctl = document.createElement("div");
    ctl.className = "opt-ctl";

    if (opt.gear) {
      const gear = document.createElement("button");
      gear.className = "gear"; gear.title = "Settings"; gear.textContent = "⚙";
      gear.onclick = () => openGear(opt);
      ctl.appendChild(gear);
    }
    if (opt.inline === "broll") ctl.appendChild(brollMini(opt));
    ctl.appendChild(sw);
    const toggle = () => {
      state.toggles[opt.key] = !optOn(opt.key);
      sw.classList.toggle("on", optOn(opt.key));
      row.classList.toggle("disabled", !optOn(opt.key));
      if (optOn(opt.key) && opt.gear) openGear(opt);
    };
    sw.onclick = toggle;
    main.style.cursor = "pointer";
    main.onclick = toggle;

    row.append(main, ctl);
    rowsEl.appendChild(row);
  }

  function brollMini(opt) {
    const btn = document.createElement("button");
    btn.className = "gear"; btn.title = "Add b-roll files"; btn.textContent = "🎞️";
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "video/*"; inp.multiple = inp.style.display = "none";
    inp.onchange = async () => {
      for (const f of inp.files) {
        const up = await upload(f, "broll");
        state.brollClips.push({ path: up.path, name: f.name, note: "" });
        renderBrollClips();
      }
      inp.value = "";
    };
    btn.onclick = () => inp.click();
    btn.after(inp);
    return btn;
  }

  function renderBrollClips() {
    const host = $("#brollList");
    if (!host) return;
    host.innerHTML = "";
    for (const [i, c] of state.brollClips.entries()) {
      const li = document.createElement("li");
      li.innerHTML = `<span>🎞️ ${c.name}</span>`;
      const note = document.createElement("input");
      note.type = "text"; note.placeholder = "when to use (optional)";
      note.style.cssText = "flex:1;min-width:140px;background:#0d0d14;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 9px;font-size:12.5px";
      note.onchange = () => { c.note = note.value; };
      const rm = document.createElement("button");
      rm.className = "mini"; rm.textContent = "remove";
      rm.onclick = () => { state.brollClips.splice(i, 1); renderBrollClips(); };
      li.append(li.firstChild, note, rm);
      host.appendChild(li);
    }
  }

  /* ================= gear modals ================= */
  const modalBack = $("#modalBack"), modal = $("#modal");
  modalBack.onclick = (e) => { if (e.target === modalBack) closeGear(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGear(); });
  function closeGear() {
    modal.querySelectorAll("video").forEach(v => { try { v.pause(); } catch (e) {} });
    modalBack.classList.add("hidden");
  }

  /* ---------- brand template gallery ---------- */
  async function loadTemplates() {
    if (state.templates) return state.templates;
    try {
      const r = await fetch("templates.json");
      state.templates = (await r.json()).templates;
    } catch (e) { state.templates = []; }
    return state.templates;
  }

  function tplCard(id, name, desc, src) {
    const sel = (state.settings.brand || {}).template === id;
    const card = document.createElement("div");
    card.className = "tpl-card" + (sel ? " sel" : "");
    if (src) {
      const v = document.createElement("video");
      v.src = src; v.muted = true; v.loop = true; v.playsInline = true;
      v.preload = "metadata"; v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
      card.appendChild(v);
      card.addEventListener("mouseenter", () => v.play().catch(() => {}));
      card.addEventListener("mouseleave", () => { try { v.pause(); } catch (e) {} });
    } else {
      const ph = document.createElement("div"); ph.className = "tpl-none"; ph.textContent = "✨ No preset";
      card.appendChild(ph);
    }
    const nm = document.createElement("div"); nm.className = "tpl-name"; nm.textContent = name;
    const ds = document.createElement("div"); ds.className = "tpl-desc"; ds.textContent = desc;
    card.append(nm, ds);
    card.onclick = () => selectTemplate(id, name, desc);
    return card;
  }

  function selectTemplate(id, name) {
    const s = state.settings;
    if (id === "none") {
      s.brand = Object.assign({}, s.brand, { template: "none", name: null, style: null, structure: null });
    } else {
      const t = (state.templates || []).find(x => x.id === id);
      if (!t) return;
      s.brand = Object.assign({}, s.brand, { template: t.id, name: t.name, style: t.style, structure: t.structure });
      const st = t.style || {};
      if (st.captions) s.captions = {
        custom: true, font: "Impact (default)",
        size: st.captions.size || 64, color: st.captions.color || "#ffffff",
        outline: !!st.captions.outline, minWords: st.captions.minWords || 2,
      };
      if (st.hookColor) s.textHook = Object.assign({}, s.textHook, { color: st.hookColor });
      if (st.zoomStrength) s.zooms = { strength: st.zoomStrength };
      if (st.music && st.music !== "none") { s.music = { style: st.music }; state.toggles.music = true; }
      if (st.sfx === "none") state.toggles.sfx = false; else state.toggles.sfx = true;
      if (st.broll === "heavy" || st.broll === "medium") state.toggles.broll = true;
      if (st.broll === "none") state.toggles.broll = false;
    }
    syncRows();
    // re-render the brand modal so the selection ring + inherited fields reflect the choice
    openGear(OPTIONS.find(o => o.key === "brand"));
    toast(`Template “${name}” applied to your edit`);
  }

  function renderTemplateGallery() {
    const host = document.createElement("div"); host.className = "tpl-gal";
    const loading = document.createElement("p"); loading.className = "m-hint";
    loading.textContent = "Loading styles…"; host.appendChild(loading);
    modal.appendChild(host);
    loadTemplates().then(tpls => {
      host.innerHTML = "";
      host.appendChild(tplCard("none", "None", "No preset — the editor decides everything from the content", null));
      for (const t of tpls) host.appendChild(tplCard(t.id, t.name, t.desc, t.sample));
    });
  }

  function openGear(opt) {
    const s = state.settings[opt.key] || {};
    modal.querySelectorAll("video").forEach(v => { try { v.pause(); } catch (e) {} });
    modal.innerHTML = "";
    const h = document.createElement("h3"); h.textContent = opt.title + " — settings"; modal.appendChild(h);
    if (opt.gear.hint) { const p = document.createElement("p"); p.className = "m-hint"; p.textContent = opt.gear.hint; modal.appendChild(p); }
    if (opt.gear.gallery) renderTemplateGallery();
    if (opt.gear.inherit) {
      const inh = document.createElement("div");
      inh.className = "m-inherit";
      inh.textContent = "↺ Inherit from brand template";
      inh.onclick = () => { // apply what the selected brand template supplies for this option
        const st = (state.settings.brand || {}).style || {};
        if (opt.key === "captions" && st.captions) {
          state.settings.captions = { custom: true, font: "Impact (default)",
            size: st.captions.size || 64, color: st.captions.color || "#ffffff",
            outline: !!st.captions.outline, minWords: st.captions.minWords || 2 };
        } else if (opt.key === "textHook" && st.hookColor) {
          state.settings.textHook = Object.assign({}, state.settings.textHook, { color: st.hookColor });
        } else {
          state.settings[opt.key] = JSON.parse(JSON.stringify(DEFAULTS[opt.key] || {}));
        }
        openGear(opt);
      };
      modal.appendChild(inh);
    }
    for (const f of opt.gear.fields) {
      const wrap = document.createElement("div"); wrap.className = "m-field";
      const mkLabel = (txt) => { const l = document.createElement("label"); l.textContent = txt; wrap.appendChild(l); };
      const val = f.id in s ? s[f.id] : (f.id in (DEFAULTS[opt.key] || {}) ? DEFAULTS[opt.key][f.id] : "");
      if (f.type === "check") {
        const c = document.createElement("input"); c.type = "checkbox"; c.checked = !!val;
        if (f.text) mkLabel("");
        wrap.appendChild(c);
        const t = document.createElement("span"); t.textContent = f.text || f.label; t.style.fontSize = "14px";
        if (!f.text) t.textContent = f.label;
        wrap.append(c, t);
        c.onchange = () => { s[f.id] = c.checked; };
      } else if (f.type === "select") {
        mkLabel(f.label);
        const sel = document.createElement("select");
        for (const o of f.options) { const op = document.createElement("option"); op.textContent = o; if (o === val) op.selected = true; sel.appendChild(op); }
        sel.onchange = () => { s[f.id] = sel.value; };
        wrap.appendChild(sel);
      } else if (f.type === "number") {
        mkLabel(f.label);
        const n = document.createElement("input"); n.type = "number"; n.value = val;
        if (f.step) n.step = f.step; if (f.min != null) n.min = f.min; if (f.max != null) n.max = f.max;
        n.onchange = () => { s[f.id] = Number(n.value); };
        wrap.appendChild(n);
      } else if (f.type === "swatches") {
        mkLabel(f.label);
        const row = document.createElement("div"); row.className = "color-swatches";
        const swatchList = (val && !f.values.includes(val)) ? [...f.values, val] : f.values;
        for (const hex of swatchList) {
          const d = document.createElement("div");
          d.className = "color-sw" + (hex === val ? " sel" : "");
          d.style.background = hex; d.title = hex;
          d.onclick = () => { s[f.id] = hex; row.querySelectorAll(".color-sw").forEach(x => x.classList.remove("sel")); d.classList.add("sel"); };
          row.appendChild(d);
        }
        wrap.appendChild(row);
      } else { // text / textarea
        if (f.label) mkLabel(f.label);
        const el = f.type === "textarea" ? document.createElement("textarea") : document.createElement("input");
        if (f.type !== "textarea") el.type = "text";
        el.value = val; if (f.placeholder) el.placeholder = f.placeholder;
        el.oninput = () => { s[f.id] = el.value; };
        wrap.appendChild(el);
      }
      modal.appendChild(wrap);
    }
    const foot = document.createElement("div"); foot.className = "m-foot";
    const done = document.createElement("button"); done.className = "big"; done.textContent = "Done";
    done.onclick = closeGear;
    foot.appendChild(done); modal.appendChild(foot);
    modalBack.classList.remove("hidden");
  }

  /* ================= presets (save / load) ================= */
  const PRE_KEY = "11se-presets-v1";
  function readPresets() { try { return JSON.parse(localStorage.getItem(PRE_KEY) || "{}"); } catch { return {}; } }
  function writePresets(p) { localStorage.setItem(PRE_KEY, JSON.stringify(p)); }
  function snapshot() {
    return { toggles: { ...state.toggles }, settings: JSON.parse(JSON.stringify(state.settings)) };
  }
  function applySnapshot(snap) {
    if (!snap) return;
    state.toggles = { ...snap.toggles };
    state.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), snap.settings);
    syncRows();
  }
  function syncRows() {
    document.querySelectorAll(".opt-row").forEach((row, i) => {
      const key = OPTIONS[i].key;
      const sw = row.querySelector(".sw");
      sw.classList.toggle("on", optOn(key));
      row.classList.toggle("disabled", !optOn(key));
    });
  }
  function refreshPresetUI() {
    const names = Object.keys(readPresets());
    $("#presetLoad").classList.toggle("hidden", names.length === 0);
    $("#presetClear").classList.toggle("hidden", !$("#presetName").value);
  }
  $("#presetName").addEventListener("input", refreshPresetUI);
  $("#presetSave").onclick = () => {
    const name = $("#presetName").value.trim();
    if (!name) { alert("Give the preset a name first."); return; }
    const all = readPresets();
    all[name] = snapshot();
    writePresets(all);
    toast(`Preset “${name}” saved`);
  };
  $("#presetLoad").onclick = () => {
    const all = readPresets();
    const names = Object.keys(all);
    if (!names.length) return;
    const pick = prompt("Presets:\n" + names.map((n, i) => (i + 1) + ". " + n).join("\n") + "\n\nEnter number to load:");
    const n = Number(pick);
    if (n >= 1 && n <= names.length) { applySnapshot(all[names[n - 1]]); toast(`Loaded “${names[n - 1]}”`); }
  };
  refreshPresetUI();
  function toast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#123527;color:#34d399;border:1px solid #22c55e;padding:10px 18px;border-radius:10px;font-weight:600;z-index:99";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  /* ================= file picking ================= */
  function dragZone(dz, onfiles) {
    ["dragover", "dragenter"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
    dz.addEventListener("drop", (e) => onfiles(e.dataTransfer.files));
  }
  let upBar = null;
  function uploadProgress(msg) {
    if (!upBar) {
      upBar = document.createElement("div");
      upBar.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#0f172a;color:#7dd3fc;border:1px solid #38bdf8;padding:10px 18px;border-radius:10px;font-weight:600;z-index:99;box-shadow:0 6px 24px rgba(0,0,0,.45);max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      document.body.appendChild(upBar);
    }
    upBar.textContent = msg;
  }
  function uploadDone() { if (upBar) { upBar.remove(); upBar = null; } }
  function upload(file, kind) {
    // XHR instead of fetch: we need upload progress events — remote uploads
    // (e.g. from a laptop over the network) take long enough to feel dead
    // without a live percentage.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}&kind=${kind}`);
      if (file.type) xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((100 * e.loaded) / e.total);
          uploadProgress(`⬆ Uploading ${file.name} — ${pct}% · ${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`);
        } else {
          uploadProgress(`⬆ Uploading ${file.name}… ${(e.loaded / 1048576).toFixed(1)} MB`);
        }
      };
      const fail = (msg) => { uploadDone(); reject(new Error(msg)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          uploadDone();
          try { resolve(JSON.parse(xhr.responseText)); } catch { fail("server returned an invalid response"); }
        } else {
          let msg = "HTTP " + xhr.status;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
          fail(msg);
        }
      };
      xhr.onerror = () => fail("network error — the connection to the server was interrupted mid-upload. Check the network path to this server and retry (the upload can resume by simply retrying).");
      xhr.onabort = () => fail("upload was aborted");
      uploadProgress(`⬆ Uploading ${file.name}…`);
      xhr.send(file);
    });
  }
  const baseInput = $("#baseFile");
  baseInput.onchange = () => baseInput.files[0] && addVideo(baseInput.files[0]);
  dragZone($("#baseDrop"), (files) => { for (const f of files) addVideo(f); });
  $("#addVideoBtn").onclick = () => baseInput.click();

  async function addVideo(file) {
    setBusy(true);
    try {
      const up = await upload(file, "base");
      state.videos.push({ path: up.path, name: file.name });
      renderVideos();
    } catch (e) { alert("Upload failed: " + e.message); }
    setBusy(false);
  }
  function renderVideos() {
    const ul = $("#vidList");
    ul.innerHTML = "";
    state.videos.forEach((v, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${i === 0 ? "🎬" : "🎞️"} ${v.name}${i === 0 ? "" : " <small style='color:var(--dim)'>(extra — usable as b-roll)</small>"}</span>`;
      const rm = document.createElement("button"); rm.className = "mini"; rm.textContent = "remove";
      rm.onclick = () => { state.videos.splice(i, 1); renderVideos(); };
      li.append(li.firstChild, rm);
      ul.appendChild(li);
    });
    $("#basePicked").classList.toggle("hidden", state.videos.length === 0);
    $("#baseDrop").classList.toggle("hidden", state.videos.length > 0);
    if (state.videos.length) $("#baseName").textContent = state.videos.map(v => v.name).join(" + ");
    syncEditBtn();
  }
  $("#baseClear").onclick = () => { state.videos = []; renderVideos(); };
  $("#baseUsePath").onclick = () => {
    const p = $("#basePath").value.trim();
    if (!p) return;
    state.videos.push({ path: p, name: p.split("/").pop() });
    renderVideos();
  };

  function setBusy(b) { $("#editBtn").disabled = b; }
  function syncEditBtn() { $("#editBtn").disabled = !state.videos.length; }

  /* ================= start edit ================= */
  $("#editBtn").onclick = async () => {
    const on = (k) => optOn(k);
    const features = {
      enhanceAudio: on("enhanceAudio"),
      removeBadTakes: on("removeBadTakes"),
      removeFillers: on("removeFillers"),
      removeSilences: on("removeSilences"),
      broll: on("broll") || on("brollOwn"),
      zooms: on("zooms"),
      color: on("color"),
      hook: on("hook"),
      cta: on("cta"),
      captions: on("captions"),
      music: on("music"),
      sfx: on("sfx"),
    };
    const aspect = document.querySelector('input[name=format]:checked').value === "long" ? "16:9" : "9:16";
    const settings = {
      brand: state.settings.brand,
      fillers: { customList: (state.settings.removeFillers || {}).customList || "" },
      silences: state.settings.removeSilences || { minGap: 0.45 },
      captions: state.settings.captions,
      broll: { aiPrompt: state.settings.broll.aiPrompt || "", clips: state.brollClips },
      emotion: state.settings.emotion,
      instructions: state.settings.instructions.text || "",
      zooms: state.settings.zooms,
      music: state.settings.music,
      color: state.settings.color,
      hook: state.settings.hook,
      textHook: state.settings.textHook,
      cta: state.settings.cta,
      transcribe: state.settings.transcribe,
      targetLength: state.settings.targetLength,
    };
    setBusy(true);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoPath: state.videos[0].path,
          brollPaths: [...state.videos.slice(1).map(v => v.path), ...state.brollClips.map(c => c.path)],
          features, aspect, settings,
          outName: (state.videos[0].name || "reel").replace(/\.[^.]+$/, "") + "-11s",
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      startProgress(j.id);
    } catch (e) { alert("Could not start: " + e.message); setBusy(false); }
  };

  /* ================= progress ================= */
  function startProgress(id) {
    state.jobId = id;
    $("#setup").classList.add("hidden");
    $("#progress").classList.remove("hidden");
    $("#doneRow").classList.add("hidden");
    poll();
    state.poll = setInterval(poll, 1400);
  }
  async function poll() {
    const id = state.jobId;
    if (!id) return;
    let st;
    try { st = await (await fetch(`/api/jobs/${id}/state`)).json(); } catch { return; }
    const chip = $("#progChip");
    chip.className = "chip " + (st.status === "done" ? "done" : st.status === "failed" ? "failed" : "");
    chip.textContent = st.status === "pending" ? "auto-edit running…" : st.status;
    const ol = $("#checklist");
    ol.innerHTML = "";
    for (const s of st.steps || []) {
      const li = document.createElement("li");
      const icon = { pending: "○", running: "◐", done: "✓", skipped: "↷", failed: "✕" }[s.status] || "○";
      li.innerHTML = `<span class="ck ${s.status}">${icon}</span><span class="ck-body"><div class="ck-label">${s.label}</div><div class="ck-detail">${s.detail || ""}</div></span>`;
      ol.appendChild(li);
    }
    if (st.status === "done") {
      clearInterval(state.poll);
      $("#progTitle").textContent = "Done — your edit is ready";
      $("#openEditorBtn").href = "#editor";
      $("#openEditorBtn").onclick = (e) => { e.preventDefault(); openEditor(id); };
      if (window.__fc) $("#fcOpenBtn").onclick = (e) => { e.preventDefault(); window.__fc.openFilmCraft(id); };
      $("#downloadBtn").href = `/api/jobs/${id}/export`;
      $("#doneRow").classList.remove("hidden");
    }
    if (st.status === "failed") clearInterval(state.poll);
  }

  /* ================= editor ================= */
  let edData = null; // {id, transcript, plan}
  async function openEditor(id) {
    $("#progress").classList.add("hidden");
    const ed = $("#editor");
    ed.classList.remove("hidden");
    $("#prev").src = `/composition.html?job=${id}`;
    await loadEditor(id);
    ed.scrollIntoView({ behavior: "smooth" });
    $("#noteText").focus();
  }
  async function loadEditor(id) {
    const [tr, pl] = await Promise.all([
      fetch(`/api/jobs/${id}/transcript`).then(r => r.ok ? r.json() : null),
      fetch(`/api/jobs/${id}/plan`).then(r => r.ok ? r.json() : null),
    ]);
    if (!tr) return;
    edData = { id, transcript: tr, plan: pl };
    await renderEditor();
  }
  async function renderEditor() {
    const { id, transcript: tr, plan: pl } = edData;
    const cutSet = new Set((pl && pl.cuts && pl.cuts.words) || []);
    let segs, total;
    if (window.PlanLib) { // same math as the preview + render (single source of truth)
      const st = window.PlanLib.deriveAll(tr.words, { cuts: { words: [...cutSet] } });
      segs = st.segments.map(s => ({ start: s.tlStart, end: s.tlEnd, srcStart: s.srcStart, srcEnd: s.srcEnd }));
      total = st.duration || (tr.duration || 0);
    } else {
      segs = segsOf(tr.words, cutSet);
      total = segs.length ? segs[segs.length - 1].end : (tr.duration || 0);
    }
    $("#tlMeta").textContent = `${segs.length} segments · ${total.toFixed(1)}s · ${pl ? pl.aspect : "9:16"}`;
    const tl = $("#tl");
    tl.innerHTML = "";
    if (total > 0) {
      for (const s of segs) {
        const d = document.createElement("div");
        d.className = "tl-seg";
        d.style.left = (s.start / total * 100) + "%";
        d.style.width = Math.max(0.6, (s.end - s.start) / total * 100) + "%";
        tl.appendChild(d);
      }
      if (pl && pl.broll) for (const b of pl.broll) {
        const d = document.createElement("div");
        d.className = "tl-seg broll";
        d.style.left = (b.tlStart / total * 100) + "%";
        d.style.width = Math.max(0.6, b.dur / total * 100) + "%";
        d.style.top = "50%";
        tl.appendChild(d);
      }
      // current playhead from the preview iframe
      const mark = document.createElement("div");
      mark.className = "tl-seg"; mark.style.cssText = "top:0;bottom:0;width:2px;background:var(--acc);z-index:5";
      mark.id = "tlPlayhead";
      tl.appendChild(mark);
    }
    const trEl = $("#tr");
    trEl.innerHTML = "";
    tr.words.forEach((w, i) => {
      const s = document.createElement("span");
      s.className = "w" + (cutSet.has(i) ? " cut" : "");
      s.textContent = w.word;
      s.onclick = async () => {
        await fetch(`/api/jobs/${id}/word/${i}/${cutSet.has(i) ? "uncut" : "cut"}`, { method: "POST" });
        loadEditor(id);
        const prev = $("#prev");
        prev.src = prev.src.split("&t=")[0] + "&t=" + Date.now();
      };
      trEl.appendChild(s);
      trEl.appendChild(document.createTextNode(" "));
    });
    $("#exportBtn2").href = `/api/jobs/${id}/export`;
    $("#xmlBtn").classList.remove("hidden");
    $("#xmlBtn").onclick = () => downloadXML(id);
    $("#reRenderBtn").onclick = async () => {
      const btn = $("#reRenderBtn");
      btn.textContent = "⏳ sent — re-rendering automatically…";
      btn.style.pointerEvents = "none";
      await fetch(`/api/jobs/${id}/rerender`, { method: "POST" }).catch(() => {});
      const res = await waitDone(id);
      refreshPreview(id);
      btn.textContent = "↻ Re-render with current cuts";
      btn.style.pointerEvents = "auto";
      loadEditor(id);
    };
    edData.total = total;
    sel = null;
    updateSelUI();
    renderAIReqs();
    // playhead follows the preview
    if (state.phTick) clearInterval(state.phTick);
    let phN = 0;
    state.phTick = setInterval(() => {
      try {
        const doc = $("#prev").contentWindow;
        if (!doc) return;
        const t = doc.__t, dur = doc.__dur;
        if (t != null && dur && $("#tlPlayhead")) $("#tlPlayhead").style.left = (t / dur * 100) + "%";
        if (t != null && !sel) $("#selRange").textContent = "at " + fmtT(t) + " (select a section)";
      } catch {}
      if (++phN % 5 === 0) renderAIReqs(); // refresh AI-edit statuses a few times a second
    }, 700);
  }
  function fmtT(x) { const m = Math.floor(x / 60), s = x - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); }

  /* ---- section editor: select a range + AI edit instruction ---- */
  let sel = null; // {t0, t1} on the FINAL timeline
  function updateSelUI() {
    const el = $("#selRange");
    if (sel) el.textContent = fmtT(sel.t0) + " → " + fmtT(sel.t1) + ` (${(sel.t1 - sel.t0).toFixed(1)}s)`;
    else el.textContent = "no selection";
    $("#applyNotes").disabled = !sel;
  }
  function tlTime(clientX) {
    const r = $("#tl").getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (edData.total || 1);
  }
  function selOverlay(x0p, x1p) {
    let ov = document.getElementById("tlSel");
    if (!ov) {
      ov = document.createElement("div"); ov.id = "tlSel";
      ov.style.cssText = "position:absolute;top:0;bottom:0;background:rgba(255,214,10,.28);border-left:2px solid var(--acc);border-right:2px solid var(--acc);z-index:4;";
      $("#tl").appendChild(ov);
    }
    const a = Math.min(x0p, x1p), b = Math.max(x0p, x1p);
    ov.style.left = a + "%"; ov.style.width = Math.max(0.5, b - a) + "%";
  }
  function hideSelOverlay() { const ov = document.getElementById("tlSel"); if (ov) ov.style.display = "none"; }

  $("#tl").addEventListener("mousedown", (e) => {
    if (!edData) return;
    e.preventDefault();
    const x0 = e.clientX;
    const r = $("#tl").getBoundingClientRect();
    const move = (ev) => selOverlay((x0 - r.left) / r.width * 100, (ev.clientX - r.left) / r.width * 100);
    const up = (ev) => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const a = Math.min(x0, ev.clientX), b = Math.max(x0, ev.clientX);
      const t0 = (a - r.left) / r.width * (edData.total || 1);
      let t1 = (b - r.left) / r.width * (edData.total || 1);
      if (t1 - t0 < 0.15) t1 = Math.min(t0 + 2, edData.total || t0 + 2); // click = point → 2s section
      sel = { t0: Math.max(0, t0), t1: Math.max(t0 + 0.2, t1) };
      updateSelUI();
      hideSelOverlay();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  function prevT() { try { return $("#prev").contentWindow.__t; } catch { return null; } }
  $("#markIn").onclick = () => {
    const t = prevT(); if (t == null) return;
    sel = sel ? { t0: t, t1: Math.max(sel.t1, t + 1) } : { t0: t, t1: t + 2 };
    updateSelUI();
  };
  $("#markOut").onclick = () => {
    const t = prevT(); if (t == null) return;
    sel = sel ? { t0: Math.min(sel.t0, t - 1), t1: t } : { t0: Math.max(0, t - 2), t1: t };
    updateSelUI();
  };
  $("#clearSel").onclick = () => { sel = null; updateSelUI(); };

  async function renderAIReqs() {
    if (!edData) return;
    try {
      const r = await fetch(`/api/jobs/${edData.id}/ai`);
      if (!r.ok) return;
      const j = await r.json();
      const ul = $("#noteList");
      ul.innerHTML = "";
      (j.requests || []).slice(-8).reverse().forEach((n) => {
        const li = document.createElement("li");
        const st = { pending: "⏳ queued", applied: "✓ applied", "needs-review": "✎ needs review" }[n.status] || n.status;
        li.innerHTML = `<span class="nt">${fmtT(n.t0)}–${fmtT(n.t1)}</span><span style="flex:1">${n.instruction}</span><span class="hint2">${st}</span>`;
        if (n.result) {
          const div = document.createElement("div");
          div.className = "hint2";
          div.style.cssText = "margin-top:2px;white-space:normal";
          div.textContent = n.result;
          li.appendChild(div);
        }
        ul.appendChild(li);
      });
    } catch { /* server hiccup — next tick retries */ }
  }

  $("#applyNotes").onclick = async () => {
    const id = edData.id;
    const ins = $("#noteText").value.trim();
    const status = $("#notesStatus");
    if (!ins) { status.textContent = "Type what to change in the selected section."; return; }
    if (!sel) { status.textContent = "Select a section first — drag on the timeline."; return; }
    const btn = $("#applyNotes");
    btn.textContent = "⏳ sending…"; btn.disabled = true;
    try {
      const r = await fetch(`/api/jobs/${id}/ai`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t0: sel.t0, t1: sel.t1, instruction: ins }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      status.textContent = "Queued — it applies now and re-renders automatically…";
      $("#noteText").value = "";
      sel = null; updateSelUI();
      renderAIReqs();
      const res = await waitDone(id);
      refreshPreview(id);
      renderAIReqs(); // pick up the applied/needs-review result
      if (res === "done") status.textContent = "Applied ✓ and re-rendered — preview updated.";
      else if (res === "failed") status.textContent = "Failed — check the job log.";
    } catch (e) {
      status.textContent = "Failed: " + e.message;
    }
    btn.textContent = "⚡ Apply AI edit"; btn.disabled = !sel;
  };

  /* Wait until the automatic engine finishes the run that started just now,
     then refresh the preview iframe (new plan + new audio mix). */
  async function waitDone(id) {
    const t0 = Date.now();
    for (let i = 0; i < 240; i++) { // up to ~16 min (render is the long pole)
      await new Promise(r => setTimeout(r, 4000));
      try {
        const st = await (await fetch(`/api/jobs/${id}/state`)).json();
        if (st.status === "failed") return "failed";
        if (st.status === "done" && new Date(st.updatedAt || 0).getTime() > t0) return "done";
      } catch { /* retry */ }
    }
    return "timeout";
  }
  function refreshPreview(id) {
    $("#prev").src = `/composition.html?job=${id}&t=${Date.now()}`;
  }

  /* ---- XML export (DaVinci Resolve / Premiere / Final Cut) ---- */
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function downloadXML(id) {
    const { transcript: tr, plan: pl } = edData;
    const cutSet = new Set((pl && pl.cuts && pl.cuts.words) || []);
    let segs;
    if (window.PlanLib) {
      segs = window.PlanLib.deriveAll(tr.words, { cuts: { words: [...cutSet] } }).segments;
    } else {
      segs = segsOf(tr.words, cutSet);
    }
    const fps = 30;
    const rows = segs.map((s, i) => {
      const tc = (x) => { const f = Math.round(x * fps); return `01:00:${String(Math.floor(f / 3600) % 24).padStart(2, "0")}:${String(Math.floor((f % 3600) / 60)).padStart(2, "0")}:${String(f % 60).padStart(2, "0")}`; };
      return `        <SequenceEntry IN="${tc(s.srcStart)}" OUT="${tc(s.srcEnd)}">\n          <ClipEntry IN="${tc(s.start)}" OUT="${tc(s.end)}" NAME="${esc("segment " + (i + 1))}" SRC="${esc(id + " segment " + (i + 1))}"/>\n        </SequenceEntry>`;
    });
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- 11 Second Edit — cut list (word-index cuts, never mid-word).
     Import into DaVinci Resolve / Premiere / Final Cut: the timeline lists each kept
     segment with its source in/out points from the original file. -->
<SequenceSequenceEdit version="1.6" fps="${fps}">
  <SequenceEditInfo NAME="${esc((pl && pl.outName) || "edit")}" fps="${fps}"/>
  <Sequence>
${rows.join("\n")}
  </Sequence>
</SequenceSequenceEdit>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([xml], { type: "text/xml" }));
    a.download = (pl && pl.outName || "edit") + ".xml";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // studio → FilmCraft replica view
  $("#fcFromStudio").onclick = () => {
    if (window.__fc && edData && edData.id) window.__fc.openFilmCraft(edData.id);
  };

  // debug / automation hook
  window.__11se = { openEditor, state, OPTIONS };

  // same math as planlib.deriveSegments (kept here so the panel works without loading it)
  function segsOf(words, cutSet) {
    const out = [];
    let cur = null, prev = null;
    words.forEach((w, i) => {
      if (cutSet.has(i)) { prev = null; return; }
      const merge = prev && prev.i + 1 === i && w.start - (prev.end != null ? prev.end : prev.start) <= 0.85;
      if (cur && merge) cur.end = Math.max(cur.end, w.end != null ? w.end + 0.05 : w.start + 0.25);
      else { cur = { start: Math.max(0, w.start - 0.05), end: w.end != null ? w.end + 0.05 : w.start + 0.3 }; out.push(cur); }
      prev = { i, start: w.start, end: w.end };
    });
    return out.filter(s => s.end - s.start >= 0.3).map(s => { s.srcStart = s.start; s.srcEnd = s.end; return s; });
  }
})();
