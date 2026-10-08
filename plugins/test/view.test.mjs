import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

class Element {
  children = [];
  hidden = false;
  textContent = "";
  dataset = {};
  listeners = new Map();
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(fragment) {
    this.children = [...fragment.children];
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
}
class Button extends Element {
  disabled = false;
}

// Keep the DOM fixture small; the runtime compiler checks real browser types.
async function view() {
  const ids = [
    "repository",
    "files",
    "refresh",
    "empty",
    "count",
    "summary",
    "branch",
    "root",
  ];
  const elements = new Map(
    ids.map((id) => [id, id === "refresh" ? new Button() : new Element()]),
  );
  const sent = [];
  let render;
  const source = await readFile(
    new URL("../examples/git-status/dist/view.js", import.meta.url),
    "utf8",
  );
  runInNewContext(source, {
    HTMLButtonElement: Button,
    document: {
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
    sent,
    render: (data) => render({ data }),
  };
}

test("compiled Git pane renders safe filenames, reuses rows, and sends refresh", async () => {
  const pane = await view();
  pane.render(null);
  assert.equal(pane.element("refresh").disabled, true);
  const data = {
    root: "/repo",
    branch: "main",
    total: 1,
    files: [{ status: "??", path: "dir/界👻<script>.txt" }],
  };
  pane.render(data);
  assert.equal(pane.element("count").textContent, "1");
  assert.equal(pane.element("refresh").disabled, false);
  const row = pane.element("files").children[0];
  assert.equal(row.children[0].textContent, "U");
  assert.equal(row.children[1].children[0].textContent, "界👻<script>.txt");
  pane.render({ ...data, branch: "next" });
  assert.equal(pane.element("files").children[0], row);
  assert.equal(pane.element("branch").textContent, "next");
  pane.element("refresh").listeners.get("click")();
  assert.equal(pane.sent[0].action, "refresh");
  pane.render({ ...data, files: [{ status: "M", path: null }] });
  assert.equal(pane.element("files").hidden, true);
  pane.render({ root: "/repo", branch: "main", total: 0, files: [] });
  assert.equal(pane.element("empty").hidden, false);
});

test("Git HTML references the compiled local script", async () => {
  const html = await readFile(
    new URL("../examples/git-status/view.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /<script src="dist\/view\.js"><\/script>/);
  assert.match(html, /script-src 'self'/);
});
