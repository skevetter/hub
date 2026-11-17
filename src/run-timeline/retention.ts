import type { Database } from "../db/types.js";

const DAY_MS = 24 * 60 * 60_000;
const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 250;
const SWEEP_DELAY_MS = 60 * 60_000;
const RETRY_DELAY_MS = 60_000;

export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export function isRunTimelineExpired(
  run: { completedAt: Date | null; expiredAt?: Date | null },
  cutoff: Date,
): boolean {
  return (
    run.expiredAt != null ||
    (run.completedAt !== null && run.completedAt.getTime() < cutoff.getTime())
  );
}

export interface TimelineRetentionOptions {
  retentionDays: number;
  now?: () => Date;
  reportFailure?: (error: unknown) => void;
}

export class TimelineRetention {
  private timer: NodeJS.Timeout | undefined;
  private pauseTimer: NodeJS.Timeout | undefined;
  private cancelPause: (() => void) | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly database: Pick<Database, "expireRunTimelines">,
    private readonly options: TimelineRetentionOptions,
  ) {}

  start(): void {
    if (!this.stopped || this.active) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.cancelPause?.();
    await this.active;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, delay);
    this.timer.unref();
  }

  private tick(): void {
    if (this.stopped || this.active) return;
    let delay = SWEEP_DELAY_MS;
    this.active = this.sweep()
      .catch((error: unknown) => {
        delay = RETRY_DELAY_MS;
        try {
          this.options.reportFailure?.(error);
        } catch {}
      })
      .finally(() => {
        this.active = undefined;
        if (!this.stopped) this.schedule(delay);
      });
  }

  private async sweep(): Promise<void> {
    const cutoff = retentionCutoff(this.options.now?.() ?? new Date(), this.options.retentionDays);
    while (!this.stopped) {
      const count = await this.database.expireRunTimelines(cutoff, BATCH_SIZE);
      if (this.stopped || count < BATCH_SIZE) return;
      await this.pause();
    }
  }

  private pause(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.cancelPause = () => {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = undefined;
      this.cancelPause = undefined;
      resolve();
    };
    this.pauseTimer = setTimeout(this.cancelPause, BATCH_DELAY_MS);
    this.pauseTimer.unref();
    return promise;
  }
}
