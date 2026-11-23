import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { delegationReadback, proveDelegation, type DelegationProofStage } from "./delegation.js";
import { MAX_PILOT_MESSAGE_CHARS, type LinearPilotEvent } from "./intake.js";
import type { z } from "zod";

const signed: LinearPilotEvent = {
  kind: "created",
  pendingDelegation: true,
  nativeSessionId: "session",
  workspaceId: "workspace",
  applicationId: "application",
  appUserId: "app",
  humanId: "human",
  issueId: "issue",
  teamId: "team",
};
const human = { id: signed.humanId };
const app = { id: signed.appUserId };
const other = { id: "other" };
const sessionTime = "2026-11-22T01:02:00.000Z";
type Readback = z.infer<typeof delegationReadback>;
type Session = z.input<typeof delegationReadback>["agentSession"];
type Issue = NonNullable<Session["issue"]>;
type Entry = Issue["history"]["nodes"][number];

function history(extra: Partial<Entry> = {}): Entry {
  return {
    id: "history-entry",
    createdAt: "2026-11-22T01:00:00.000Z",
    actor: human,
    botActor: null,
    triageResponsibilityAutoAssigned: null,
    toAssignee: null,
    toDelegate: app,
    ...extra,
  };
}

function evidence(issue: Partial<Issue> = {}, session: Partial<Session> = {}): Readback {
  return delegationReadback.parse(rawEvidence(issue, session));
}

function rawEvidence(issue: Partial<Issue>, session: Partial<Session> = {}) {
  return {
    agentSession: {
      id: signed.nativeSessionId,
      createdAt: sessionTime,
      creator: human,
      appUser: app,
      comment: null,
      sourceComment: null,
      issue: {
        id: signed.issueId,
        identifier: "TEST-1",
        title: "Title",
        description: "Description.",
        team: { id: "team", organization: { id: signed.workspaceId } },
        delegate: app,
        assignee: null,
        history: { nodes: [history()] },
        ...issue,
      },
      ...session,
    },
  };
}

const prompt = {
  message: "Work on TEST-1: Title\n\nDescription.",
  historyEntryId: "history-entry",
};
const refused = (stage: DelegationProofStage) => ({ reason: "origin_unproven", stage });
const run = (read: (signal: AbortSignal) => Promise<Readback>, remaining = 10_000) =>
  proveDelegation(signed, Date.now() + remaining, read);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("accepts delegation at the inclusive 120-second boundary and assignment at session creation", async () => {
  await expect(run(async () => evidence())).resolves.toEqual(prompt);
  const entry = history({ toDelegate: null, toAssignee: app, createdAt: sessionTime });
  await expect(
    run(async () => evidence({ delegate: null, assignee: app, history: { nodes: [entry] } })),
  ).resolves.toEqual(prompt);
});

it.each([human, null])("accepts a generated comment with user %j", async (user) => {
  await expect(
    run(async () => evidence({}, { comment: { id: "comment", user } })),
  ).resolves.toEqual(prompt);
});

it("uses the newest qualifying history entry regardless of response order", async () => {
  const nodes = [
    history(),
    history({ id: "tied-match", createdAt: "2026-11-22T01:01:00.000001Z" }),
    history({ id: "newest-match", createdAt: "2026-11-22T01:01:00.000001Z" }),
    history({ id: "older-match", createdAt: "2026-11-22T01:01:00.000000Z" }),
    history({ id: "wrong-actor", createdAt: sessionTime, actor: other }),
  ];
  for (const order of [nodes, nodes.toReversed()]) {
    await expect(run(async () => evidence({ history: { nodes: order } }))).resolves.toEqual({
      ...prompt,
      historyEntryId: "newest-match",
    });
  }
});

it.each<[string, Partial<Entry>]>([
  ["bot actor", { botActor: { id: "bot" } }],
  ["bot without id", { botActor: { id: null } }],
  ["null actor", { actor: null }],
  ["triage assignment", { triageResponsibilityAutoAssigned: true }],
  ["wrong actor", { actor: other }],
  ["stale entry", { createdAt: "2026-11-22T00:59:59.999Z" }],
  ["entry after creation", { createdAt: "2026-11-22T01:02:00.001Z" }],
  ["submillisecond entry after creation", { createdAt: "2026-11-22T01:02:00.000001Z" }],
  ["changed to someone else", { toDelegate: other, toAssignee: other }],
])("refuses after one re-read for %s", async (_label, change) => {
  const read = vi.fn(async () => evidence({ history: { nodes: [history(change)] } }));
  const proof = run(read);
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(proof).resolves.toEqual(refused("no_history_match"));
  expect(read).toHaveBeenCalledTimes(2);
});

it.each<[string, DelegationProofStage, Readback]>([
  [
    "current delegate and assignee both differ",
    "issue_mismatch",
    evidence({ delegate: other, assignee: other }),
  ],
  ["creator mismatch", "session_mismatch", evidence({}, { creator: other })],
  [
    "comment by another user",
    "session_mismatch",
    evidence({}, { comment: { id: "comment", user: other } }),
  ],
  [
    "source comment present",
    "session_mismatch",
    evidence({}, { sourceComment: { id: "comment" } }),
  ],
  ["session mismatch", "session_mismatch", evidence({}, { id: "other-session" })],
  ["app mismatch", "session_mismatch", evidence({}, { appUser: other })],
  ["issue mismatch", "issue_mismatch", evidence({ id: "other-issue" })],
  [
    "team mismatch",
    "issue_mismatch",
    evidence({ team: { id: "other-team", organization: { id: "workspace" } } }),
  ],
  [
    "workspace mismatch",
    "issue_mismatch",
    evidence({ team: { id: "team", organization: { id: "other" } } }),
  ],
])("refuses %s as %s without a re-read", async (_label, stage, readback) => {
  const read = vi.fn(async () => readback);
  await expect(run(read)).resolves.toEqual(refused(stage));
  expect(read).toHaveBeenCalledTimes(1);
});

it("refuses malformed GraphQL evidence and over-limit descriptions without truncating", async () => {
  const { agentSession } = rawEvidence({});
  expect(
    delegationReadback.safeParse({ agentSession: { ...agentSession, comment: undefined } }).success,
  ).toBe(false);
  const read = vi.fn(async () => evidence({ description: "x".repeat(MAX_PILOT_MESSAGE_CHARS) }));
  await expect(run(read)).resolves.toEqual({
    reason: "oversized",
    historyEntryId: "history-entry",
  });
  expect(read).toHaveBeenCalledTimes(1);
});

it("admits a late history entry on the single re-read", async () => {
  const read = vi
    .fn(async () => evidence())
    .mockResolvedValueOnce(evidence({ history: { nodes: [] } }));
  const proof = run(read);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(proof).resolves.toEqual(prompt);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([4_000, 500])("aborts an unresponsive proof after %s ms", async (effectiveBudget) => {
  const read = vi.fn((_signal: AbortSignal) => new Promise<Readback>(() => {}));
  const proof = run(read, effectiveBudget === 4_000 ? 10_000 : effectiveBudget);
  await vi.advanceTimersByTimeAsync(effectiveBudget - 1);
  const signal = read.mock.calls[0]?.[0];
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(proof).resolves.toEqual(refused("timeout"));
  expect(signal?.aborted).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
});
