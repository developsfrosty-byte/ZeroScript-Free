(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let state = {
    status: null,
    skills: [],
    logs: [],
    activity: { items: [], stats: { total: 0, ok: 0, errors: 0, avgMs: 0 } },
    expandedActs: new Set(),
    diagnostics: null,
    skillFilter: "All",
    provFilter: "All",
    actFilter: "all",
    actServerFilter: "all",
    editingId: null,
    motion: true,
    accent: "indigo",
    glass: "liquid",
  };
  const _sig = { pinned: "", providers: "", presets: "", starter: "", custom: "", servers: "", tools: "", activity: "", blender: "" };

  // ── Smooth rAF Ambient Motion & Liquid Glass Pointer Sheen ────────────
  function startAmbientCanvas() {
    const canvas = $("#bg-matrix");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let t = 0;
    let lastTs = 0;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    const draw = (ts) => {
      requestAnimationFrame(draw);
      if (document.hidden || !state.motion || reduced) {
        if (!state.motion) ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      if (ts - lastTs < 42) return;
      lastTs = ts;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      t += 0.024;
      const gap = 38;
      for (let x = 18; x < canvas.width; x += gap) {
        for (let y = 18; y < canvas.height; y += gap) {
          const wave = Math.sin((x + y) * 0.0075 + t) * 0.5 + 0.5;
          ctx.fillStyle = `rgba(255, 255, 255, ${(0.025 + wave * 0.055).toFixed(3)})`;
          ctx.fillRect(x, y, 1.5, 1.5);
        }
      }
    };
    requestAnimationFrame(draw);
  }

  function startPointerSheen() {
    let raf = 0;
    let lastEvent = null;
    document.addEventListener("pointermove", (e) => {
      lastEvent = e;
      if (raf || !state.motion) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const ev = lastEvent;
        if (!ev) return;
        const card = ev.target && ev.target.closest ? ev.target.closest(".hero-card, .provider-card, .guide-card, .skill-card, .server-card, .settings-card, .surface-card, .prompt-card, .quick-card") : null;
        if (!card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${Math.round(ev.clientX - r.left)}px`);
        card.style.setProperty("--my", `${Math.round(ev.clientY - r.top)}px`);
      });
    }, { passive: true });
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  async function api(path, body = null) {
    const opts = body !== null
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { method: "GET" };
    const r = await fetch(path, opts);
    return await r.json();
  }

  function toast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function copyText(text, okMsg = "Copied to clipboard.") {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      toast("Copy failed.");
    }
  }

  function greetingPrefix() {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }

  function formatUptime(sec) {
    const s = Math.max(0, Number(sec || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function applyTheme(settings) {
    const accent = (settings && settings.accentTheme) || "indigo";
    const glass = (settings && settings.glassStyle) || "liquid";
    state.accent = accent;
    state.glass = glass;
    state.motion = !settings || settings.ambientMotion !== false;
    document.documentElement.setAttribute("data-accent", accent);
    document.documentElement.setAttribute("data-glass", glass);
    document.documentElement.setAttribute("data-motion", state.motion ? "on" : "off");
    $$("[data-accent-pick]").forEach((b) =>
      b.classList.toggle("active", b.dataset.accentPick === accent)
    );
    $$("[data-glass-pick]").forEach((b) =>
      b.classList.toggle("active", b.dataset.glassPick === glass)
    );
  }

  function animateCount(el, nextVal) {
    if (!el) return;
    const target = Number(nextVal) || 0;
    const prev = Number(el.dataset.numVal);
    if (Number.isNaN(prev) || prev === target || !state.motion) {
      el.dataset.numVal = String(target);
      el.textContent = String(target);
      return;
    }
    el.dataset.numVal = String(target);
    const start = performance.now();
    const dur = 320;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(prev + (target - prev) * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── Navigation ────────────────────────────────────────────────────────
  const VIEW_META = {
    home: { eyebrow: "— HOME", sub: "Bridge online. Pick an AI, equip playbooks, build in Studio or Blender." },
    blender: { eyebrow: "— BLENDER 3D", sub: "1-click Blender add-on bridge, live scene telemetry, viewport preview & Roblox export." },
    activity: { eyebrow: "— ACTIVITY", sub: "Real-time inspector for every MCP tool call executed by your AIs." },
    environment: { eyebrow: "— SKILLS", sub: "10 AAA Roblox & Blender playbooks, 1-click preset packs, and custom .md skills." },
    prompts: { eyebrow: "— PROMPTS", sub: "Global instructions synced across all 12 AIs plus reusable developer templates." },
    connections: { eyebrow: "— CONNECTIONS", sub: "Health Doctor diagnostics, MCP processes, and live command browser." },
    settings: { eyebrow: "— SETTINGS", sub: "Personalize Liquid Glass surface, accent theme, motion, and tray behavior." },
  };

  function switchView(view) {
    $$("#side-nav .nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    const meta = VIEW_META[view] || VIEW_META.home;
    $("#page-eyebrow").textContent = meta.eyebrow;
    if (view === "home") {
      const name = (state.status && state.status.settings && state.status.settings.userName) || "Builder";
      $("#page-title").textContent = `${greetingPrefix()}, ${name}`;
    } else {
      const titles = { blender: "Blender 3D Hub", environment: "Skills & Playbooks", connections: "Connections & Doctor", prompts: "Prompt Studio", activity: "Live Activity", settings: "Settings" };
      $("#page-title").textContent = titles[view] || (view.charAt(0).toUpperCase() + view.slice(1));
    }
    $("#page-sub").textContent = meta.sub;
    if (view === "environment") loadSkills();
    if (view === "activity") loadActivity();
    if (view === "connections" && !state.diagnostics) runDiagnostics();
    if (view === "blender" && state.status) renderBlender(state.status.blender || {}, state.status.starterPrompts || []);
  }

  function switchSubtab(name) {
    $$(".subtab").forEach((b) => b.classList.toggle("active", b.dataset.subtab === name));
    $$(".subpanel").forEach((p) => p.classList.toggle("active", p.id === `sub-${name}`));
  }

  // ── Render Status & Views ─────────────────────────────────────────────
  function renderStatus(s) {
    state.status = s;
    if (!s || !s.ok) return;

    const br = s.bridge || {};
    const st = s.studio || {};
    const bl = s.blender || {};
    const servers = s.servers || [];
    const tools = s.tools || [];
    const settings = s.settings || {};
    const providers = s.providers || [];
    const stats = s.activityStats || {};

    applyTheme(settings);

    $("#brand-ver").textContent = `V${br.version || "1.8.0"}`;
    const name = settings.userName || "Builder";
    $("#profile-name").textContent = name;
    $("#profile-avatar").textContent = name.charAt(0).toUpperCase();
    $("#profile-role").textContent = `${providers.length} AI · LOCAL BRIDGE`;
    if ($("#view-home").classList.contains("active")) {
      $("#page-title").textContent = `${greetingPrefix()}, ${name}`;
    }

    // Settings & Global Prompt bindings (avoid overwriting while actively focused)
    if (document.activeElement !== $("#set-username")) $("#set-username").value = name;
    if (document.activeElement !== $("#global-prompt-input")) {
      $("#global-prompt-input").value = settings.globalPrompt || "";
    }
    $("#set-motion").checked = settings.ambientMotion !== false;
    $("#set-tray").checked = settings.minimizeToTray !== false;
    $("#set-autoopen").checked = settings.autoOpenWindow !== false;

    if (s.paths) {
      $("#path-ext").textContent = s.paths.extension;
      $("#path-skills").textContent = s.paths.skills;
      $("#path-logs").textContent = s.paths.logs;
    }

    // Header pill + pipeline diagram
    const pill = $("#header-pill");
    const pillTxt = $("#header-pill-txt");
    const diagBox = $("#diagram-status");
    const diagTxt = $("#diagram-status-txt");
    pill.classList.remove("warn", "off");
    diagBox.classList.remove("warn", "off");

    if (!br.online) {
      pill.classList.add("off");
      pillTxt.textContent = "BRIDGE OFFLINE";
      diagBox.classList.add("off");
      diagTxt.textContent = "Bridge offline · attempting startup";
    } else if (st.place === true) {
      pillTxt.textContent = "STUDIO READY";
      diagTxt.textContent = `Studio attached · ${tools.length} commands ready`;
    } else if (st.app === true) {
      pill.classList.add("warn");
      pillTxt.textContent = "NO PLACE OPEN";
      diagBox.classList.add("warn");
      diagTxt.textContent = "Studio open · open a place to attach";
    } else {
      pill.classList.add("warn");
      pillTxt.textContent = "BRIDGE ONLINE";
      diagTxt.textContent = `Bridge online · ${br.clients || 0} tab(s) connected`;
    }

    $("#diag-tabs").textContent = `${br.clients || 0} active tab(s)`;
    const studioToolsCount = tools.filter((t) => (t.server || "roblox") === "roblox").length;
    const blToolsCount = tools.filter((t) => t.server === "blender").length;
    $("#diag-tools-sub").textContent = `${studioToolsCount} commands`;
    const stDot = $("#diag-studio-dot");
    if (stDot) stDot.className = `dot-sm ${st.place === true ? "" : st.app === true ? "warn" : "off"}`;

    const blDot = $("#diag-blender-dot");
    const navBlDot = $("#nav-blender-dot");
    if (bl.connected) {
      if (blDot) blDot.className = "dot-sm";
      if (navBlDot) navBlDot.className = "nav-dot-mini on";
      $("#diag-blender-sub").textContent = `${bl.objects || 0} objs · ${blToolsCount || bl.serverTools || 11} cmds`;
    } else if (bl.addonInstalled && bl.serverConfigured) {
      if (blDot) blDot.className = "dot-sm warn";
      if (navBlDot) navBlDot.className = "nav-dot-mini warn";
      $("#diag-blender-sub").textContent = "Add-on ready (closed)";
    } else {
      if (blDot) blDot.className = "dot-sm off";
      if (navBlDot) navBlDot.className = "nav-dot-mini";
      $("#diag-blender-sub").textContent = bl.installations && bl.installations.length ? "Click to setup" : "Not detected";
    }

    $("#hero-uptime").textContent = `UPTIME ${formatUptime(br.uptime)}`;
    const enabledSkills = (s.skills || []).filter((sk) => sk.enabled).length;
    $("#hero-skills-pill").textContent = `${enabledSkills} SKILLS READY`;
    $("#prov-count-pill").textContent = String(providers.length);
    $("#nav-activity-badge").textContent = String(stats.total || 0);

    // Overview KPIs
    animateCount($("#kpi-commands"), tools.length);
    if (st.place === true) {
      $("#kpi-studio").textContent = "Connected";
      $("#kpi-studio-sub").textContent = bl.connected ? "Studio + Blender both live." : "Place active and ready.";
    } else if (bl.connected) {
      $("#kpi-studio").textContent = "Blender Live";
      $("#kpi-studio-sub").textContent = `Blender ${bl.version || ""} ready · Studio offline.`;
    } else if (st.app === true) {
      $("#kpi-studio").textContent = "No place";
      $("#kpi-studio-sub").textContent = "Open a place in Roblox Studio.";
    } else if (st.proc === true) {
      $("#kpi-studio").textContent = "MCP waiting";
      $("#kpi-studio-sub").textContent = "Open Assistant Settings > MCP Servers.";
    } else {
      $("#kpi-studio").textContent = "Waiting";
      $("#kpi-studio-sub").textContent = "Open Roblox Studio or Blender.";
    }

    animateCount($("#kpi-activity"), stats.total || 0);
    $("#kpi-activity-sub").textContent = stats.total ? `${stats.avgMs || 0}ms avg · ${stats.errors || 0} errors` : "No tool calls yet";

    animateCount($("#kpi-skills-kpi"), enabledSkills);
    $("#kpi-skills-sub").textContent = `${(s.skills || []).length} total playbooks installed`;
    $("#quick-skills-sub").textContent = `${enabledSkills} active playbooks & ${(s.presets || []).length} preset packs`;

    renderPinnedProviders(providers, settings.favoriteProviders || []);
    renderProviders(providers, settings.favoriteProviders || []);
    renderPresets(s.presets || []);
    renderPrompts(s.starterPrompts || [], settings.customPrompts || []);
    renderConnections(servers, tools);
    renderBlender(bl, s.starterPrompts || []);
  }

  function renderPinnedProviders(providers, favIds) {
    const row = $("#pinned-providers-row");
    if (!row) return;
    const favSet = new Set(favIds);
    let picks = providers.filter((p) => favSet.has(p.id));
    if (!picks.length) picks = providers.slice(0, 3);
    const sig = picks.map((p) => p.id).join(",");
    if (sig === _sig.pinned) return;
    _sig.pinned = sig;
    row.innerHTML = picks.map((p) => `
      <button class="pinned-chip" data-url="${esc(p.url)}">
        <span class="pinned-dot" style="background:${esc(p.color || "#818cf8")}"></span>
        ${esc(p.name)}
      </button>
    `).join("");
  }

  function renderProviders(providers, favIds) {
    const grid = $("#providers-grid");
    if (!grid) return;
    const favSet = new Set(favIds || []);
    const q = ($("#prov-search")?.value || "").trim().toLowerCase();
    const filtered = providers.filter((p) => {
      if (state.provFilter !== "All" && (p.category || "").toLowerCase() !== state.provFilter.toLowerCase()) return false;
      if (q && !`${p.name} ${p.desc} ${p.tag} ${p.category}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const sig = `${state.provFilter}|${q}|${filtered.map((p) => `${p.id}:${favSet.has(p.id) ? 1 : 0}`).join(",")}`;
    if (sig === _sig.providers) return;
    _sig.providers = sig;

    grid.innerHTML = filtered.map((p) => {
      const isFav = favSet.has(p.id);
      return `
        <div class="provider-card">
          <div>
            <div class="prov-head">
              <div class="prov-ident">
                <div class="prov-badge" style="background:${esc(p.color || "#818cf8")}">${esc(p.badge || p.name.slice(0, 2).toUpperCase())}</div>
                <div class="prov-name">${esc(p.name)}</div>
              </div>
              <button class="fav-btn ${isFav ? "active" : ""}" data-fav-prov="${esc(p.id)}" title="${isFav ? "Unpin from Home" : "Pin to Home"}">${isFav ? "★" : "☆"}</button>
            </div>
            <div class="prov-tags">
              <span class="tag ${p.vision ? "green" : ""}">${esc(p.vision ? "Vision" : "Text")}</span>
              <span class="tag accent">${esc(p.tag)}</span>
            </div>
            <p class="prov-desc">${esc(p.desc)}</p>
          </div>
          <div class="prov-foot">
            <button class="btn-primary sm" data-url="${esc(p.url)}">LAUNCH ${esc(p.name)} →</button>
          </div>
        </div>
      `;
    }).join("") || `<div class="sec-sub">No matching AI providers.</div>`;
  }

  // ── Activity View ─────────────────────────────────────────────────────
  async function loadActivity() {
    try {
      const res = await api("/api/activity");
      if (res && res.ok) {
        state.activity = { items: res.items || [], stats: res.stats || {} };
        renderActivity();
      }
    } catch {}
  }

  function renderActivity() {
    const st = state.activity.stats || {};
    const total = st.total || 0;
    const ok = st.ok || 0;
    const err = st.errors || 0;
    const rate = total ? Math.round((ok / total) * 100) : 100;

    $("#act-total").textContent = String(total);
    $("#act-ok").textContent = String(ok);
    $("#act-rate").textContent = `${rate}% success rate`;
    $("#act-err").textContent = String(err);
    $("#act-ms").textContent = `${st.avgMs || 0}ms`;
    $("#nav-activity-badge").textContent = String(total);

    const list = $("#activity-list");
    if (!list) return;
    const q = ($("#activity-search")?.value || "").trim().toLowerCase();
    const filtered = (state.activity.items || []).filter((it) => {
      if (state.actFilter === "ok" && !it.ok) return false;
      if (state.actFilter === "err" && it.ok) return false;
      if (state.actServerFilter !== "all" && (it.server || "roblox") !== state.actServerFilter) return false;
      if (q && !`${it.tool} ${it.server} ${it.args} ${it.preview}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const sig = `${state.actFilter}|${state.actServerFilter}|${q}|${filtered.map((it) => `${it.id}:${it.ok ? 1 : 0}:${state.expandedActs.has(it.id) ? 1 : 0}`).join(",")}`;
    if (sig === _sig.activity) return;
    _sig.activity = sig;

    list.innerHTML = filtered.map((it) => `
      <div class="act-card">
        <div class="act-head" data-toggle-act="${it.id}">
          <div class="act-left">
            <span class="act-dot ${it.ok ? "" : "err"}"></span>
            <span class="act-tool">${esc(it.tool)}</span>
            <span class="tag">${esc(it.server)}</span>
            ${it.images ? `<span class="tag accent">${it.images} img</span>` : ""}
          </div>
          <div class="act-right">
            <button class="btn-outline sm" data-copy-act="${it.id}" title="Copy command JSON">COPY</button>
            <span class="tag ${it.ok ? "green" : "red"}">${it.ok ? "OK" : "ERROR"}</span>
            <span class="tag">${it.ms}ms</span>
            <span class="act-ts">${esc(it.ts)}</span>
          </div>
        </div>
        <div class="act-detail" id="act-det-${it.id}" ${state.expandedActs.has(it.id) ? "" : "hidden"}>
          <div>
            <div class="act-box-label">Arguments</div>
            <pre class="act-pre">${esc(it.args || "{}")}</pre>
          </div>
          <div>
            <div class="act-box-label">Output Preview</div>
            <pre class="act-pre">${esc(it.preview || "(empty)")}</pre>
          </div>
        </div>
      </div>
    `).join("") || `<div class="surface-card"><div class="sec-sub">No tool calls recorded yet. Start an AI agent in any supported browser tab to inspect live Studio execution here.</div></div>`;
  }

  // ── Skills & Presets View ─────────────────────────────────────────────
  function renderPresets(presets) {
    const row = $("#presets-row");
    if (!row) return;
    const sig = (presets || []).map((p) => p.id).join(",");
    if (sig === _sig.presets) return;
    _sig.presets = sig;
    row.innerHTML = presets.map((p) => `
      <button class="preset-btn" data-preset="${esc(p.id)}">
        <div class="preset-name">${esc(p.name)}</div>
        <div class="preset-desc">${esc(p.desc)}</div>
      </button>
    `).join("");
  }

  async function loadSkills() {
    const res = await api("/api/skills");
    if (res && res.ok) {
      state.skills = res.skills || [];
      renderSkills();
    }
  }

  function renderSkills() {
    const grid = $("#skills-grid");
    if (!grid) return;
    const cat = state.skillFilter;
    const q = ($("#skill-search")?.value || "").trim().toLowerCase();
    const list = state.skills.filter((s) => {
      if (cat !== "All" && (s.category || "").toLowerCase() !== cat.toLowerCase()) return false;
      if (q && !`${s.name} ${s.tagline} ${s.category} ${s.id}`.toLowerCase().includes(q)) return false;
      return true;
    });

    grid.innerHTML = list.map((s) => `
      <div class="skill-card ${s.enabled ? "" : "disabled"}">
        <div class="skill-top">
          <span class="tag accent">${esc(s.category || "Custom")}</span>
          <span class="tag">${s.builtin ? "Built-in" : "Custom"} · ${Math.round((s.chars || 0) / 100) / 10}k chars</span>
        </div>
        <h3 class="skill-title">${esc(s.name)}</h3>
        <p class="skill-tagline">${esc(s.tagline || "Specialized agent playbook.")}</p>
        <div class="skill-controls">
          <div class="mode-switch" title="Auto lets the agent read on demand; Always embeds in every session start">
            <button class="mode-btn ${s.mode === "auto" ? "active" : ""}" data-skill-mode="auto" data-id="${esc(s.id)}">AUTO</button>
            <button class="mode-btn ${s.mode === "always" ? "active" : ""}" data-skill-mode="always" data-id="${esc(s.id)}">ALWAYS</button>
          </div>
          <div class="toolbar-actions">
            <button class="btn-outline sm" data-edit-skill="${esc(s.id)}">EDIT</button>
            <button class="btn-outline sm" data-export-skill="${esc(s.id)}" title="Download Markdown file">EXPORT</button>
            ${!s.builtin ? `<button class="btn-outline sm" data-del-skill="${esc(s.id)}">DEL</button>` : ""}
            <label class="switch" title="Enable / disable skill">
              <input type="checkbox" data-toggle-skill="${esc(s.id)}" ${s.enabled ? "checked" : ""} />
              <span class="switch-track"></span>
            </label>
          </div>
        </div>
      </div>
    `).join("") || `<div class="sec-sub">No matching skills found.</div>`;
  }

  function openSkillModal(skill = null) {
    state.editingId = skill ? skill.id : null;
    $("#skill-modal-eyebrow").textContent = skill ? "— EDIT SKILL PLAYBOOK" : "— CREATE CUSTOM SKILL";
    $("#skill-modal-title").textContent = skill ? skill.name : "New Agent Skill";
    $("#sk-name").value = skill ? skill.name : "";
    $("#sk-id").value = skill ? skill.id : "";
    $("#sk-id").disabled = !!(skill && skill.builtin);
    $("#sk-cat").value = skill ? (skill.category || "Custom") : "Custom";
    $("#sk-mode").value = skill ? (skill.mode || "auto") : "auto";
    $("#sk-tagline").value = skill ? (skill.tagline || "") : "";
    $("#sk-content").value = skill ? (skill.content || "") : "# Custom Skill Playbook\n\nDescribe the rules, standards, and workflows the AI agent should follow:\n";
    $("#skill-form-msg").textContent = "";
    $("#skill-modal").hidden = false;
  }

  function exportSkillMarkdown(sk) {
    const q = (v) => `"${String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const md = `---\nid: ${sk.id}\nname: ${q(sk.name)}\ncategory: ${q(sk.category)}\ntagline: ${q(sk.tagline || "")}\nenabled: ${sk.enabled ? "true" : "false"}\nmode: ${sk.mode || "auto"}\n---\n\n${sk.content || ""}\n`;
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${sk.id}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${sk.id}.md`);
  }

  // ── Prompts View ──────────────────────────────────────────────────────
  function renderPrompts(starter, custom) {
    const sGrid = $("#starter-prompts-grid");
    const sSig = JSON.stringify(starter || []);
    if (sGrid && sSig !== _sig.starter) {
      _sig.starter = sSig;
      sGrid.innerHTML = starter.map((p, idx) => `
        <div class="prompt-card">
          <div class="skill-top">
            <span class="tag accent">${esc(p.category || "Starter")}</span>
            <button class="btn-outline sm" data-copy-prompt="${idx}" data-source="starter">COPY</button>
          </div>
          <div class="prompt-title">${esc(p.title)}</div>
          <div class="prompt-body">${esc(p.text)}</div>
        </div>
      `).join("");
    }

    const cGrid = $("#custom-prompts-grid");
    const cSig = JSON.stringify(custom || []);
    if (cGrid && cSig !== _sig.custom) {
      _sig.custom = cSig;
      cGrid.innerHTML = (custom || []).map((p) => `
        <div class="prompt-card">
          <div class="skill-top">
            <span class="tag green">${esc(p.category || "Custom")}</span>
            <div class="toolbar-actions">
              <button class="btn-outline sm" data-copy-custom="${esc(p.id)}">COPY</button>
              <button class="btn-outline sm" data-del-custom="${esc(p.id)}">DEL</button>
            </div>
          </div>
          <div class="prompt-title">${esc(p.title)}</div>
          <div class="prompt-body">${esc(p.text)}</div>
        </div>
      `).join("") || `<div class="surface-card"><div class="sec-sub">No saved personal prompts yet. Click "+ Save Prompt" to build your reusable snippet library.</div></div>`;
    }
  }

  // ── Connections & Health Doctor ───────────────────────────────────────
  async function runDiagnostics() {
    const box = $("#diag-list");
    if (box) box.innerHTML = `<div class="sec-sub">Running diagnostics...</div>`;
    try {
      const res = await api("/api/diagnostics");
      if (res && res.ok) {
        state.diagnostics = res;
        renderDiagnostics(res);
      }
    } catch {
      if (box) box.innerHTML = `<div class="sec-sub">Diagnostics check failed.</div>`;
    }
  }

  function renderDiagnostics(res) {
    const box = $("#diag-list");
    if (!box || !res) return;
    const iconFor = { ok: "✓", warn: "!", fail: "✕" };
    box.innerHTML = (res.checks || []).map((c) => `
      <div class="diag-row">
        <div class="diag-ic ${esc(c.status)}">${iconFor[c.status] || "!"}</div>
        <div>
          <div class="diag-name">${esc(c.title)}</div>
          <div class="diag-detail">${esc(c.detail)}</div>
        </div>
      </div>
    `).join("");
  }

  function renderConnections(servers, tools) {
    const sList = $("#servers-list");
    const srvSig = JSON.stringify(servers || []);
    if (sList && srvSig !== _sig.servers) {
      _sig.servers = srvSig;
      sList.innerHTML = servers.map((sv) => `
        <div class="server-card">
          <div class="srv-top">
            <strong>${esc(sv.id)}</strong>
            <span class="tag ${sv.alive ? "green" : "amber"}">${sv.alive ? `Online · ${sv.tools} tools` : "Offline"}</span>
          </div>
          <div class="srv-cmd">${esc(sv.command)} ${esc((sv.args || []).join(" "))}</div>
          ${sv.startError ? `<div class="srv-err">${esc(sv.startError)}</div>` : ""}
          <div class="srv-actions">
            <button class="btn-outline sm" data-restart-srv="${esc(sv.id)}">RESTART</button>
            ${sv.id !== "roblox" ? `<button class="btn-outline sm" data-remove-srv="${esc(sv.id)}">REMOVE</button>` : ""}
          </div>
        </div>
      `).join("");
    }

    const q = ($("#tool-search")?.value || "").trim().toLowerCase();
    const filtered = q
      ? tools.filter((t) => `${t.name} ${t.description} ${t.server}`.toLowerCase().includes(q))
      : tools;
    $("#tools-count-sub").textContent = `${filtered.length} of ${tools.length} commands · click any command to copy JSON`;
    const tList = $("#tools-list");
    const toolSig = `${q}|${filtered.map((t) => `${t.server}/${t.name}`).join(",")}`;
    if (tList && toolSig !== _sig.tools) {
      _sig.tools = toolSig;
      tList.innerHTML = filtered.map((t) => `
        <div class="tool-row" data-copy-tool="${esc(t.name)}">
          <div class="tool-head">
            <span class="tool-name">${esc(t.name)}</span>
            <span class="tag">${esc(t.server)}</span>
          </div>
          ${t.description ? `<div class="tool-desc">${esc(t.description)}</div>` : ""}
        </div>
      `).join("") || `<div class="sec-sub">No matching commands loaded.</div>`;
    }
  }

  // ── Blender 3D Hub ────────────────────────────────────────────────────
  function renderBlender(bl, starterPrompts) {
    const sig = JSON.stringify({ bl, n: (starterPrompts || []).length });
    if (sig === _sig.blender) return;
    _sig.blender = sig;

    const pill = $("#bl-status-pill");
    const pillTxt = $("#bl-status-txt");
    if (pill && pillTxt) {
      pill.classList.remove("warn", "off");
      if (bl.connected) {
        pillTxt.textContent = "LIVE CONNECTED";
      } else if (bl.addonInstalled && bl.serverConfigured) {
        pill.classList.add("warn");
        pillTxt.textContent = bl.blenderRunning ? "RESTART BLENDER" : "READY · OPEN BLENDER";
      } else {
        pill.classList.add("off");
        pillTxt.textContent = "SETUP NEEDED";
      }
    }

    $("#bl-ver").textContent = bl.version || "—";
    $("#bl-scene").textContent = bl.scene || "—";
    $("#bl-objs").textContent = String(bl.objects || 0);
    $("#bl-active").textContent = bl.activeObject || "—";

    const toggleBtn = $("#btn-bl-toggle");
    if (toggleBtn) {
      toggleBtn.textContent = bl.serverConfigured ? "DISABLE MCP" : "ENABLE MCP";
      toggleBtn.dataset.enabled = bl.serverConfigured ? "1" : "0";
    }

    const listEl = $("#bl-installs-list");
    if (listEl) {
      const installs = bl.installations || [];
      listEl.innerHTML = installs.length
        ? installs.map((ins) => `
            <div class="bl-install-row">
              <div>
                <div class="bl-install-ver">Blender ${esc(ins.version)}</div>
                <div class="bl-install-path">${esc(ins.exe)}</div>
              </div>
              <span class="tag ${ins.addonInstalled ? "green" : "amber"}">${ins.addonInstalled ? "Add-on Installed" : "Not Installed"}</span>
            </div>
          `).join("")
        : `<div class="sec-sub">No Blender 3.6+ installation found automatically. Install Blender or copy <code>blender_addon/zeroscript_blender_addon.py</code> manually.</div>`;
    }

    const qBox = $("#bl-quick-prompts");
    if (qBox) {
      const blPrompts = (starterPrompts || []).filter((p) => (p.category || "").toLowerCase() === "blender");
      qBox.innerHTML = blPrompts.map((p) => `
        <div class="bl-install-row">
          <div style="min-width:0">
            <div class="bl-install-ver">${esc(p.title)}</div>
            <div class="bl-install-path">${esc(p.text.slice(0, 110))}...</div>
          </div>
          <button class="btn-outline sm" data-copy-bl-prompt="${esc(p.id)}">COPY</button>
        </div>
      `).join("");
    }
  }

  // ── Command Palette (Ctrl+K) ──────────────────────────────────────────
  let _paletteIndex = 0;
  function openPalette() {
    $("#cmd-palette").hidden = false;
    const inp = $("#palette-input");
    inp.value = "";
    _paletteIndex = 0;
    renderPalette("");
    requestAnimationFrame(() => inp.focus());
  }

  function buildPaletteEntries() {
    const out = [
      { title: "Go to Home Overview", sub: "Navigation", badge: "VIEW", run: () => { switchView("home"); switchSubtab("overview"); } },
      { title: "Go to Blender 3D Hub", sub: "1-click add-on setup, live scene & preview", badge: "BLENDER", run: () => switchView("blender") },
      { title: "Go to Live Activity Inspector", sub: "Inspect MCP tool calls", badge: "VIEW", run: () => switchView("activity") },
      { title: "Go to Skills & Presets", sub: "Manage 10+ AI playbooks", badge: "VIEW", run: () => switchView("environment") },
      { title: "Go to Prompt Studio", sub: "Global instructions & starter prompts", badge: "VIEW", run: () => switchView("prompts") },
      { title: "Go to Connections & Health Doctor", sub: "MCP servers, commands & diagnostics", badge: "VIEW", run: () => { switchView("connections"); runDiagnostics(); } },
      { title: "Go to Settings & Liquid Glass", sub: "Glass style, accent colors, tray & folders", badge: "VIEW", run: () => switchView("settings") },
      { title: "Install & Enable Blender Add-on (1-Click)", sub: "Auto-install into detected Blender versions", badge: "BLENDER", run: () => { switchView("blender"); $("#btn-bl-install").click(); } },
      { title: "Launch Blender Desktop App", sub: "Start Blender with ZeroScript bridge", badge: "BLENDER", run: () => $("#btn-bl-launch").click() },
      { title: "Capture Blender Viewport Preview", sub: "Live 3D viewport snapshot", badge: "BLENDER", run: () => { switchView("blender"); $("#btn-bl-preview").click(); } },
      { title: "Refresh Bridge, Studio & Blender Status", sub: "Action", badge: "ACTION", run: () => refreshNow() },
      { title: "Restart Roblox MCP Proxy", sub: "Action", badge: "ACTION", run: () => api("/api/restart_mcp", { server: "roblox" }).then((r) => { if (r.ok) renderStatus(r); toast("Roblox MCP restarted."); }) },
      { title: "Open Chrome Extension Folder", sub: "Load unpacked extension", badge: "FOLDER", run: () => api("/api/open_folder", { folder: "extension" }) },
      { title: "Open Bridge Logs Drawer", sub: "Telemetry", badge: "LOGS", run: () => { $("#logs-drawer").hidden = false; loadLogs(); } },
    ];
    for (const gs of ["liquid", "frosted", "crystal"]) {
      out.push({
        title: `Glass Style: ${gs.charAt(0).toUpperCase() + gs.slice(1)}`,
        sub: "Switch workspace glass surface style",
        badge: "GLASS",
        run: () => api("/api/settings", { glassStyle: gs }).then((r) => { if (r.ok && state.status) { state.status.settings = r.settings; applyTheme(r.settings); toast(`Glass style: ${gs}`); } }),
      });
    }
    for (const p of ((state.status && state.status.providers) || [])) {
      out.push({ title: `Launch ${p.name}`, sub: `${p.tag} · ${p.url}`, badge: "AI", run: () => api("/api/open_url", { url: p.url }) });
    }
    for (const pr of ((state.status && state.status.presets) || [])) {
      out.push({ title: `Apply Preset: ${pr.name}`, sub: pr.desc, badge: "PRESET", run: () => applyPresetById(pr.id) });
    }
    for (const sk of (state.skills || [])) {
      out.push({
        title: `${sk.enabled ? "Disable" : "Enable"} Skill: ${sk.name}`,
        sub: sk.category,
        badge: "SKILL",
        run: () => api("/api/skills/toggle", { id: sk.id, enabled: !sk.enabled }).then((r) => { if (r.ok) { state.skills = r.skills; renderSkills(); toast(`Updated ${sk.name}`); } }),
      });
    }
    return out;
  }

  let _paletteActions = [];
  function renderPalette(query) {
    const q = (query || "").trim().toLowerCase();
    const all = buildPaletteEntries();
    _paletteActions = q ? all.filter((x) => `${x.title} ${x.sub} ${x.badge}`.toLowerCase().includes(q)) : all.slice(0, 14);
    if (_paletteIndex >= _paletteActions.length) _paletteIndex = 0;
    $("#palette-results").innerHTML = _paletteActions.map((it, idx) => `
      <button class="pal-item ${idx === _paletteIndex ? "selected" : ""}" data-pal-idx="${idx}">
        <div>
          <div class="pal-item-title">${esc(it.title)}</div>
          <div class="pal-item-sub">${esc(it.sub)}</div>
        </div>
        <span class="tag accent">${esc(it.badge)}</span>
      </button>
    `).join("") || `<div class="sec-sub" style="padding:12px">No matching commands.</div>`;
  }

  // ── Logs Drawer ───────────────────────────────────────────────────────
  async function loadLogs() {
    const res = await api("/api/logs");
    if (!res || !res.ok) return;
    state.logs = res.logs || [];
    $("#logs-badge").textContent = String(state.logs.length);
    renderLogs();
  }

  function renderLogs() {
    const box = $("#logs-stream");
    if (!box || $("#logs-drawer").hidden) return;
    const q = ($("#logs-filter").value || "").trim().toLowerCase();
    const lines = q ? state.logs.filter((l) => l.msg.toLowerCase().includes(q)) : state.logs;
    box.innerHTML = lines.map((l) => `
      <div class="log-line">
        <span class="log-ts">${esc(l.ts)}</span>
        <span class="log-msg ${esc(l.color || "dim")}">${esc(l.msg)}</span>
      </div>
    `).join("");
    box.scrollTop = box.scrollHeight;
  }

  // ── Shared Actions ────────────────────────────────────────────────────
  async function refreshNow() {
    const btn = $("#btn-refresh-top");
    if (btn) btn.classList.add("is-spinning");
    toast("Refreshing Studio, Blender & MCP connections...");
    try {
      const res = await api("/api/refresh", {});
      renderStatus(res);
      toast("Connections refreshed.");
    } finally {
      if (btn) btn.classList.remove("is-spinning");
    }
  }

  async function applyPresetById(id) {
    const res = await api("/api/skills/preset", { preset: id });
    if (res && res.ok) {
      state.skills = res.skills || [];
      renderSkills();
      toast(`Applied preset: ${res.preset.name}`);
      tick();
    } else {
      toast((res && res.error) || "Preset failed");
    }
  }

  // ── Event Wiring ──────────────────────────────────────────────────────
  $$("#side-nav .nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  $$(".subtab").forEach((b) => b.addEventListener("click", () => switchSubtab(b.dataset.subtab)));

  $("#cta-browse-providers").addEventListener("click", () => { switchView("home"); switchSubtab("providers"); });
  $("#cta-open-blender").addEventListener("click", () => switchView("blender"));
  $("#cta-open-skills").addEventListener("click", () => switchView("environment"));
  $("#quick-skills").addEventListener("click", () => switchView("environment"));
  $("#quick-prompts").addEventListener("click", () => switchView("prompts"));
  $("#quick-activity").addEventListener("click", () => switchView("activity"));
  $("#quick-connections").addEventListener("click", () => { switchView("connections"); runDiagnostics(); });
  $("#guide-diag").addEventListener("click", () => { switchView("connections"); runDiagnostics(); });
  $("#guide-open-env").addEventListener("click", () => switchView("environment"));
  $("#guide-browse-ai").addEventListener("click", () => { switchView("home"); switchSubtab("providers"); });

  $("#btn-refresh-top").addEventListener("click", refreshNow);
  $("#btn-refresh-overview").addEventListener("click", refreshNow);
  $("#btn-overview-diag").addEventListener("click", () => { switchView("connections"); runDiagnostics(); });
  $("#btn-overview-ext").addEventListener("click", () => api("/api/open_folder", { folder: "extension" }));
  $("#btn-run-diag").addEventListener("click", runDiagnostics);
  $("#btn-copy-diag").addEventListener("click", () => {
    if (!state.diagnostics) { toast("Run Health Check first."); return; }
    const txt = (state.diagnostics.checks || [])
      .map((c) => `[${c.status.toUpperCase()}] ${c.title}: ${c.detail}`).join("\n");
    copyText(txt, "Diagnostic report copied.");
  });

  $("#btn-restart-top").addEventListener("click", async () => {
    toast("Restarting Roblox MCP proxy...");
    const res = await api("/api/restart_mcp", { server: "roblox" });
    if (res.ok) renderStatus(res);
    toast(res.ok ? "Roblox MCP restarted." : (res.error || "Restart failed"));
  });

  $("#btn-restart-all").addEventListener("click", async () => {
    toast("Restarting all MCP servers...");
    const res = await api("/api/restart_mcp", {});
    if (res.ok) renderStatus(res);
    toast(res.ok ? "All servers restarted." : (res.error || "Restart failed"));
  });

  $("#btn-clear-activity").addEventListener("click", async () => {
    const res = await api("/api/activity/clear", {});
    if (res && res.ok) {
      state.activity = { items: res.items || [], stats: res.stats || {} };
      renderActivity();
      toast("Activity timeline cleared.");
    }
  });

  $("#btn-open-palette").addEventListener("click", openPalette);
  $("#palette-input").addEventListener("input", (e) => { _paletteIndex = 0; renderPalette(e.target.value); });
  $("#palette-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && _paletteActions.length) {
      e.preventDefault();
      _paletteIndex = (_paletteIndex + 1) % _paletteActions.length;
      renderPalette(e.target.value);
    } else if (e.key === "ArrowUp" && _paletteActions.length) {
      e.preventDefault();
      _paletteIndex = (_paletteIndex - 1 + _paletteActions.length) % _paletteActions.length;
      renderPalette(e.target.value);
    } else if (e.key === "Enter" && _paletteActions.length) {
      e.preventDefault();
      $("#cmd-palette").hidden = true;
      (_paletteActions[_paletteIndex] || _paletteActions[0]).run();
    }
  });
  for (const bId of ["#cmd-palette", "#skill-modal", "#prompt-modal", "#logs-drawer"]) {
    $(bId).addEventListener("click", (e) => {
      if (e.target === e.currentTarget) e.currentTarget.hidden = true;
    });
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if ($("#cmd-palette").hidden) openPalette();
      else $("#cmd-palette").hidden = true;
    } else if (e.key === "Escape") {
      $("#cmd-palette").hidden = true;
      $("#skill-modal").hidden = true;
      $("#prompt-modal").hidden = true;
      $("#logs-drawer").hidden = true;
    }
  });

  document.addEventListener("click", async (e) => {
    const pal = e.target.closest("[data-pal-idx]");
    if (pal) {
      const idx = Number(pal.dataset.palIdx);
      $("#cmd-palette").hidden = true;
      if (_paletteActions[idx]) _paletteActions[idx].run();
      return;
    }
    const urlBtn = e.target.closest("[data-url]");
    if (urlBtn) { await api("/api/open_url", { url: urlBtn.dataset.url }); return; }
    const folderBtn = e.target.closest("[data-folder]");
    if (folderBtn) { await api("/api/open_folder", { folder: folderBtn.dataset.folder }); return; }

    const favBtn = e.target.closest("[data-fav-prov]");
    if (favBtn) {
      const id = favBtn.dataset.favProv;
      const cur = new Set(((state.status && state.status.settings && state.status.settings.favoriteProviders) || []));
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      const res = await api("/api/settings", { favoriteProviders: [...cur] });
      if (res && res.ok && state.status) {
        state.status.settings = res.settings;
        renderPinnedProviders(state.status.providers || [], res.settings.favoriteProviders || []);
        renderProviders(state.status.providers || [], res.settings.favoriteProviders || []);
      }
      return;
    }

    const presetBtn = e.target.closest("[data-preset]");
    if (presetBtn) { await applyPresetById(presetBtn.dataset.preset); return; }

    const copyAct = e.target.closest("[data-copy-act]");
    if (copyAct) {
      e.stopPropagation();
      const aid = Number(copyAct.dataset.copyAct);
      const item = (state.activity.items || []).find((x) => x.id === aid);
      if (item) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(item.args || "{}"); } catch {}
        copyText(JSON.stringify({ command: item.tool, params: parsedArgs }, null, 2), `Copied ${item.tool} call`);
      }
      return;
    }

    const copyBlPrompt = e.target.closest("[data-copy-bl-prompt]");
    if (copyBlPrompt) {
      const pid = copyBlPrompt.dataset.copyBlPrompt;
      const item = ((state.status && state.status.starterPrompts) || []).find((x) => x.id === pid);
      if (item) copyText(item.text, "Blender prompt copied — paste into any AI chat!");
      return;
    }

    const toggleAct = e.target.closest("[data-toggle-act]");
    if (toggleAct) {
      const aid = Number(toggleAct.dataset.toggleAct);
      if (state.expandedActs.has(aid)) state.expandedActs.delete(aid);
      else state.expandedActs.add(aid);
      const det = $(`#act-det-${aid}`);
      if (det) det.hidden = !state.expandedActs.has(aid);
      _sig.activity = "";
      return;
    }

    const restartSrv = e.target.closest("[data-restart-srv]");
    if (restartSrv) {
      const id = restartSrv.dataset.restartSrv;
      toast(`Restarting ${id}...`);
      const res = await api("/api/restart_mcp", { server: id });
      if (res.ok) renderStatus(res);
      toast(res.ok ? `${id} restarted.` : (res.error || "Restart failed"));
      return;
    }
    const removeSrv = e.target.closest("[data-remove-srv]");
    if (removeSrv) {
      const res = await api("/api/servers/remove", { server_id: removeSrv.dataset.removeSrv });
      if (res.ok) renderStatus(res);
      toast(res.ok ? "Server removed." : (res.error || "Remove failed"));
      return;
    }

    const modeBtn = e.target.closest("[data-skill-mode]");
    if (modeBtn) {
      const res = await api("/api/skills/toggle", { id: modeBtn.dataset.id, mode: modeBtn.dataset.skillMode });
      if (res.ok) { state.skills = res.skills; renderSkills(); toast("Skill mode updated."); }
      return;
    }
    const editSkill = e.target.closest("[data-edit-skill]");
    if (editSkill) {
      const sk = state.skills.find((x) => x.id === editSkill.dataset.editSkill);
      if (sk) openSkillModal(sk);
      return;
    }
    const expSkill = e.target.closest("[data-export-skill]");
    if (expSkill) {
      const sk = state.skills.find((x) => x.id === expSkill.dataset.exportSkill);
      if (sk) exportSkillMarkdown(sk);
      return;
    }
    const delSkill = e.target.closest("[data-del-skill]");
    if (delSkill) {
      const res = await api("/api/skills/delete", { id: delSkill.dataset.delSkill });
      if (res.ok) { state.skills = res.skills; renderSkills(); toast("Skill deleted."); }
      else toast(res.error || "Could not delete skill");
      return;
    }

    const copyStarter = e.target.closest("[data-copy-prompt]");
    if (copyStarter) {
      const idx = Number(copyStarter.dataset.copyPrompt);
      const list = (state.status && state.status.starterPrompts) || [];
      if (list[idx]) copyText(list[idx].text, "Prompt copied — paste into any AI chat!");
      return;
    }
    const copyCustom = e.target.closest("[data-copy-custom]");
    if (copyCustom) {
      const list = (state.status && state.status.settings && state.status.settings.customPrompts) || [];
      const item = list.find((x) => x.id === copyCustom.dataset.copyCustom);
      if (item) copyText(item.text, "Prompt copied!");
      return;
    }
    const delCustom = e.target.closest("[data-del-custom]");
    if (delCustom) {
      const res = await api("/api/prompts/delete", { id: delCustom.dataset.delCustom });
      if (res && res.ok && state.status) {
        state.status.settings = res.settings;
        renderPrompts(state.status.starterPrompts || [], res.customPrompts || []);
        toast("Prompt deleted.");
      }
      return;
    }

    const copyTool = e.target.closest("[data-copy-tool]");
    if (copyTool) {
      const name = copyTool.dataset.copyTool;
      copyText(`{"command": "${name}", "params": {}}`, `Copied ${name} snippet`);
      return;
    }

    const sw = e.target.closest("[data-accent-pick]");
    if (sw) {
      const accent = sw.dataset.accentPick;
      const res = await api("/api/settings", { accentTheme: accent });
      if (res && res.ok && state.status) state.status.settings = res.settings;
      applyTheme({ accentTheme: accent, glassStyle: state.glass, ambientMotion: state.motion });
      toast(`Accent theme: ${accent}`);
      return;
    }

    const gs = e.target.closest("[data-glass-pick]");
    if (gs) {
      const glassStyle = gs.dataset.glassPick;
      const res = await api("/api/settings", { glassStyle });
      if (res && res.ok && state.status) state.status.settings = res.settings;
      applyTheme({ accentTheme: state.accent, glassStyle, ambientMotion: state.motion });
      toast(`Glass style: ${glassStyle}`);
    }
  });

  document.addEventListener("change", async (e) => {
    const toggle = e.target.closest("[data-toggle-skill]");
    if (toggle) {
      const res = await api("/api/skills/toggle", { id: toggle.dataset.toggleSkill, enabled: toggle.checked });
      if (res.ok) { state.skills = res.skills; renderSkills(); tick(); }
    }
  });

  // Filters & searches
  $$("#prov-filters .filter-pill").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#prov-filters .filter-pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.provFilter = b.dataset.pcat;
      if (state.status) renderProviders(state.status.providers || [], (state.status.settings && state.status.settings.favoriteProviders) || []);
    });
  });
  $("#prov-search").addEventListener("input", () => {
    if (state.status) renderProviders(state.status.providers || [], (state.status.settings && state.status.settings.favoriteProviders) || []);
  });

  $$("#activity-filters .filter-pill").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#activity-filters .filter-pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.actFilter = b.dataset.af;
      renderActivity();
    });
  });
  $$("#activity-server-filters .filter-pill").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#activity-server-filters .filter-pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.actServerFilter = b.dataset.asrv;
      renderActivity();
    });
  });
  $("#btn-export-activity").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.activity, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zeroscript-activity-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Activity exported as JSON.");
  });
  $("#activity-search").addEventListener("input", renderActivity);

  // Blender Hub actions
  $("#btn-bl-install").addEventListener("click", async () => {
    const msg = $("#bl-action-msg");
    msg.classList.remove("err");
    msg.textContent = "Installing & enabling ZeroScript add-on in Blender...";
    const res = await api("/api/blender/install_addon", {});
    if (res && res.ok) {
      _sig.blender = "";
      renderStatus(res);
      const vers = (res.installed || []).map((x) => x.version).join(", ");
      const running = res.blenderRunning || (res.blender && res.blender.blenderRunning);
      msg.textContent = running
        ? `Installed & enabled in Blender ${vers || ""}. Restart your open Blender window to activate the updated add-on!`
        : `Installed & enabled in Blender ${vers || ""}. Open Blender to connect live!`;
      toast("Blender add-on installed & enabled!");
    } else {
      msg.classList.add("err");
      msg.textContent = (res && res.error) || "Add-on install failed.";
    }
  });
  $("#btn-bl-launch").addEventListener("click", async () => {
    const res = await api("/api/blender/launch", {});
    if (res && res.ok) {
      toast("Launching Blender...");
      setTimeout(tick, 3000);
    } else {
      toast((res && res.error) || "Could not launch Blender.");
    }
  });
  $("#btn-bl-toggle").addEventListener("click", async () => {
    const enabled = $("#btn-bl-toggle").dataset.enabled !== "1";
    const res = await api("/api/blender/toggle", { enabled });
    if (res && res.ok) {
      _sig.blender = "";
      renderStatus(res);
      toast(enabled ? "Blender MCP enabled." : "Blender MCP disabled.");
    } else {
      toast((res && res.error) || "Failed to toggle Blender MCP.");
    }
  });
  $("#btn-bl-test").addEventListener("click", async () => {
    const msg = $("#bl-action-msg");
    const port = (state.status && state.status.blender && state.status.blender.port) || 17615;
    msg.classList.remove("err");
    msg.textContent = `Probing Blender on 127.0.0.1:${port}...`;
    const res = await api("/api/blender/status");
    if (res && res.ok && res.blender) {
      if (state.status) state.status.blender = res.blender;
      _sig.blender = "";
      renderBlender(res.blender, (state.status && state.status.starterPrompts) || []);
      if (res.blender.connected) {
        msg.textContent = `Connected to Blender ${res.blender.version} (${res.blender.scene}, ${res.blender.objects} objects).`;
        toast("Blender bridge connected!");
      } else {
        msg.classList.add("err");
        msg.textContent = res.blender.blenderRunning
          ? `Blender is open, but the ZeroScript add-on isn't active on port ${res.blender.port || port} yet — restart Blender (or press N in View3D → ZeroScript → Start Bridge).`
          : `Blender is not responding on port ${res.blender.port || port} yet — open Blender first.`;
      }
    }
  });
  $("#btn-bl-preview").addEventListener("click", async () => {
    const msg = $("#bl-action-msg");
    msg.classList.remove("err");
    msg.textContent = "Capturing Blender viewport...";
    const res = await api("/api/blender/preview", { shading: $("#bl-shading").value, max_size: 800 });
    if (res && res.ok && res.image_b64) {
      const img = $("#bl-preview-img");
      img.src = `data:${res.mime_type || "image/png"};base64,${res.image_b64}`;
      img.hidden = false;
      $("#bl-preview-empty").hidden = true;
      msg.textContent = `Captured ${res.mode || "viewport"} (${res.width}x${res.height}).`;
    } else {
      msg.classList.add("err");
      msg.textContent = (res && res.error) || "Could not capture viewport.";
    }
  });

  $$("#skill-filters .filter-pill").forEach((b) => {
    b.addEventListener("click", () => {
      $$("#skill-filters .filter-pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.skillFilter = b.dataset.cat;
      renderSkills();
    });
  });
  $("#skill-search").addEventListener("input", renderSkills);

  // Import Markdown Skill
  $("#btn-import-skill").addEventListener("click", () => $("#skill-import-file").click());
  $("#skill-import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const raw = await file.text();
    const baseName = file.name.replace(/\.(md|markdown|txt)$/i, "");
    let name = baseName, category = "Custom", tagline = "", mode = "auto", content = raw.trim();
    if (raw.startsWith("---\n")) {
      const end = raw.indexOf("\n---\n", 4);
      if (end !== -1) {
        const fm = raw.slice(4, end);
        content = raw.slice(end + 5).trim();
        for (const line of fm.split("\n")) {
          const i = line.indexOf(":");
          if (i === -1) continue;
          const k = line.slice(0, i).trim().toLowerCase();
          const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
          if (k === "name" && v) name = v;
          if (k === "category" && v) category = v;
          if (k === "tagline" && v) tagline = v;
          if (k === "mode" && (v === "auto" || v === "always")) mode = v;
        }
      }
    }
    const res = await api("/api/skills/save", { name, category, tagline, mode, content });
    e.target.value = "";
    if (res && res.ok) {
      state.skills = res.skills || [];
      renderSkills();
      toast(`Imported skill: ${res.skill.name}`);
    } else {
      toast((res && res.error) || "Import failed");
    }
  });

  // Modals
  $("#btn-new-skill").addEventListener("click", () => openSkillModal(null));
  $("#skill-modal-close").addEventListener("click", () => { $("#skill-modal").hidden = true; });
  $("#skill-modal-cancel").addEventListener("click", () => { $("#skill-modal").hidden = true; });
  $("#skill-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("/api/skills/save", {
      id: $("#sk-id").value.trim() || state.editingId,
      name: $("#sk-name").value.trim(),
      category: $("#sk-cat").value,
      mode: $("#sk-mode").value,
      tagline: $("#sk-tagline").value.trim(),
      content: $("#sk-content").value,
    });
    if (res.ok) {
      state.skills = res.skills;
      renderSkills();
      $("#skill-modal").hidden = true;
      toast("Skill saved and synced to extensions.");
    } else {
      $("#skill-form-msg").textContent = res.error || "Failed to save";
      $("#skill-form-msg").classList.add("err");
    }
  });

  $("#btn-new-prompt").addEventListener("click", () => {
    $("#pr-title").value = "";
    $("#pr-cat").value = "Custom";
    $("#pr-text").value = "";
    $("#prompt-form-msg").textContent = "";
    $("#prompt-modal").hidden = false;
  });
  $("#prompt-modal-close").addEventListener("click", () => { $("#prompt-modal").hidden = true; });
  $("#prompt-modal-cancel").addEventListener("click", () => { $("#prompt-modal").hidden = true; });
  $("#prompt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("/api/prompts/save", {
      title: $("#pr-title").value.trim(),
      category: $("#pr-cat").value.trim() || "Custom",
      text: $("#pr-text").value,
    });
    if (res && res.ok) {
      if (state.status) state.status.settings = res.settings;
      renderPrompts((state.status && state.status.starterPrompts) || [], res.customPrompts || []);
      $("#prompt-modal").hidden = true;
      toast("Prompt saved to library.");
    } else {
      $("#prompt-form-msg").textContent = (res && res.error) || "Failed to save";
    }
  });

  // Global Prompt Form
  $("#global-prompt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("/api/settings", { globalPrompt: $("#global-prompt-input").value });
    if (res && res.ok) {
      if (state.status) state.status.settings = res.settings;
      $("#global-prompt-msg").textContent = "Synced to all 12 AIs.";
      toast("Global instructions synced.");
      setTimeout(() => { $("#global-prompt-msg").textContent = ""; }, 2600);
    }
  });
  $("#btn-clear-global-prompt").addEventListener("click", async () => {
    $("#global-prompt-input").value = "";
    const res = await api("/api/settings", { globalPrompt: "" });
    if (res && res.ok && state.status) state.status.settings = res.settings;
    toast("Global instructions cleared.");
  });

  // Add MCP Server Form
  $("#add-server-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#add-server-msg");
    msg.classList.remove("err");
    msg.textContent = "Connecting...";
    let env = null;
    const rawEnv = $("#srv-env").value.trim();
    if (rawEnv) {
      try { env = JSON.parse(rawEnv); } catch {
        msg.textContent = "Invalid Env JSON";
        msg.classList.add("err");
        return;
      }
    }
    const res = await api("/api/servers/add", {
      server_id: $("#srv-id").value.trim(),
      command: $("#srv-cmd").value.trim(),
      args: $("#srv-args").value.trim(),
      env,
    });
    if (res.ok) {
      renderStatus(res);
      $("#add-server-form").reset();
      msg.textContent = "Server connected.";
    } else {
      msg.textContent = res.error || "Failed to add server";
      msg.classList.add("err");
    }
  });

  $("#tool-search").addEventListener("input", () => {
    if (state.status) renderConnections(state.status.servers || [], state.status.tools || []);
  });

  // Settings Form
  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("/api/settings", {
      userName: $("#set-username").value.trim(),
      ambientMotion: $("#set-motion").checked,
      minimizeToTray: $("#set-tray").checked,
      autoOpenWindow: $("#set-autoopen").checked,
      accentTheme: state.accent,
    });
    if (res.ok) {
      if (state.status) state.status.settings = res.settings;
      renderStatus(state.status);
      $("#settings-msg").textContent = "Saved.";
      toast("Preferences saved.");
      setTimeout(() => { $("#settings-msg").textContent = ""; }, 2400);
    }
  });

  $("#btn-open-logs").addEventListener("click", () => { $("#logs-drawer").hidden = false; loadLogs(); });
  $("#btn-close-logs").addEventListener("click", () => { $("#logs-drawer").hidden = true; });
  $("#logs-filter").addEventListener("input", renderLogs);
  $("#btn-copy-logs").addEventListener("click", () => {
    const text = state.logs.map((l) => `${l.ts} ${l.msg}`).join("\n");
    copyText(text, "Logs copied.");
  });

  async function quitApp() {
    await api("/api/quit", {});
    toast("ZeroScript stopped.");
    setTimeout(() => window.close(), 300);
  }
  $("#btn-quit-side").addEventListener("click", quitApp);
  $("#btn-quit-settings").addEventListener("click", quitApp);

  // ── Boot & Polling ────────────────────────────────────────────────────
  async function tick() {
    try {
      const s = await api("/api/status");
      renderStatus(s);
      await loadLogs();
      if ($("#view-activity").classList.contains("active")) await loadActivity();
    } catch {}
  }

  startAmbientCanvas();
  startPointerSheen();
  tick();
  loadSkills();
  setInterval(tick, 2500);
})();
