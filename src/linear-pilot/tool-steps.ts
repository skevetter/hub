import { createHash } from "node:crypto";
import { logger } from "../logger.js";
import { LinearAgentError } from "../providers/linear/agent.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import {
  claimPilotActivity,
  stableActivityId,
  type LinearPilotAcceptedEvent,
  type PilotClient,
} from "./activities.js";
import { createToolStepRenderer, detailRecord, type ToolCallItem } from "./tool-steps-content.js";

const CAP = 30;
const QUEUE = 5;
const INTERVAL_MS = 1_000;
const COOLDOWN_MS = 60_000;
const WRITE_TIMEOUT_MS = 16_000;
const GAP_BODY = "Some steps not shown.";
const FINISHED = new Set(["completed", "failed", "canceled"]);
type ActivityInput = Parameters<PilotClient["createActivity"]>[0];

interface Scope {
  organizationId: string;
  sessionId: string;
  commandId: string;
}

interface ResolvedTurn {
  event: LinearPilotAcceptedEvent;
  clientFor: () => PilotClient;
}

export type ToolStepHook = (scope: Scope, cwd?: string) => ToolStepTurn | undefined;

export interface ToolStepTurn {
  accept(item: ToolCallItem): void;
  close(): void;
}

interface Options {
  resolve: (scope: Scope) => ResolvedTurn | undefined;
  scrubValues?: readonly string[] | undefined;
  now?: () => number;
}

class InstallationBuckets {
  private readonly availableAt = new Map<string, number>();
  constructor(private readonly now: () => number) {}

  takeOrWait(installation: string) {
    const at = this.now();
    const wait = (this.availableAt.get(installation) ?? at) - at;
    if (wait > 0) return wait;
    this.availableAt.set(installation, at + INTERVAL_MS);
    return 0;
  }

  pause(installation: string) {
    this.availableAt.set(installation, this.now() + COOLDOWN_MS);
  }
}

function actionIdentity(event: LinearPilotAcceptedEvent, item: ToolCallItem) {
  const { callId, status } = item;
  if (!callId || callId.length > 255 || !status || !FINISHED.has(status)) return undefined;
  const hash = createHash("sha256").update(callId).digest("hex");
  return stableActivityId(event.nativeSessionId, "action", `${event.interactionId}:${hash}`);
}

function logFailure(error: unknown) {
  const known = error instanceof LinearAgentError ? error : undefined;
  logger.warn(
    {
      operation: "action",
      httpStatus: known?.status,
      linearErrorCode: known?.code ?? "unconfirmed",
    },
    "Linear pilot tool step failed",
  );
  const status = known?.status ?? 0;
  return status === 429 || (status >= 500 && status < 600);
}

type Outcome = "written" | "dropped" | "cooldown";

async function readAction(
  client: PilotClient,
  input: ActivityInput,
  signal: AbortSignal,
): Promise<Outcome> {
  let cooldown = false;
  const report = (error: unknown) => {
    if (!signal.aborted) cooldown = logFailure(error);
  };
  try {
    await client.isActivityConfirmed(
      { sessionId: input.sessionId, activityId: input.activityId, kind: "action" },
      signal,
      report,
    );
  } catch (error) {
    report(error);
  }
  return cooldown ? "cooldown" : "dropped";
}

async function writeAction(
  client: PilotClient,
  input: ActivityInput,
  signal: AbortSignal,
): Promise<Outcome> {
  try {
    const id = await client.createActivity(input, signal);
    if (id === input.activityId) return "written";
    if (!signal.aborted) logFailure(new LinearAgentError("mutation_unconfirmed"));
  } catch (error) {
    if (!signal.aborted && logFailure(error)) return "cooldown";
  }
  if (signal.aborted) return "dropped";
  return readAction(client, input, signal);
}

interface TurnOptions extends ResolvedTurn {
  readonly render: ReturnType<typeof createToolStepRenderer>;
  readonly noteKeys: (item: ToolCallItem) => void;
  readonly claim: (id: string) => ReturnType<typeof claimPilotActivity>;
  readonly claimGap: (id: string) => ReturnType<typeof claimPilotActivity>;
  readonly buckets: InstallationBuckets;
  readonly release: () => void;
}

