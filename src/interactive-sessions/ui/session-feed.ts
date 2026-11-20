import type {
  DeliveryStatus,
  TranscriptItem as DisplayItem,
} from "../../components/app/transcript-types.js";
import type { HistoryPage, SessionSnapshot } from "../functions.js";
import type { AgentCursor } from "../service.js";
import { compareAgentPosition, type CommandStatus, type TranscriptItem } from "../types.js";

type History = Extract<HistoryPage, { entries: unknown }>;
export type SessionMessage = SessionSnapshot["messages"][number];

interface FeedRow {
  item: TranscriptItem;
  start: number;
  end: number;
  turn?: number;
  projected: boolean;
}

export interface AgentFeed {
  epoch: string | null;
  cursor: AgentCursor | null;
  before: AgentCursor | null;
  rows: readonly FeedRow[];
}

export function initialAgentFeed(): AgentFeed {
  return { epoch: null, cursor: null, before: null, rows: [] };
}

export function appendAgentItem(
  feed: AgentFeed,
  epoch: string,
  item: TranscriptItem,
  turn: number,
): AgentFeed {
  const current = feed.epoch === epoch ? feed : initialAgentFeed();
  if (current.cursor && compareAgentPosition(item, current.cursor) <= 0) return feed;
  const chunkOffset = item.kind === "assistant" ? item.chunkOffset : undefined;
  return {
    ...current,
    epoch,
    cursor: { epoch, seq: item.seq, ...(chunkOffset === undefined ? {} : { chunkOffset }) },
    rows: [...current.rows, { item, start: item.seq, end: item.seq, turn, projected: false }],
  };
}

export function mergeHistoryPage(feed: AgentFeed, page: History, older = false): AgentFeed {
  const current = feed.epoch === page.epoch ? feed : initialAgentFeed();
  const first = page.startCursor?.seq;
  const last = page.endCursor?.seq;
  const uncovered = current.rows.filter(
    ({ start, end }) => first === undefined || last === undefined || end < first || start > last,
  );
  const loaded = page.entries.map((item) => ({
    item,
    start: item.seqStart,
    end: item.seqEnd,
    projected: true,
  }));
  const cursor =
    current.cursor !== null &&
    (page.endCursor === null || compareAgentPosition(current.cursor, page.endCursor) > 0)
      ? current.cursor
      : page.endCursor;
  const extendsEarlier =
    older || (current.before !== null && first !== undefined && first <= current.before.seq);
  const canSetBefore =
    current.rows.length === 0 ||
    current.rows.every(({ projected }) => !projected) ||
    extendsEarlier;
  const pageBefore = page.hasOlder ? page.startCursor : null;
  return {
    epoch: page.epoch,
    cursor,
    before: canSetBefore ? pageBefore : current.before,
    rows: [...uncovered, ...loaded].sort((left, right) =>
      compareAgentPosition(left.item, right.item),
    ),
  };
}

export function sessionCursor(hubSeq: number, agent: AgentCursor | null): string {
  if (agent === null) return String(hubSeq);
  const offset = agent.chunkOffset === undefined ? "" : `.${agent.chunkOffset}`;
  return `${hubSeq}:${agent.seq}${offset}:${agent.epoch}`;
}

export function parseSessionCursor(
  value: string,
): { hubSeq: number; agent: AgentCursor | null } | undefined {
  const match = /^(\d+)(?::(\d+)(?:\.(\d+))?:(.{1,200}))?(?![\s\S])/u.exec(value);
  if (match === null) return undefined;
  const [, hub, sequence, offset, epoch] = match;
  const hubSeq = Number(hub);
  if (!Number.isSafeInteger(hubSeq)) return undefined;
  if (epoch === undefined) return { hubSeq, agent: null };
  const seq = Number(sequence);
  if (!Number.isSafeInteger(seq)) return undefined;
  const chunkOffset = offset === undefined ? undefined : Number(offset);
  if (
    chunkOffset !== undefined &&
    (!Number.isSafeInteger(chunkOffset) || chunkOffset < 1 || chunkOffset > 65536)
  )
    return undefined;
  return { hubSeq, agent: { seq, epoch, ...(chunkOffset === undefined ? {} : { chunkOffset }) } };
}

const deliveryStatus: Record<CommandStatus, DeliveryStatus> = {
  pending: "sending",
  queued: "queued",
  dispatching: "sending",
  delivered: "delivered",
  unknown: "unknown",
  superseded: "not_sent",
  failed: "failed",
  done: "delivered",
};

export function transcriptItems(
  feed: AgentFeed,
  messages: readonly SessionMessage[],
): DisplayItem[] {
  const displayed: DisplayItem[] = [];
  const anchors = new Map<string, number>();
  let previous: FeedRow | undefined;
  let assistant: Extract<DisplayItem, { kind: "assistant" }> | undefined;
  for (const row of feed.rows) {
    const { item } = row;
    const id = `agent:${feed.epoch ?? ""}:${row.start}`;
    if (item.kind === "assistant") {
      if (assistant !== undefined && sameAssistantTurn(previous, row, item)) {
        assistant.text += item.text;
        assistant.truncated ||= item.truncated;
      } else {
        assistant = {
          id,
          kind: "assistant",
          seq: row.start,
          text: item.text,
          truncated: item.truncated,
        };
        displayed.push(assistant);
      }
    } else if (item.kind === "tool") {
      displayed.push({ id, kind: "tool", seq: item.seq, name: item.name, status: item.status });
    } else if (item.commandId !== null && !anchors.has(item.commandId)) {
      anchors.set(item.commandId, item.seq);
    }
    previous = row;
  }
  for (const message of messages.toSorted((left, right) => left.ordinal - right.ordinal)) {
    displayed.push({
      id: message.commandId,
      kind: "human",
      seq: anchors.get(message.commandId) ?? null,
      author: message.authorName,
      text: message.expired ? null : message.text,
      status: deliveryStatus[message.status],
      retryable: message.retryable && !message.expired,
    });
  }
  return displayed;
}

function sameAssistantTurn(
  previous: FeedRow | undefined,
  row: FeedRow,
  item: Extract<TranscriptItem, { kind: "assistant" }>,
) {
  if (previous?.item.kind !== "assistant") return false;
  const previousTurn = previous.item.turnId;
  return (
    (previousTurn === undefined || item.turnId === undefined || previousTurn === item.turnId) &&
    (previous.turn === undefined || row.turn === undefined || previous.turn === row.turn)
  );
}
