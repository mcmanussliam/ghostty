import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context, JSONValue } from "../sdk/dist/index.mjs";
import type {
  Notification,
  ParentMessage,
  WorkerMessage,
} from "./messages.mjs";

export const VERSION = 1;
export const MAX_BYTES = 256 * 1024;
export const MAX_PLUGINS = 16;
export const MAX_ITEMS = 32;
export const MAX_CONTEXTS = 128;
export const HOOK_TIMEOUT_MS = 1500;
export const CAPABILITIES: ReadonlySet<string> = new Set([
  "context",
  "shell.command.finished",
  "commands",
  "ui.statusBar",
  "ui.panes",
]);
export const EVENTS: ReadonlySet<string> = new Set([
  "session.start",
  "session.end",
  "context.changed",
  "context.closed",
  "shell.command.finished",
  "command.run",
  "ui.status.press",
  "ui.status.update",
  "ui.pane.open",
  "ui.pane.close",
  "ui.pane.message",
]);

export interface Manifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  main: string;
  capabilities: string[];
}
export interface LoadedPlugin {
  root: string;
  entry: string;
  manifest: Manifest;
  settings: JSONValue;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export function boundedJSON(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_BYTES)
    throw new Error("Message exceeds the 256 KiB protocol limit");
  return encoded;
}

export function jsonValue(value: unknown): JSONValue {
  return JSON.parse(boundedJSON(value)) as JSONValue;
}

export function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)
  )
    throw new Error("Expected an identifier of at most 96 characters");
  return value;
}

export function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max)
    throw new Error("Invalid text field");
  return value;
}

export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected a finite number");
  return value;
}

export function sequence(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid sequence or context revision");
  return result;
}

export function workerMessage(value: unknown): WorkerMessage {
  boundedJSON(value);
  const message = record(value);
  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "fatal":
      return { type: "fatal", error: text(message.error) };
    case "call":
      return {
        type: "call",
        id: sequence(message.id),
        method: text(message.method, 96),
        args: message.args,
      };
    case "event.result":
      return {
        type: "event.result",
        id: sequence(message.id),
        error: message.error === undefined ? undefined : text(message.error),
      };
    default:
      throw new Error("Unknown worker protocol message");
  }
}

export function contextValue(value: unknown): Context {
  const input = record(value);
  return {
    id: identifier(input.id),
    surfaceId: identifier(input.surfaceId),
    cwd: text(input.cwd),
    revision: sequence(input.revision),
  };
}

function notification(name: unknown, value: unknown): Notification {
  const event = record(value);
  switch (name) {
    case "session.end":
    case "host.ping":
      return { name, event: {} };
    case "context.changed":
    case "context.closed":
      return { name, event: { context: contextValue(event.context) } };
    case "shell.command.finished":
      return {
        name,
        event: {
          context: contextValue(event.context),
          exitCode: event.exitCode === null ? null : number(event.exitCode),
          durationMs: number(event.durationMs),
        },
      };
    case "command.run":
      return {
        name,
        event: {
          id: identifier(event.id),
          contextId: identifier(event.contextId),
        },
      };
    case "ui.status.press":
      return {
        name,
        event: {
          id: identifier(event.id),
          contextId: identifier(event.contextId),
          command: identifier(event.command),
        },
      };
    case "ui.pane.close":
      return {
        name,
        event: {
          id: identifier(event.id),
          contextId: identifier(event.contextId),
          revision: sequence(event.revision),
          reason: "person",
        },
      };
    case "ui.pane.message":
      return {
        name,
        event: {
          id: identifier(event.id),
          contextId: identifier(event.contextId),
          revision: sequence(event.revision),
          reason: "person",
          payload: jsonValue(event.payload),
        },
      };
    default:
      throw new Error("Unknown native hook event");
  }
}

