import { expect, it, vi } from "vitest";
import { readDroppedEventPage } from "./dropped-events.js";
import type { QueryHandle, QueryRow } from "./runtime/index.js";
import type { DroppedEventPageRequest } from "./types.js";

const date = new Date("2026-01-02T00:00:00Z");
const cursor = { createdAt: "2026-01-02 00:00:00.000001+00", id: "target" };
const row = {
  id: "receipt",
  provider: "manual",
  source: "webhook.received",
  reason: "trigger_filters_rejected",
  received_at: date,
  cursor_time: "2026-01-02 00:00:00.000002+00",
  workspace: "workspace",
  trigger_id: "trigger",
};
const key = { createdAt: row.cursor_time, id: row.id };

function paged(...batches: QueryRow[][]) {
  const database: QueryHandle = {
    async query() {
      throw new Error("unexpected query");
    },
  };
  const query = vi.spyOn(database, "query");
  for (const rows of batches) query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  return {
    query,
    read: (request: DroppedEventPageRequest) => readDroppedEventPage(database, "org", request),
  };
}

it("maps the first page with stable keys, using the extra row only to detect older results", async () => {
  const { read, query } = paged([row, { ...row, id: "next" }]);
  const result = await read({ limit: 1 });
  expect(JSON.stringify(result)).toBe(
    JSON.stringify({
      records: [
        {
          id: "receipt",
          provider: "webhook",
          source: "webhook.received",
          reason: "trigger_filters_rejected",
          triggerId: "trigger",
          workspaceOrRepo: "workspace",
          receivedAt: date.toISOString(),
        },
      ],
      older: key,
      newer: null,
    }),
  );
  expect(query.mock.calls.map(([, params]) => params)).toEqual([["org", 2]]);
});

it("preserves SQL filter parameter order and the before-page adjacent probe", async () => {
  const { read, query } = paged([row], [{}]);
  const result = await read({
    limit: 1,
    position: { direction: "before", key: cursor },
    provider: "manual",
    source: "webhook.received",
    reason: "trigger_filters_rejected",
    receivedSince: date,
  });
  expect([result.older, result.newer]).toEqual([null, key]);
  expect(query.mock.calls.map(([, params]) => params)).toEqual([
    [
      "org",
      "manual",
      "webhook.received",
      date,
      "trigger_filters_rejected",
      cursor.createdAt,
      cursor.id,
      2,
    ],
    ["org", "manual", "webhook.received", date, "trigger_filters_rejected", key.createdAt, key.id],
  ]);
});

it("reverses after-page rows and probes only the adjacent older page", async () => {
  const newest = { ...row, id: "newest", cursor_time: "2026-01-02 00:00:00.000003+00" };
  const { read, query } = paged([row, newest, { ...row, id: "extra" }], []);
  const result = await read({ limit: 2, position: { direction: "after", key: cursor } });
  expect(result.records.map(({ id }) => id)).toEqual(["newest", "receipt"]);
  expect([result.older, result.newer]).toEqual([
    null,
    { createdAt: newest.cursor_time, id: "newest" },
  ]);
  expect(query.mock.calls.map(([, params]) => params)).toEqual([
    ["org", cursor.createdAt, cursor.id, 3],
    ["org", row.cursor_time, row.id],
  ]);
  const empty = paged([]);
  expect(await empty.read({ limit: 2, position: { direction: "after", key: cursor } })).toEqual({
    records: [],
    older: null,
    newer: null,
  });
  expect(empty.query.mock.calls.length).toBe(1);
});
