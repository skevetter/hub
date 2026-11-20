import type { AgentEvent, AgentTimelinePage } from "../daemons/agents/index.js";
import type { TimelineScrubber } from "../run-timeline/capture-types.js";
import { createTimelineScrubber, createTimelineSpanScrubber } from "../run-timeline/scrub.js";
import { readTimelineScrubValues } from "../run-timeline/secrets.js";
import type { TranscriptItem } from "./types.js";

const MAX_ASSISTANT_BYTES = 64 * 1024;
const MAX_LIVE_MESSAGES = 64;
const TOOL_NAME = /^[A-Za-z0-9_.:/ -]{1,64}(?![\s\S])/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

interface Position {
  seq: number;
  at: string;
  turnId?: string | undefined;
}

interface Item {
  type: string;
  text?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  messageId?: string | undefined;
  clientMessageId?: unknown;
}

type StreamItem = Extract<AgentEvent, { type: "agent_stream" }>;
type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
type HistoryItem = TranscriptItem & { seqStart: number; seqEnd: number };
type DaemonHistoryEntry = AgentTimelinePage["entries"][number];

export class SessionTranscriptNormalizer {
  readonly inputLimit: number;
  private readonly prose: ReturnType<typeof createTimelineSpanScrubber>;

  constructor(
    knownValues: readonly string[] = readTimelineScrubValues(process.env),
    private readonly scrub: TimelineScrubber = createTimelineScrubber({ scrubValues: knownValues }),
  ) {
    this.prose = createTimelineSpanScrubber(knownValues);
    // Inspect text beyond the visible boundary before deciding whether a match crosses it.
    this.inputLimit =
      MAX_ASSISTANT_BYTES +
      knownValues.reduce((longest, value) => Math.max(longest, value.length), 512);
  }

  stream(event: AgentEvent): TranscriptItem | undefined {
    if (event.type !== "agent_stream" || event.event.type !== "timeline" || event.seq === undefined)
      return undefined;
    return this.project(event.event.item, streamPosition(event, event.seq));
  }

  history(entry: DaemonHistoryEntry): HistoryItem | undefined {
    const item = this.project(entry.item, historyPosition(entry));
    return item ? { ...item, seqStart: entry.seqStart, seqEnd: entry.seqEnd } : undefined;
  }

  historyEntries(entries: readonly DaemonHistoryEntry[]): HistoryItem[] {
    const groups = new Map<string, { entry: DaemonHistoryEntry; text: string }[]>();
    for (const entry of entries) {
      const { item, turnId } = entry;
      if (
        item.type !== "assistant_message" ||
        (turnId === undefined && item.messageId === undefined)
      )
        continue;
      const id = assistantIdentity(turnId, item.messageId);
      const parts = groups.get(id) ?? [];
      parts.push({ entry, text: item.text });
      groups.set(id, parts);
    }
    const assistantItems = new Map<DaemonHistoryEntry, HistoryItem | undefined>();
    for (const parts of groups.values()) {
      const safe = this.prose.redactParts(parts.map(({ text }) => text));
      let limit = MAX_ASSISTANT_BYTES;
      let truncated = false;
      for (const [index, { entry }] of parts.entries()) {
        const item = this.assistantDelta(safe[index]!, historyPosition(entry), limit, false);
        const visible = !truncated && (item.text.length > 0 || item.truncated);
        assistantItems.set(
          entry,
          visible ? { ...item, seqStart: entry.seqStart, seqEnd: entry.seqEnd } : undefined,
        );
        limit -= Buffer.byteLength(item.text);
        truncated ||= item.truncated;
      }
    }
    return entries.flatMap((entry) => {
      const item = assistantItems.has(entry) ? assistantItems.get(entry) : this.history(entry);
      return item ? [item] : [];
    });
  }

  assistant(value: string, position: Position): AssistantItem {
    return this.assistantDelta(this.prose.redact(value), position, MAX_ASSISTANT_BYTES, false);
  }

  takeAssistant(value: string, boundary: boolean) {
    return this.prose.take(value, boundary);
  }

  finishAssistant(value: string): string {
    return this.prose.redact(value);
  }

  assistantDelta(
    value: string,
    position: Position,
    limit: number,
    overflow: boolean,
  ): AssistantItem {
    const bytes = Buffer.from(value);
    let end = Math.min(bytes.length, limit);
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return {
      kind: "assistant",
      ...this.safePosition(position),
      text: bytes.subarray(0, end).toString("utf8"),
      truncated: overflow || bytes.length > limit,
    };
  }

  private safePosition({ seq, at, turnId }: Position) {
    return { seq, at, ...(turnId && this.scrub(turnId, 200) === turnId ? { turnId } : {}) };
  }

  private project(item: Item, position: Position): TranscriptItem | undefined {
    switch (item.type) {
      case "assistant_message":
        return typeof item.text === "string" ? this.assistant(item.text, position) : undefined;
      case "tool_call": {
        const { status } = item;
        if (
          status !== "running" &&
          status !== "completed" &&
          status !== "failed" &&
          status !== "canceled"
        )
          return undefined;
        const name = typeof item.name === "string" ? this.scrub(item.name, 64) : "";
        return {
          kind: "tool",
          ...this.safePosition(position),
          name: TOOL_NAME.test(name) ? name : "unnamed",
          status,
        };
      }
      case "user_message": {
        const commandId = [item.messageId, item.clientMessageId].find(
          (id): id is string =>
            typeof id === "string" && UUID.test(id) && this.scrub(id, 200) === id,
        );
        return { kind: "human", seq: position.seq, at: position.at, commandId: commandId ?? null };
      }
      default:
        return undefined;
    }
  }
}

