import type { AgentEvent, AgentTimelinePage } from "../daemons/agents/index.js";
import type { TimelineScrubber } from "../run-timeline/capture-types.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { readTimelineScrubValues } from "../run-timeline/secrets.js";
import type { TranscriptItem } from "./types.js";

const MAX_ASSISTANT_BYTES = 64 * 1024;
const MAX_DEFERRED_ITEMS = 256;
const TOOL_NAME = /^[A-Za-z0-9_.:/ -]{1,64}(?![\s\S])/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

const CREDENTIALS = [
  /\bBearer[ \t]+([A-Za-z0-9._~+/-]{4,}={0,2})/giu,
  /\b((?:ghp_|github_pat_|lin_api_)[A-Za-z0-9_]{8,})/gu,
  /\b(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gu,
  /\b(?:[a-z0-9]+[-_])*(?:key|token|secret|password)\b["']?[ \t]*[:=][ \t]*["']?([a-z0-9+/_-]{24,}={0,2})/giu,
] as const;

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

export class SessionTranscriptNormalizer {
  readonly inputLimit: number;
  private readonly knownValues: readonly string[];

  constructor(
    knownValues: readonly string[] = readTimelineScrubValues(process.env),
    private readonly scrub: TimelineScrubber = createTimelineScrubber({ scrubValues: knownValues }),
  ) {
    this.knownValues = [...new Set(knownValues.filter((value) => value.length > 0))];
    // Inspect text beyond the visible boundary before deciding whether a match crosses it.
    this.inputLimit =
      MAX_ASSISTANT_BYTES +
      this.knownValues.reduce((longest, value) => Math.max(longest, value.length), 512);
  }

  stream(event: AgentEvent): TranscriptItem | undefined {
    if (event.type !== "agent_stream" || event.event.type !== "timeline" || event.seq === undefined)
      return undefined;
    return this.project(event.event.item, streamPosition(event, event.seq));
  }

  history(entry: AgentTimelinePage["entries"][number]): HistoryItem | undefined {
    const item = this.project(entry.item, {
      seq: entry.seqEnd,
      turnId: entry.turnId,
      at: entry.timestamp,
    });
    return item ? { ...item, seqStart: entry.seqStart, seqEnd: entry.seqEnd } : undefined;
  }

  assistant(value: string, position: Position, overflow = false): AssistantItem {
    const scrubbed = redactProse(value, this.knownValues);
    const bytes = Buffer.from(scrubbed);
    let end = Math.min(bytes.length, MAX_ASSISTANT_BYTES);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return {
      kind: "assistant",
      ...this.safePosition(position),
      text: bytes.subarray(0, end).toString("utf8"),
      truncated: overflow || bytes.length > MAX_ASSISTANT_BYTES,
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

interface Span {
  start: number;
  end: number;
}

function redactProse(text: string, knownValues: readonly string[]): string {
  const spans: Span[] = [];
  for (const value of knownValues) {
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
      spans.push({ start, end: start + value.length });
    }
  }
  for (const pattern of CREDENTIALS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]!;
      const start = match.index + match[0].length - value.length;
      spans.push({ start, end: start + value.length });
    }
  }
  if (spans.length === 0) return text;
  spans.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let end = 0;
  for (const span of spans) {
    if (span.start >= end) parts.push(text.slice(end, span.start), "[redacted]");
    end = Math.max(end, span.end);
  }
  parts.push(text.slice(end));
  return parts.join("");
}

function streamPosition(event: StreamItem, seq: number): Position {
  const turnId = event.event["turnId"];
  return { seq, at: event.timestamp, turnId: typeof turnId === "string" ? turnId : undefined };
}

interface BufferedAssistant {
  identity: string;
  epoch: string;
  position: Position;
  text: string;
  overflow: boolean;
}

interface TranscriptFrame {
  epoch: string;
  item: TranscriptItem;
}
export type RelayedTranscript = TranscriptFrame | { gap: "behind" | "epoch_changed" };

export class LiveSessionTranscript {
  private current: BufferedAssistant | undefined;
  private deferred: TranscriptFrame[] = [];
  private behind = false;

  constructor(private readonly normalizer: SessionTranscriptNormalizer) {}

  accept(event: StreamItem): RelayedTranscript[] {
    if (!event.epoch || event.seq === undefined || event.event.type !== "timeline") return [];
    const { item } = event.event;
    const completed = this.resetEpoch(event.epoch);
    if (item.type !== "assistant_message" || typeof item.text !== "string") {
      const normalized = this.normalizer.stream(event);
      if (normalized) this.acceptFrame({ epoch: event.epoch, item: normalized }, completed);
      return completed;
    }

    const position = streamPosition(event, event.seq);
    const identity = JSON.stringify([event.epoch, position.turnId, item.messageId]);
    if (this.current?.identity !== identity) completed.push(...this.finish());
    const current = this.current ?? {
      identity,
      epoch: event.epoch,
      position,
      text: "",
      overflow: false,
    };
    if (this.current && position.seq <= current.position.seq) return completed;
    const remaining = this.normalizer.inputLimit - current.text.length;
    current.text += item.text.slice(0, remaining);
    current.overflow ||= item.text.length > remaining;
    current.position = position;
    this.current = current;
    return completed;
  }

  private resetEpoch(epoch: string): RelayedTranscript[] {
    if (!this.current || this.current.epoch === epoch) return [];
    this.current = undefined;
    this.deferred = [];
    this.behind = false;
    return [{ gap: "epoch_changed" }];
  }

  private acceptFrame(frame: TranscriptFrame, completed: RelayedTranscript[]): void {
    if (!this.current) {
      completed.push(frame);
    } else if (this.deferred.length < MAX_DEFERRED_ITEMS) {
      this.deferred.push(frame);
    } else {
      this.behind = true;
    }
  }

  finish(turnId?: string): RelayedTranscript[] {
    const current = this.current;
    if (
      !current ||
      (turnId !== undefined &&
        current.position.turnId !== undefined &&
        current.position.turnId !== turnId)
    )
      return [];
    const completed = this.deferred;
    completed.push({
      epoch: current.epoch,
      item: this.normalizer.assistant(current.text, current.position, current.overflow),
    });
    completed.sort((left, right) => left.item.seq - right.item.seq);
    const tail: RelayedTranscript[] = this.behind ? [{ gap: "behind" }] : [];
    this.current = undefined;
    this.deferred = [];
    this.behind = false;
    return [...completed, ...tail];
  }
}
