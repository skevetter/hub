import { z } from "zod";
import { surfaceRevision } from "../surfaces/store.js";
import type { AgentEvent } from "../daemons/agents/index.js";
import type { StartSessionInput } from "../interactive-sessions/store.js";
import type { SessionPrincipal, SessionRecord } from "../interactive-sessions/types.js";
import { MAX_REPLY_INPUT_CHARS, type FinalReplyAnswer } from "../run-replies/format.js";

export type LinearPilotStart = Pick<
  StartSessionInput,
  "profileId" | "profileVersion" | "message" | "idempotencyKey"
> & { nativeRequester: NonNullable<StartSessionInput["nativeRequester"]> };

export const LINEAR_PILOT_FRESH_BODY = "[Linear follow-up prompt withheld]";
export type LinearPilotFreshDispatch = "started" | "unconfirmed";

export interface LinearPilotCommand {
  organizationId: string;
  sessionId: string;
  commandId: string;
}

export interface LinearPilotRetirement extends LinearPilotCommand {
  profileId: string;
  workspaceId: string;
  generation: number;
  hubTurn: number;
  agentId: string;
  expectedBindingGeneration: number;
}

export interface LinearPilotStopRequest extends LinearPilotCommand {
  expectedAgentId: string;
  expectedDaemonTurnId: string;
  expectedBindingGeneration: number;
  requestedAt: string;
}

export interface LinearPilotTarget extends LinearPilotCommand {
  daemonId: string;
  agentId: string;
  generation: number;
  hubTurn: number;
  daemonTurnId: string;
  epoch: string;
  startedAt: string | null;
}

type TurnScope = Omit<LinearPilotTarget, "daemonTurnId" | "epoch" | "startedAt">;

export type LinearPilotTerminal =
  | (LinearPilotTarget & {
      status: "completed";
      seq: number;
      messageId: string;
      answer: FinalReplyAnswer;
    })
  | (LinearPilotTarget & { status: "failed" | "canceled" })
  | (TurnScope & { status: "unconfirmed" });

export type LinearPilotStop =
  | { status: "stopped"; target: LinearPilotTarget; message: "Stopped." }
  | {
      status: "unconfirmed";
      target?: LinearPilotTarget;
      message: "Stop requested; I could not confirm it stopped";
    };

export interface LinearPilotSessionHooks {
  authorizeStart(principal: SessionPrincipal, input: LinearPilotStart): Promise<boolean>;
  authorize(
    session: SessionRecord,
    commandId: string,
    expectedBindingGeneration?: number,
  ): Promise<boolean>;
  onTerminal(terminal: LinearPilotTerminal): void | Promise<void>;
  stopTimeoutMs?: number;
}

type Stream = Extract<AgentEvent, { type: "agent_stream" }>;

type TimelineItem = Extract<Stream["event"], { type: "timeline" }>["item"];
interface TimelinePosition {
  turnId: string | undefined;
  epoch: string | undefined;
  seq: number | undefined;
}

const MAX_ASSISTANT_BLOCK_IDS = 1024;
const instant = z.iso.datetime({ offset: true });

export function matchesLinearPilotStop(target: LinearPilotTarget, request: LinearPilotStopRequest) {
  if (
    target.organizationId !== request.organizationId ||
    target.sessionId !== request.sessionId ||
    target.commandId !== request.commandId ||
    target.agentId !== request.expectedAgentId ||
    target.daemonTurnId !== request.expectedDaemonTurnId ||
    !surfaceRevision(request.expectedBindingGeneration) ||
    target.startedAt === null
  )
    return false;
  const requestedAt = instant.safeParse(request.requestedAt);
  return requestedAt.success && Date.parse(requestedAt.data) > Date.parse(target.startedAt);
}

export class LinearPilotTurn {
  private turnId: string | undefined;
  private startedAt: string | null = null;
  private active: LinearPilotTarget | undefined;
  private seq = 0;
  private messageId: string | undefined;
  private readonly recentMessageIds = new Set<string>();
  private messageEnded = false;
  private text = "";
  private truncated = false;
  private sealed = false;
  permissionPending = false;
  turnEnded = false;

  constructor(private readonly scope: TurnScope) {}

  get target(): LinearPilotTarget | undefined {
    return this.sealed ? undefined : this.active;
  }

  get hasPromptEvidence(): boolean {
    return this.active !== undefined && (!this.sealed || this.turnEnded);
  }

  accept({ agentId, event, epoch, seq, wireTimestamp }: Stream): LinearPilotTerminal | undefined {
    if (this.sealed || agentId !== this.scope.agentId) return undefined;
    const turnId = typeof event["turnId"] === "string" ? event["turnId"] : undefined;
    if (event.type === "turn_started") return this.acceptStart(turnId, wireTimestamp);
    return this.acceptEvent(event, { turnId, epoch, seq });
  }

