import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  boundedJSON,
  containedFile,
  HOOK_TIMEOUT_MS,
  identifier,
  lineDecoder,
  loadConfiguration,
  MAX_CONTEXTS,
  MAX_ITEMS,
  text,
  VERSION,
  errorMessage,
  record,
  number,
  sequence,
  jsonValue,
  workerMessage,
} from "./protocol.mjs";

import type { Context, JSONValue } from "../sdk/dist/index.mjs";
import type { LoadedPlugin } from "./protocol.mjs";
import type {
  Notification,
  HostEvents,
  HostMessage,
  HostStatus,
  OpenPane,
  ParentMessage,
  PluginState,
  QueuedEvent,
  Snapshot,
} from "./messages.mjs";

const apiCapabilities: ReadonlyMap<string, string> = new Map([
  ["context.list", "context"],
  ["command.register", "commands"],
  ["status.set", "ui.statusBar"],
  ["status.remove", "ui.statusBar"],
  ["pane.register", "ui.panes"],
  ["pane.open", "ui.panes"],
  ["pane.close", "ui.panes"],
  ["pane.publish", "ui.panes"],
]);

function paneData(value: unknown): JSONValue {
  const encoded = boundedJSON(value);
  if (Buffer.byteLength(encoded) > 16 * 1024)
    throw new Error("Pane data exceeds 16 KiB");
  return JSON.parse(encoded) as JSONValue;
}

export class Supervisor {
  readonly plugins = new Map<string, PluginState>();
  readonly contexts = new Map<string, Context>();
  private readonly dirty = new Set<string>();
  private sequence = 0;
  private stopping = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private rateTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  constructor(private readonly emit: (message: HostMessage) => void) {}

  async start(configuration: string): Promise<void> {
    this.rateTimer = setInterval(() => {
      for (const state of this.plugins.values()) state.apiCalls = 0;
    }, 1000);
    this.heartbeatTimer = setInterval(() => {
      for (const state of this.plugins.values()) {
        if (state.ready && !state.active) this.enqueue(state, "host.ping", {});
      }
    }, 5000);
    const plugins = await loadConfiguration(configuration);
    await Promise.all(plugins.map((plugin) => this.startPlugin(plugin)));
    this.emit({ type: "ready", version: VERSION });
  }

