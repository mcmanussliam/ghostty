import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStatus } from "../examples/git-status/dist/index.mjs";
import { directory, host, nodeExecutable } from "./helpers.mjs";

const gitPlugin = fileURLToPath(
  new URL("../examples/git-status", import.meta.url),
);

function initRepository(path) {
  execFileSync("git", ["init", "--initial-branch=main", path], {
    stdio: "ignore",
  });
}

function commandFinished(app, contextId = "window-a") {
  app.send({
    type: "shell.command.finished",
    contextId,
    exitCode: 0,
    durationMs: 1,
  });
}

test("Git porcelain parser handles renames, Unicode, whitespace, and bounded display", () => {
  const status = parseStatus(
    "## main\0R  new name👻\0old name\0 M line\nbreak\0?? untracked\0",
  );
  assert.equal(status.branch, "main");
  assert.equal(status.total, 3);
  assert.deepEqual(status.files[0], { status: "R ", path: "new name👻" });
  assert.equal(status.files[1].path, "line\nbreak");
  const many = parseStatus("## main\0" + "?? file\0".repeat(100));
  assert.equal(many.total, 100);
  assert.equal(many.files.length, 50);
  const unicode = parseStatus(
    "## " +
      "日本語👻".repeat(100) +
      "\0" +
      ("?? " + "界👻".repeat(100) + "\0").repeat(100),
  );
  assert.equal(unicode.total, 100);
  assert.ok(Buffer.byteLength(unicode.branch) <= 256);
  assert.ok(unicode.files.every((file) => Buffer.byteLength(file.path) <= 200));
  assert.ok(!JSON.stringify(unicode).includes("�"));
  const escaped = parseStatus(
    "## " +
      "\u0001".repeat(256) +
      "\0" +
      ("?? " + "\u0001".repeat(200) + "\0").repeat(100),
  );
  const data = { root: "\u0001".repeat(1024), ...escaped };
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 16 * 1024);
  assert.equal(escaped.total, 100);
});

test("Git example auto-opens a real repo, honors manual close, follows cwd, and reopens on click", async (t) => {
  const root = await directory(t);
  const repo = resolve(root, "repository");
  const outside = resolve(root, "outside");
  await mkdir(repo);
  await mkdir(outside);
  execFileSync("git", ["init", "--initial-branch=main", repo], {
    stdio: "ignore",
  });
  await writeFile(resolve(repo, "hello.txt"), "hello");
  const app = await host(t, root, [
    {
      path: fileURLToPath(new URL("../examples/git-status", import.meta.url)),
      settings: { pollIntervalMs: 0 },
    },
  ]);
  app.context("window-a", repo);
  const status = await app.wait((m) => m.panes?.[0]?.data?.total === 1);
  assert.match(status.statuses[0].text, /1 change/);
  const mark = app.messages.length;
  app.send({
    type: "ui.pane.close",
    pluginId: "git-status",
    id: "changes",
    contextId: "window-a",
  });
  await app.wait(
    (m) => m.panes?.length === 0 && m.statuses?.length === 1,
    mark,
  );
  await writeFile(resolve(repo, "second.txt"), "second");
  app.send({
    type: "shell.command.finished",
    contextId: "window-a",
    exitCode: 0,
    durationMs: 10,
  });
  await app.wait(
    (m) =>
      m.panes?.length === 0 && /2 changes/.test(m.statuses?.[0]?.text ?? ""),
    mark,
  );
  app.send({
    type: "ui.status.press",
    pluginId: "git-status",
    id: "branch",
    contextId: "window-a",
  });
  await app.wait((m) => m.panes?.[0]?.data?.total === 2, mark);
  const subdirectory = resolve(repo, "nested");
  await mkdir(subdirectory);
  const transitionMark = app.messages.length;
  app.context("window-a", subdirectory, 2);
  await app.wait(
    (m) => m.contextRevision === 2 && m.panes?.[0]?.data?.total === 2,
    transitionMark,
  );
  assert.ok(
    app.messages
      .slice(transitionMark)
      .filter((m) => m.type === "snapshot")
      .every((m) => m.panes.length === 1),
  );
  assert.ok(
    app.messages
      .filter((m) => m.panes?.length && !m.panes[0].loading)
      .every((m) => m.panes[0].data !== null),
  );
  const secondMark = app.messages.length;
  app.context("window-a", outside, 3);
  await app.wait(
    (m) =>
      m.contextRevision === 3 &&
      m.statuses?.length === 0 &&
      m.panes?.length === 0,
    secondMark,
  );
});

