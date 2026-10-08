import { pathToFileURL } from "node:url";
import type { HookResult, Plugin, PluginAPI } from "../sdk/dist/index.mjs";
import {
  boundedJSON,
  errorMessage,
  EVENTS,
  identifier,
  parentMessage,
  record,
  contextValue,
} from "./protocol.mjs";
import type { LoadedPlugin } from "./protocol.mjs";
import type {
  ParentMessage,
  RPCArguments,
  RPCMethod,
  RPCResult,
  WorkerMessage,
} from "./messages.mjs";
import { freeze, Middleware } from "./hooks.mjs";

const middleware = new Middleware();
const commands = new Map<
  string,
  Parameters<PluginAPI["commands"]["register"]>[0]["run"]
>();
const calls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let sequence = 0;
let activation: Promise<PluginAPI> | undefined;
let dispose: (() => void | Promise<void>) | undefined;

const hookCapabilities: ReadonlyMap<string, string> = new Map([
  ["context.changed", "context"],
  ["context.closed", "context"],
  ["ui.pane.open", "ui.panes"],
  ["ui.pane.close", "ui.panes"],
  ["ui.pane.message", "ui.panes"],
  ["ui.status.press", "ui.statusBar"],
  ["ui.status.update", "ui.statusBar"],
  ["command.run", "commands"],
  ["shell.command.finished", "shell.command.finished"],
]);

function rpcResult<K extends RPCMethod>(
  method: K,
  value: unknown,
): RPCResult<K> {
  if (method === "context.list") {
    if (!Array.isArray(value)) throw new Error("Expected a context list");
    return value.map(contextValue) as RPCResult<K>;
  }
  return record(value) as RPCResult<K>;
}

function send(message: WorkerMessage): void {
  boundedJSON(message);
  if (!process.connected || !process.send?.(message))
    throw new Error("Plugin IPC is disconnected or congested");
}

function rpc<K extends RPCMethod>(
  method: K,
  args: RPCArguments[K],
): Promise<RPCResult<K>> {
  if (calls.size >= 64)
    return Promise.reject(new Error("Too many outstanding API calls"));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    calls.set(id, {
      resolve: (value) => {
        try {
          resolve(rpcResult(method, value));
        } catch (error) {
          reject(new Error(errorMessage(error)));
        }
      },
      reject,
    });
    try {
      send({ type: "call", id, method, args });
    } catch (error) {
      calls.delete(id);
      reject(new Error(errorMessage(error)));
    }
  });
}

async function runCommand(event: {
  id: string;
  contextId: string;
}): Promise<HookResult> {
  const command = commands.get(event.id);
  if (!command) throw new Error("Unknown command");
  return (await command(freeze(event))) ?? {};
}

function createAPI(plugin: LoadedPlugin): PluginAPI {
  const api: PluginAPI = {
    version: 1,
    plugin: freeze({
      id: plugin.manifest.id,
      root: plugin.root,
      settings: plugin.settings,
    }),
    on(name, handler, options = {}) {
      if (!EVENTS.has(name) || typeof handler !== "function")
        throw new Error("Unknown event or invalid handler");
      const capability = hookCapabilities.get(name);
      if (capability && !plugin.manifest.capabilities.includes(capability))
        throw new Error(`Undeclared capability: ${capability}`);
      return middleware.on(name, handler, options.priority ?? 0);
    },
    commands: {
      async register(command) {
        identifier(command.id);
        if (
          typeof command.run !== "function" ||
          commands.size >= 32 ||
          commands.has(command.id)
        )
          throw new Error("Invalid or duplicate command");
        const result = await rpc("command.register", {
          id: command.id,
          title: command.title,
        });
        commands.set(command.id, command.run);
        return result;
      },
      run: (id, contextId) =>
        middleware.dispatch("command.run", { id, contextId }, runCommand),
    },
    ui: {
      statusBar: {
        set: (item) =>
          middleware.dispatch("ui.status.update", item, (event) =>
            rpc("status.set", event),
          ),
        remove: (id, contextId, options = {}) =>
          rpc("status.remove", { id, contextId, revision: options.revision }),
      },
      panes: {
        register: (pane) => rpc("pane.register", pane),
        open: (id, contextId, options = {}) =>
          middleware.dispatch(
            "ui.pane.open",
            { id, contextId, ...options, reveal: options.reveal === true },
            (event) => rpc("pane.open", event),
          ),
        close: (id, contextId, options = {}) =>
          middleware.dispatch(
            "ui.pane.close",
            { id, contextId, reason: "plugin", revision: options.revision },
            (event) => rpc("pane.close", event),
          ),
        publish: (id, contextId, data, options = {}) =>
          rpc("pane.publish", {
            id,
            contextId,
            data,
            revision: options.revision,
          }),
      },
    },
    contexts: { list: () => rpc("context.list", {}) },
    log: (message) => rpc("log", { message }),
  };
  return freeze(api);
}

async function activate(plugin: LoadedPlugin): Promise<PluginAPI> {
  const api = createAPI(plugin);
  // The plugin module is user code; validate its entry point before calling it.
  const module: unknown = await import(pathToFileURL(plugin.entry).href);
  const exported = record(record(module).default);
  if (typeof exported.activate !== "function")
    throw new Error("Export a default plugin with activate(api)");
  const initialize = exported.activate as Plugin["activate"];
  const returned: unknown = await initialize.call(exported, api);
  if (
    returned !== undefined &&
    returned !== null &&
    typeof returned !== "function"
  )
    throw new Error("activate() must return a disposer function or nothing");
  dispose =
    returned == null ? undefined : (returned as () => void | Promise<void>);
  await middleware.dispatch("session.start", {});
  return api;
}

async function handleEvent(
  message: Extract<ParentMessage, { type: "event" }>,
  api: PluginAPI,
): Promise<HookResult> {
  switch (message.name) {
    case "ui.status.press":
      return middleware.dispatch(message.name, message.event, (event) =>
        api.commands.run(event.command, event.contextId),
      );
    case "command.run":
      return middleware.dispatch(message.name, message.event, runCommand);
    case "ui.pane.close":
      return middleware.dispatch(message.name, message.event, (event) =>
        rpc("pane.close", {
          id: event.id,
          contextId: event.contextId,
          reason: "person",
          revision: message.event.revision,
        }),
      );
    default:
      return middleware.dispatch(message.name, message.event);
  }
}

async function receive(message: ParentMessage): Promise<void> {
  switch (message.type) {
    case "result": {
      const call = calls.get(message.id);
      if (!call) return;
      calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error));
      else call.resolve(message.value);
      return;
    }
    case "activate":
      activation = activate(message.plugin);
      try {
        await activation;
        send({ type: "ready" });
      } catch (error) {
        send({ type: "fatal", error: errorMessage(error) });
      }
      return;
    case "event":
      try {
        const api = await activation;
        if (!api) throw new Error("Plugin has not been activated");
        const value = await handleEvent(message, api);
        if (message.name === "session.end") await dispose?.();
        send({ type: "event.result", id: message.id, value });
      } catch (error) {
        send({
          type: "event.result",
          id: message.id,
          error: errorMessage(error),
        });
      }
  }
}

function fatal(error: unknown): void {
  try {
    send({ type: "fatal", error: errorMessage(error) });
  } finally {
    process.exitCode = 1;
  }
}

process.on("message", (value: unknown) => {
  try {
    void receive(parentMessage(value)).catch(fatal);
  } catch (error) {
    fatal(error);
  }
});
process.on("disconnect", () => process.exit(0));
process.on("unhandledRejection", fatal);
