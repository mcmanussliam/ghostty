import type { ChildProcess } from "node:child_process";
import type {
  Context,
  EventMap,
  HookResult,
  JSONValue,
  PaneEvent,
  PluginAPI,
  StatusItem,
} from "../sdk/dist/index.mjs";
import type { LoadedPlugin } from "./protocol.mjs";

export type EventName = keyof EventMap | "host.ping";
export type HostEvents = EventMap & { "host.ping": Record<string, never> };
export type EventData = HostEvents[EventName];
type NativeEventName = Exclude<
  EventName,
  "ui.status.update" | "ui.pane.open" | "session.start"
>;
export type Notification = {
  [K in NativeEventName]: { name: K; event: HostEvents[K] };
}[NativeEventName];
export type QueuedEvent = Notification & { id: number };

type ContextAction = { id: string; contextId: string; revision?: number };
export interface RPCArguments {
  "context.list": Record<string, never>;
  log: { message: string };
  "command.register": { id: string; title: string };
  "pane.register": Parameters<PluginAPI["ui"]["panes"]["register"]>[0];
  "status.set": StatusItem;
  "status.remove": ContextAction;
  "pane.open": PaneEvent;
  "pane.close": PaneEvent;
  "pane.publish": ContextAction & { data: JSONValue };
}
export type RPCMethod = keyof RPCArguments;
export type RPCResult<K extends RPCMethod> = K extends "context.list"
  ? Context[]
  : HookResult;

export type WorkerMessage =
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "call"; id: number; method: string; args: unknown }
  | { type: "event.result"; id: number; value?: HookResult; error?: string };
export type ParentMessage =
  | { type: "activate"; plugin: LoadedPlugin }
  | { type: "result"; id: number; value?: unknown; error?: string }
  | ({ type: "event" } & QueuedEvent);

export interface PaneType {
  id: string;
  title: string;
  entry: string;
  root: string;
  width: number;
  retainOnContextChange: boolean;
}
export interface OpenPane extends PaneType {
  pluginId: string;
  contextId: string;
  data: JSONValue;
  loading: boolean;
}
export interface HostStatus extends Required<
  Omit<StatusItem, "revision" | "command">
> {
  pluginId: string;
  command: string | null;
}
export interface PluginState extends LoadedPlugin {
  child: ChildProcess;
  ready: boolean;
  failed: boolean;
  queue: QueuedEvent[];
  active: (QueuedEvent & { timer: NodeJS.Timeout }) | null;
  statuses: Map<string, HostStatus>;
  panes: Map<string, PaneType>;
  open: Map<string, OpenPane>;
  dismissed: Set<string>;
  commands: Map<string, string>;
  apiCalls: number;
  activationTimer?: NodeJS.Timeout;
  resolveActivation?: () => void;
}
export interface Snapshot {
  type: "snapshot";
  contextId: string;
  contextRevision: number;
  statuses: HostStatus[];
  panes: OpenPane[];
  commands: { id: string; title: string; pluginId: string }[];
}
export type HostMessage =
  | { type: "ready"; version: number }
  | { type: "error" | "log"; pluginId?: string; message: string }
  | Snapshot;