  private acceptEvent(
    event: Exclude<Stream["event"], { type: "turn_started" }>,
    row: TimelinePosition,
  ) {
    switch (event.type) {
      case "timeline":
        return this.acceptTimeline(event.item, row);
      case "permission_requested":
      case "permission_resolved":
        this.permissionPending = event.type === "permission_requested";
        return undefined;
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled":
        return this.acceptTerminal(event.type, row);
      case "attention_required":
      case "thread_started":
      default:
        return undefined;
    }
  }

  private acceptStart(turnId: string | undefined, wireTimestamp: string | undefined) {
    if (!turnId || (this.turnId && this.turnId !== turnId)) return this.loseProof();
    if (this.turnId === undefined) {
      const started = instant.safeParse(wireTimestamp);
      this.turnId = turnId;
      this.startedAt =
        started.success && Number.isFinite(Date.parse(started.data)) ? started.data : null;
    }
    return undefined;
  }

  private acceptInitialRow(item: TimelineItem, row: TimelinePosition) {
    if (item.type !== "user_message") return undefined;
    const { turnId, epoch, seq } = row;
    if (
      !this.turnId ||
      turnId !== this.turnId ||
      !epoch ||
      seq === undefined ||
      item["clientMessageId"] !== this.scope.commandId
    )
      return this.loseProof();
    this.active = { ...this.scope, daemonTurnId: turnId, epoch, startedAt: this.startedAt };
    this.seq = seq;
    return undefined;
  }

  private acceptTimeline(
    item: TimelineItem,
    row: TimelinePosition,
  ): LinearPilotTerminal | undefined {
    const active = this.active;
    if (!active) return this.acceptInitialRow(item, row);
    const { turnId, epoch, seq } = row;
    if (epoch !== active.epoch || seq !== this.seq + 1 || turnId !== active.daemonTurnId)
      return this.loseProof();
    this.seq = seq;
    if (item.type === "user_message") return this.loseProof();
    if (item.type === "tool_call") {
      this.messageEnded = true;
      this.clearAnswer();
    }
    if (item.type === "assistant_message")
      return this.acceptAssistantBlock(item.messageId, item.text);
    return undefined;
  }

  private acceptAssistantBlock(messageId: string | undefined, text: string | undefined) {
    if (!messageId || typeof text !== "string") return this.loseProof();
    if (this.messageId !== messageId) {
      if (this.recentMessageIds.has(messageId)) return this.loseProof();
      if (this.recentMessageIds.size === MAX_ASSISTANT_BLOCK_IDS) {
        const oldest = this.recentMessageIds.values().next();
        if (!oldest.done) this.recentMessageIds.delete(oldest.value);
      }
      this.recentMessageIds.add(messageId);
      this.clearAnswer();
      this.messageId = messageId;
      this.messageEnded = false;
    } else if (this.messageEnded) return this.loseProof();
    const remaining = MAX_REPLY_INPUT_CHARS - this.text.length;
    this.text += text.slice(0, remaining);
    this.truncated ||= text.length > remaining;
    return undefined;
  }

  private acceptTerminal(
    type: "turn_completed" | "turn_failed" | "turn_canceled",
    row: TimelinePosition,
  ): LinearPilotTerminal {
    const active = this.active;
    if (!active || !this.matchesTerminal(active, row)) return this.loseProof();
    this.turnEnded = true;
    this.sealed = true;
    const { messageId, text, truncated } = this;
    this.clearAnswer();
    if (type === "turn_failed") return { ...active, status: "failed" };
    if (type === "turn_canceled") return { ...active, status: "canceled" };
    if (!messageId || text.trim() === "") return { ...this.scope, status: "unconfirmed" };
    return {
      ...active,
      status: "completed",
      seq: this.seq,
      messageId,
      answer: { text, truncated },
    };
  }

  private matchesTerminal(active: LinearPilotTarget, { turnId, epoch, seq }: TimelinePosition) {
    // The pinned daemon sends epoch and sequence on timeline rows, not terminal frames.
    return (
      turnId === active.daemonTurnId &&
      (epoch === undefined || epoch === active.epoch) &&
      (seq === undefined || seq === this.seq + 1)
    );
  }

  private clearAnswer(): void {
    this.text = "";
    this.truncated = false;
  }

  private loseProof(): LinearPilotTerminal {
    this.sealed = true;
    this.clearAnswer();
    return { ...this.scope, status: "unconfirmed" };
  }
}
