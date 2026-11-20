import type { AgentEvent, AgentTimelinePage } from "../daemons/agents/index.js";
import type { TimelineScrubber } from "../run-timeline/capture-types.js";
import type { TranscriptItem } from "./types.js";

const MAX_ASSISTANT_BYTES = 64 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_.:/ -]{1,64}(?![\s\S])/u;

export function normalizeAgentStreamItem(
  event: AgentEvent,
  scrub: TimelineScrubber,
): TranscriptItem | undefined {
  if (event.type !== "agent_stream" || event.event.type !== "timeline" || event.seq === undefined)
    return undefined;
  const turnId = event.event["turnId"];
  return normalizeItem(
    event.event.item,
    event.seq,
    event.timestamp,
    typeof turnId === "string" ? turnId : undefined,
    scrub,
  );
}

export function normalizeAgentHistoryEntry(
  entry: AgentTimelinePage["entries"][number],
  scrub: TimelineScrubber,
): TranscriptItem | undefined {
  return normalizeItem(entry.item, entry.seqEnd, entry.timestamp, entry.turnId, scrub);
}

function normalizeItem(
  item: {
    type: string;
    text?: string | undefined;
    name?: string | undefined;
    status?: string | undefined;
    messageId?: string | undefined;
    clientMessageId?: unknown;
  },
  seq: number,
  at: string,
  turnId: string | undefined,
  scrub: TimelineScrubber,
): TranscriptItem | undefined {
  const position = { seq, at, ...(turnId && scrub(turnId, 200) === turnId ? { turnId } : {}) };
  switch (item.type) {
    case "assistant_message": {
      if (typeof item.text !== "string") return undefined;
      const text = scrub(item.text, MAX_ASSISTANT_BYTES);
      return {
        kind: "assistant",
        ...position,
        text,
        truncated: Buffer.byteLength(item.text) > MAX_ASSISTANT_BYTES || text === "[too long]",
      };
    }
    case "tool_call": {
      const { status } = item;
      if (
        status !== "running" &&
        status !== "completed" &&
        status !== "failed" &&
        status !== "canceled"
      )
        return undefined;
      const name = typeof item.name === "string" ? scrub(item.name, 64) : "";
      return { kind: "tool", ...position, name: TOOL_NAME.test(name) ? name : "unnamed", status };
    }
    case "user_message": {
      const id = item.messageId ?? item.clientMessageId;
      return {
        kind: "human",
        seq,
        at,
        commandId: typeof id === "string" && scrub(id, 200) === id ? id : null,
      };
    }
    default:
      return undefined;
  }
}
