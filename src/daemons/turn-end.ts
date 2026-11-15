import type { AgentEvent } from "./agents/index.js";

/**
 * How long a finished turn must stay quiet before Hub treats it as the end of the run. Any new
 * activity inside the window, such as a queued prompt starting a turn, cancels the completion.
 */
export const TURN_END_SETTLE_MS = 2_000;

/** The final text is stored in the step output, so it is bounded. */
export const MAX_TURN_END_OUTPUT_CHARS = 16_000;

/** Recorded in the result so an inferred completion can be told from an explicit finish. */
export const TURN_END_COMPLETION = "inferred_from_turn_end";

export type TurnEndVerdict =
  /** The agent ended a turn normally. Start the settle timer. */
  | "finished"
  /** The agent is active again, or the turn did not end normally. Stop the settle timer. */
  | "active"
  | "none";

/**
 * Follows one execution's agent stream and says when a turn ended normally.
 *
 * `turn_completed` is the daemon's own "this turn ended normally" event; `turn_failed` and
 * `turn_canceled` are separate events, and a turn blocked on a permission or on input never
 * completes. Idle status alone cannot tell those apart, so it is not used here. Events are fed
 * in arrival order, and the tracker only exists once the prompt is being sent, so a turn that
 * ended before then is never counted.
 */
export class TurnEndTracker {
  private finished = false;
  private generation = 0;
  private messageId: string | undefined;
  private text = "";

  observe(event: AgentEvent): TurnEndVerdict {
    // Snapshots describe state from before the prompt. Status updates are not trusted either way:
    // Hub asks the daemon for the agent's status when the settle timer fires.
    if (event.type !== "agent_stream") return "none";
    const stream = event.event;
    switch (stream.type) {
      case "turn_completed":
        this.finished = true;
        this.generation += 1;
        return "finished";
      case "thread_started":
        return "none";
      case "attention_required":
        return stream.reason === "finished" ? "none" : this.interrupt(true);
      case "timeline": {
        const item = stream.item;
        if (item.type === "assistant_message" && typeof item.text === "string") {
          this.append(item.messageId, item.text);
          return this.interrupt(false);
        }
        // Reasoning sits beside the answer. Anything else is work, so earlier text is not final.
        return this.interrupt(item.type !== "reasoning");
      }
      // turn_started, turn_failed, turn_canceled, permission_requested, permission_resolved, and
      // any event added later: not a normal turn end, so none of it may complete the run.
      default:
        return this.interrupt(true);
    }
  }

  /** Whether the turn end seen at `generation` is still the latest word from the agent. */
  isCurrent(generation: number): boolean {
    return this.finished && this.generation === generation;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** The agent's closing text: the trailing assistant message after its last piece of work. */
  finalOutput(): { text: string; truncated: boolean } | undefined {
    const text = this.text.trim();
    if (text.length === 0) return undefined;
    return text.length > MAX_TURN_END_OUTPUT_CHARS
      ? { text: text.slice(0, MAX_TURN_END_OUTPUT_CHARS), truncated: true }
      : { text, truncated: false };
  }

  private interrupt(clearText: boolean): TurnEndVerdict {
    if (clearText) {
      this.text = "";
      this.messageId = undefined;
    }
    const wasFinished = this.finished;
    this.finished = false;
    return wasFinished ? "active" : "none";
  }

  private append(messageId: string | undefined, text: string): void {
    if (messageId !== undefined && this.messageId !== undefined && messageId !== this.messageId) {
      this.text = "";
    }
    if (messageId !== undefined) this.messageId = messageId;
    this.text += text;
  }
}
