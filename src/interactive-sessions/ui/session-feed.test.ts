import { expect, it } from "vitest";
import type { TranscriptItem } from "../types.js";
import {
  appendAgentItem,
  initialAgentFeed,
  mergeHistoryPage,
  parseSessionCursor,
  sessionCursor,
  transcriptItems,
} from "./session-feed.js";

function reply(seq: number, text: string): Extract<TranscriptItem, { kind: "assistant" }> {
  return { kind: "assistant", seq, text, truncated: false, at: "2026-01-01T00:00:00.000Z" };
}

it("replaces overlapping live text with projected history and adds later chunks once", () => {
  const live = appendAgentItem(
    initialAgentFeed(),
    "e:1",
    { ...reply(3, "hel"), chunkOffset: 3 },
    1,
  );
  const loaded = mergeHistoryPage(live, {
    epoch: "e:1",
    startCursor: { epoch: "e:1", seq: 2 },
    endCursor: { epoch: "e:1", seq: 3 },
    hasOlder: true,
    entries: [{ ...reply(3, "hello"), seqStart: 2, seqEnd: 3 }],
  });
  const repeated = appendAgentItem(loaded, "e:1", { ...reply(3, "lo"), chunkStart: 3 }, 1);
  const next = appendAgentItem(repeated, "e:1", reply(4, " world"), 1);
  expect(transcriptItems(next, [])).toMatchObject([{ kind: "assistant", text: "hello world" }]);
});

it("orders byte-framed deltas and keeps independent Hub and agent cursors", () => {
  const first = appendAgentItem(
    initialAgentFeed(),
    "opaque:epoch",
    { ...reply(7, "first "), chunkOffset: 6 },
    2,
  );
  const final = appendAgentItem(first, "opaque:epoch", { ...reply(7, "last"), chunkStart: 6 }, 2);
  expect(transcriptItems(final, [])).toMatchObject([{ kind: "assistant", text: "first last" }]);
  expect(sessionCursor(23, first.cursor)).toBe("23:7.6:opaque:epoch");
  expect(parseSessionCursor("24:7.6:opaque:epoch")).toEqual({
    hubSeq: 24,
    agent: { epoch: "opaque:epoch", seq: 7, chunkOffset: 6 },
  });
  expect(sessionCursor(24, final.cursor)).toBe("24:7:opaque:epoch");
});
