(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  let state = {
    status: null,
    skills: [],
    logs: [],
    skillFilter: "All",
    editingId: null,
  };

  // ── Subtle Matrix Backdrop (ASTROX style) ─────────────────────────────
  function startMatrixCanvas() {
    const canvas = $("#bg-matrix");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const chars = "01ZEROSCRIPTLUAU{}[]<>+-=";
    let cols = [];
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const count = Math.ceil(canvas.width / 22);
      cols = Array.from({ length: count }, () => Math.floor(Math.random() * 40));
    };
    resize();
    window.addEventListener("resize", resize);
    setInterval(() => {
      ctx.fillStyle = "rgba(9, 9, 11, 0.14)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(255, 255, 255, 0.075)";
      ctx.font = "11px monospace";
      for (let i = 0; i < cols.length; i++) {
        const ch = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(ch, i * 22, cols[i] * 16);
        if (cols[i] * 16 > canvas.height && Math.random() > 0.975) cols[i] = 0;
        cols[i]++;
      }
    }, 95);
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

  function greetingPrefix() {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }

  // ── Navigation ────────────────────────────────────────────────────────
  const VIEW_META = {
    home: { eyebrow: "— HOME", sub: "Bridge online. Pick a chat, equip skills, build." },
    environment: { eyebrow: "— ENVIRONMENT", sub: "Manage AAA Roblox Studio playbooks and custom agent skills." },
    connections: { eyebrow: "— CONNECTIONS", sub: "Inspect MCP processes, add integrations, and browse commands." },
    settings: { eyebrow: "— SETTINGS", sub: "Customize your ZeroScript desktop workspace." },
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
      $("#page-title").textContent = view.charAt(0).toUpperCase() + view.slice(1);
    }
    $("#page-sub").textContent = meta.sub;
    if (view === "environment") loadSkills();
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
    const servers = s.servers || [];
    const tools = s.tools || [];
    const settings = s.settings || {};

    $("#brand-ver").textContent = `V${br.version || "1.6.0"}`;
    const name = settings.userName || "Builder";
    $("#profile-name").textContent = name;
    $("#profile-avatar").textContent = name.charAt(0).toUpperCase();
    if ($("#view-home").classList.contains("active")) {
      $("#page-title").textContent = `${greetingPrefix()}, ${name}`;
    }

    // Populate Settings inputs only if not actively editing
    if (document.activeElement !== $("#set-username")) $("#set-username").value = name;
    $("#set-tray").checked = settings.minimizeToTray !== false;
    $("#set-autoopen").checked = settings.autoOpenWindow !== false;
    if (s.paths) {
      $("#path-ext").textContent = s.paths.extension;
      $("#path-skills").textContent = s.paths.skills;
      $("#path-logs").textContent = s.paths.logs;
    }

    // Header pill + diagram status
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
      diagTxt.textContent = `Bridge online · ${tools.length} commands ready`;
    } else if (st.app === true) {
      pill.classList.add("warn");
      pillTxt.textContent = "NO PLACE OPEN";
      diagBox.classList.add("warn");
      diagTxt.textContent = "Studio open · open a place to attach";
    } else {
      pill.classList.add("warn");
      pillTxt.textContent = "BRIDGE ONLINE";
      diagTxt.textContent = `Local bridge online · ${br.clients || 0} tab(s) connected`;
    }

    // KPIs
    $("#kpi-commands").textContent = String(tools.length);
    if (st.place === true) {
      $("#kpi-studio").textContent = "Connected";
      $("#kpi-studio-sub").textContent = "Place active and ready for agents.";
    } else if (st.app === true) {
      $("#kpi-studio").textContent = "No place";
      $("#kpi-studio-sub").textContent = "Open a place in Roblox Studio.";
    } else if (st.proc === true) {
      $("#kpi-studio").textContent = "MCP waiting";
      $("#kpi-studio-sub").textContent = "Open Assistant Settings > MCP Servers in Studio.";
    } else {
      $("#kpi-studio").textContent = "Not running";
      $("#kpi-studio-sub").textContent = "Open Roblox Studio and a place; ZeroScript attaches by itself.";
    }

    const aliveCount = servers.filter((x) => x.alive).length;
    $("#kpi-servers").textContent = String(servers.length);
    $("#kpi-servers-sub").textContent = `${aliveCount} of ${servers.length} connected`;

    $("#kpi-bridge").textContent = br.online ? "Online" : "Offline";
    $("#kpi-bridge-sub").textContent = `${br.host || "127.0.0.1"}:${br.port || 17613}`;

    const enabledSkills = (s.skills || []).filter((sk) => sk.enabled).length;
    $("#quick-skills-sub").textContent = `${enabledSkills} active playbooks (UI, Building, Cutscenes)`;

    renderProviders(s.providers || []);
    renderConnections(servers, tools);
  }

  function renderProviders(providers) {
    const grid = $("#providers-grid");
    if (!grid) return;
    grid.innerHTML = providers.map((p) => `
      <div class="provider-card">
        <div>
          <div class="prov-top">
            <div class="prov-name">${esc(p.name)}</div>
            <span class="tag ${p.vision ? "green" : ""}">${esc(p.vision ? "Vision" : "Text")} · ${esc(p.tag)}</span>
          </div>
          <p class="prov-desc">${esc(p.desc)}</p>
        </div>
        <div>
          <button class="btn-primary sm" data-url="${esc(p.url)}">LAUNCH ${esc(p.name)} →</button>
        </div>
      </div>
    `).join("");
  }

  function renderConnections(servers, tools) {
    const sList = $("#servers-list");
    if (sList) {
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
      ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.server.toLowerCase().includes(q))
      : tools;
    $("#tools-count-sub").textContent = `${filtered.length} of ${tools.length} commands`;
    const tList = $("#tools-list");
    if (tList) {
      tList.innerHTML = filtered.map((t) => `
        <div class="tool-row">
          <div class="tool-head">
            <span class="tool-name">${esc(t.name)}</span>
            <span class="tag">${esc(t.server)}</span>
          </div>
          ${t.description ? `<div class="tool-desc">${esc(t.description)}</div>` : ""}
        </div>
      `).join("") || `<div class="sec-sub">No matching commands loaded.</div>`;
    }
  }

  // ── Skills UI ─────────────────────────────────────────────────────────
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
    const list = cat === "All"
      ? state.skills
      : state.skills.filter((s) => (s.category || "").toLowerCase() === cat.toLowerCase());

    grid.innerHTML = list.map((s) => `
      <div class="skill-card ${s.enabled ? "" : "disabled"}">
        <div class="skill-top">
          <span class="tag green">${esc(s.category || "Custom")}</span>
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
            ${!s.builtin ? `<button class="btn-outline sm" data-del-skill="${esc(s.id)}">DEL</button>` : ""}
            <label class="switch" title="Enable / disable skill">
              <input type="checkbox" data-toggle-skill="${esc(s.id)}" ${s.enabled ? "checked" : ""} />
              <span class="switch-track"></span>
            </label>
          </div>
        </div>
      </div>
    `).join("") || `<div class="sec-sub">No skills in this category yet.</div>`;
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

  // ── Event Wiring ──────────────────────────────────────────────────────
  $$("#side-nav .nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  $$(".subtab").forEach((b) => b.addEventListener("click", () => switchSubtab(b.dataset.subtab)));

  $("#cta-browse-providers").addEventListener("click", () => { switchView("home"); switchSubtab("providers"); });
  $("#cta-open-skills").addEventListener("click", () => switchView("environment"));
  $("#quick-skills").addEventListener("click", () => switchView("environment"));
  $("#quick-providers").addEventListener("click", () => { switchView("home"); switchSubtab("providers"); });
  $("#quick-connections").addEventListener("click", () => switchView("connections"));
  $("#guide-open-env").addEventListener("click", () => switchView("environment"));
  $("#guide-browse-ai").addEventListener("click", () => { switchView("home"); switchSubtab("providers"); });

  async function refreshNow() {
    toast("Refreshing Studio & MCP connections...");
    const res = await api("/api/refresh", {});
    renderStatus(res);
    toast("Connections refreshed.");
  }
  $("#btn-refresh-top").addEventListener("click", refreshNow);
  $("#btn-refresh-overview").addEventListener("click", refreshNow);
  $("#guide-refresh").addEventListener("click", refreshNow);

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

  document.addEventListener("click", async (e) => {
    const urlBtn = e.target.closest("[data-url]");
    if (urlBtn) {
      await api("/api/open_url", { url: urlBtn.dataset.url });
      return;
    }
    const folderBtn = e.target.closest("[data-folder]");
    if (folderBtn) {
      await api("/api/open_folder", { folder: folderBtn.dataset.folder });
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
      const id = removeSrv.dataset.removeSrv;
      const res = await api("/api/servers/remove", { server_id: id });
      if (res.ok) renderStatus(res);
      toast(res.ok ? `Removed ${id}.` : (res.error || "Remove failed"));
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
    const delSkill = e.target.closest("[data-del-skill]");
    if (delSkill) {
      const id = delSkill.dataset.delSkill;
      const res = await api("/api/skills/delete", { id });
      if (res.ok) { state.skills = res.skills; renderSkills(); toast("Skill deleted."); }
      else toast(res.error || "Could not delete skill");
    }
  });

  document.addEventListener("change", async (e) => {
    const toggle = e.target.closest("[data-toggle-skill]");
    if (toggle) {
      const res = await api("/api/skills/toggle", { id: toggle.dataset.toggleSkill, enabled: toggle.checked });
      if (res.ok) { state.skills = res.skills; renderSkills(); }
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

  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await api("/api/settings", {
      userName: $("#set-username").value.trim(),
      minimizeToTray: $("#set-tray").checked,
      autoOpenWindow: $("#set-autoopen").checked,
    });
    if (res.ok) {
      if (state.status) state.status.settings = res.settings;
      renderStatus(state.status);
      $("#settings-msg").textContent = "Saved.";
      toast("Preferences saved.");
    }
  });

  $("#btn-open-logs").addEventListener("click", () => { $("#logs-drawer").hidden = false; loadLogs(); });
  $("#btn-close-logs").addEventListener("click", () => { $("#logs-drawer").hidden = true; });
  $("#logs-filter").addEventListener("input", renderLogs);
  $("#btn-copy-logs").addEventListener("click", async () => {
    const text = state.logs.map((l) => `${l.ts} ${l.msg}`).join("\n");
    try { await navigator.clipboard.writeText(text); toast("Logs copied."); } catch {}
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
    } catch {}
  }

  startMatrixCanvas();
  tick();
  loadSkills();
  setInterval(tick, 2500);
})();

