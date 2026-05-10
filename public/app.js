const state = {
  token: new URLSearchParams(location.search).get("token") || localStorage.getItem("codexRemoteToken") || "",
  cwd: "",
  threadId: null,
  activeTurnId: null,
  turnPending: false,
  items: new Map(),
  deltas: new Map(),
  images: [],
  queue: [],
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
  thinkingIndicator: qs("#thinkingIndicator"),
  transcript: qs("#transcript"),
  composer: qs("#composer"),
  messageInput: qs("#messageInput"),
  imageInput: qs("#imageInput"),
  attachButton: qs("#attachButton"),
  clearImagesButton: qs("#clearImagesButton"),
  sendButton: qs("#sendButton"),
  attachmentList: qs("#attachmentList"),
  queueList: qs("#queueList"),
  queueCount: qs("#queueCount"),
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
  renderAttachments();
  renderQueue();
  renderRunState();
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

  els.composer.addEventListener("submit", handleComposerSubmit);

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

async function handleComposerSubmit(event) {
  event.preventDefault();
  const draft = createDraft();
  if (!hasDraftContent(draft)) return;

  clearComposerDraft();
  if (isBusy()) {
    enqueueDraft(draft);
    return;
  }

  try {
    await deliverDraft(draft);
  } catch (error) {
    enqueueDraft(draft);
    log("error", error.message || String(error));
  }
}

async function openThread(threadId) {
  const data = await api(`/api/thread/${encodeURIComponent(threadId)}`);
  ingestThread(data.thread);
  await loadThreads();
}

async function deliverDraft(draft) {
  const targetThreadId = draft.threadId || state.threadId;
  if (!targetThreadId) {
    await startThread(draft);
  } else {
    if (targetThreadId !== state.threadId) await openThread(targetThreadId);
    await sendMessage(targetThreadId, draft);
  }
}

async function startThread(input, images = []) {
  const draft = normalizeDraft(input, images);
  state.turnPending = hasDraftContent(draft);
  renderRunState();
  try {
    const data = await api("/api/thread/start", {
      method: "POST",
      body: {
        ...settingsPayload(),
        text: draft.text,
        images: draft.images
      }
    });
    const thread = data.thread;
    if (thread?.id) {
      ingestThread(thread);
      await loadThreads();
    }
    if (data.turn?.id) state.activeTurnId = data.turn.id;
  } finally {
    state.turnPending = false;
    renderRunState();
  }
}

async function sendMessage(threadId, input, images = []) {
  const draft = normalizeDraft(input, images);
  const outgoing = {
    type: "userMessage",
    id: nextLocalId("local"),
    content: [
      ...(draft.text ? [{ type: "text", text: draft.text, text_elements: [] }] : []),
      ...draft.images.map((image) => ({ type: "image", url: image.url, name: image.name }))
    ]
  };
  upsertItem(outgoing);
  renderTranscript();
  state.turnPending = true;
  renderRunState();
  try {
    const data = await api(`/api/thread/${encodeURIComponent(threadId)}/send`, {
      method: "POST",
      body: {
        ...settingsPayload(),
        text: draft.text,
        images: draft.images
      }
    });
    if (data.turn?.id) state.activeTurnId = data.turn.id;
  } catch (error) {
    state.items.delete(outgoing.id);
    renderTranscript();
    throw error;
  } finally {
    state.turnPending = false;
    renderRunState();
  }
}

function createDraft() {
  return normalizeDraft({
    text: els.messageInput.value.trim(),
    images: state.images,
    threadId: state.threadId,
    createdAt: Date.now()
  });
}

function normalizeDraft(input, images = []) {
  if (input && typeof input === "object") {
    return {
      id: input.id || nextLocalId("draft"),
      text: String(input.text || "").trim(),
      images: (input.images || []).map(cloneImage).filter((image) => image.url),
      threadId: input.threadId || null,
      createdAt: input.createdAt || Date.now()
    };
  }

  return {
    id: nextLocalId("draft"),
    text: String(input || "").trim(),
    images: (images || []).map(cloneImage).filter((image) => image.url),
    threadId: state.threadId,
    createdAt: Date.now()
  };
}

function cloneImage(image) {
  return {
    name: image?.name || "image",
    url: image?.url || ""
  };
}

function hasDraftContent(draft) {
  return Boolean(String(draft?.text || "").trim()) || (draft?.images || []).length > 0;
}

function clearComposerDraft() {
  els.messageInput.value = "";
  state.images = [];
  renderAttachments();
}

function enqueueDraft(draft) {
  state.queue.push(normalizeDraft(draft));
  renderQueue();
  log("info", "message queued");
}

async function sendQueuedMessage(id) {
  const index = state.queue.findIndex((draft) => draft.id === id);
  if (index < 0) return;
  const [draft] = state.queue.splice(index, 1);
  renderQueue();
  try {
    await deliverDraft(draft);
  } catch (error) {
    state.queue.splice(index, 0, draft);
    renderQueue();
    throw error;
  }
}

function removeQueuedMessage(id) {
  state.queue = state.queue.filter((draft) => draft.id !== id);
  renderQueue();
}

function isBusy() {
  return Boolean(state.activeTurnId || state.turnPending);
}

function nextLocalId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      state.turnPending = false;
      for (const item of params.turn?.items || []) upsertItem(item);
      renderTranscript();
      renderRunState();
      break;
    case "turn/completed":
      state.activeTurnId = null;
      state.turnPending = false;
      for (const item of params.turn?.items || []) upsertItem(item);
      renderTranscript();
      renderRunState();
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
  const previousThreadId = state.threadId;
  state.threadId = thread.id;
  state.items.clear();
  state.deltas.clear();
  els.threadTitle.textContent = thread.name || thread.preview || thread.id;
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) upsertItem(item);
  }
  if (!previousThreadId) {
    for (const draft of state.queue) {
      if (!draft.threadId) draft.threadId = thread.id;
    }
    renderQueue();
  }
  renderTranscript();
  renderThreadButtons();
}

