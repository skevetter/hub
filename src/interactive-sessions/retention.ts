import type { QueryHandle } from "../db/runtime/index.js";
import { logger } from "../logger.js";
import type { RunPayloadRetentionSettings } from "../run-payload-retention/settings.js";
import { retentionCutoff } from "../run-timeline/retention.js";
import type { InteractiveSessionStore } from "./store.js";

const BATCH_SIZE = 200;
const BATCH_DELAY_MS = 250;
const SWEEP_DELAY_MS = 60 * 60_000;
const RETRY_DELAY_MS = 60_000;

export function sessionMessageBodyCutoff(
  settings: RunPayloadRetentionSettings | undefined,
  now: Date,
): Date | null {
  return settings?.mode === "on" ? retentionCutoff(now, settings.retentionDays) : null;
}

export class SessionMessageRetention {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;

  constructor(
    private readonly store: Pick<InteractiveSessionStore, "expireInteractiveSessionMessageBodies">,
    private readonly pool: QueryHandle,
    private readonly settings: RunPayloadRetentionSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.running || this.active || this.settings.mode === "off") return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.active;
  }

  async sweep(): Promise<number> {
    const { mode, retentionDays } = this.settings;
    if (mode === "off") return 0;
    const now = this.now();
    const cutoff = retentionCutoff(now, retentionDays);
    if (mode === "count") {
      const { rows } = await this.pool.query<{ count: string | number }>(
        "select count(*) as count from interactive_session_commands where body is not null and created_at < $1",
        [cutoff],
      );
      const eligible = Number(rows[0]!.count);
      logger.info({ eligible }, "interactive session message retention count");
      return eligible;
    }
    const expired = await this.store.expireInteractiveSessionMessageBodies(cutoff, BATCH_SIZE, now);
    logger.info({ expired }, "interactive session message retention applied");
    return expired;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      let nextDelay = SWEEP_DELAY_MS;
      this.active = this.sweep()
        .then((expired) => {
          if (this.settings.mode === "on" && expired === BATCH_SIZE) nextDelay = BATCH_DELAY_MS;
          return undefined;
        })
        .catch(() => {
          nextDelay = RETRY_DELAY_MS;
          logger.warn("interactive session message retention failed");
        })
        .finally(() => {
          this.active = undefined;
          if (this.running) this.schedule(nextDelay);
        });
    }, delay).unref();
  }
}