  private async startPlugin(plugin: LoadedPlugin): Promise<void> {
    const child = fork(
      fileURLToPath(new URL("./worker.mjs", import.meta.url)),
      [],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        execArgv: ["--max-old-space-size=128"],
        serialization: "json",
      },
    );
    const state: PluginState = {
      ...plugin,
      child,
      ready: false,
      failed: false,
      queue: [],
      active: null,
      statuses: new Map(),
      panes: new Map(),
      open: new Map(),
      dismissed: new Set(),
      commands: new Map(),
      apiCalls: 0,
    };
    this.plugins.set(plugin.manifest.id, state);
    // Plugins' console output never reaches the JSONL channel. Bound forwarding.
    let logBytes = 0;
    child.stderr?.on("data", (data: Buffer) => {
      if (logBytes < 16 * 1024)
        process.stderr.write(data.subarray(0, 16 * 1024 - logBytes));
      logBytes += data.length;
    });
    child.on("error", (error) => this.fail(state, error));
    child.on("exit", () => {
      if (!this.stopping && !state.failed)
        this.fail(state, new Error("Plugin process exited"));
    });
    await new Promise<void>((resolve) => {
      state.activationTimer = setTimeout(() => {
        this.fail(state, new Error("Plugin activation exceeded 5 seconds"));
        resolve();
      }, 5000);
      state.resolveActivation = resolve;
      child.on("message", (message) => this.receive(state, message));
      this.send(state, { type: "activate", plugin });
    });
  }

  private receive(state: PluginState, value: unknown): void {
    let message;
    try {
      message = workerMessage(value);
    } catch (error) {
      this.fail(state, error);
      return;
    }
    if (
      state.failed ||
      (this.stopping &&
        message.type !== "event.result" &&
        message.type !== "call")
    )
      return;
    try {
      boundedJSON(message);
      if (message.type === "ready") {
        clearTimeout(state.activationTimer);
        state.ready = true;
        state.resolveActivation?.();
        for (const context of this.contexts.values())
          this.enqueue(state, "context.changed", { context });
        this.pump(state);
      } else if (message.type === "fatal") {
        this.fail(state, new Error(message.error));
      } else if (
        message.type === "event.result" &&
        state.active?.id === message.id
      ) {
        clearTimeout(state.active.timer);
        state.active = null;
        if (message.error)
          this.emit({
            type: "log",
            pluginId: state.manifest.id,
            message: text(message.error),
          });
        this.pump(state);
      } else if (message.type === "call") {
        // A stuck interval issuing unbounded calls must not monopolize the supervisor.
        if (++state.apiCalls > 128)
          throw new Error("Plugin exceeded 128 API calls per second");
        void this.api(state, message.method, message.args).then(
          (value) => this.respond(state, message.id, { value }),
          (error) =>
            this.respond(state, message.id, {
              error: errorMessage(error).slice(0, 4096),
            }),
        );
      }
    } catch (error) {
      this.fail(state, error);
    }
  }

  private respond(
    state: PluginState,
    id: number,
    result: { value?: unknown; error?: string },
  ): void {
    if (!state.failed && state.child.connected) {
      const message: ParentMessage = { type: "result", id, ...result };
      try {
        boundedJSON(message);
        this.send(state, message);
      } catch (error) {
        this.fail(state, error);
      }
    }
  }

  private enqueue<K extends Notification["name"]>(
    state: PluginState,
    name: K,
    event: HostEvents[K],
  ): void {
    if (state.failed) return;
    // Coalesce context churn while an async handler is working. Discrete events stay ordered.
    if (name === "context.changed" && "context" in event) {
      const queued = state.queue.find(
        (item) =>
          item.name === "context.changed" &&
          item.event.context.id === event.context.id,
      );
      if (queued) {
        if (queued.name === "context.changed")
          queued.event = { context: event.context };
        return;
      }
    }
    let discrete = 0;
    if (name !== "context.changed") {
      for (const queued of state.queue)
        if (queued.name !== "context.changed") discrete++;
    }
    if (state.queue.length >= MAX_CONTEXTS + 64 || discrete >= 64) {
      this.fail(state, new Error("Plugin event queue overflow"));
      return;
    }
    state.queue.push({ id: ++this.sequence, name, event } as QueuedEvent);
    this.pump(state);
  }

  private pump(state: PluginState): void {
    if (!state.ready || state.failed || state.active) return;
    const event = state.queue.shift();
    if (!event) return;
    state.active = {
      ...event,
      timer: setTimeout(
        () =>
          this.fail(
            state,
            new Error(`${event.name} hook exceeded ${HOOK_TIMEOUT_MS}ms`),
          ),
        HOOK_TIMEOUT_MS,
      ),
    };
    this.send(state, { type: "event", ...event });
  }

  private fail(state: PluginState, error: unknown): void {
    if (state.failed) return;
    state.failed = true;
    clearTimeout(state.activationTimer);
    clearTimeout(state.active?.timer);
    state.resolveActivation?.();
    state.queue.length = 0;
    state.statuses.clear();
    state.open.clear();
    state.child.kill("SIGKILL");
    for (const id of this.contexts.keys()) this.changed(id);
    this.emit({
      type: "error",
      pluginId: state.manifest.id,
      message: errorMessage(error).slice(0, 4096),
    });
  }

  private send(state: PluginState, message: ParentMessage): void {
    try {
      boundedJSON(message);
      state.child.send(message, (error) => {
        if (error) this.fail(state, error);
      });
    } catch (error) {
      this.fail(state, error);
    }
  }

  private context(value: unknown): Context {
    const context = this.contexts.get(identifier(value));
    if (!context) throw new Error("Unknown or closed context");
    return context;
  }

  async api(
    state: PluginState,
    method: string,
    input: unknown,
  ): Promise<unknown> {
    boundedJSON(input);
    const args = record(input);
    const capability = apiCapabilities.get(method);
    if (capability && !state.manifest.capabilities.includes(capability))
      throw new Error(`Undeclared capability: ${capability}`);
    switch (method) {
      case "context.list":
        return [...this.contexts.values()];
      case "log":
        this.emit({
          type: "log",
          pluginId: state.manifest.id,
          message: text(args.message),
        });
        return {};
      case "command.register":
        return this.registerCommand(state, args);
      case "pane.register":
        return this.registerPane(state, args);
      case "status.set":
      case "status.remove":
      case "pane.open":
      case "pane.close":
      case "pane.publish":
        return this.updateUI(state, method, args);
      default:
        throw new Error("Unknown plugin API method");
    }
  }

  private registerCommand(
    state: PluginState,
    args: Record<string, unknown>,
  ): object {
    const id = identifier(args.id);
    let total = 0;
    for (const plugin of this.plugins.values()) total += plugin.commands.size;
    if (
      total >= 128 ||
      state.commands.size >= MAX_ITEMS ||
      state.commands.has(id)
    )
      throw new Error("Duplicate or excess command");
    state.commands.set(id, text(args.title, 128));
    for (const contextId of this.contexts.keys()) this.changed(contextId);
    return {};
  }

  private async registerPane(
    state: PluginState,
    args: Record<string, unknown>,
  ): Promise<object> {
    const id = identifier(args.id);
    if (state.panes.size >= 8 || state.panes.has(id))
      throw new Error("Duplicate or excess pane type");
    const entry = await containedFile(state.root, args.entry);
    if (!entry.endsWith(".html")) throw new Error("Pane entry must be HTML");
    const width = number(args.width ?? 320);
    if (width < 160 || width > 1200)
      throw new Error("Pane width must be 160–1200");
    if (
      args.retainOnContextChange !== undefined &&
      typeof args.retainOnContextChange !== "boolean"
    )
      throw new Error("retainOnContextChange must be a boolean");
    if (state.failed) throw new Error("Plugin stopped during registration");
    state.panes.set(id, {
      id,
      title: text(args.title, 128),
      entry,
      root: state.root,
      width,
      retainOnContextChange: args.retainOnContextChange === true,
    });
    return {};
  }

  private setStatus(
    state: PluginState,
    args: Record<string, unknown>,
    contextId: string,
    key: string,
  ): boolean {
    if (!state.statuses.has(key)) {
      let count = 0;
      for (const item of state.statuses.values())
        if (item.contextId === contextId) count++;
      if (count >= MAX_ITEMS || this.snapshot(contextId).statuses.length >= 32)
        throw new Error("Status item limit reached");
    }
    const alignment = args.alignment ?? "left";
    if (alignment !== "left" && alignment !== "center" && alignment !== "right")
      throw new Error("Invalid alignment");
    const command =
      args.command === undefined ? null : identifier(args.command);
    if (command !== null && !state.commands.has(command))
      throw new Error("Unknown status command");
    const item: HostStatus = {
      id: identifier(args.id),
      pluginId: state.manifest.id,
      contextId,
      text: text(args.text, 512),
      tooltip: text(args.tooltip ?? "", 1024),
      alignment,
      priority: number(args.priority ?? 0),
      command,
    };
    if (isDeepStrictEqual(state.statuses.get(key), item)) return false;
    state.statuses.set(key, item);
    return true;
  }

  private updateUI(
    state: PluginState,
    method: string,
    args: Record<string, unknown>,
  ): object {
    const id = identifier(args.id);
    const context = this.context(args.contextId);
    if (args.revision !== undefined && args.revision !== context.revision)
      return { stale: true };
    const key = `${context.id}/${id}`;
    switch (method) {
      case "status.set":
        if (!this.setStatus(state, args, context.id, key)) return {};
        break;
      case "status.remove":
        if (!state.statuses.delete(key)) return {};
        break;
      case "pane.open": {
        const pane = state.panes.get(id);
        if (!pane) throw new Error("Unknown pane type");
        const previous = state.open.get(key);
        const data =
          args.data === undefined
            ? (previous?.data ?? null)
            : paneData(args.data);
        if (state.dismissed.has(key) && args.reveal !== true)
          return { opened: false };
        if (!previous && this.snapshot(context.id).panes.length >= 4)
          throw new Error("At most four panes per context");
        state.dismissed.delete(key);
        const opened: OpenPane = {
          ...pane,
          pluginId: state.manifest.id,
          contextId: context.id,
          data,
          loading: false,
        };
        if (isDeepStrictEqual(previous, opened)) return {};
        state.open.set(key, opened);
        break;
      }
      case "pane.close":
        if (args.reason === "person") state.dismissed.add(key);
        if (!state.open.delete(key)) return {};
        break;
      case "pane.publish": {
        const data = paneData(args.data);
        const pane = state.open.get(key);
        if (!pane) return { published: false };
        if (!pane.loading && isDeepStrictEqual(pane.data, data)) return {};
        pane.data = data;
        pane.loading = false;
        break;
      }
    }
    this.changed(context.id, method === "pane.close");
    return {};
  }

  snapshot(contextId: string): Snapshot {
    const statuses: HostStatus[] = [];
    const panes: OpenPane[] = [];
    const commands: Snapshot["commands"] = [];
    for (const state of this.plugins.values()) {
      if (state.failed) continue;
      statuses.push(
        ...[...state.statuses.values()].filter(
          (item) => item.contextId === contextId,
        ),
      );
      panes.push(
        ...[...state.open.values()].filter(
          (item) => item.contextId === contextId,
        ),
      );
      commands.push(
        ...[...state.commands].map(([id, title]) => ({
          id,
          title,
          pluginId: state.manifest.id,
        })),
      );
    }
    statuses.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.pluginId.localeCompare(b.pluginId) ||
        a.id.localeCompare(b.id),
    );
    return {
      type: "snapshot",
      contextId,
      contextRevision: this.contexts.get(contextId)?.revision ?? 0,
      statuses,
      panes,
      commands,
    };
  }

  changed(contextId: string, immediate = false): void {
    // Once a pane closes, release its layout without another UI batching interval.
    if (immediate) {
      this.dirty.delete(contextId);
      this.emit(this.snapshot(contextId));
      return;
    }
    this.dirty.add(contextId);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      for (const id of this.dirty) this.emit(this.snapshot(id));
      this.dirty.clear();
    }, 33);
  }

  handle(input: unknown): void {
    if (this.stopping) return;
    boundedJSON(input);
    const message = record(input);
    switch (message.type) {
      case "context":
        this.setContext(record(message.context));
        return;
      case "context.close":
        this.closeContext(this.context(message.contextId));
        return;
      case "shell.command.finished": {
        const context = this.context(message.contextId);
        const exitCode =
          message.exitCode === null ? null : number(message.exitCode);
        const durationMs = number(message.durationMs);
        if (
          exitCode !== null &&
          (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
        )
          throw new Error("Invalid exit code");
        if (durationMs < 0) throw new Error("Invalid command duration");
        for (const state of this.plugins.values())
          this.enqueue(state, "shell.command.finished", {
            context,
            exitCode,
            durationMs,
          });
        return;
      }
      case "command.run":
      case "ui.status.press":
      case "ui.pane.close":
      case "ui.pane.message":
        this.nativeAction(message);
        return;
      default:
        throw new Error("Unknown native protocol message");
    }
  }

  private clearContext(
    state: PluginState,
    contextId: string,
    retain: boolean,
  ): void {
    for (const [key, item] of state.statuses)
      if (item.contextId === contextId) state.statuses.delete(key);
    for (const [key, pane] of state.open) {
      if (pane.contextId !== contextId) continue;
      if (retain && pane.retainOnContextChange) {
        pane.data = null;
        pane.loading = true;
      } else state.open.delete(key);
    }
    for (const key of state.dismissed)
      if (key.startsWith(`${contextId}/`)) state.dismissed.delete(key);
  }

  private setContext(args: Record<string, unknown>): void {
    const context: Context = {
      id: identifier(args.id),
      surfaceId: identifier(args.surfaceId),
      cwd: text(args.cwd),
      revision: sequence(args.revision),
    };
    if (!this.contexts.has(context.id) && this.contexts.size >= MAX_CONTEXTS)
      throw new Error("Too many contexts");
    const previous = this.contexts.get(context.id);
    this.contexts.set(context.id, context);
    for (const state of this.plugins.values()) {
      if (
        previous &&
        (previous.cwd !== context.cwd ||
          previous.surfaceId !== context.surfaceId)
      )
        this.clearContext(state, context.id, true);
      this.enqueue(state, "context.changed", { context });
    }
    this.changed(context.id);
  }

  private closeContext(context: Context): void {
    this.contexts.delete(context.id);
    for (const state of this.plugins.values()) {
      this.clearContext(state, context.id, false);
      this.enqueue(state, "context.closed", { context });
    }
    this.changed(context.id);
  }

  private nativeAction(message: Record<string, unknown>): void {
    const context = this.context(message.contextId);
    const state = this.plugins.get(identifier(message.pluginId));
    if (!state || state.failed) return;
    const id = identifier(message.id);
    const contextId = context.id;
    switch (message.type) {
      case "command.run":
        if (state.commands.has(id))
          this.enqueue(state, "command.run", { id, contextId });
        return;
      case "ui.status.press": {
        const command = state.statuses.get(`${contextId}/${id}`)?.command;
        if (command)
          this.enqueue(state, "ui.status.press", { id, contextId, command });
        return;
      }
      case "ui.pane.close":
        if (state.open.has(`${contextId}/${id}`))
          this.enqueue(state, "ui.pane.close", {
            id,
            contextId,
            revision: context.revision,
            reason: "person",
          });
        return;
      case "ui.pane.message":
        if (state.open.has(`${contextId}/${id}`))
          this.enqueue(state, "ui.pane.message", {
            id,
            contextId,
            revision: context.revision,
            reason: "person",
            payload: jsonValue(message.payload ?? null),
          });
        return;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.rateTimer);
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.flushTimer);
    // Dispose is best effort and never holds application shutdown indefinitely.
    for (const state of this.plugins.values()) {
      if (state.ready && !state.failed) {
        state.queue.length = 0;
        this.enqueue(state, "session.end", {});
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    for (const state of this.plugins.values()) {
      clearTimeout(state.activationTimer);
      clearTimeout(state.active?.timer);
      state.child.kill("SIGKILL");
    }
  }
}

export async function main(configPath: string): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node.js 22 or newer is required");
  function emit(message: HostMessage): void {
    const line = boundedJSON(message) + "\n";
    // Cap writes to a native host which stopped reading; do not accumulate an unbounded queue.
    if (process.stdout.writableLength > 1024 * 1024)
      throw new Error("Native protocol backpressure limit exceeded");
    process.stdout.write(line);
  }
  const supervisor = new Supervisor(emit);
  const finish = async () => {
    try {
      await supervisor.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => {
    void finish();
  });
  process.once("SIGINT", () => {
    void finish();
  });
  process.stdin.once("end", () => {
    void finish();
  });
  process.stdout.on("error", () => {
    void finish();
  });
  // The native side waits for ready and then replays context snapshots.
  await supervisor.start(configPath);
  process.stdin.on(
    "data",
    lineDecoder(
      (message) => {
        try {
          supervisor.handle(message);
        } catch (error) {
          emit({
            type: "error",
            message: errorMessage(error).slice(0, 4096),
          });
        }
      },
      (error) => {
        emit({ type: "error", message: errorMessage(error).slice(0, 4096) });
      },
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Provide a plugin configuration file");
  void main(configPath).catch((error: unknown) => {
    process.stderr.write(`Ghostty plugin host: ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