export function parentMessage(value: unknown): ParentMessage {
  boundedJSON(value);
  const message = record(value);
  switch (message.type) {
    case "result":
      return {
        type: "result",
        id: sequence(message.id),
        value: message.value,
        error: message.error === undefined ? undefined : text(message.error),
      };
    case "activate": {
      const plugin = record(message.plugin);
      return {
        type: "activate",
        plugin: {
          root: text(plugin.root),
          entry: text(plugin.entry),
          manifest: manifestValue(plugin.manifest),
          settings: jsonValue(plugin.settings),
        },
      };
    }
    case "event":
      return {
        type: "event",
        id: sequence(message.id),
        ...notification(message.name, message.event),
      };
    default:
      throw new Error("Unknown parent protocol message");
  }
}

export async function containedFile(
  root: string,
  path: unknown,
): Promise<string> {
  if (typeof path !== "string" || isAbsolute(path))
    throw new Error("Use a relative plugin file path");
  const actual = await realpath(resolve(root, path));
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Plugin file escapes its directory");
  if (!(await stat(actual)).isFile())
    throw new Error("Expected a regular file");
  return actual;
}

export async function readJSON(path: string): Promise<unknown> {
  if ((await stat(path)).size > MAX_BYTES)
    throw new Error("JSON file exceeds 256 KiB");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function manifestValue(value: unknown): Manifest {
  const input = record(value);
  if (input.apiVersion !== VERSION)
    throw new Error("Unsupported plugin API version");
  const capabilities = input.capabilities;
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every(
      (item: unknown): item is string =>
        typeof item === "string" && CAPABILITIES.has(item),
    )
  )
    throw new Error("Declare supported capabilities in plugin.json");
  return {
    id: identifier(input.id),
    name: text(input.name, 128),
    version: text(input.version, 64),
    apiVersion: VERSION,
    main: text(input.main),
    capabilities,
  };
}

export async function loadManifest(
  directory: string,
): Promise<Omit<LoadedPlugin, "settings">> {
  if (!isAbsolute(directory))
    throw new Error("Plugin directories must be absolute");
  const root = await realpath(directory);
  const manifest = manifestValue(
    await readJSON(await containedFile(root, "plugin.json")),
  );
  text(root);
  const entry = await containedFile(root, manifest.main);
  if (!/\.(mjs|js)$/.test(entry))
    throw new Error("Compile TypeScript to an ESM .mjs or .js entry");
  return { root, entry, manifest };
}

export async function loadConfiguration(path: string): Promise<LoadedPlugin[]> {
  const config = record(await readJSON(path));
  if (typeof config.nodePath !== "string" || !isAbsolute(config.nodePath))
    throw new Error("Set an absolute nodePath in plugins.json");
  if (
    config.version !== VERSION ||
    !Array.isArray(config.plugins) ||
    config.plugins.length > MAX_PLUGINS
  )
    throw new Error("Expected version 1 and at most 16 plugins");
  const plugins: LoadedPlugin[] = [];
  const ids = new Set<string>();
  for (const value of config.plugins as unknown[]) {
    const item = record(value);
    if (item.enabled === false) continue;
    const plugin = await loadManifest(text(item.path));
    if (ids.has(plugin.manifest.id)) throw new Error("Duplicate plugin ID");
    ids.add(plugin.manifest.id);
    plugins.push({ ...plugin, settings: jsonValue(item.settings ?? {}) });
  }
  return plugins;
}

export function lineDecoder(
  onLine: (value: unknown) => void,
  onError: (error: unknown) => void,
): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  let failed = false;
  return (chunk) => {
    if (failed) return;
    pending = Buffer.concat([pending, chunk]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > MAX_BYTES) {
        failed = true;
        onError(new Error("Protocol frame too large"));
        return;
      }
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      if (!line.length) continue;
      try {
        onLine(JSON.parse(line) as unknown);
      } catch (error) {
        onError(error);
      }
    }
    if (pending.length > MAX_BYTES) {
      failed = true;
      onError(new Error("Protocol frame too large"));
    }
  };
}
