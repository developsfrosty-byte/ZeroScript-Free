// SPDX-License-Identifier: GPL-3.0-or-later
// providers/mistral.js - Mistral Le Chat (chat.mistral.ai) provider.
// Exports the ZSProvider interface consumed by core/main.js.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {};

  const S = {
    roleMsg: '[data-message-author-role]',
    asstPart: '[data-testid="text-message-part"], .prose, .markdown',
    thinking: '[data-testid*="thinking"], [class*="thinking"], [class*="thought"]',
    editorSels: [
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[name="message.text"]',
      'form textarea',
      'textarea',
    ],
    sendSels: [
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Envoyer" i]',
    ],
    stopSels: [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Arrêt" i]',
      'button[data-testid*="stop" i]',
    ],
    codeWrap: 'pre, .not-prose',
    errorSurfaces: '[role="alert"], [class*="toast"], [class*="error"]',
  };

  const RE = {
    contextLimit: /conversation.{0,25}(too long|limit)|maximum.{0,20}context|token limit|trop long/i,
    tooLong: /conversation.{0,25}(too long|getting long|trop longue)/i,
    busy: /rate limit|too many requests|something went wrong|try again later|server is busy/i,
  };

  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function isVisibleBox(el) {
    if (!el || el.closest("#zs-root")) return false;
    if (!el.getBoundingClientRect) return true;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
    } catch {}
    return true;
  }

  function getEditor() {
    for (const sel of S.editorSels) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisibleBox(el)) return el;
      }
    }
    return null;
  }

  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return e.tagName === "TEXTAREA" ? (e.value || "") : (e.textContent || "");
  };

  function allItems() {
    const roleNodes = [...document.querySelectorAll(S.roleMsg)].filter((el) => !el.closest("#zs-root"));
    if (roleNodes.length) return roleNodes;
    const seen = new Set();
    const out = [];
    for (const part of document.querySelectorAll('[data-testid="text-message-part"]')) {
      if (part.closest("#zs-root")) continue;
      const host = part.closest('[data-testid*="message"]') || part.parentElement;
      if (host && !seen.has(host)) { seen.add(host); out.push(host); }
    }
    return out;
  }

  function isUserItem(item) {
    if (!item) return false;
    const role = item.getAttribute && item.getAttribute("data-message-author-role");
    if (role) return role === "user";
    const cl = (item.className || "").toString();
    return /\bjustify-end\b|\bself-end\b|\bitems-end\b/.test(cl);
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  const BLOCK_TAGS = /^(?:P|DIV|PRE|LI|UL|OL|BLOCKQUOTE|H[1-6]|TABLE|TR|SECTION|ARTICLE|HR)$/;
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = S.thinking + ", .zs-chip" + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const breakLine = () => { if (t && !t.endsWith("\n")) t += "\n"; };
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      if (n.tagName === "BR") { t += "\n"; return; }
      if (n.classList && n.classList.contains("cm-line")) {
        for (const c of n.childNodes) walk(c);
        t += "\n";
        return;
      }
      const isBlock = BLOCK_TAGS.test(n.tagName);
      if (isBlock) breakLine();
      for (const c of n.childNodes) walk(c);
      if (isBlock) breakLine();
    };
    walk(root);
    return t;
  }

  const replyContainer = (item) => {
    if (!item) return null;
    if (isAssistantItem(item)) return item.querySelector(S.asstPart) || item;
    return item;
  };
  const itemText = (item) => {
    const rc = replyContainer(item);
    return rc ? textWithout(rc) : "";
  };
  const classifyText = (item, excludeSel) => {
    const rc = replyContainer(item);
    if (!rc || (excludeSel && rc.closest(excludeSel))) return "";
    return textWithout(rc, excludeSel);
  };

  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  const _idMap = new WeakMap();
  let _idSeq = 0;
  function lastAssistantId() {
    const it = lastAssistant();
    if (!it) return null;
    let id = _idMap.get(it);
    if (!id) { id = ++_idSeq; _idMap.set(it, id); }
    return id;
  }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !/\/chat\/[^/]+/.test(location.pathname) && !!getEditor();

  function composerFrame() {
    const ed = getEditor();
    return ed ? (ed.closest("form") || ed.parentElement) : null;
  }

  function barAnchor() {
    const ed = getEditor();
    if (!ed) return null;
    let n = ed.closest("form") || ed.parentElement;
    for (let i = 0; i < 6 && n; i++) {
      if (n.closest && n.closest("#zs-root")) break;
      const cl = [...(n.classList || [])];
      if (cl.some((c) => c.startsWith("rounded"))) {
        const r = n.getBoundingClientRect();
        if (r.width >= 260 && r.height >= 36) return n;
      }
      n = n.parentElement;
    }
    const f = composerFrame();
    if (f && f.getBoundingClientRect && f.getBoundingClientRect().width >= 260) return f;
    return null;
  }

  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    if (ed.tagName === "TEXTAREA") {
      if (on) ed.setAttribute("readonly", "");
      else ed.removeAttribute("readonly");
    } else {
      ed.setAttribute("contenteditable", on ? "false" : "true");
    }
    if (on) ed.setAttribute("data-zs-locked", "1");
    else ed.removeAttribute("data-zs-locked");
  }

  function firstVisible(sels) {
    for (const sel of sels) {
      for (const b of document.querySelectorAll(sel)) {
        if (isVisibleBox(b)) return b;
      }
    }
    return null;
  }
  const sendButton = () => firstVisible(S.sendSels);
  const stopButton = () => firstVisible(S.stopSels);

  function streamText(item) { return item ? textWithout(item, ".zs-chip") : ""; }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  const WEDGE_MS = 10000;
  let _stopSince = 0;
  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      if (!_stopSince) _stopSince = now;
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2500);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }
  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = () => !!stopButton();

  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function snapshot() {
    try {
      const it = lastAssistant();
      return it ? { th: 0, rp: itemText(it).length } : { th: 0, rp: 0 };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    return {
      present: true,
      reply: classifyText(item, ".zs-chip").trim(),
      thinking: "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  const SEND_MAX_CHARS = 116000;
  const SEND_MAX_LINES = 800;
  const INSERT_CHUNK_LINES = 40;
  function truncateForSend(text) {
    if (!text) return text;
    const lines = String(text).split("\n");
    if (text.length <= SEND_MAX_CHARS && lines.length <= SEND_MAX_LINES) return text;
    const marker = (what) => `\n\n[…ZeroScript: result truncated (${what}) for Mistral composer…]\n\n`;
    let out = text;
    if (lines.length > SEND_MAX_LINES) {
      const head = Math.floor(SEND_MAX_LINES * 0.85);
      out = lines.slice(0, head).join("\n") + marker(`${lines.length - SEND_MAX_LINES} lines omitted`) + lines.slice(lines.length - (SEND_MAX_LINES - head)).join("\n");
    }
    if (out.length > SEND_MAX_CHARS) {
      const budget = SEND_MAX_CHARS - 300;
      const head = Math.floor(budget * 0.85);
      out = out.slice(0, head) + marker(`${out.length - budget} chars omitted`) + out.slice(out.length - (budget - head));
    }
    return out;
  }

  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function setEditorText(ed, text) {
    ed.focus();
    if (ed.tagName === "TEXTAREA") {
      setTextareaValue(ed, text);
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) document.execCommand("insertText", false, lines[i]);
      if (i < lines.length - 1) document.execCommand("insertLineBreak");
      if (i && i % INSERT_CHUNK_LINES === 0) await sleep(0);
    }
  }

  async function typeAndSend(text, images) {
    const ed = getEditor();
    if (!ed) throw new Error("Mistral input box not found");
    text = truncateForSend(text);
    const relock = _locked;
    if (relock) {
      if (ed.tagName === "TEXTAREA") ed.removeAttribute("readonly");
      else ed.setAttribute("contenteditable", "true");
    }
    try {
      if (editorText() !== text) await setEditorText(ed, text);
      if (images && images.length) {
        try { await attachImages(images); } catch {}
      }
      await waitFor(() => { const b = sendButton(); return !!b && !b.disabled; }, 3500);
      const btn = sendButton();
      if (btn && !btn.disabled) { btn.click(); return; }
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent("keydown", o));
      ed.dispatchEvent(new KeyboardEvent("keyup", o));
    } finally {
      if (relock) setInputLock(true);
    }
  }

  function stopGeneration() {
    const b = stopButton();
    if (b) try { b.click(); } catch {}
  }

  function enforceComposer() { return { ready: true }; }
  async function ensureComposerReady(reason) {
    diag("mode_ready", { reason, provider: "mistral" });
    return { ready: !!getEditor() };
  }

  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.roleMsg)) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);
  const isBusyMsg = (text) => RE.busy.test(text);

  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `zeroscript_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  async function attachImages(images) {
    if (!images || !images.length) return false;
    const inp = document.querySelector('input[type="file"]');
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    if (inp) {
      try { inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }
    return await waitFor(() => !!document.querySelector('img[src^="blob:"], [class*="preview"], [class*="thumbnail"]'), 12000);
  }
  function clearAttachments() {
    try {
      document.querySelectorAll('button[aria-label*="Remove"], button[aria-label*="Supprimer"]')
        .forEach((b) => { try { b.click(); } catch {} });
    } catch {}
  }

  async function openNewChat() {
    const a = document.querySelector('a[href="/chat"], button[aria-label*="New chat" i]');
    if (a) {
      try { a.click(); } catch {}
      await waitFor(() => chatIsEmpty() && !!getEditor(), 5000);
      return true;
    }
    location.assign("https://chat.mistral.ai/chat");
    return true;
  }

  const conversationKey = () => (/\/chat\/[^/]+/.test(location.pathname) ? location.pathname : "");

  const PROMPT_EXTRA = `- NEVER CLAIM ZEROSCRIPT IS INACTIVE OR TELL THE USER TO PASTE CODE: the ZeroScript browser extension is live in this tab for the entire session. Always emit a fenced ZeroScript command block directly (multi_edit or ###LUA### ... ###END_LUA###) instead of asking the user to paste code into Roblox Studio.`;

  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (!e.isTrusted) return;
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const ed = getEditor();
      if (!ed || !ed.contains(e.target)) return;
      if (editorText().trim() === "") return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);

    document.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      if (!getEditor()) return;
      const b = e.target && e.target.closest && e.target.closest("button");
      if (!b) return;
      if (S.stopSels.some((sel) => b.matches(sel))) { handlers.onNativeStop(); return; }
      if (!S.sendSels.some((sel) => b.matches(sel))) return;
      if (b.disabled) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  const CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;
  function findToolBlockSpot(item) {
    const rc = replyContainer(item);
    if (!rc) return null;
    let hidAny = null;
    rc.querySelectorAll(S.codeWrap).forEach((cw) => {
      if (cw.closest(".zs-chip")) return;
      if (CMD_SHAPE.test(cw.textContent || "")) {
        cw.classList.add("zs-tool-hide");
        rc.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: cw.parentElement, ref: cw };
      }
    });
    [...rc.children].forEach((el) => {
      if (el.classList.contains("zs-chip") || el.querySelector(S.codeWrap)) return;
      const t = el.textContent || "";
      if ((/^\{\s*"(?:command|tool)"\s*:/.test(t.trim()) || t.length < 600) && CMD_SHAPE.test(t)) {
        el.classList.add("zs-tool-hide");
        rc.classList.add("zs-cmd-mask");
        hidAny = hidAny || { parent: el.parentElement, ref: el };
      }
    });
    return hidAny;
  }

  return {
    id: "mistral",
    displayName: "Mistral",
    supportsVision: true,
    timings,
    thinkingSel: S.thinking,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) {
      if (d) diag = d;
      try { document.documentElement.setAttribute("data-zs-mistral-ver", "2026-11-22_v1.7.0"); } catch {}
    },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages, clearAttachments, openNewChat, conversationKey,
    installSendHooks, findToolBlockSpot,
    promptExtra: PROMPT_EXTRA,
    resendSystemEvery: 5,
    sendCharBudget: SEND_MAX_CHARS - 4000,
  };
})();

