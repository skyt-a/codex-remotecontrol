import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { URL } from "node:url";
import { redactToken, VERSION } from "./config.mjs";

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const LOCAL_IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif"
};
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon"
};

export function createRemoteControlServer({ bridge, config }) {
  const clients = new Set();

  bridge.on("event", (event) => {
    const safeEvent = {
      ...event,
      payload: sanitizePayload(event.payload, config.token)
    };
    const frame = `event: message\ndata: ${JSON.stringify(safeEvent)}\n\n`;
    for (const client of clients) {
      client.write(frame);
    }
  });

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (url.pathname === "/readyz") {
        sendJson(res, 200, { ok: true, status: bridge.getStatus() });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!isAuthorized(req, url, config.token)) {
          sendJson(res, 403, { error: "Invalid or missing token." });
          return;
        }
        await routeApi(req, res, url, bridge, config, clients);
        return;
      }

      serveStatic(req, res, url, config.staticRoot);
    } catch (error) {
      sendJson(res, 500, { error: error.message || String(error) });
    }
  });
}

async function routeApi(req, res, url, bridge, config, clients) {
  if (req.method === "GET" && url.pathname === "/api/local-image") {
    serveLocalImage(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, {
      app: {
        name: "codex-remotecontrol",
        version: VERSION,
        cwd: config.cwd
      },
      bridge: bridge.getStatus(),
      connectedBrowsers: clients.size
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(`event: message\ndata: ${JSON.stringify({ type: "hello", payload: { status: bridge.getStatus() }, at: Date.now() })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    const result = await bridge.call("model/list", { limit: 100, includeHidden: false });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/threads") {
    const params = {
      limit: Number.parseInt(url.searchParams.get("limit") || "30", 10),
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false
    };
    const searchTerm = url.searchParams.get("search");
    if (searchTerm) params.searchTerm = searchTerm;
    const cwd = url.searchParams.get("cwd");
    if (cwd) params.cwd = cwd;
    const result = await bridge.call("thread/list", params);
    sendJson(res, 200, result);
    return;
  }

  const threadRead = url.pathname.match(/^\/api\/thread\/([^/]+)$/);
  if (req.method === "GET" && threadRead) {
    const threadId = decodeURIComponent(threadRead[1]);
    const result = await readThreadOrResume(bridge, threadId);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/thread/start") {
    const body = await readJsonBody(req);
    const params = buildThreadParams(body, config.cwd);
    const result = await bridge.call("thread/start", params);
    const threadId = result?.thread?.id;
    let turn = null;
    if (threadId && hasInput(body)) {
      turn = await bridge.call("turn/start", buildTurnParams(threadId, body));
    }
    sendJson(res, 200, { ...result, turn });
    return;
  }

  const threadResume = url.pathname.match(/^\/api\/thread\/([^/]+)\/resume$/);
  if (req.method === "POST" && threadResume) {
    const body = await readJsonBody(req);
    const threadId = decodeURIComponent(threadResume[1]);
    const result = await bridge.call("thread/resume", { threadId, ...buildThreadParams(body, config.cwd) });
    sendJson(res, 200, result);
    return;
  }

  const threadSend = url.pathname.match(/^\/api\/thread\/([^/]+)\/send$/);
  if (req.method === "POST" && threadSend) {
    const body = await readJsonBody(req);
    const threadId = decodeURIComponent(threadSend[1]);
    const result = await startTurnOrResume(bridge, threadId, body);
    sendJson(res, 200, result);
    return;
  }

  const threadInterrupt = url.pathname.match(/^\/api\/thread\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && threadInterrupt) {
    const body = await readJsonBody(req).catch(() => ({}));
    const threadId = decodeURIComponent(threadInterrupt[1]);
    const turnId = body.turnId || bridge.getLatestTurnId(threadId);
    if (!turnId) {
      sendJson(res, 400, { error: "No active turn is known for this thread." });
      return;
    }
    const result = await bridge.call("turn/interrupt", { threadId, turnId });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/approvals") {
    sendJson(res, 200, { data: bridge.listServerRequests() });
    return;
  }

  const approval = url.pathname.match(/^\/api\/approval\/([^/]+)$/);
  if (req.method === "POST" && approval) {
    const requestId = decodeURIComponent(approval[1]);
    const request = bridge.getServerRequest(requestId);
    if (!request) {
      sendJson(res, 404, { error: "Approval request not found." });
      return;
    }
    const body = await readJsonBody(req);
    const response = buildApprovalResponse(request, body);
    if (response.error) {
      bridge.rejectServerRequest(requestId, response.error.code, response.error.message);
    } else {
      bridge.respond(requestId, response.result);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

function serveLocalImage(req, res, url) {
  const imagePath = url.searchParams.get("path") || "";
  const filePath = resolveLocalImagePath(imagePath);
  if (!filePath) {
    sendJson(res, 400, { error: "A valid absolute image path is required." });
    return;
  }

  const type = localImageContentType(filePath);
  if (!type) {
    sendJson(res, 415, { error: "Only raster image files can be previewed." });
    return;
  }

  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    sendJson(res, 404, { error: "Image file was not found." });
    return;
  }

  if (!stats.isFile()) {
    sendJson(res, 404, { error: "Image file was not found." });
    return;
  }

  res.writeHead(200, {
    "content-type": type,
    "content-length": stats.size,
    "cache-control": "private, max-age=60"
  });
  createReadStream(filePath).pipe(res);
}

function resolveLocalImagePath(imagePath) {
  const trimmed = String(imagePath || "").trim();
  if (!trimmed || !isAbsolute(trimmed)) return "";
  return resolve(trimmed);
}

function localImageContentType(filePath) {
  return LOCAL_IMAGE_MIME_TYPES[extname(filePath).toLowerCase()] || "";
}

function buildThreadParams(body, defaultCwd) {
  const params = {
    cwd: body.cwd || defaultCwd,
    approvalPolicy: body.approvalPolicy || "on-request",
    approvalsReviewer: body.approvalsReviewer || "user",
    sandbox: body.sandbox || "workspace-write",
    threadSource: "user"
  };

  if (body.model) params.model = body.model;
  if (body.modelProvider) params.modelProvider = body.modelProvider;
  if (body.developerInstructions) params.developerInstructions = body.developerInstructions;
  if (body.baseInstructions) params.baseInstructions = body.baseInstructions;
  if (body.serviceTier) params.serviceTier = body.serviceTier;
  return params;
}

async function readThreadOrResume(bridge, threadId) {
  try {
    return await bridge.call("thread/read", { threadId, includeTurns: true });
  } catch (error) {
    if (!isThreadNotFound(error)) throw error;
    return bridge.call("thread/resume", { threadId });
  }
}

async function startTurnOrResume(bridge, threadId, body) {
  const turnParams = buildTurnParams(threadId, body);
  try {
    return await bridge.call("turn/start", turnParams);
  } catch (error) {
    if (!isThreadNotFound(error)) throw error;
    await bridge.call("thread/resume", { threadId });
    return bridge.call("turn/start", turnParams);
  }
}

function isThreadNotFound(error) {
  return /thread not found/i.test(error?.message || String(error));
}

function buildTurnParams(threadId, body) {
  const input = [];
  const text = String(body.text || "").trim();
  if (text) {
    input.push({ type: "text", text, text_elements: [] });
  }
  for (const image of body.images || []) {
    if (image?.url) {
      input.push({ type: "image", url: image.url });
    }
  }
  for (const path of body.localImages || []) {
    if (path) {
      input.push({ type: "localImage", path });
    }
  }

  if (input.length === 0) {
    throw new Error("Message text or image input is required.");
  }

  const params = { threadId, input };
  if (body.cwd) params.cwd = body.cwd;
  if (body.model) params.model = body.model;
  if (body.approvalPolicy) params.approvalPolicy = body.approvalPolicy;
  if (body.approvalsReviewer) params.approvalsReviewer = body.approvalsReviewer;
  if (body.effort) params.effort = body.effort;
  if (body.summary) params.summary = body.summary;
  if (body.serviceTier) params.serviceTier = body.serviceTier;
  return params;
}

function hasInput(body) {
  return Boolean(String(body.text || "").trim()) || (body.images || []).length > 0 || (body.localImages || []).length > 0;
}

function buildApprovalResponse(request, body) {
  const decision = body.decision || "decline";
  const method = request.method;

  if (method === "item/commandExecution/requestApproval") {
    return { result: { decision } };
  }

  if (method === "item/fileChange/requestApproval") {
    return { result: { decision } };
  }

  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { result: { decision: decision === "acceptForSession" ? "approved_for_session" : decision === "accept" ? "approved" : "denied" } };
  }

  if (method === "item/permissions/requestApproval") {
    if (decision === "accept" || decision === "acceptForSession") {
      return {
        result: {
          permissions: body.permissions || stripNulls(request.params.permissions || {}),
          scope: body.scope || (decision === "acceptForSession" ? "session" : "turn"),
          strictAutoReview: Boolean(body.strictAutoReview)
        }
      };
    }
    return { result: { permissions: {}, scope: "turn", strictAutoReview: false } };
  }

  if (method === "item/tool/requestUserInput") {
    return { result: { answers: body.answers || {} } };
  }

  if (method === "mcpServer/elicitation/request") {
    return {
      result: {
        action: decision === "accept" ? "accept" : decision === "cancel" ? "cancel" : "decline",
        content: body.content || null,
        _meta: body._meta || null
      }
    };
  }

  if (method === "item/tool/call") {
    return { error: { code: -32601, message: "Dynamic tool calls are not implemented by codex-remotecontrol." } };
  }

  return { error: { code: -32000, message: `Unsupported server request method: ${method}` } };
}

function stripNulls(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripNulls).filter((item) => item !== undefined);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const stripped = stripNulls(item);
    if (stripped !== undefined) out[key] = stripped;
  }
  return out;
}

function isAuthorized(req, url, token) {
  const queryToken = url.searchParams.get("token");
  const headerToken = req.headers["x-codex-remote-token"];
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  return [queryToken, headerToken, bearer].some((candidate) => candidate === token);
}

function sanitizePayload(payload, token) {
  try {
    return JSON.parse(redactToken(JSON.stringify(payload), token));
  } catch {
    return payload;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function serveStatic(req, res, url, staticRoot) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const requestedPath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(join(staticRoot, requestedPath));
  const root = resolve(staticRoot);
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

export const internals = {
  buildThreadParams,
  buildTurnParams,
  isThreadNotFound,
  buildApprovalResponse,
  stripNulls,
  isAuthorized,
  resolveLocalImagePath,
  localImageContentType
};