test("Git command bursts coalesce and revalidate the repository root", async (t) => {
  const root = await directory(t);
  const bin = resolve(root, "bin");
  const log = resolve(root, "calls.jsonl");
  await mkdir(bin);
  await writeFile(
    resolve(bin, "git"),
    `#!${nodeExecutable}
import {appendFileSync} from 'node:fs';
const kind = process.argv.includes('rev-parse') ? 'root' : 'status';
const log = process.env.GHOSTTY_TEST_GIT_LOG;
appendFileSync(log,JSON.stringify({kind,pid:process.pid,phase:'start'})+'\\n');
setTimeout(() => {
  process.stdout.write(kind === 'root' ? process.env.GHOSTTY_TEST_GIT_ROOT+'\\n' : '## main\\0?? file\\0');
  appendFileSync(log,JSON.stringify({kind,pid:process.pid,phase:'end'})+'\\n');
},250);
`,
    { mode: 0o755 },
  );
  const app = await host(
    t,
    root,
    [
      {
        path: fileURLToPath(new URL("../examples/git-status", import.meta.url)),
        settings: { pollIntervalMs: 0 },
      },
    ],
    {
      PATH: `${bin}:${process.env.PATH}`,
      GHOSTTY_TEST_GIT_LOG: log,
      GHOSTTY_TEST_GIT_ROOT: root,
    },
  );
  async function callsUntil(predicate) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const calls = (await readFile(log, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      if (predicate(calls)) return calls;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Git calls did not settle");
  }
  app.context();
  await callsUntil((calls) => calls.length > 0);
  for (let i = 0; i < 20; i++)
    app.send({
      type: "shell.command.finished",
      contextId: "window-a",
      exitCode: 0,
      durationMs: 1,
    });
  await app.wait((m) => m.panes?.[0]?.data?.total === 1);
  const calls = await callsUntil(
    (calls) => calls.filter((call) => call.phase === "end").length >= 4,
  );
  assert.equal(
    calls.filter((call) => call.phase === "start" && call.kind === "root")
      .length,
    2,
  );
  assert.equal(calls.filter((call) => call.phase === "start").length, 4);
  let active = 0;
  for (const call of calls) {
    active += call.phase === "start" ? 1 : -1;
    assert.ok(active <= 1, "Git queries must not overlap in one context");
  }
  assert.equal(active, 0);
  assert.ok(!app.messages.some((m) => m.type === "error"));
});

test("Git dismissal survives visiting another repository and explicit reopening", async (t) => {
  const root = await directory(t);
  const first = resolve(root, "first");
  const second = resolve(root, "second");
  await mkdir(first);
  await mkdir(second);
  initRepository(first);
  initRepository(second);
  const app = await host(t, root, [
    { path: gitPlugin, settings: { pollIntervalMs: 0 } },
  ]);
  app.context("window-a", first);
  await app.wait((m) => m.panes?.[0]?.data?.root === first);
  let mark = app.messages.length;
  app.send({
    type: "ui.pane.close",
    pluginId: "git-status",
    id: "changes",
    contextId: "window-a",
  });
  await app.wait((m) => m.panes?.length === 0, mark);
  mark = app.messages.length;
  app.context("window-a", second, 2);
  await app.wait((m) => m.panes?.[0]?.data?.root === second, mark);
  mark = app.messages.length;
  app.context("window-a", first, 3);
  await app.wait(
    (m) =>
      m.contextRevision === 3 &&
      m.statuses?.length === 1 &&
      m.panes?.length === 0,
    mark,
  );
  app.send({
    type: "ui.status.press",
    pluginId: "git-status",
    id: "branch",
    contextId: "window-a",
  });
  await app.wait(
    (m) => m.contextRevision === 3 && m.panes?.[0]?.data?.root === first,
    mark,
  );
  assert.ok(!app.messages.some((m) => m.type === "error"));
});

test("Git discovers nested initialization and metadata removal without a cwd change", async (t) => {
  const root = await directory(t);
  const outer = resolve(root, "outer");
  const inner = resolve(outer, "inner");
  await mkdir(inner, { recursive: true });
  initRepository(outer);
  const app = await host(t, root, [
    { path: gitPlugin, settings: { pollIntervalMs: 0 } },
  ]);
  app.context("window-a", inner);
  await app.wait((m) => m.panes?.[0]?.data?.root === outer);
  initRepository(inner);
  await writeFile(resolve(inner, "file.txt"), "hello");
  let mark = app.messages.length;
  commandFinished(app);
  await app.wait(
    (m) => m.panes?.[0]?.data?.root === inner && m.panes[0].data.total === 1,
    mark,
  );
  await rm(resolve(inner, ".git"), { recursive: true });
  mark = app.messages.length;
  commandFinished(app);
  await app.wait((m) => m.panes?.[0]?.data?.root === outer, mark);
  await rm(resolve(outer, ".git"), { recursive: true });
  mark = app.messages.length;
  commandFinished(app);
  await app.wait(
    (m) => m.panes?.length === 0 && m.statuses?.length === 0,
    mark,
  );
  initRepository(inner);
  mark = app.messages.length;
  commandFinished(app);
  await app.wait((m) => m.panes?.[0]?.data?.root === inner, mark);
  assert.ok(!app.messages.some((m) => m.type === "error"));
});

test("Git refresh keeps a manually opened pane updated with autoOpen disabled", async (t) => {
  const root = await directory(t);
  const repo = resolve(root, "repository");
  await mkdir(repo);
  initRepository(repo);
  const app = await host(t, root, [
    { path: gitPlugin, settings: { autoOpen: false, pollIntervalMs: 0 } },
  ]);
  app.context("window-a", repo);
  const initial = await app.wait((m) => m.statuses?.length === 1);
  assert.equal(initial.panes.length, 0);
  app.send({
    type: "ui.status.press",
    pluginId: "git-status",
    id: "branch",
    contextId: "window-a",
  });
  await app.wait((m) => m.panes?.[0]?.data?.root === repo);
  await writeFile(resolve(repo, "file.txt"), "hello");
  const mark = app.messages.length;
  commandFinished(app);
  await app.wait((m) => m.panes?.[0]?.data?.total === 1, mark);
});

test("Git context replay and polling settle every tab without exceeding the API limit", async (t) => {
  const root = await directory(t);
  const repo = resolve(root, "repository");
  await mkdir(repo);
  initRepository(repo);
  const app = await host(t, root, [{ path: gitPlugin }]);
  const count = 40;
  for (let index = 0; index < count; index++) {
    app.context(`window-${index}`, repo, 1, `surface-${index}`);
  }
  const settled = new Set();
  function everyTab(total) {
    return (message) => {
      if (message.panes?.[0]?.data?.total === total)
        settled.add(message.contextId);
      return settled.size === count;
    };
  }
  await app.wait(everyTab(0));
  settled.clear();
  await writeFile(resolve(repo, "file.txt"), "hello");
  const mark = app.messages.length;
  await app.wait(everyTab(1), mark);
  assert.ok(!app.messages.some((m) => m.type === "error"));
});

test("Git startup supports the full 128-context limit", async (t) => {
  const root = await directory(t);
  const repo = resolve(root, "repository");
  await mkdir(repo);
  initRepository(repo);
  const app = await host(t, root, [
    { path: gitPlugin, settings: { pollIntervalMs: 0 } },
  ]);
  const settled = new Set();
  for (let index = 0; index < 128; index++)
    app.context(`window-${index}`, repo, 1, `surface-${index}`);
  await app.wait(
    (message) => {
      if (message.panes?.[0]?.data?.root === repo)
        settled.add(message.contextId);
      return settled.size === 128;
    },
    0,
    15000,
  );
  assert.ok(!app.messages.some((message) => message.type === "error"));
});
