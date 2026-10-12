import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lineDecoder } from "../dist/host/protocol.mjs";

// Some managed runtimes report "node" rather than an absolute process.execPath.
export const nodeExecutable = isAbsolute(process.execPath)
  ? process.execPath
  : (process.env.PATH ?? "")
      .split(delimiter)
      .map((path) => resolve(path, process.execPath))
      .find(existsSync);

export async function directory(t) {
  const parent = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function fixture(root, id, source, settings = {}) {
  const path = resolve(root, id);
  await mkdir(path);
  await writeFile(resolve(path, "index.mjs"), source);
  await writeFile(
    resolve(path, "view.html"),
    "<!doctype html><title>Test pane</title>",
  );
  await writeFile(
    resolve(path, "plugin.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1",
      apiVersion: 1,
      main: "index.mjs",
      capabilities: [
        "context",
        "commands",
        "shell.command.finished",
        "ui.statusBar",
        "ui.panes",
      ],
    }),
  );
  return { path, settings };
}

export async function host(t, root, plugins, environment = {}) {
  const config = resolve(root, "plugins.json");
  await writeFile(
    config,
    JSON.stringify({ version: 1, nodePath: nodeExecutable, plugins }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/host/supervisor.mjs", import.meta.url)),
      config,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_CEILING_DIRECTORIES: root, ...environment },
    },
  );
  const messages = [];
  const listeners = new Set();
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  child.stdout.on(
    "data",
    lineDecoder(
      (message) => {
        messages.push(message);
        for (const listener of listeners) listener();
      },
      (error) => {
        throw error;
      },
    ),
  );
  const exit = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exit;
    clearTimeout(timer);
  });
  function wait(predicate, after = 0, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `Expected host message; messages=${JSON.stringify(messages)} stderr=${stderr}`,
          ),
        );
      }, timeout);
      function check() {
        const match = messages.slice(after).find(predicate);
        if (match) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(match);
        }
      }
      listeners.add(check);
      check();
    });
  }
  await wait((message) => message.type === "ready");
  return {
    messages,
    wait,
    child,
    exit,
    send(message) {
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    context(
      id = "window-a",
      cwd = root,
      revision = 1,
      surfaceId = "surface-a",
    ) {
      child.stdin.write(
        JSON.stringify({
          type: "context",
          context: { id, cwd, revision, surfaceId },
        }) + "\n",
      );
    },
  };
}
