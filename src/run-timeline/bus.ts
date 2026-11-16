export interface RunTimelineNotification {
  readonly runId: string;
  readonly seq: number;
}

export type RunTimelineListener = (notification: RunTimelineNotification) => void | Promise<void>;

export interface RunTimelineBusOptions {
  maxSubscriptions?: number;
  reportFailure?: (error: unknown) => void;
}

interface RunTimelineSubscription {
  readonly listener: RunTimelineListener;
  readonly generation: number;
}

export class RunTimelineBus {
  private readonly listeners = new Map<string, Set<RunTimelineSubscription>>();
  private readonly maxSubscriptions: number;
  private subscriptionCount = 0;
  private nextGeneration = 0;

  constructor(private readonly options: RunTimelineBusOptions = {}) {
    this.maxSubscriptions = options.maxSubscriptions ?? 1024;
    if (!Number.isSafeInteger(this.maxSubscriptions) || this.maxSubscriptions < 1) {
      throw new RangeError("maxSubscriptions must be a positive safe integer");
    }
  }

  subscribe(runId: string, listener: RunTimelineListener): () => void {
    if (this.subscriptionCount >= this.maxSubscriptions) {
      throw new Error("Run timeline subscription limit reached");
    }
    const subscription: RunTimelineSubscription = {
      listener,
      generation: this.nextGeneration++,
    };
    let listeners = this.listeners.get(runId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(runId, listeners);
    }
    listeners.add(subscription);
    this.subscriptionCount += 1;
    return () => {
      if (!listeners.delete(subscription)) return;
      this.subscriptionCount -= 1;
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, seq: number): void {
    const listeners = this.listeners.get(runId);
    if (!listeners) return;
    const notification: RunTimelineNotification = Object.freeze({ runId, seq });
    const generation = this.nextGeneration;
    for (const subscription of listeners) {
      if (subscription.generation >= generation) break;
      try {
        const pending = subscription.listener(notification);
        if (pending) void pending.catch((error: unknown) => this.report(error));
      } catch (error) {
        this.report(error);
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.options.reportFailure?.(error);
    } catch {}
  }
}
