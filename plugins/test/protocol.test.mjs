import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  boundedJSON,
  containedFile,
  lineDecoder,
  loadConfiguration,
  loadManifest,
  MAX_BYTES,
  workerMessage,
  parentMessage,
} from "../dist/host/protocol.mjs";
import { directory, fixture, nodeExecutable } from "./helpers.mjs";

test("JSONL preserves fragmented Unicode and multiple messages", () => {
  const messages = [],
    errors = [];
  const decode = lineDecoder(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  const bytes = Buffer.from('{"text":"👻 日本語"}\n{"value":2}\n');
  for (const byte of bytes) decode(Buffer.from([byte]));
  assert.deepEqual(messages, [{ text: "👻 日本語" }, { value: 2 }]);
  assert.equal(errors.length, 0);
});

test("IPC validates message headers and context shapes before dispatch", () => {
  assert.throws(() => workerMessage(null), /object/);
  assert.throws(
    () =>
      workerMessage({
        type: "call",
        id: "one",
        method: "context.list",
        args: {},
      }),
    /number/,
  );
  assert.throws(() => workerMessage({ type: "surprise" }), /Unknown worker/);
  assert.throws(
    () =>
      parentMessage({
        type: "event",
        id: 1,
        name: "context.changed",
        event: { context: null },
      }),
    /object/,
  );
  assert.throws(
    () =>
      parentMessage({
        type: "event",
        id: 1,
        name: "ui.pane.close",
        event: { id: "pane", contextId: "window", revision: -1 },
      }),
    /revision/,
  );
  assert.deepEqual(
    parentMessage({
      type: "event",
      id: 2,
      name: "ui.pane.close",
      event: { id: "pane", contextId: "window", revision: 3 },
    }).event,
    { id: "pane", contextId: "window", revision: 3, reason: "person" },
  );
});

test("oversized unterminated frames stop decoding without growth", () => {
  let calls = 0;
  const decode = lineDecoder(
    () => assert.fail("Frame should not decode"),
    () => calls++,
  );
  decode(Buffer.alloc(MAX_BYTES + 1, 97));
  decode(Buffer.from("{}\n"));
  assert.equal(calls, 1);
  assert.throws(() => boundedJSON("x".repeat(MAX_BYTES)), /limit/);
});

test("manifest validation rejects traversal, symlink escapes, API mismatch, duplicate IDs", async (t) => {
  const root = await directory(t);
  const plugin = await fixture(
    root,
    "valid",
    "export default { activate() {} }",
  );
  assert.equal((await loadManifest(plugin.path)).manifest.id, "valid");
  await writeFile(resolve(root, "outside.mjs"), "export default {}");
  await symlink(
    resolve(root, "outside.mjs"),
    resolve(plugin.path, "escape.mjs"),
  );
  await assert.rejects(containedFile(plugin.path, "../outside.mjs"), /escapes/);
  await assert.rejects(containedFile(plugin.path, "escape.mjs"), /escapes/);
  const config = resolve(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      nodePath: nodeExecutable,
      plugins: [plugin, plugin],
    }),
  );
  await assert.rejects(loadConfiguration(config), /Duplicate/);
  await writeFile(
    resolve(plugin.path, "plugin.json"),
    JSON.stringify({
      id: "valid",
      name: "Valid",
      version: "1",
      apiVersion: 99,
      main: "index.mjs",
    }),
  );
  await assert.rejects(loadManifest(plugin.path), /API version/);
});
