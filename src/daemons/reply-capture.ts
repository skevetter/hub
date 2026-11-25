import { MAX_REPLY_INPUT_CHARS, type FinalReplyAnswer } from "../run-replies/format.js";
import type { RunReplyScope } from "../run-replies/store.js";
import type { AgentEvent } from "./agents/index.js";

const FINISH_REPLY_WAIT_MS = 10_000;
type AgentStream = Extract<AgentEvent, { type: "agent_stream" }>;
export type OnRunReplyAnswer = (
  scope: RunReplyScope,
  executionId: string,
  answer: FinalReplyAnswer | null,
) => void;

interface Observation {
  scope: RunReplyScope;
  turn: LastAssistantMessage;
  sequence: number;
  finishing: boolean;
  releaseRequested: boolean;
  stopWaiting?: () => void;
}

export class RunReplyCapture {
  private readonly observations = new Map<string, Observation>();

  constructor(
    private readonly offer: OnRunReplyAnswer,
    private readonly unsubscribe: (executionId: string) => void,
    private readonly schedule: (callback: () => Promise<void>, delay: number) => () => void,
  ) {}

  begin(executionId: string, scope: RunReplyScope): void {
    this.observations.get(executionId)?.stopWaiting?.();
    this.observations.set(executionId, {
      scope,
      turn: new LastAssistantMessage(),
      sequence: -1,
      finishing: false,
      releaseRequested: false,
    });
  }

  has(executionId: string): boolean {
    return this.observations.has(executionId);
  }

  noteExplicitFinish(executionId: string): void {
    const observation = this.observations.get(executionId);
    if (observation !== undefined) observation.finishing = true;
  }

  observe(executionId: string, event: AgentEvent): void {
    const observation = this.observations.get(executionId);
    if (observation === undefined || event.type !== "agent_stream") return;
    if (event.seq !== undefined) {
      if (event.seq <= observation.sequence) return;
      observation.sequence = event.seq;
    }
    if (observation.finishing && endsExplicitFinishWatch(event)) {
      this.close(executionId, observation);
      return;
    }
    observation.turn.observe(event);
    if (observation.stopWaiting !== undefined && observation.turn.completed)
      this.close(executionId, observation, observation.turn.answer());
  }

  complete(executionId: string, waitForFinalTurn: boolean): void {
    const observation = this.observations.get(executionId);
    if (observation === undefined) return;
    if (observation.turn.completed) {
      this.close(executionId, observation, observation.turn.answer());
    } else if (waitForFinalTurn) {
      // The finish tool must return before the provider can emit its final text and turn end.
      observation.stopWaiting = this.schedule(async () => {
        this.close(executionId, observation);
      }, FINISH_REPLY_WAIT_MS);
    }
  }

  /** The same watch may still be needed to collect the tail after an explicit finish. */
  release(executionId: string): boolean {
    const observation = this.observations.get(executionId);
    if (observation?.stopWaiting !== undefined) {
      observation.releaseRequested = true;
      return false;
    }
    this.observations.delete(executionId);
    return true;
  }

  stop(): void {
    for (const observation of this.observations.values()) observation.stopWaiting?.();
    this.observations.clear();
  }

  private close(executionId: string, observation: Observation, answer?: FinalReplyAnswer | null) {
    if (this.observations.get(executionId) !== observation) return;
    this.observations.delete(executionId);
    observation.stopWaiting?.();
    if (observation.releaseRequested) this.unsubscribe(executionId);
    if (answer !== undefined) this.offer(observation.scope, executionId, answer);
  }
}

function endsExplicitFinishWatch({ event }: AgentStream): boolean {
  return (
    event.type === "turn_started" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled" ||
    (event.type === "timeline" && event.item.type === "user_message")
  );
}

class LastAssistantMessage {
  completed = false;
  private messageId: string | undefined;
  private turnId: string | undefined;
  private text = "";
  private truncated = false;
  private crossedTool = false;
  private interrupted = false;

  observe({ event }: AgentStream): void {
    switch (event.type) {
      case "turn_started":
        this.startTurn();
        return;
      case "turn_completed":
        this.completed = !this.interrupted;
        return;
      case "turn_failed":
      case "turn_canceled":
        this.startTurn();
        this.interrupted = true;
        return;
      case "timeline":
        this.observeTimeline(event);
        return;
      case "attention_required":
      case "permission_requested":
      case "permission_resolved":
      case "thread_started":
      default:
        return;
    }
  }

  private observeTimeline(event: Extract<AgentStream["event"], { type: "timeline" }>): void {
    if (event.item.type === "user_message") this.startTurn();
    if (event.item.type === "tool_call") this.crossedTool = true;
    if (event.item.type === "assistant_message" && typeof event.item.text === "string") {
      const turnId = typeof event["turnId"] === "string" ? event["turnId"] : undefined;
      this.append(event.item.text, event.item.messageId, turnId);
    }
  }

  answer(): FinalReplyAnswer | null {
    return this.text.trim() === "" ? null : { text: this.text, truncated: this.truncated };
  }

  private append(value: string, messageId: string | undefined, turnId: string | undefined) {
    if (this.startsNewTurn(turnId)) this.startTurn();
    if (this.interrupted) return;
    if (messageId !== this.messageId || (messageId === undefined && this.crossedTool))
      this.clearMessage();
    this.turnId = turnId ?? this.turnId;
    this.messageId = messageId;
    const available = MAX_REPLY_INPUT_CHARS - this.text.length;
    this.text += value.slice(0, available);
    this.truncated ||= value.length > available;
    this.crossedTool = false;
  }

  private startsNewTurn(turnId: string | undefined): boolean {
    return (
      this.completed ||
      (turnId !== undefined && this.turnId !== undefined && turnId !== this.turnId)
    );
  }

  private startTurn() {
    this.completed = false;
    this.turnId = undefined;
    this.interrupted = false;
    this.crossedTool = false;
    this.clearMessage();
  }

  private clearMessage() {
    this.messageId = undefined;
    this.text = "";
    this.truncated = false;
  }
}
