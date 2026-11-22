import type { AgentEvent, AgentTimelinePage } from "../daemons/agents/index.js";
import type { TimelineScrubber } from "../run-timeline/capture-types.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { createAssistantTextRedactor } from "../assistant-text/redact.js";
import { readTimelineScrubValues } from "../run-timeline/secrets.js";
import type { TranscriptItem } from "./types.js";

const MAX_ASSISTANT_BYTES = 64 * 1024;
const MAX_LIVE_MESSAGES = 64;
const TEXT_LOOKAHEAD = 64;
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
  private readonly prose: ReturnType<typeof createAssistantTextRedactor>;

  constructor(
    knownValues: readonly string[] = readTimelineScrubValues(process.env),
    private readonly scrub: TimelineScrubber = createTimelineScrubber({ scrubValues: knownValues }),
  ) {
    this.prose = createAssistantTextRedactor(knownValues);
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
      let remaining = MAX_ASSISTANT_BYTES;
      let overflowAt = -1;
      const bounded = parts.map(({ text }, index) => {
        if (overflowAt !== -1) return "";
        const part = limitText(text, remaining);
        remaining -= part.bytes;
        if (part.truncated) overflowAt = index;
        return part.text;
      });
      const safe = this.prose.redact(bounded, overflowAt !== -1);
      let limit = MAX_ASSISTANT_BYTES;
      let truncated = false;
      for (const [index, { entry }] of parts.entries()) {
        const item = this.assistantDelta(
          safe[index]!,
          historyPosition(entry),
          limit,
          index === overflowAt,
        );
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
    const input = limitText(value, MAX_ASSISTANT_BYTES);
    const safe = this.prose.redact([input.text], input.truncated)[0]!;
    return this.assistantDelta(safe, position, MAX_ASSISTANT_BYTES, input.truncated);
  }

  openAssistant() {
    return this.prose.open();
  }

  assistantDelta(
    value: string,
    position: Position,
    limit: number,
    overflow: boolean,
  ): AssistantItem {
    const cut = limitText(value, limit);
    return {
      kind: "assistant",
      ...this.safePosition(position),
      text: cut.text,
      truncated: overflow || cut.truncated,
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

// Slice the UTF-16 input first so the byte count never scans the discarded suffix.
function limitText(
  value: string,
  limit: number,
): { text: string; bytes: number; truncated: boolean } {
  let text = value.slice(0, limit);
  if (text.length < value.length && /[\uD800-\uDBFF]/u.test(text.at(-1) ?? ""))
    text = text.slice(0, -1);
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return { text, bytes, truncated: text.length < value.length };
  const buffer = Buffer.from(text);
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), bytes: end, truncated: true };
}

interface PendingChunk {
  position: Position;
  text: string;
  offset: number;
  overflow: boolean;
}

interface BufferedAssistant {
  chunks: PendingChunk[];
  turnId: string | undefined;
  redact: ReturnType<SessionTranscriptNormalizer["openAssistant"]>;
  inputBytes: number;
  outputBytes: number;
  truncated: boolean;
}

interface TranscriptFrame {
  epoch: string;
  item: TranscriptItem;
}
export type RelayedTranscript = TranscriptFrame | { gap: "behind" | "epoch_changed" };

export class LiveSessionTranscript {
  private current: string | undefined;
  private readonly messages = new Map<string, BufferedAssistant>();
  private saturated = false;
  private epoch: string | undefined;
  private seenSeq = -1;

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
        this.flushCurrent(output, false);
        output.push({ epoch: event.epoch, item: frame });
      }
      return output;
    }

    if (this.saturated) return output;
    const position = streamPosition(event, event.seq);
    const identity = assistantIdentity(position.turnId, item.messageId);
    if (this.current !== identity) this.flushCurrent(output, false);
    const prior = this.messages.get(identity);
    if (!prior && this.messages.size >= MAX_LIVE_MESSAGES) {
      this.clearMessages();
      this.saturated = true;
      output.push({ gap: "behind" });
      return output;
    }
    const message = prior ?? {
      chunks: [],
      turnId: position.turnId,
      redact: this.normalizer.openAssistant(),
      inputBytes: 0,
      outputBytes: 0,
      truncated: false,
    };
    this.current = identity;
    this.messages.set(identity, message);
    if (message.truncated) return output;
    const raw = limitText(item.text, MAX_ASSISTANT_BYTES - message.inputBytes);
    message.inputBytes += raw.bytes;
    if (raw.text.length > 0 || raw.truncated)
      message.chunks.push({ position, text: raw.text, offset: 0, overflow: raw.truncated });
    this.release(message, raw.truncated, false, output);
    return output;
  }

  private resetEpoch(epoch: string): RelayedTranscript[] {
    if (this.epoch === epoch) return [];
    const gap: RelayedTranscript[] = this.epoch === undefined ? [] : [{ gap: "epoch_changed" }];
    this.epoch = epoch;
    this.clearMessages();
    this.seenSeq = -1;
    return gap;
  }

  private clearMessages(): void {
    this.current = undefined;
    this.messages.clear();
    this.saturated = false;
  }

  private flushCurrent(output: RelayedTranscript[], final: boolean): void {
    if (this.current === undefined) return;
    const message = this.messages.get(this.current);
    if (message) this.release(message, true, final, output);
    this.current = undefined;
  }

  private release(
    message: BufferedAssistant,
    boundary: boolean,
    final: boolean,
    output: RelayedTranscript[],
  ): void {
    if (message.truncated || message.chunks.length === 0) return;
    const source = message.chunks.map(({ text }) => text).join("");
    let end = boundary ? source.length : Math.max(0, source.length - TEXT_LOOKAHEAD);
    if (!boundary && /[\uD800-\uDBFF]/u.test(source[end - 1] ?? "")) end -= 1;
    if (end === 0 && !boundary) return;

    const parts = takeChunks(message, end, boundary);
    const safe = message.redact(
      source,
      parts.map(({ text }) => text),
      end,
      boundary,
      final,
    );
    for (const [index, part] of parts.entries()) {
      const item = this.normalizer.assistantDelta(
        safe[index]!,
        part.chunk.position,
        MAX_ASSISTANT_BYTES - message.outputBytes,
        part.chunk.overflow && part.done,
      );
      message.outputBytes += Buffer.byteLength(item.text);
      message.truncated = item.truncated;
      if (item.text.length > 0 || item.truncated || (part.done && part.previousOffset > 0)) {
        if (!part.done && !item.truncated) item.chunkOffset = part.chunk.offset;
        if (part.previousOffset > 0) item.chunkStart = part.previousOffset;
        output.push({ epoch: this.epoch!, item });
      }
      if (item.truncated) {
        message.chunks.length = 0;
        break;
      }
    }
  }

  finish(turnId?: string): RelayedTranscript[] {
    const output: RelayedTranscript[] = [];
    this.saturated = false;
    for (const [identity, message] of this.messages) {
      const owner = message.turnId;
      if (owner !== undefined && turnId !== undefined && owner !== turnId) continue;
      this.release(message, true, true, output);
      this.messages.delete(identity);
      if (this.current === identity) this.current = undefined;
    }
    return output;
  }
}

function takeChunks(message: BufferedAssistant, take: number, boundary: boolean) {
  const result: { chunk: PendingChunk; previousOffset: number; text: string; done: boolean }[] = [];
  for (const chunk of message.chunks) {
    if (take === 0 && !(boundary && chunk.text.length === 0)) break;
    const consumed = Math.min(take, chunk.text.length);
    const done = consumed === chunk.text.length;
    const text = chunk.text.slice(0, consumed);
    result.push({ chunk, previousOffset: chunk.offset, text, done });
    chunk.offset += consumed;
    chunk.text = chunk.text.slice(consumed);
    take -= consumed;
  }
  message.chunks.splice(0, result.filter(({ done }) => done).length);
  return result;
}
