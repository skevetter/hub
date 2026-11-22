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
  private previousMessageId: string | undefined;
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
    switch (event.type) {
      case "turn_started":
        if (!turnId || (this.turnId && this.turnId !== turnId)) return this.loseProof();
        if (this.turnId === undefined) {
          const started = instant.safeParse(wireTimestamp);
          this.turnId = turnId;
          this.startedAt =
            started.success && Number.isFinite(Date.parse(started.data)) ? started.data : null;
        }
        return undefined;
      case "timeline":
        return this.acceptTimeline(event.item, turnId, epoch, seq);
      case "permission_requested":
      case "permission_resolved":
        this.permissionPending = event.type === "permission_requested";
        return undefined;
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled":
        return this.acceptTerminal(event.type, turnId, epoch, seq);
      default:
        return undefined;
    }
  }

  private acceptTimeline(
    item: Extract<Stream["event"], { type: "timeline" }>["item"],
    turnId: string | undefined,
    epoch: string | undefined,
    seq: number | undefined,
  ): LinearPilotTerminal | undefined {
    const active = this.active;
    if (!active) {
      if (item.type !== "user_message") return undefined;
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
    if (messageId === this.previousMessageId || (this.messageEnded && messageId === this.messageId))
      return this.loseProof();
    if (this.messageId !== messageId) {
      this.clearAnswer();
      this.previousMessageId = this.messageId;
      this.messageId = messageId;
      this.messageEnded = false;
    }
    const remaining = MAX_REPLY_INPUT_CHARS - this.text.length;
    this.text += text.slice(0, remaining);
    this.truncated ||= text.length > remaining;
    return undefined;
  }

  private acceptTerminal(
    type: "turn_completed" | "turn_failed" | "turn_canceled",
    turnId: string | undefined,
    epoch: string | undefined,
    seq: number | undefined,
  ): LinearPilotTerminal {
    const active = this.active;
    // The pinned daemon sends epoch and sequence on timeline rows, not terminal frames.
    if (
      !active ||
      turnId !== active.daemonTurnId ||
      (epoch !== undefined && epoch !== active.epoch) ||
      (seq !== undefined && seq !== this.seq + 1)
    )
      return this.loseProof();
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
