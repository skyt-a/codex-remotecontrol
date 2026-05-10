import test from "node:test";
import assert from "node:assert/strict";
import { internals } from "../server/app.mjs";
import { CodexBridge } from "../server/codexBridge.mjs";
import { redactToken } from "../server/config.mjs";

test("buildTurnParams maps text and image inputs", () => {
  const params = internals.buildTurnParams("thread-1", {
    text: "hello",
    images: [{ url: "data:image/png;base64,abc" }],
    model: "gpt-5.1-codex",
    approvalPolicy: "on-request"
  });

  assert.equal(params.threadId, "thread-1");
  assert.equal(params.input.length, 2);
  assert.deepEqual(params.input[0], { type: "text", text: "hello", text_elements: [] });
  assert.equal(params.input[1].type, "image");
  assert.equal(params.model, "gpt-5.1-codex");
});

test("permission approval preserves requested primitive values", () => {
  const response = internals.buildApprovalResponse({
    method: "item/permissions/requestApproval",
    params: {
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/tmp"], write: null }
      }
    }
  }, { decision: "acceptForSession" });

  assert.equal(response.result.scope, "session");
  assert.deepEqual(response.result.permissions, {
    network: { enabled: true },
    fileSystem: { read: ["/tmp"] }
  });
});

test("token redaction removes repeated token values", () => {
  assert.equal(redactToken("abc secret abc secret", "secret"), "abc [token] abc [token]");
});

test("thread not found detection matches Codex app-server errors", () => {
  assert.equal(internals.isThreadNotFound(new Error("thread not found: 019e1186-ad47-7181-b9d3-7064a1e4e8f5")), true);
  assert.equal(internals.isThreadNotFound(new Error("model list failed")), false);
});

test("local image preview only accepts absolute raster image paths", () => {
  assert.equal(internals.resolveLocalImagePath("/tmp/example.png"), "/tmp/example.png");
  assert.equal(internals.resolveLocalImagePath("relative/example.png"), "");
  assert.equal(internals.localImageContentType("/tmp/example.png"), "image/png");
  assert.equal(internals.localImageContentType("/tmp/example.jpeg"), "image/jpeg");
  assert.equal(internals.localImageContentType("/tmp/example.svg"), "");
});

test("bridge status tracks active turns across notification shapes", () => {
  const bridge = new CodexBridge({ skipCodex: true, codexWsUrl: "ws://127.0.0.1:45213" });
  bridge.rememberNotification({
    method: "turn/started",
    params: { turn: { id: "turn-1", threadId: "thread-1" } }
  });

  assert.deepEqual(bridge.getStatus().activeTurns, [{ threadId: "thread-1", turnId: "turn-1" }]);

  bridge.rememberNotification({
    method: "turn/completed",
    params: { turnId: "turn-1" }
  });

  assert.deepEqual(bridge.getStatus().activeTurns, []);
});
