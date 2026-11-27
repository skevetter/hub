import { describe, expect, it } from "vitest";
import {
  appendAgentItem,
  initialAgentFeed,
  mergeHistoryPage,
  parseSessionCursor,
  transcriptItems,
  type SessionMessage,
} from "./session-feed.js";

const at = "2026-11-20T00:00:00Z";
const epoch = "agent:epoch";

function reply(seq: number, text: string, truncated = false) {
  return { kind: "assistant" as const, seq, text, truncated, at };
}

describe("session transcript feed", () => {
  it("preserves newest live cursors and only advances the older boundary for covered pages", () => {
    const cursor = (seq: number) => ({ epoch, seq });
    const page = (seq: number) => ({
      epoch,
      startCursor: cursor(seq),
      endCursor: cursor(seq),
      entries: [{ ...reply(seq, `history ${seq}`), seqStart: seq, seqEnd: seq }],
      hasOlder: true,
    });
    const live = appendAgentItem(initialAgentFeed(), epoch, reply(5, "live"), 1);
    const loaded = mergeHistoryPage(live, page(3));
    const later = mergeHistoryPage(loaded, page(4));
    expect(later.rows.map(({ item }) => item.seq)).toEqual([3, 4, 5]);
    expect(later.cursor).toEqual(cursor(5));
    expect(later.before).toEqual(cursor(3));
    expect(mergeHistoryPage(later, page(4), true).before).toEqual(cursor(4));
    expect(mergeHistoryPage(later, { ...page(2), hasOlder: false }).before).toBeNull();
    expect(mergeHistoryPage(later, { ...page(2), epoch: "other" }).rows).toHaveLength(1);
    const empty = { ...page(2), startCursor: null, endCursor: null, entries: [] };
    expect(mergeHistoryPage(later, empty)).toEqual(later);
  });

  it("rejects unsafe cursor components and preserves accepted offsets and epoch punctuation", () => {
    for (const invalid of [
      "",
      "-1",
      "9007199254740992",
      "1:9007199254740992:e",
      "1:2.0:e",
      "1:2.65537:e",
      "1:2.9007199254740992:e",
      "1:2:e\n",
      "1:2:" + "e".repeat(201),
    ]) {
      expect(parseSessionCursor(invalid)).toBeUndefined();
    }
    expect(parseSessionCursor("0001")).toEqual({ hubSeq: 1, agent: null });
    expect(parseSessionCursor("1:2:agent:epoch")).toEqual({ hubSeq: 1, agent: { seq: 2, epoch } });
    expect(parseSessionCursor("1:2.65536:agent:epoch")).toEqual({
      hubSeq: 1,
      agent: { seq: 2, epoch, chunkOffset: 65536 },
    });
  });

  it("merges adjacent assistant chunks and keeps the first human anchor and delivery status", () => {
    let feed = initialAgentFeed();
    feed = appendAgentItem(feed, epoch, reply(1, "reply "), 1);
    feed = appendAgentItem(feed, epoch, reply(2, "continued", true), 1);
    feed = appendAgentItem(feed, epoch, reply(3, "new turn"), 2);
    feed = appendAgentItem(
      feed,
      epoch,
      { kind: "tool", seq: 4, name: "tool", at, status: "failed" },
      2,
    );
    feed = appendAgentItem(feed, epoch, reply(5, "after tool"), 2);
    for (const seq of [6, 7])
      feed = appendAgentItem(feed, epoch, { kind: "human", seq, at, commandId: "command" }, 2);
    const message = {
      commandId: "command",
      ordinal: 2,
      authorName: "Author",
      text: "prompt",
      expired: false,
      retryable: true,
      status: "unknown",
      delivery: "queue",
      createdAt: at,
    } satisfies SessionMessage;
    const items = transcriptItems(feed, [
      message,
      { ...message, commandId: "old", ordinal: 1, expired: true },
    ]);
    expect(items).toMatchObject([
      { kind: "assistant", seq: 1, text: "reply continued", truncated: true },
      { kind: "assistant", seq: 3, text: "new turn" },
      { kind: "tool", seq: 4, status: "failed" },
      { kind: "assistant", seq: 5, text: "after tool" },
      { kind: "human", id: "old", seq: null, text: null, status: "unknown", retryable: false },
      { kind: "human", id: "command", seq: 6, text: "prompt", status: "unknown", retryable: true },
    ]);
  });
});