function upsertItem(item) {
  if (!item?.id) return;
  if (item.type === "userMessage" && !String(item.id).startsWith("local-")) {
    removeMatchingLocalUserMessage(item);
  }
  state.items.set(item.id, item);
}

function removeMatchingLocalUserMessage(item) {
  const incoming = userMessageSignature(item);
  for (const [id, existing] of state.items) {
    if (!String(id).startsWith("local-") || existing.type !== "userMessage") continue;
    if (userMessageSignature(existing) === incoming) {
      state.items.delete(id);
      return;
    }
  }
}

function userMessageSignature(item) {
  return (item.content || []).map((part) => {
    if (part.type === "text") return `text:${String(part.text || "").trim()}`;
    if (part.type === "image") return `image:${part.url || ""}`;
    if (part.type === "localImage") return `localImage:${part.path || ""}`;
    return `${part.type}:${part.name || part.path || ""}`;
  }).join("|");
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
  renderRunState();
}

function renderRunState() {
  const busy = isBusy();
  els.thinkingIndicator.classList.toggle("hidden", !busy);
  els.sendButton.textContent = busy ? "Queue" : "Send";
  renderThreadButtons();
  renderTranscript();
}

function renderThreadButtons() {
  const hasThread = Boolean(state.threadId);
  els.resumeButton.disabled = !hasThread;
  els.interruptButton.disabled = !hasThread || !isBusy();
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
  if (items.length === 0 && !isBusy()) {
    els.transcript.append(empty(state.threadId ? "Waiting for activity" : "Start or select a thread"));
    return;
  }
  for (const item of items) {
    els.transcript.append(renderItem(item));
  }
  if (isBusy()) els.transcript.append(renderThinkingItem());
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function renderThinkingItem() {
  const node = document.createElement("article");
  node.className = "message assistant thinking-message";
  const header = document.createElement("div");
  header.className = "message-header";
  header.append(span("Codex"), span("running"));
  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = `<div class="thinking-line"><span>Thinking</span><span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span></div>`;
  node.append(header, body);
  return node;
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
  enhanceCopyBlocks(body);

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
      if (part.type === "image" || part.type === "localImage") return renderInlineImage(part);
      return `<span class="badge">${escapeHtml(part.type)}</span>`;
    }).join("\n");
  }
  if (item.type === "agentMessage" || item.type === "plan") return markdown(item.text || "");
  if (item.type === "reasoning") return markdown([...(item.summary || []), ...(item.content || [])].join("\n"));
  if (item.type === "imageView" || item.type === "imageGeneration") {
    const gallery = renderImageGallery(item);
    if (gallery) return gallery;
  }
  if (item.type === "commandExecution") {
    return collapsedBlock(
      item.status ? `Command · ${item.status}` : "Command",
      item.command || "",
      item.aggregatedOutput || ""
    );
  }
  if (item.type === "fileChange") {
    return collapsedBlock("File change", "", compactJson(item.changes || item));
  }
  if (item.type === "mcpToolCall") {
    return collapsedBlock(
      `MCP · ${item.server || ""}/${item.tool || ""}`,
      item.status || "",
      compactJson({ arguments: item.arguments, result: item.result, error: item.error })
    );
  }
  if (item.type === "dynamicToolCall") {
    return collapsedBlock(
      `Tool · ${item.tool || ""}`,
      item.status || "",
      compactJson({ arguments: item.arguments, success: item.success, contentItems: item.contentItems })
    );
  }
  if (item.type === "webSearch") return markdown(item.query || "");
  return collapsedBlock(item.type || "Item", "", compactJson(item));
}

