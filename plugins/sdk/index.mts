export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type HookResult = Record<string, unknown>;

export interface Context {
  /** A window/tab controller ID, stable while a custom pane takes keyboard focus. */
  readonly id: string;
  readonly surfaceId: string;
  /** Local shell-reported directory. Empty until shell integration reports one. */
  readonly cwd: string;
  /** Check this after async work to avoid publishing data for a previous terminal/repo. */
  readonly revision: number;
}

export interface StatusItem {
  id: string;
  contextId: string;
  revision?: number;
  text: string;
  tooltip?: string;
  alignment?: "left" | "center" | "right";
  priority?: number;
  /** A command registered by this plugin. */
  command?: string;
}

export interface PaneEvent {
  id: string;
  contextId: string;
  /** Native pane actions carry the context revision captured when accepted. */
  revision?: number;
  reason?: "person" | "plugin";
  reveal?: boolean;
  /** Initial state, committed in the same snapshot as opening the pane. */
  data?: JSONValue;
}

export interface EventMap {
  "session.start": Record<string, never>;
  "session.end": Record<string, never>;
  "context.changed": { context: Context };
  "context.closed": { context: Context };
  "shell.command.finished": {
    context: Context;
    exitCode: number | null;
    durationMs: number;
  };
  "command.run": { id: string; contextId: string };
  "ui.status.press": { id: string; contextId: string; command: string };
  "ui.status.update": StatusItem;
  "ui.pane.open": PaneEvent;
  "ui.pane.close": PaneEvent;
  "ui.pane.message": PaneEvent & { payload: JSONValue };
}

export type Hook<E> = (
  event: Readonly<E>,
  /** Call once to continue; code before/after this call is the pre/post hook. */
  next: (replacement?: E) => Promise<HookResult>,
  /** Aborted when dispatch finishes. Hard deadlines are enforced by the supervisor. */
  signal: AbortSignal,
) => HookResult | void | Promise<HookResult | void>;

export interface PluginAPI {
  readonly version: 1;
  readonly plugin: {
    readonly id: string;
    readonly root: string;
    readonly settings: JSONValue;
  };
  on<K extends keyof EventMap>(
    event: K,
    handler: Hook<EventMap[K]>,
    options?: { priority?: number },
  ): () => void;
  readonly contexts: { list(): Promise<Context[]> };
  readonly commands: {
    register(command: {
      id: string;
      title: string;
      run(
        this: void,
        event: { id: string; contextId: string },
      ): HookResult | void | Promise<HookResult | void>;
    }): Promise<HookResult>;
    run(id: string, contextId: string): Promise<HookResult>;
  };
  readonly ui: {
    readonly statusBar: {
      set(item: StatusItem): Promise<HookResult>;
      remove(
        id: string,
        contextId: string,
        options?: { revision?: number },
      ): Promise<HookResult>;
    };
    readonly panes: {
      register(pane: {
        id: string;
        title: string;
        entry: string;
        width?: number;
        /** Reuse the pane across focus/cwd changes, hiding its content until open/publish/close. */
        retainOnContextChange?: boolean;
      }): Promise<HookResult>;
      open(
        id: string,
        contextId: string,
        options?: { reveal?: boolean; revision?: number; data?: JSONValue },
      ): Promise<HookResult>;
      close(
        id: string,
        contextId: string,
        options?: { revision?: number },
      ): Promise<HookResult>;
      publish(
        id: string,
        contextId: string,
        data: JSONValue,
        options?: { revision?: number },
      ): Promise<HookResult>;
    };
  };
  log(message: string): Promise<HookResult>;
}

export interface Plugin {
  activate(
    api: PluginAPI,
  ):
    | void
    | (() => void | Promise<void>)
    | Promise<void | (() => void | Promise<void>)>;
}

export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin;
}

/** Available inside a pane entry. Bundle React/other libraries locally. */
export interface PaneBridge {
  send(payload: JSONValue): void;
  onState(
    handler: (state: { context: Context; data: JSONValue }) => void,
  ): () => void;
}
