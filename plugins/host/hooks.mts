import { AsyncLocalStorage } from "node:async_hooks";
import type { EventMap, Hook, HookResult } from "../sdk/dist/index.mjs";
import type { EventName, HostEvents } from "./messages.mjs";

interface Registration {
  handler: Hook<object>;
  priority: number;
}

export function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export class Middleware {
  private readonly hooks = new Map<EventName, Registration[]>();
  private readonly active = new AsyncLocalStorage<ReadonlySet<EventName>>();

  on<K extends keyof EventMap>(
    name: K,
    handler: Hook<EventMap[K]>,
    priority: number,
  ): () => void {
    if (!Number.isFinite(priority)) throw new Error("Invalid hook priority");
    const list = this.hooks.get(name) ?? [];
    if (list.length >= 32) throw new Error("Too many hooks for one event");
    // Erase the event type only inside the registry; dispatch restores it by name.
    const registration: Registration = {
      handler: handler as Hook<object>,
      priority,
    };
    list.push(registration);
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(name, list);
    return () => {
      const index = list.indexOf(registration);
      if (index >= 0) list.splice(index, 1);
    };
  }

  async dispatch<K extends EventName>(
    name: K,
    event: HostEvents[K],
    core: (event: HostEvents[K]) => Promise<HookResult> = () =>
      Promise.resolve({}),
  ): Promise<HookResult> {
    const active = this.active.getStore() ?? new Set<EventName>();
    if (active.has(name)) return core(event);
    const list = [...(this.hooks.get(name) ?? [])];
    const controller = new AbortController();
    async function step(
      index: number,
      input: HostEvents[K],
    ): Promise<HookResult> {
      const registration = list[index];
      if (!registration) return core(input);
      let called = false;
      const next = (replacement = input): Promise<HookResult> => {
        if (called) throw new Error("next() may be called only once");
        called = true;
        return step(index + 1, freeze(replacement));
      };
      const handler = registration.handler as Hook<HostEvents[K]>;
      return (await handler(freeze(input), next, controller.signal)) ?? {};
    }
    try {
      return await this.active.run(new Set([...active, name]), () =>
        step(0, freeze(structuredClone(event))),
      );
    } finally {
      controller.abort();
    }
  }
}
