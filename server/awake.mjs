import { spawn } from "node:child_process";

const CAFFEINATE_ARGS = ["-ims"];

export class AwakeController {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.spawnFn = options.spawnFn || spawn;
    this.proc = null;
    this.lastError = null;
  }

  get supported() {
    return this.platform === "darwin";
  }

  get enabled() {
    return Boolean(this.proc && !this.proc.killed);
  }

  getStatus() {
    return {
      supported: this.supported,
      enabled: this.enabled,
      pid: this.proc?.pid || null,
      command: this.supported ? `caffeinate ${CAFFEINATE_ARGS.join(" ")}` : null,
      lastError: this.lastError
    };
  }

  start() {
    if (this.enabled) return this.getStatus();
    if (!this.supported) {
      this.lastError = "Keep Awake requires macOS.";
      throw new Error(this.lastError);
    }

    const child = this.spawnFn("caffeinate", CAFFEINATE_ARGS, {
      stdio: "ignore"
    });
    this.proc = child;
    this.lastError = null;

    child.once("error", (error) => {
      if (this.proc === child) this.proc = null;
      this.lastError = error.message || String(error);
    });

    child.once("exit", (code, signal) => {
      if (this.proc === child) this.proc = null;
      if (code && code !== 0) this.lastError = `caffeinate exited (${code ?? signal})`;
    });

    return this.getStatus();
  }

  stop() {
    if (this.proc) {
      const child = this.proc;
      this.proc = null;
      child.kill("SIGTERM");
    }
    return this.getStatus();
  }
}

export function createDisabledAwakeController() {
  return {
    getStatus() {
      return {
        supported: false,
        enabled: false,
        pid: null,
        command: null,
        lastError: null
      };
    },
    start() {
      throw new Error("Keep Awake is not configured.");
    },
    stop() {
      return this.getStatus();
    }
  };
}
