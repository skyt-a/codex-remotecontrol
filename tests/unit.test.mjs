import test from "node:test";
import assert from "node:assert/strict";
import { internals } from "../server/app.mjs";
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
