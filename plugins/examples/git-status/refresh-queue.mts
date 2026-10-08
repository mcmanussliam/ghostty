import type { Context } from "../../sdk/dist/index.mjs";

interface RefreshRequest {
  context: Context;
  reveal: boolean;
  rediscover: boolean;
}
export interface RefreshJob extends RefreshRequest {
  controller: AbortController;
}

const maxConcurrent = 4;
const refreshIntervalMs = 50;

export class RefreshQueue {
  private readonly pending = new Map<string, RefreshRequest>();
  private readonly active = new Map<string, RefreshJob>();
  private timer: NodeJS.Timeout | undefined;
  private lastStart = -Infinity;
  private stopped = false;

  constructor(
    private readonly refresh: (job: RefreshJob) => Promise<void>,
    private readonly onError: (error: unknown) => Promise<void>,
  ) {}

  schedule(
    context: Context,
    options: { reveal?: boolean; rediscover?: boolean } = {},
  ): void {
    if (this.stopped) return;
    const previous = this.pending.get(context.id);
    const sameRevision = previous?.context.revision === context.revision;
    this.pending.set(context.id, {
      context,
      reveal:
        options.reveal === true || (sameRevision && previous?.reveal === true),
      rediscover:
        options.reveal === true ||
        options.rediscover === true ||
        (sameRevision && previous?.rediscover === true),
    });
    const running = this.active.get(context.id);
    if (running && running.context.revision !== context.revision)
      running.controller.abort();
    this.pump();
  }

  cancel(contextId: string): void {
    this.active.get(contextId)?.controller.abort();
    this.pending.delete(contextId);
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.active.values()) job.controller.abort();
    this.pending.clear();
    clearTimeout(this.timer);
  }

  private pump(): void {
    if (this.stopped || this.active.size >= maxConcurrent || this.timer) return;
    let request: RefreshRequest | undefined;
    for (const pending of this.pending.values()) {
      if (!this.active.has(pending.context.id)) {
        request = pending;
        break;
      }
    }
    if (!request) return;
    const delay = refreshIntervalMs - (performance.now() - this.lastStart);
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, delay);
      return;
    }
    const job: RefreshJob = { ...request, controller: new AbortController() };
    this.pending.delete(job.context.id);
    this.active.set(job.context.id, job);
    this.lastStart = performance.now();
    void this.run(job).catch(this.onError);
    this.pump();
  }

  private async run(job: RefreshJob): Promise<void> {
    try {
      await this.refresh(job);
    } catch (error) {
      if (!this.stopped) await this.onError(error);
    } finally {
      this.active.delete(job.context.id);
      this.pump();
    }
  }
}
