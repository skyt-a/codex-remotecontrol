const state = {
  token: new URLSearchParams(location.search).get("token") || localStorage.getItem("codexRemoteToken") || "",
  cwd: "",
  threadId: null,
  activeTurnId: null,
  items: new Map(),
  deltas: new Map(),
  images: [],
  approvals: new Map(),
  logs: []
};

const els = {
  bridgeState: qs("#bridgeState"),
  tokenPanel: qs("#tokenPanel"),
  tokenInput: qs("#tokenInput"),
  saveTokenButton: qs("#saveTokenButton"),
  refreshButton: qs("#refreshButton"),
  cwdInput: qs("#cwdInput"),
  modelSelect: qs("#modelSelect"),
  approvalSelect: qs("#approvalSelect"),
  sandboxSelect: qs("#sandboxSelect"),
  newThreadButton: qs("#newThreadButton"),
  startThreadButton: qs("#startThreadButton"),
  threadSearch: qs("#threadSearch"),
  threadSearchButton: qs("#threadSearchButton"),
  threadList: qs("#threadList"),
  threadTitle: qs("#threadTitle"),
  resumeButton: qs("#resumeButton"),
  interruptButton: qs("#interruptButton"),
  transcript: qs("#transcript"),
  composer: qs("#composer"),
  messageInput: qs("#messageInput"),
  imageInput: qs("#imageInput"),
  attachButton: qs("#attachButton"),
  clearImagesButton: qs("#clearImagesButton"),
  sendButton: qs("#sendButton"),
  attachmentList: qs("#attachmentList"),
  approvalList: qs("#approvalList"),
  approvalCount: qs("#approvalCount"),
  logList: qs("#logList"),
  clearLogButton: qs("#clearLogButton")
};

boot();

async function boot() {
  if (state.token) {
    localStorage.setItem("codexRemoteToken", state.token);
    els.tokenInput.value = state.token;
  } else {
    els.tokenPanel.classList.remove("hidden");
  }

  bindEvents();
  renderTranscript();
  connectEvents();
  await refreshAll();
}

function bindEvents() {
  els.saveTokenButton.addEventListener("click", () => {
    state.token = els.tokenInput.value.trim();
    if (state.token) {
      localStorage.setItem("codexRemoteToken", state.token);
      els.tokenPanel.classList.add("hidden");
      connectEvents();
      refreshAll();
    }
  });

  els.refreshButton.addEventListener("click", refreshAll);
  els.threadSearchButton.addEventListener("click", loadThreads);
  els.threadSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadThreads();
  });

  els.newThreadButton.addEventListener("click", () => {
    state.threadId = null;
    state.activeTurnId = null;
    state.items.clear();
    state.deltas.clear();
    els.threadTitle.textContent = "New thread";
    renderTranscript();
    renderThreadButtons();
  });

  els.startThreadButton.addEventListener("click", async () => {
    await startThread("");
  });

  els.resumeButton.addEventListener("click", async () => {
    if (!state.threadId) return;
    const data = await api(`/api/thread/${encodeURIComponent(state.threadId)}/resume`, {
      method: "POST",
      body: settingsPayload()
    });
    ingestThread(data.thread);
    log("info", `resumed ${state.threadId}`);
  });

  els.interruptButton.addEventListener("click", async () => {
    if (!state.threadId) return;
    await api(`/api/thread/${encodeURIComponent(state.threadId)}/interrupt`, {
      method: "POST",
      body: { turnId: state.activeTurnId }
    });
    log("warn", "interrupt requested");
  });

  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = els.messageInput.value.trim();
    if (!text && state.images.length === 0) return;
    if (!state.threadId) {
      await startThread(text);
    } else {
      await sendMessage(state.threadId, text);
    }
    els.messageInput.value = "";
    state.images = [];
    renderAttachments();
  });

  els.attachButton.addEventListener("click", () => els.imageInput.click());
  els.clearImagesButton.addEventListener("click", () => {
    state.images = [];
    renderAttachments();
  });
  els.imageInput.addEventListener("change", handleImages);
  els.clearLogButton.addEventListener("click", () => {
    state.logs = [];
    renderLogs();
  });
}

async function refreshAll() {
  if (!state.token) return;
  await Promise.allSettled([loadStatus(), loadModels(), loadThreads(), loadApprovals()]);
}