class PendingToolSteps implements ToolStepTurn {
  private readonly controller = new AbortController();
  private readonly seen = new Set<string>();
  private readonly queue: ActivityInput[] = [];
  private inFlight = false;
  private gap = false;
  private done = false;
  private wake: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: TurnOptions) {}

  accept(item: ToolCallItem): void {
    if (this.controller.signal.aborted) return;
    this.options.noteKeys(item);
    if (this.done) return;
    const { event, render } = this.options;
    const id = actionIdentity(event, item);
    if (!id || this.seen.has(id)) return;
    if (this.seen.size >= CAP || this.queue.length >= QUEUE) {
      this.omit();
      return;
    }
    this.seen.add(id);
    const refused = this.options.claim(id);
    if (refused === "already-claimed") return;
    if (refused === "capacity") {
      this.omit();
      return;
    }
    this.queue.push({
      sessionId: event.nativeSessionId,
      activityId: id,
      content: render(item),
      ephemeral: false,
    });
    this.drain();
  }

  close(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.queue.length = 0;
    clearTimeout(this.wake);
    this.options.release();
  }

  private omit(): void {
    this.done = true;
    if (this.gap) return;
    this.gap = true;
    const { event, claimGap } = this.options;
    const activityId = stableActivityId(event.nativeSessionId, "action_gap", event.interactionId);
    if (claimGap(activityId)) return;
    void this.postGap({
      sessionId: event.nativeSessionId,
      activityId,
      content: { type: "thought", body: GAP_BODY },
    });
  }

  private async postGap(input: ActivityInput): Promise<void> {
    const signal = this.signal();
    try {
      await this.options.clientFor().createActivity(input, signal);
    } catch (error) {
      if (!signal.aborted) logFailure(error);
    }
  }

  private drain(): void {
    const next = this.queue[0];
    if (!next || this.inFlight || this.wake || this.controller.signal.aborted) return;
    const wait = this.options.buckets.takeOrWait(this.options.event.binding.id);
    if (wait > 0) {
      this.wake = setTimeout(() => {
        this.wake = undefined;
        this.drain();
      }, wait);
      return;
    }
    this.queue.shift();
    this.inFlight = true;
    void this.post(next);
  }

  private signal(): AbortSignal {
    return AbortSignal.any([this.controller.signal, AbortSignal.timeout(WRITE_TIMEOUT_MS)]);
  }

  private async post(input: ActivityInput): Promise<void> {
    const signal = this.signal();
    let outcome: Outcome = "dropped";
    try {
      outcome = await writeAction(this.options.clientFor(), input, signal);
    } catch (error) {
      if (!signal.aborted && logFailure(error)) outcome = "cooldown";
    }
    this.inFlight = false;
    if (outcome === "cooldown") this.options.buckets.pause(this.options.event.binding.id);
    if (this.controller.signal.aborted) return;
    if (outcome === "written") return this.drain();
    this.omit();
    this.queue.length = 0;
  }
}

export function createLinearPilotToolStepHook({ resolve, scrubValues, now = Date.now }: Options) {
  const claims = new Map<string, number>();
  const gaps = new Map<string, number>();
  const logged = new Set<string>();
  const active = new Map<string, { interactionId: string; turn: ToolStepTurn }>();
  const buckets = new InstallationBuckets(now);
  const scrub = createTimelineScrubber(scrubValues === undefined ? {} : { scrubValues });
  const open: ToolStepHook = (scope, cwd) => {
    const bound = resolve(scope);
    if (!bound || bound.event.kind === "stop") return undefined;
    const id = bound.event.nativeSessionId;
    active.get(id)?.turn.close();
    const turn = new PendingToolSteps({
      ...bound,
      buckets,
      render: createToolStepRenderer(scrub, cwd),
      noteKeys(item) {
        if (logged.has(id)) return;
        logged.add(id);
        logger.debug(
          { keys: Object.keys(detailRecord(item.detail) ?? {}) },
          "Linear pilot tool detail keys",
        );
      },
      claim: (activityId) => claimPilotActivity(claims, activityId, now()),
      claimGap: (activityId) => claimPilotActivity(gaps, activityId, now()),
      release: () => {
        active.delete(id);
      },
    });
    active.set(id, { interactionId: bound.event.interactionId, turn });
    return turn;
  };
  return Object.assign(open, {
    close(event: LinearPilotAcceptedEvent) {
      const current = active.get(event.nativeSessionId);
      if (current?.interactionId === event.interactionId) current.turn.close();
    },
  });
}
