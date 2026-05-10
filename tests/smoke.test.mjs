import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRemoteControlServer } from "../server/app.mjs";

class FakeBridge extends EventEmitter {
  getStatus() {
    return {
      state: "test",
      initialized: false,
      codexWsUrl: "ws://127.0.0.1:45213",
      pid: null,
      pendingRequests: 0,
      pendingApprovals: 0,
      lastError: null
    };
  }

  listServerRequests() {
    return [];
  }
}

test("HTTP server protects APIs and serves static app", async (t) => {
  const token = "test-token";
  const bridge = new FakeBridge();
  const server = createRemoteControlServer({
    bridge,
    config: {
      token,
      cwd: process.cwd(),
      staticRoot: new URL("../public", import.meta.url).pathname
    }
  });

  const listened = await listen(server);
  if (!listened.ok) {
    t.skip(`local listen is unavailable: ${listened.error.code || listened.error.message}`);
    return;
  }
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;

  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);

  const denied = await fetch(`${base}/api/status`);
  assert.equal(denied.status, 403);

  const status = await fetch(`${base}/api/status?token=${token}`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).bridge.state, "test");

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Codex RemoteControl/);
});

function listen(server) {
  return new Promise((resolve) => {
    const onError = (error) => {
      server.off("listening", onListening);
      resolve({ ok: false, error });
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ ok: true });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}