async function loadStatus() {
  const data = await api("/api/status");
  state.cwd = data.app.cwd;
  if (!els.cwdInput.value) els.cwdInput.value = data.app.cwd;
  renderStatus(data.bridge);
}

async function loadModels() {
  const data = await api("/api/models");
  const selected = els.modelSelect.value;
  els.modelSelect.textContent = "";
  els.modelSelect.append(option("", "Default"));
  for (const model of data.data || []) {
    const label = model.isDefault ? `${model.displayName} (default)` : model.displayName;
    els.modelSelect.append(option(model.model || model.id, label));
  }
  els.modelSelect.value = selected;
}

async function loadThreads() {
  const search = els.threadSearch.value.trim();
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  const data = await api(`/api/threads${query}`);
  renderThreads(data.data || []);
}

async function loadApprovals() {
  const data = await api("/api/approvals");
  state.approvals.clear();
  for (const request of data.data || []) state.approvals.set(request.id, request);
  renderApprovals();
}

async function openThread(threadId) {
  const data = await api(`/api/thread/${encodeURIComponent(threadId)}`);
  ingestThread(data.thread);
  await loadThreads();
}

async function startThread(text) {
  const data = await api("/api/thread/start", {
    method: "POST",
    body: {
      ...settingsPayload(),
      text,
      images: state.images
    }
  });
  const thread = data.thread;
  if (thread?.id) {
    ingestThread(thread);
    await loadThreads();
  }
}

async function sendMessage(threadId, text) {
  const outgoing = {
    type: "userMessage",
    id: `local-${Date.now()}`,
    content: [{ type: "text", text, text_elements: [] }, ...state.images.map((image) => ({ type: "image", url: image.url }))]
  };
  upsertItem(outgoing);
  renderTranscript();
  const data = await api(`/api/thread/${encodeURIComponent(threadId)}/send`, {
    method: "POST",
    body: {
      ...settingsPayload(),
      text,
      images: state.images
    }
  });
  if (data.turn?.id) state.activeTurnId = data.turn.id;
}

function settingsPayload() {
  return {
    cwd: els.cwdInput.value.trim() || state.cwd,
    model: els.modelSelect.value || null,
    approvalPolicy: els.approvalSelect.value,
    sandbox: els.sandboxSelect.value
  };
}

function connectEvents() {
  if (!state.token) return;
  if (state.eventSource) state.eventSource.close();

  state.eventSource = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  state.eventSource.addEventListener("message", (event) => {
    handleBridgeEvent(JSON.parse(event.data));
  });
  state.eventSource.addEventListener("error", () => {
    els.bridgeState.textContent = "event stream reconnecting";
  });
}

function handleBridgeEvent(event) {
  if (event.type === "hello") {
    renderStatus(event.payload.status);
    return;
  }
  if (event.type === "status") {
    renderStatus(event.payload);
    return;
  }
  if (event.type === "log") {
    log(event.payload.level || "info", event.payload.message || "");
    return;
  }
  if (event.type === "approval") {
    state.approvals.set(event.payload.id, event.payload);
    renderApprovals();
    log("warn", `${event.payload.method} is waiting`);
    return;
  }
  if (event.type === "approvalResolved") {
    state.approvals.delete(String(event.payload.id));
    renderApprovals();
    return;
  }
  if (event.type === "notification") {
    handleNotification(event.payload);
  }
}

function handleNotification(note) {
  const params = note.params || {};
  if (params.threadId && state.threadId && params.threadId !== state.threadId) {
    log("info", note.method);
    return;
  }

  switch (note.method) {
    case "thread/started":
      if (params.thread?.id) ingestThread(params.thread);
      loadThreads();
      break;
    case "turn/started":
      state.activeTurnId = params.turn?.id || null;
      for (const item of params.turn?.items || []) upsertItem(item);
      renderTranscript();
      break;
    case "turn/completed":
      state.activeTurnId = null;
      for (const item of params.turn?.items || []) upsertItem(item);
      renderTranscript();
      loadThreads();
      break;
    case "item/started":
    case "item/completed":
      if (params.item) upsertItem(params.item);
      renderTranscript();
      break;
    case "item/agentMessage/delta":
      appendDelta(params.itemId, "agentMessage", params.delta || "");
      break;
    case "item/plan/delta":
      appendDelta(params.itemId, "plan", params.delta || "");
      break;
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
    case "process/outputDelta":
      appendDelta(params.itemId || params.processId || "output", "commandExecution", params.delta || "");
      break;
    case "error":
    case "warning":
    case "guardianWarning":
    case "configWarning":
      log(note.method === "error" ? "error" : "warn", compactJson(params));
      break;
    default:
      log("info", note.method);
  }
}

