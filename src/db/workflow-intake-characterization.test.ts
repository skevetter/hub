import { expect, it, vi } from "vitest";
import type { QueryHandle, QueryRow } from "./runtime/index.js";
import type { CreateAcceptedTriggerRunInput } from "./types.js";
import { acceptWorkflowRun } from "./workflow-intake.js";

const now = new Date("2026-01-02T00:00:00Z");
const input: CreateAcceptedTriggerRunInput = {
  organizationId: "org",
  projectId: "project",
  configurationRevisionId: "revision",
  providerEventReceiptId: "receipt",
  configuredTriggerName: "trigger",
  prompt: "prompt",
  inputs: {},
  triggerContext: {},
  outputContext: {},
  deadlineAt: now,
  createdAt: now,
  stepIds: ["first", "second"],
};
const intact = { payload_expiry_state: null };
const run = { id: "run", status: "running", outcome: "accepted", payload_expiry_state: null };

function scriptedQuery(...batches: QueryRow[][]) {
  const client: QueryHandle = {
    async query() {
      throw new Error("unexpected query");
    },
  };
  const query = vi.spyOn(client, "query");
  for (const rows of batches) query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  return { client, query };
}

it("locks the receipt before writing the run, ordered steps, and wakeup", async () => {
  const { client, query } = scriptedQuery([intact], [run], [], [], []);
  const result = await acceptWorkflowRun(client, input);
  expect(result).toEqual({ id: "run", created: true });
  expect(Object.keys(result)).toEqual(["id", "created"]);
  expect(
    query.mock.calls.map(([sql, args]) => [sql.split(/\s+/u).slice(0, 3).join(" "), args]),
  ).toEqual([
    ["select payload_expiry_state from", ["receipt", "org"]],
    [
      "insert into trigger_runs",
      [
        null,
        "org",
        "project",
        "revision",
        "receipt",
        "trigger",
        "prompt",
        {},
        {},
        {},
        now,
        now,
        null,
      ],
    ],
    ["insert into workflow_step_runs", ["run", "first", 0]],
    ["insert into workflow_step_runs", ["run", "second", 1]],
    ["insert into workflow_wakeups", ["run", now]],
  ]);
});

it("only looks up the matching branch on a marked receipt", async () => {
  for (const rows of [[], [run]]) {
    const { client, query } = scriptedQuery([{ payload_expiry_state: "expired" }], rows);
    const result = await acceptWorkflowRun(client, input);
    expect(result).toEqual({ created: false, receiptReplay: true, runId: rows[0]?.id });
    expect(Object.keys(result)).toEqual(["created", "receiptReplay", "runId"]);
    expect(query.mock.calls.map(([, params]) => params)).toEqual([
      ["receipt", "org"],
      ["org", "receipt", "project", "trigger"],
    ]);
  }
});

it("locks the conflicting branch and skips workflow writes for canceled or marked rows", async () => {
  for (const row of [
    { ...run, status: "canceled" },
    { ...run, payload_expiry_state: "expiring" },
  ]) {
    const { client, query } = scriptedQuery([intact], [], [row]);
    expect(await acceptWorkflowRun(client, input)).toEqual({ id: "run", created: false });
    expect(query.mock.calls.at(-1)?.[0].endsWith("for update")).toBe(true);
    expect(query.mock.calls.at(-1)?.[1]).toEqual(["receipt", "project", "trigger", "org"]);
    expect(query.mock.calls.length).toBe(3);
  }
  const { client, query } = scriptedQuery([intact], [], [run], [], [], []);
  expect(await acceptWorkflowRun(client, input)).toEqual({ id: "run", created: false });
  expect(query.mock.calls.length).toBe(6);
});

it("preserves missing receipt, missing row, and outcome conflict errors", async () => {
  await expect(acceptWorkflowRun(scriptedQuery([]).client, input)).rejects.toThrow(
    "provider event receipt unavailable",
  );
  await expect(acceptWorkflowRun(scriptedQuery([intact], [], []).client, input)).rejects.toThrow(
    "trigger run insert returned no row",
  );
  await expect(
    acceptWorkflowRun(scriptedQuery([intact], [], [{ ...run, outcome: "rejected" }]).client, input),
  ).rejects.toThrow("trigger branch outcome conflict");
});
