interface TerminalLeaseOptions {
  now: () => Date;
  leaseMs: number;
  deadline: number;
  renew: (now: Date, leaseMs: number) => Promise<boolean>;
  report: (error: unknown, operation: string) => void;
}

export const DEFAULT_TERMINAL_NOTIFICATION_HOLD_MS = 5 * 60_000;
export const DEFAULT_TERMINAL_NOTIFICATION_STOP_GRACE_MS = 10_000;

/** Resolves true when the work settles in time and false at the deadline; the work is not cancelled. */
export async function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, ms, false);
    timer.unref();
  });
  try {
    return await Promise.race([work.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class TerminalNotificationLease {
  private timer: NodeJS.Timeout | undefined;
  private capTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ownershipLost = false;
  private pending: Promise<void> | undefined;

  constructor(private readonly options: TerminalLeaseOptions) {}

  start(): void {
    const now = this.options.now().getTime();
    this.capTimer = setTimeout(() => this.reachHoldCap(), this.options.deadline - now);
    this.capTimer.unref();
    this.schedule(now);
  }

  get lost(): boolean {
    return this.ownershipLost;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.capTimer);
  }

  get pendingRenewal(): Promise<void> | undefined {
    return this.pending;
  }

  private schedule(lastTick: number): void {
    if (this.stopped) return;
    const delay = lastTick + this.options.leaseMs / 3 - this.options.now().getTime();
    this.timer = setTimeout(() => {
      const now = this.options.now();
      this.pending = this.renew(now).then(() => {
        this.pending = undefined;
        return this.schedule(now.getTime());
      });
    }, delay);
    this.timer.unref();
  }

  private reachHoldCap(): void {
    this.stop();
    this.options.report(
      new Error("Terminal notification reached its lease hold cap"),
      "workflow.notification.terminal.hold_cap",
    );
  }

  private async renew(now: Date): Promise<void> {
    const remaining = this.options.deadline - now.getTime();
    if (this.stopped || remaining <= 0) return;
    try {
      if (await this.options.renew(now, Math.min(this.options.leaseMs, remaining))) return;
      this.ownershipLost = true;
      this.stop();
      this.options.report(
        new Error("Terminal notification lease ownership was lost"),
        "workflow.notification.terminal.lease_lost",
      );
    } catch (error) {
      this.options.report(error, "workflow.notification.terminal.renew");
    }
  }
}