function ingestThread(thread) {
  if (!thread) return;
  state.threadId = thread.id;
  state.items.clear();
  state.deltas.clear();
  els.threadTitle.textContent = thread.name || thread.preview || thread.id;
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) upsertItem(item);
  }
  renderTranscript();
  renderThreadButtons();
}

function upsertItem(item) {
  if (!item?.id) return;
  state.items.set(item.id, item);
}

function appendDelta(itemId, type, delta) {
  if (!itemId || !delta) return;
  const current = state.items.get(itemId) || { id: itemId, type, text: "", command: "", aggregatedOutput: "" };
  if (type === "agentMessage" || type === "plan") {
    current.text = `${current.text || ""}${delta}`;
  } else {
    current.aggregatedOutput = `${current.aggregatedOutput || ""}${delta}`;
  }
  current.type = current.type || type;
  state.items.set(itemId, current);
  renderTranscript();
}

function renderStatus(status) {
  els.bridgeState.textContent = status?.state || "offline";
  renderThreadButtons();
}

function renderThreadButtons() {
  const hasThread = Boolean(state.threadId);
  els.resumeButton.disabled = !hasThread;
  els.interruptButton.disabled = !hasThread;
}

function renderThreads(threads) {
  els.threadList.textContent = "";
  if (threads.length === 0) {
    els.threadList.append(empty("No threads"));
    return;
  }
  for (const thread of threads) {
    const button = document.createElement("button");
    button.className = `thread-item${thread.id === state.threadId ? " active" : ""}`;
    button.addEventListener("click", () => openThread(thread.id));
    const title = document.createElement("div");
    title.className = "thread-preview";
    title.textContent = thread.name || thread.preview || thread.id;
    const meta = document.createElement("div");
    meta.className = "thread-meta";
    meta.textContent = `${formatTime(thread.updatedAt)} · ${thread.cwd}`;
    button.append(title, meta);
    els.threadList.append(button);
  }
}

