import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

export const VERSION = "0.1.0";

export function readToken(tokenFile = ".phone-token") {
  if (process.env.CODEX_REMOTE_TOKEN) {
    return process.env.CODEX_REMOTE_TOKEN.trim();
  }

  if (existsSync(tokenFile)) {
    return readFileSync(tokenFile, "utf8").trim();
  }

  const token = randomBytes(24).toString("base64url");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {
    // Best effort on platforms that do not support POSIX mode bits.
  }
  return token;
}

export function getRuntimeConfig() {
  const port = Number.parseInt(process.env.PORT || process.env.CODEX_REMOTE_PORT || "8787", 10);
  const host = process.env.HOST || process.env.CODEX_REMOTE_HOST || "0.0.0.0";
  const codexWsUrl = process.env.CODEX_APP_SERVER_WS || "ws://127.0.0.1:45213";
  const cwd = resolve(process.env.CODEX_REMOTE_CWD || process.cwd());

  return {
    port,
    host,
    codexWsUrl,
    cwd,
    codexBin: process.env.CODEX_BIN || "codex",
    skipCodex: process.env.CODEX_REMOTE_SKIP_CODEX === "1",
    token: readToken(),
    staticRoot: resolve("public")
  };
}

export function getLanUrls(port, token) {
  const urls = [`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`];
  const nets = networkInterfaces();

  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}/?token=${encodeURIComponent(token)}`);
      }
    }
  }

  return urls;
}

export function redactToken(text, token) {
  if (!token) return text;
  return String(text).split(token).join("[token]");
}