function collapsedBlock(title, subtitle, body) {
  const safeSubtitle = subtitle ? `<div class="tool-subtitle">${escapeHtml(subtitle)}</div>` : "";
  const safeBody = body ? `<pre>${escapeHtml(body)}</pre>` : "";
  return `<details class="tool-details"><summary>${escapeHtml(title)}</summary>${safeSubtitle}${safeBody}</details>`;
}

function enhanceCopyBlocks(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.closest(".copyable-block")) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "copyable-block";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-block-button";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy text block");
    button.addEventListener("click", async () => {
      try {
        await copyText(pre.textContent || "");
        flashButton(button, "Copied");
      } catch (error) {
        flashButton(button, "Failed");
        log("error", error.message || String(error));
      }
    });

    pre.replaceWith(wrapper);
    wrapper.append(button, pre);
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    textarea.remove();
  }
}

function flashButton(button, label) {
  const original = button.textContent;
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1100);
}

function renderInlineImage(part) {
  const src = safeImageSource(part?.url || part?.image_url || part?.data_url || part?.src);
  const label = part?.name || part?.path || "image";
  if (!src) return `<span class="badge">${escapeHtml(label)}</span>`;
  return `<figure class="inline-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`;
}

function renderImageGallery(value) {
  const images = collectImages(value).slice(0, 12);
  if (images.length === 0) return "";
  return `<div class="inline-image-grid">${images.map(renderInlineImage).join("")}</div>`;
}

function collectImages(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const found = [];
  const src = safeImageSource(value.url || value.image_url || value.data_url || value.src);
  if (src) found.push({ url: src, name: value.name || value.path || "image" });

  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) {
    found.push(...collectImages(entry, seen));
  }

  const unique = new Map();
  for (const image of found) {
    if (!unique.has(image.url)) unique.set(image.url, image);
  }
  return [...unique.values()];
}

function safeImageSource(value) {
  const src = String(value || "");
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) return src;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^blob:/i.test(src)) return src;
  return "";
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
  els.clearImagesButton.disabled = state.images.length === 0;
  for (const [index, image] of state.images.entries()) {
    const card = document.createElement("div");
    card.className = "attachment-card";

    const preview = document.createElement("img");
    preview.src = image.url;
    preview.alt = image.name;
    preview.loading = "lazy";

    const meta = document.createElement("div");
    meta.className = "attachment-meta";
    meta.textContent = image.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      state.images.splice(index, 1);
      renderAttachments();
    });

    card.append(preview, meta, remove);
    els.attachmentList.append(card);
  }
}

function renderQueue() {
  els.queueCount.textContent = String(state.queue.length);
  els.queueList.textContent = "";
  if (state.queue.length === 0) {
    els.queueList.append(empty("No queued messages"));
    return;
  }

  for (const draft of state.queue) {
    const card = document.createElement("div");
    card.className = "queue-card";

    const body = document.createElement("div");
    body.className = "queue-body";
    const preview = document.createElement("div");
    preview.className = "queue-preview";
    preview.textContent = draft.text || `${draft.images.length} image attachment${draft.images.length === 1 ? "" : "s"}`;
    const meta = document.createElement("div");
    meta.className = "queue-meta";
    meta.textContent = `${formatClock(draft.createdAt)} · ${draft.images.length} image${draft.images.length === 1 ? "" : "s"}`;
    body.append(preview, meta);

    if (draft.images.length > 0) {
      const thumbs = document.createElement("div");
      thumbs.className = "queue-thumbs";
      for (const image of draft.images.slice(0, 4)) {
        const thumb = document.createElement("img");
        thumb.src = image.url;
        thumb.alt = image.name;
        thumb.loading = "lazy";
        thumbs.append(thumb);
      }
      body.append(thumbs);
    }

    const actions = document.createElement("div");
    actions.className = "queue-actions";
    const sendNow = document.createElement("button");
    sendNow.type = "button";
    sendNow.textContent = "Send now";
    sendNow.addEventListener("click", async () => {
      try {
        await sendQueuedMessage(draft.id);
      } catch (error) {
        log("error", error.message || String(error));
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeQueuedMessage(draft.id));
    actions.append(sendNow, remove);

    card.append(body, actions);
    els.queueList.append(card);
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