function renderTranscript() {
  els.transcript.textContent = "";
  const items = [...state.items.values()];
  if (items.length === 0) {
    els.transcript.append(empty(state.threadId ? "Waiting for activity" : "Start or select a thread"));
    return;
  }
  for (const item of items) {
    els.transcript.append(renderItem(item));
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function renderItem(item) {
  const node = document.createElement("article");
  node.className = `message ${messageClass(item)}`;

  const header = document.createElement("div");
  header.className = "message-header";
  header.append(span(itemLabel(item)), span(item.id || ""));

  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = renderBody(item);

  node.append(header, body);
  return node;
}

function messageClass(item) {
  if (item.type === "userMessage") return "user";
  if (item.type === "agentMessage" || item.type === "plan") return "assistant";
  if (item.type === "reasoning") return "reasoning";
  return "tool";
}

function itemLabel(item) {
  const labels = {
    userMessage: "User",
    agentMessage: "Codex",
    plan: "Plan",
    reasoning: "Reasoning",
    commandExecution: "Command",
    fileChange: "File change",
    mcpToolCall: "MCP",
    dynamicToolCall: "Tool",
    webSearch: "Web search",
    imageView: "Image",
    imageGeneration: "Image generation"
  };
  return labels[item.type] || item.type || "Item";
}

function renderBody(item) {
  if (item.type === "userMessage") {
    return (item.content || []).map((part) => {
      if (part.type === "text") return markdown(part.text || "");
      if (part.type === "image") return `<span class="badge">image</span>`;
      if (part.type === "localImage") return `<span class="badge">${escapeHtml(part.path)}</span>`;
      return `<span class="badge">${escapeHtml(part.type)}</span>`;
    }).join("\n");
  }
  if (item.type === "agentMessage" || item.type === "plan") return markdown(item.text || "");
  if (item.type === "reasoning") return markdown([...(item.summary || []), ...(item.content || [])].join("\n"));
  if (item.type === "commandExecution") {
    return `${markdown(item.command || "")}<pre>${escapeHtml(item.aggregatedOutput || "")}</pre>`;
  }
  if (item.type === "fileChange") return `<pre>${escapeHtml(compactJson(item.changes || item))}</pre>`;
  if (item.type === "mcpToolCall") return `<pre>${escapeHtml(compactJson({ server: item.server, tool: item.tool, status: item.status, result: item.result, error: item.error }))}</pre>`;
  if (item.type === "dynamicToolCall") return `<pre>${escapeHtml(compactJson({ tool: item.tool, status: item.status, success: item.success, contentItems: item.contentItems }))}</pre>`;
  if (item.type === "webSearch") return markdown(item.query || "");
  return `<pre>${escapeHtml(compactJson(item))}</pre>`;
}

function renderApprovals() {
  els.approvalList.textContent = "";
  const approvals = [...state.approvals.values()];
  els.approvalCount.textContent = String(approvals.length);
  if (approvals.length === 0) {
    els.approvalList.append(empty("No pending approvals"));
    return;
  }

  for (const approval of approvals) {
    const card = document.createElement("div");
    card.className = "approval-card";

    const body = document.createElement("div");
    body.className = "approval-body";
    body.append(strong(approval.method));
    const detail = document.createElement("pre");
    detail.textContent = approvalSummary(approval);
    body.append(detail);

    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.placeholder = "Optional JSON response";

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    actions.append(
      approvalButton("Accept", "accept", approval, textarea),
      approvalButton("Session", "acceptForSession", approval, textarea),
      approvalButton("Decline", "decline", approval, textarea),
      approvalButton("Cancel", "cancel", approval, textarea)
    );

    card.append(body, textarea, actions);
    els.approvalList.append(card);
  }
}

function approvalButton(label, decision, approval, textarea) {
  const button = document.createElement("button");
  button.textContent = label;
  button.className = decision === "accept" || decision === "acceptForSession" ? "accept" : "decline";
  button.addEventListener("click", async () => {
    const extra = parseOptionalJson(textarea.value);
    await api(`/api/approval/${encodeURIComponent(approval.id)}`, {
      method: "POST",
      body: { decision, ...extra }
    });
    state.approvals.delete(approval.id);
    renderApprovals();
  });
  return button;
}

function approvalSummary(approval) {
  const params = approval.params || {};
  if (params.command) return `${params.command}\n${params.cwd || ""}\n${params.reason || ""}`.trim();
  if (params.reason) return `${params.reason}\n${compactJson(params.permissions || params)}`;
  return compactJson(params);
}

function renderAttachments() {
  els.attachmentList.textContent = "";
  for (const image of state.images) {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.textContent = image.name;
    els.attachmentList.append(chip);
  }
}

async function handleImages(event) {
  const files = [...event.target.files];
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > 5 * 1024 * 1024) {
      log("warn", `${file.name} is larger than 5 MB`);
      continue;
    }
    const url = await readFileDataUrl(file);
    state.images.push({ name: file.name, url });
  }
  els.imageInput.value = "";
  renderAttachments();
}

function renderLogs() {
  els.logList.textContent = "";
  for (const entry of state.logs.slice(-120)) {
    const line = document.createElement("div");
    line.className = `log-line ${entry.level}`;
    line.textContent = `${formatClock(entry.at)} ${entry.level}: ${entry.message}`;
    els.logList.append(line);
  }
  els.logList.scrollTop = els.logList.scrollHeight;
}

function log(level, message) {
  state.logs.push({ level, message: String(message).trim(), at: Date.now() });
  renderLogs();
}

async function api(path, options = {}) {
  if (!state.token) throw new Error("Missing access token.");
  const url = new URL(path, location.origin);
  url.searchParams.set("token", state.token);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      "x-codex-remote-token": state.token
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error || `${response.status} ${response.statusText}`;
    log("error", message);
    throw new Error(message);
  }
  return data;
}

function markdown(text) {
  const escaped = escapeHtml(text || "");
  const withBlocks = escaped.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code.trim()}</pre>`);
  return withBlocks
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseOptionalJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    log("warn", "approval JSON could not be parsed");
    return {};
  }
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

function formatTime(epochSeconds) {
  if (!epochSeconds) return "unknown";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function formatClock(epochMs) {
  return new Date(epochMs).toLocaleTimeString();
}

function option(value, label) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function span(text) {
  const node = document.createElement("span");
  node.textContent = text;
  return node;
}

function strong(text) {
  const node = document.createElement("strong");
  node.textContent = text;
  return node;
}

function empty(text) {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = text;
  return node;
}

function qs(selector) {
  return document.querySelector(selector);
}