function streamPosition(event: StreamItem, seq: number): Position {
  const turnId = event.event["turnId"];
  return { seq, at: event.timestamp, turnId: typeof turnId === "string" ? turnId : undefined };
}

function historyPosition(entry: DaemonHistoryEntry): Position {
  return { seq: entry.seqEnd, turnId: entry.turnId, at: entry.timestamp };
}

function assistantIdentity(turnId: string | undefined, messageId: string | undefined): string {
  return JSON.stringify([turnId, messageId]);
}

interface BufferedAssistant {
  identity: string;
  position: Position;
  text: string;
  bytes: number;
  overflow: boolean;
  truncated: boolean;
}

interface TranscriptFrame {
  epoch: string;
  item: TranscriptItem;
}
export type RelayedTranscript = TranscriptFrame | { gap: "behind" | "epoch_changed" };

export class LiveSessionTranscript {
  private current: BufferedAssistant | undefined;
  private readonly messages = new Map<string, BufferedAssistant>();
  private saturated = false;
  private epoch: string | undefined;
  private seenSeq = -1;
  private emittedSeq = -1;

  constructor(private readonly normalizer: SessionTranscriptNormalizer) {}

  accept(event: StreamItem): RelayedTranscript[] {
    if (!event.epoch || event.seq === undefined || event.event.type !== "timeline") return [];
    const output = this.resetEpoch(event.epoch);
    if (event.seq <= this.seenSeq) return output;
    this.seenSeq = event.seq;

    const { item } = event.event;
    if (item.type !== "assistant_message" || typeof item.text !== "string") {
      const frame = this.normalizer.stream(event);
      if (frame) {
        const current = this.current;
        if (current) this.release(current, current.position, true, output);
        this.emittedSeq = frame.seq;
        output.push({ epoch: event.epoch, item: frame });
      }
      return output;
    }

    if (this.saturated) return output;
    const position = streamPosition(event, event.seq);
    const identity = assistantIdentity(position.turnId, item.messageId);
    if (this.current && this.current.identity !== identity)
      this.release(this.current, this.current.position, true, output);
    const prior = this.messages.get(identity);
    if (!prior && this.messages.size >= MAX_LIVE_MESSAGES) {
      this.clearMessages();
      this.saturated = true;
      output.push({ gap: "behind" });
      return output;
    }
    const current = prior ?? {
      identity,
      position,
      text: "",
      bytes: 0,
      overflow: false,
      truncated: false,
    };
    const previous = current.position;
    this.current = current;
    if (!prior) this.messages.set(identity, current);
    current.position = position;
    if (current.truncated) return output;

    const remaining = this.normalizer.inputLimit - current.text.length;
    if (!current.overflow) {
      current.text += item.text.slice(0, remaining);
      current.overflow = item.text.length > remaining;
    }
    // Reserve the newest daemon sequence for the withheld tail at a tool or turn boundary.
    if (previous.seq < position.seq) this.release(current, previous, false, output);
    return output;
  }

  private resetEpoch(epoch: string): RelayedTranscript[] {
    if (this.epoch === epoch) return [];
    const gap: RelayedTranscript[] = this.epoch === undefined ? [] : [{ gap: "epoch_changed" }];
    this.epoch = epoch;
    this.clearMessages();
    this.seenSeq = -1;
    this.emittedSeq = -1;
    return gap;
  }

  private clearMessages(): void {
    this.current = undefined;
    this.messages.clear();
    this.saturated = false;
  }

  private release(
    current: BufferedAssistant,
    position: Position,
    boundary: boolean,
    output: RelayedTranscript[],
  ): void {
    if (current.truncated || position.seq <= this.emittedSeq) return;
    const safe = this.normalizer.takeAssistant(current.text, boundary);
    current.text = safe.remaining;
    if (safe.text.length !== 0) this.emit(current, position, safe.text, false, output);
  }

  private emit(
    current: BufferedAssistant,
    position: Position,
    text: string,
    overflow: boolean,
    output: RelayedTranscript[],
  ): void {
    const item = this.normalizer.assistantDelta(
      text,
      position,
      MAX_ASSISTANT_BYTES - current.bytes,
      overflow,
    );
    if (item.text.length === 0 && !item.truncated) return;
    current.bytes += Buffer.byteLength(item.text);
    current.truncated = item.truncated;
    this.emittedSeq = position.seq;
    output.push({ epoch: this.epoch!, item });
  }

  finish(turnId?: string): RelayedTranscript[] {
    const output: RelayedTranscript[] = [];
    this.saturated = false;
    const messages = [...this.messages.values()].sort((a, b) => a.position.seq - b.position.seq);
    let behind = false;
    for (const message of messages) {
      const { position, text, truncated, overflow, identity } = message;
      if (turnId !== undefined && position.turnId !== undefined && position.turnId !== turnId)
        continue;
      this.messages.delete(identity);
      if (this.current === message) this.current = undefined;
      if (truncated || (text.length === 0 && !overflow)) continue;
      if (position.seq <= this.emittedSeq) behind = true;
      else this.emit(message, position, this.normalizer.finishAssistant(text), overflow, output);
    }
    if (behind) output.push({ gap: "behind" });
    return output;
  }
}
