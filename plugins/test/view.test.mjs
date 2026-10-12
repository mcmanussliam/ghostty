import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { parseStatus } from "../examples/git-status/dist/status.mjs";

class Element {
  children = [];
  hidden = false;
  textContent = "";
  dataset = {};
  attributes = new Map();
  listeners = new Map();
  isConnected = true;
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(fragment) {
    this.children = [...fragment.children];
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  contains(element) {
    return (
      element === this || this.children.some((child) => child.contains(element))
    );
  }
}
class Button extends Element {
  disabled = false;
}
class Input extends Element {
  disabled = false;
  value = "";
}

function descendants(element, className) {
  return element.children.flatMap((child) => [
    ...(child.className === className ? [child] : []),
    ...descendants(child, className),
  ]);
}

// The fixture tests rendering decisions; native-check.swift exercises the real WebKit DOM and CSP.
async function view() {
  const ids = [
    "repository",
    "files",
    "refresh",
    "filter",
    "empty",
    "count",
    "summary",
    "branch",
    "root",
    "repository-name",
    "tracking",
    "error",
    "tree",
    "list",
  ];
  function control(id) {
    if (id === "filter") return new Input();
    if (["refresh", "tree", "list"].includes(id)) return new Button();
    return new Element();
  }
  const elements = new Map(ids.map((id) => [id, control(id)]));
  const sent = [];
  let render;
  const source = await readFile(
    new URL("../examples/git-status/dist/view.js", import.meta.url),
    "utf8",
  );
  runInNewContext(source, {
    HTMLButtonElement: Button,
    HTMLInputElement: Input,
    document: {
      activeElement: null,
      getElementById: (id) => elements.get(id),
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
    },
    window: {
      ghostty: {
        send: (data) => sent.push(data),
        onState: (handler) => {
          render = handler;
        },
      },
    },
  });
  return {
    element: (id) => elements.get(id),
    rows: (className) => descendants(elements.get("files"), className),
    sent,
    render: (data) => render({ data }),
    click: (id) => elements.get(id).listeners.get("click")(),
    filter: (query) => {
      elements.get("filter").value = query;
      elements.get("filter").listeners.get("input")();
    },
  };
}

function state(output = "## main\0", overrides = {}) {
  return { root: "/repo", ...parseStatus(output), ...overrides };
}

test("compiled Git pane renders safe filenames, reuses rows, and sends refresh", async () => {
  const pane = await view();
  pane.render(null);
  assert.equal(pane.element("refresh").disabled, true);
  const data = state("## main\0?? dir/界👻<script>.txt\0");
  pane.render(data);
  assert.equal(pane.element("count").textContent, "1 changed file");
  assert.equal(pane.element("refresh").disabled, false);
  const row = pane.rows("file")[0];
  assert.equal(pane.rows("status")[0].title, "Untracked");
  assert.equal(pane.element("root").textContent, "/repo");
  assert.equal(pane.rows("name")[0].textContent, "界👻<script>.txt");
  pane.render({ ...data, branch: "next" });
  assert.equal(pane.rows("file")[0], row);
  assert.equal(pane.element("branch").textContent, "next");
  pane.click("refresh");
  assert.equal(pane.sent[0].action, "refresh");
  pane.render({ ...data, files: [{ status: "M", path: null }] });
  assert.equal(pane.element("files").hidden, true);
  pane.render(state());
  assert.equal(pane.element("empty").hidden, false);
});

test("Git groups split mixed changes, prioritize conflicts, and show tracking", async () => {
  const pane = await view();
  pane.render(
    state(
      "## main...origin/main [ahead 2, behind 1]\0 M unstaged\0MM both\0UU conflict\0?? untracked\0",
    ),
  );
  assert.deepEqual(
    pane.rows("group-name").map((row) => row.textContent),
    ["Merge conflicts", "Staged changes", "Changes", "Untracked files"],
  );
  assert.deepEqual(
    pane.rows("group-count").map((row) => row.textContent),
    ["1", "1", "2", "1"],
  );
  assert.equal(
    pane.rows("name").filter((row) => row.textContent === "both").length,
    2,
  );
  assert.equal(pane.rows("status")[0].dataset.kind, "conflicts");
  assert.equal(pane.element("branch").textContent, "main");
  assert.equal(
    pane.element("tracking").textContent,
    "origin/main · 2 ahead · 1 behind",
  );
  assert.equal(pane.element("count").textContent, "4 changed files");
});

test("Git tree compacts folders, preserves disclosure state, and supports list filtering", async () => {
  const pane = await view();
  const data = state(
    "## main\0R  src/lib/new.txt\0src/lib/old.txt\0?? tests/new.test.ts\0",
  );
  pane.render(data);
  assert.equal(pane.rows("folder-name")[0].textContent, "src/lib");
  const folder = pane.rows("folder")[0];
  folder.open = false;
  folder.listeners.get("toggle")();
  pane.render({ ...data, total: 3 });
  assert.equal(pane.rows("folder")[0].open, false);
  assert.equal(
    pane.element("summary").textContent,
    "Showing 2 of 3 changed files",
  );
  pane.render({ ...data, total: 3, ahead: 1 });
  assert.equal(
    pane.element("summary").textContent,
    "Showing 2 of 3 changed files",
  );
  pane.click("list");
  assert.equal(pane.rows("folder").length, 0);
  assert.equal(pane.element("list").attributes.get("aria-pressed"), "true");
  assert.ok(
    pane
      .rows("detail-path")
      .some((row) => row.textContent === "From: src/lib/old.txt"),
  );
  pane.filter("old.txt");
  assert.equal(pane.rows("file").length, 1);
  pane.filter("missing");
  assert.equal(pane.element("empty").hidden, false);
  assert.equal(pane.element("empty").textContent, "No matching changed files");
  pane.render({ ...data, root: "/other" });
  assert.equal(pane.element("filter").value, "");
  assert.equal(pane.rows("file").length, 2);
});

test("Git pane distinguishes unavailable status from a clean working tree", async () => {
  const pane = await view();
  pane.render(state("", { error: "Permission denied" }));
  assert.equal(pane.element("error").hidden, false);
  assert.match(pane.element("error").textContent, /Permission denied/);
  assert.equal(pane.element("empty").hidden, true);
  assert.equal(pane.element("refresh").disabled, false);
  assert.equal(pane.element("filter").disabled, true);
  pane.render(state("## HEAD (no branch)\0"));
  assert.equal(pane.element("branch").textContent, "Detached HEAD");
  assert.equal(pane.element("error").hidden, true);
});

test("Git HTML references the compiled local script", async () => {
  const html = await readFile(
    new URL("../examples/git-status/view.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /<script src="dist\/view\.js"><\/script>/);
  assert.match(html, /script-src 'self'/);
});
