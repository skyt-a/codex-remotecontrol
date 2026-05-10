import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const JSON_RPC = "2.0";

export class CodexBridge extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.proc = null;
    this.ws = null;
    this.connecting = null;
    this.initialized = false;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.latestTurns = new Map();
    this.state = "offline";
    this.lastError = null;
  }

  getStatus() {
    return {
      state: this.state,
      initialized: this.initialized,
      codexWsUrl: this.options.codexWsUrl,
      pid: this.proc?.pid || null,
      pendingRequests: this.pending.size,
      pendingApprovals: this.serverRequests.size,
      activeTurns: [...this.latestTurns.entries()].map(([threadId, turnId]) => ({ threadId, turnId })),
      lastError: this.lastError
    };
  }

  async start() {
    if (this.options.skipCodex) {
      this.state = "skipped";
      this.emitBridge("status", this.getStatus());
      return;
    }

    this.ensureProcess();
    await this.ensureConnected();
  }

  ensureProcess() {
    if (this.proc || this.options.externalCodex) return;

    const args = ["app-server", "--listen", this.options.codexWsUrl];
    this.proc = spawn(this.options.codexBin, args, {
      cwd: this.options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.state = "starting";
    this.emitBridge("log", { level: "info", message: `starting ${this.options.codexBin} ${args.join(" ")}` });

    this.proc.stdout.on("data", (chunk) => {
      this.emitBridge("log", { level: "debug", message: chunk.toString() });
    });

    this.proc.stderr.on("data", (chunk) => {
      this.emitBridge("log", { level: "debug", message: chunk.toString() });
    });

    this.proc.on("exit", (code, signal) => {
      this.emitBridge("log", { level: code === 0 ? "info" : "warn", message: `codex app-server exited (${code ?? signal})` });
      this.proc = null;
      this.initialized = false;
      if (this.state !== "stopping") {
        this.state = "offline";
      }
      this.emitBridge("status", this.getStatus());
    });
  }

  async ensureConnected() {
    if (this.options.skipCodex) {
      throw new Error("Codex app-server is disabled by CODEX_REMOTE_SKIP_CODEX=1.");
    }

    if (this.ws?.readyState === WebSocket.OPEN && this.initialized) {
      return;
    }

    if (this.connecting) return this.connecting;

    this.connecting = this.connectWithRetry()
      .finally(() => {
        this.connecting = null;
      });

    return this.connecting;
  }

  async connectWithRetry() {
    let lastError;
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      try {
        await this.openWebSocket();
        await this.initialize();
        this.state = "online";
        this.lastError = null;
        this.emitBridge("status", this.getStatus());
        return;
      } catch (error) {
        lastError = error;
        await delay(Math.min(2000, 150 + attempt * 75));
      }
    }

    this.lastError = lastError?.message || String(lastError);
    this.state = "offline";
    this.emitBridge("status", this.getStatus());
    throw lastError;
  }

  openWebSocket() {
    return new Promise((resolve, reject) => {
      this.state = "connecting";
      const ws = new WebSocket(this.options.codexWsUrl);
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // Ignore close errors during setup.
          }
          reject(new Error(`Timed out connecting to ${this.options.codexWsUrl}`));
        }
      }, 3000);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.ws = ws;
        this.installSocketHandlers(ws);
        resolve();
      }, { once: true });

      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Unable to connect to ${this.options.codexWsUrl}`));
      }, { once: true });
    });
  }

  installSocketHandlers(ws) {
    ws.addEventListener("message", (event) => {
      const data = event.data instanceof ArrayBuffer
        ? Buffer.from(event.data).toString("utf8")
        : String(event.data);
      this.handleMessage(data);
    });

    ws.addEventListener("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        this.initialized = false;
        this.state = this.state === "stopping" ? "stopping" : "offline";
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Codex app-server connection closed."));
          this.pending.delete(id);
        }
        this.emitBridge("status", this.getStatus());
      }
    });

    ws.addEventListener("error", () => {
      this.lastError = "Codex app-server websocket error.";
      this.emitBridge("status", this.getStatus());
    });
  }

  async initialize() {
    if (this.initialized) return;

    await this.callRaw("initialize", {
      clientInfo: {
        name: "codex-remotecontrol",
        title: "Codex RemoteControl",
        version: this.options.version || "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: []
      }
    });

    this.notify("initialized");
    this.initialized = true;
  }

  async call(method, params = {}) {
    await this.ensureConnected();
    return this.callRaw(method, params);
  }

  callRaw(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server websocket is not open."));
    }

    const id = this.nextId++;
    const message = {
      jsonrpc: JSON_RPC,
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, 120_000);

      this.pending.set(id, { resolve, reject, timeout, method });
      this.ws.send(JSON.stringify(message));
    });
  }

  notify(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message = params === undefined
      ? { jsonrpc: JSON_RPC, method }
      : { jsonrpc: JSON_RPC, method, params };
    this.ws.send(JSON.stringify(message));
  }

  respond(id, result) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not open.");
    }

    this.serverRequests.delete(String(id));
    this.ws.send(JSON.stringify({ jsonrpc: JSON_RPC, id, result }));
    this.emitBridge("approvalResolved", { id, result });
    this.emitBridge("status", this.getStatus());
  }

  rejectServerRequest(id, code = -32000, message = "Request declined by remote client.") {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not open.");
    }

    this.serverRequests.delete(String(id));
    this.ws.send(JSON.stringify({ jsonrpc: JSON_RPC, id, error: { code, message } }));
    this.emitBridge("approvalResolved", { id, error: { code, message } });
    this.emitBridge("status", this.getStatus());
  }

  getServerRequest(id) {
    return this.serverRequests.get(String(id));
  }

  listServerRequests() {
    return [...this.serverRequests.values()];
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.emitBridge("log", { level: "warn", message: `non-json message from codex: ${data}` });
      return;
    }

    if (message.id !== undefined && message.method) {
      const request = {
        id: String(message.id),
        method: message.method,
        params: message.params || {},
        receivedAt: Date.now()
      };
      this.serverRequests.set(request.id, request);
      this.emitBridge("approval", request);
      this.emitBridge("status", this.getStatus());
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.rememberNotification(message);
      this.emitBridge("notification", {
        method: message.method,
        params: message.params || {},
        receivedAt: Date.now()
      });
    }
  }

  rememberNotification(message) {
    const params = message.params || {};
    const threadId = notificationThreadId(message);
    const turnId = params.turn?.id || params.turnId || null;

    if (message.method === "turn/started" && threadId && turnId) {
      this.latestTurns.set(threadId, turnId);
    }
    if (message.method === "turn/completed") {
      if (threadId) {
        this.latestTurns.delete(threadId);
      } else if (turnId) {
        for (const [activeThreadId, activeTurnId] of this.latestTurns) {
          if (activeTurnId === turnId) this.latestTurns.delete(activeThreadId);
        }
      }
    }
  }

  getLatestTurnId(threadId) {
    return this.latestTurns.get(threadId) || null;
  }

  emitBridge(type, payload) {
    this.emit("event", { type, payload, at: Date.now() });
  }

  async stop() {
    this.state = "stopping";
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.emitBridge("status", this.getStatus());
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notificationThreadId(message) {
  const params = message.params || {};
  return params.threadId
    || params.thread?.id
    || params.turn?.threadId
    || params.item?.threadId
    || null;
}
