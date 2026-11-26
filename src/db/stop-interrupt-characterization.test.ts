import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { QueryHandle, QueryRow } from "./runtime/index.js";
import { postgresStopInterrupts } from "./stop-interrupt.js";

function interrupts(rows: QueryRow[], rowCount = rows.length) {
  const database: QueryHandle = {
    async query() {
      throw new Error("unexpected query");
    },
  };
  const query = vi.spyOn(database, "query").mockResolvedValueOnce({ rows, rowCount });
  return { store: postgresStopInterrupts(database), query };
}

function querySignature(calls: Parameters<QueryHandle["query"]>[]) {
  return calls.map(([sql, params]) => [createHash("sha256").update(sql).digest("hex"), params]);
}

it("claims only the requested execution generation and parses nullable state in order", async () => {
  const missing = interrupts([]);
  expect(await missing.store.claim("execution", "token", null)).toBe(undefined);
  expect(querySignature(missing.query.mock.calls)).toEqual([
    [
      "b25bc172cfd4e3fe9c53f4888cb85f554c42ecb15761d16500a272e73116ac3e",
      ["execution", "token", null],
    ],
  ]);
  const legacy = interrupts([{ state: null, expired: true }]);
  expect(await legacy.store.claim("execution", "new", "prior")).toEqual({
    state: null,
    expired: true,
  });
  expect(querySignature(legacy.query.mock.calls)).toEqual([
    [
      "b25bc172cfd4e3fe9c53f4888cb85f554c42ecb15761d16500a272e73116ac3e",
      ["execution", "new", "prior"],
    ],
  ]);
  const state = { approvedPeerIds: ["p"], requestedAt: "requested", outcome: "coalesced" };
  const present = interrupts([{ state: { ...state, ignored: "field" }, expired: false }]);
  expect(JSON.stringify(await present.store.claim("execution", "token", null))).toBe(
    JSON.stringify({ state, expired: false }),
  );
  await expect(
    interrupts([{ state: {}, expired: false }]).store.claim("execution", "token", null),
  ).rejects.toThrow(/approvedPeerIds/u);
});

it("retains prior coverage and start results without changing their query arguments", async () => {
  for (const outcome of [undefined, "coalesced", "delivery_unconfirmed"]) {
    const { store, query } = interrupts(outcome === undefined ? [] : [{ outcome }]);
    expect(await store.coverage("execution", "agent")).toBe(outcome);
    expect(querySignature(query.mock.calls)).toEqual([
      ["3b93b61ea4ea32d495fa192cdf4873da150294f9fc1d93bcb087b178eb83ca41", ["execution", "agent"]],
    ]);
  }
  const missing = interrupts([], 0);
  expect(await missing.store.start("execution", "token")).toBe(false);
  expect(querySignature(missing.query.mock.calls)).toEqual([
    [
      "a57cd9671f92fbf40f08fe1490124031ed8cba89351e09f8989bdf270d5771e0",
      ["execution", "token", null],
    ],
  ]);
  const updated = interrupts([], 1);
  expect(await updated.store.start("execution", "token", "agent")).toBe(true);
  expect(querySignature(updated.query.mock.calls)).toEqual([
    [
      "a57cd9671f92fbf40f08fe1490124031ed8cba89351e09f8989bdf270d5771e0",
      ["execution", "token", "agent"],
    ],
  ]);
});
