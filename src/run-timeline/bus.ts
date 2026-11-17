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
  active: boolean;
  running: boolean;
  pendingSeq: number | undefined;
}

export class RunTimelineBus {
  private readonly observers = new Set<(notification: RunTimelineNotification) => void>();
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
      active: true,
      running: false,
      pendingSeq: undefined,
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
      subscription.active = false;
      subscription.pendingSeq = undefined;
      this.subscriptionCount -= 1;
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  observe(listener: (notification: RunTimelineNotification) => void): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  publish(runId: string, seq: number): void {
    const listeners = this.listeners.get(runId);
    if (listeners === undefined && this.observers.size === 0) return;
    const notification: RunTimelineNotification = Object.freeze({ runId, seq });
    for (const observer of this.observers) {
      try {
        observer(notification);
      } catch (error) {
        this.report(error);
      }
    }
    if (listeners === undefined) return;
    const generation = this.nextGeneration;
    for (const subscription of listeners) {
      if (subscription.generation >= generation) break;
      this.deliver(runId, subscription, notification);
    }
  }

  private deliver(
    runId: string,
    subscription: RunTimelineSubscription,
    notification: RunTimelineNotification,
  ): void {
    if (subscription.running) {
      subscription.pendingSeq = notification.seq;
      return;
    }
    subscription.running = true;
    try {
      const pending = subscription.listener(notification);
      if (pending) {
        void pending.then(
          () => this.settle(runId, subscription),
          (error: unknown) => {
            this.report(error);
            this.settle(runId, subscription);
          },
        );
        return;
      }
    } catch (error) {
      this.report(error);
    }
    if (subscription.active && subscription.pendingSeq !== undefined) {
      queueMicrotask(() => this.settle(runId, subscription));
    } else {
      subscription.running = false;
    }
  }

  private settle(runId: string, subscription: RunTimelineSubscription): void {
    subscription.running = false;
    const seq = subscription.pendingSeq;
    subscription.pendingSeq = undefined;
    if (subscription.active && seq !== undefined) {
      this.deliver(runId, subscription, Object.freeze({ runId, seq }));
    }
  }

  private report(error: unknown): void {
    try {
      this.options.reportFailure?.(error);
    } catch {}
  }
}
