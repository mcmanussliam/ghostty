import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

import type { Context, Plugin } from "../../sdk/dist/index.mjs";
import { parseStatus, truncate } from "./status.mjs";
import { RefreshQueue } from "./refresh-queue.mjs";
import type { RefreshJob } from "./refresh-queue.mjs";
export { parseStatus } from "./status.mjs";

interface Repository {
  context: Context;
  root: string | null;
  checkedAt: number;
}

const execute = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const { stdout } = await execute(
    "git",
    ["--no-optional-locks", "-C", cwd, ...args],
    {
      timeout: 2000,
      signal,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return stdout;
}

export default {
  async activate(api) {
    const contexts = new Map<string, Repository>();
    const dismissed = new Map<string, Set<string>>();
    const settings = api.plugin.settings;
    const options =
      settings && typeof settings === "object" && !Array.isArray(settings)
        ? settings
        : {};
    let disposed = false;
    const queue = new RefreshQueue(refresh, async (error) => {
      await api
        .log(error instanceof Error ? error.message : String(error))
        .catch(() => {});
    });
    await api.ui.panes.register({
      id: "changes",
      title: "Git Changes",
      entry: "view.html",
      width: 320,
      retainOnContextChange: true,
    });

    function current(context: Context): boolean {
      return (
        !disposed &&
        contexts.get(context.id)?.context.revision === context.revision
      );
    }

    async function refresh({
      context,
      reveal,
      rediscover,
      controller,
    }: RefreshJob): Promise<void> {
      const cached = contexts.get(context.id);
      if (!cached || !current(context)) return;
      let root =
        !rediscover && performance.now() - cached.checkedAt < 30_000
          ? cached.root
          : null;
      try {
        if (!context.cwd || !isAbsolute(context.cwd))
          throw new Error("No local directory");
        if (!root) {
          root = (
            await git(
              context.cwd,
              ["rev-parse", "--show-toplevel"],
              controller.signal,
            )
          ).replace(/\n$/, "");
          cached.checkedAt = performance.now();
        }
      } catch {
        if (!controller.signal.aborted && current(context)) {
          cached.root = null;
          await api.ui.statusBar.remove("branch", context.id, {
            revision: context.revision,
          });
          await api.ui.panes.close("changes", context.id, {
            revision: context.revision,
          });
        }
        return;
      }
      try {
        const status = parseStatus(
          await git(
            root,
            ["status", "--porcelain=v1", "-z", "--branch"],
            controller.signal,
          ),
        );
        if (!current(context)) return;
        cached.root = root;
        const result = await api.ui.statusBar.set({
          id: "branch",
          contextId: context.id,
          revision: context.revision,
          command: "show-changes",
          alignment: "left",
          text: truncate(
            `${status.branch} · ${status.total} change${status.total === 1 ? "" : "s"}`,
            512,
          ),
          tooltip: truncate(`Git status for ${root}`, 1024),
        });
        if (result.stale || !current(context)) return;
        if (reveal) dismissed.get(context.id)?.delete(root);
        const data = { root: truncate(root, 1024), ...status };
        if (dismissed.get(context.id)?.has(root)) {
          await api.ui.panes.close("changes", context.id, {
            revision: context.revision,
          });
        } else if (reveal || options.autoOpen !== false) {
          await api.ui.panes.open("changes", context.id, {
            reveal,
            revision: context.revision,
            data,
          });
        } else {
          await api.ui.panes.publish("changes", context.id, data, {
            revision: context.revision,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted && current(context)) {
          cached.root = null;
          await api.ui.panes.close("changes", context.id, {
            revision: context.revision,
          });
          await api.ui.statusBar.set({
            id: "branch",
            contextId: context.id,
            revision: context.revision,
            text: "Git status unavailable",
            tooltip: truncate(
              error instanceof Error ? error.message : String(error),
              1024,
            ),
            command: "show-changes",
          });
        }
      }
    }

    await api.commands.register({
      id: "show-changes",
      title: "Open Git Changes",
      run({ contextId }) {
        const context = contexts.get(contextId)?.context;
        if (context) queue.schedule(context, { reveal: true });
      },
    });
    api.on("context.changed", async ({ context }, next) => {
      contexts.set(context.id, { context, root: null, checkedAt: -Infinity });
      queue.schedule(context);
      return next();
    });
    api.on("context.closed", async ({ context }, next) => {
      contexts.delete(context.id);
      queue.cancel(context.id);
      dismissed.delete(context.id);
      return next();
    });
    api.on("shell.command.finished", async ({ context }, next) => {
      queue.schedule(context, { rediscover: true });
      return next();
    });
    api.on("ui.pane.close", async (event, next) => {
      // This is a real pre/post hook: native close is committed by next(), after
      // which we remember the user's choice for this repo in this window/tab.
      const root = contexts.get(event.contextId)?.root;
      const result = await next();
      if (event.reason === "person" && !result.stale && root) {
        const roots = dismissed.get(event.contextId) ?? new Set();
        roots.add(root);
        const oldest = roots.values().next().value;
        if (roots.size > 128 && oldest !== undefined) roots.delete(oldest);
        dismissed.set(event.contextId, roots);
      }
      return result;
    });
    api.on("ui.pane.message", async (event, next) => {
      if (
        event.payload &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload) &&
        event.payload.action === "refresh"
      ) {
        const context = contexts.get(event.contextId)?.context;
        if (context) queue.schedule(context, { rediscover: true });
      }
      return next();
    });

    // Polling is deliberately infrequent and configurable. Command completion and
    // cwd changes refresh immediately; polling also sees changes made by an editor.
    const interval =
      options.pollIntervalMs === 0
        ? null
        : setInterval(
            () => {
              for (const { context } of contexts.values())
                queue.schedule(context);
            },
            Math.max(4000, Number(options.pollIntervalMs) || 4000),
          );
    return () => {
      disposed = true;
      queue.stop();
      if (interval) clearInterval(interval);
    };
  },
} satisfies Plugin;
