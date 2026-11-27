import { expect, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { AcceptedTriggerRunRecord, WorkflowStepRunRecord } from "../db/types.js";
import type { FinalReplyAnswer } from "./format.js";
import { LinearRunReplyWriter } from "./linear.js";
import { RunReplyReporter } from "./reporter.js";

const now = new Date("2026-01-01");
const scope = { organizationId: "org", runId: "run" };
const run = {
  organizationId: "org",
  id: "run",
  projectId: "project",
  configurationRevisionId: "revision",
  configuredTriggerName: "trigger",
  providerEventReceiptId: "receipt",
  prompt: "",
  inputs: {},
  values: {},
  triggerContext: {},
  outputContext: {},
  createdAt: now,
  deadlineAt: now,
  completedAt: now,
  reactionState: null,
  conversation: null,
  deadlineKind: null,
  failureReason: null,
  terminalNotificationPendingAt: null,
  terminalNotificationDeliveredAt: null,
  terminalNotificationLeaseExpiresAt: null,
  outcome: "accepted",
  status: "succeeded",
} satisfies AcceptedTriggerRunRecord;

function step(agentExecutionId: string | null): WorkflowStepRunRecord {
  return {
    id: "step",
    stepId: "step",
    ordinal: 0,
    triggerRunId: "run",
    status: "succeeded",
    agentExecutionId,
    output: null,
    failureReason: null,
    deadlineKind: null,
    deadlineAt: null,
    idleDeadlineAt: null,
    startedAt: now,
    completedAt: now,
    dispatchIntent: null,
  };
}

function fixture(mode: "available" | "missing", steps: WorkflowStepRunRecord[]) {
  const trace: unknown[] = [];
  const database = createMemoryDatabase();
  database.findTriggerRunForOrganization = async () => run;
  database.listWorkflowStepRunsForTriggerRun = async () => {
    trace.push("steps");
    return steps;
  };
  database.runReplies.finish = async (input) => {
    trace.push(input);
    return true;
  };
  database.runReplies.recoverable = async () => {
    trace.push("recover");
    return [];
  };
  const unexpected = async () => {
    throw new Error("unexpected provider call");
  };
  const writer = new LinearRunReplyWriter({
    database,
    client: { readIssue: unexpected, readComment: unexpected, createComment: unexpected },
    connectionForLinearOrganization: unexpected,
    clientSecret: "",
    providerApplicationId: "app",
  });
  writer.post = async (record, answer, perHour, signal) => {
    trace.push(["post", record === run, answer, perHour, signal.aborted]);
  };
  const reporter = new RunReplyReporter({
    database,
    perHour: 12,
    writer: () => {
      trace.push("writer");
      return mode === "available" ? writer : undefined;
    },
  });
  return { reporter, trace };
}

const answer: FinalReplyAnswer = { text: "answer", truncated: false };

it("posts only the last agent answer and recovers after the write", async () => {
  const { reporter, trace } = fixture("available", [
    step("first"),
    step(null),
    step("last"),
    step(null),
  ]);
  reporter.capture(scope, "first", { text: "first", truncated: false });
  reporter.capture(scope, "last", answer);
  await reporter.processAvailable();
  expect(trace).toEqual(["steps", "writer", ["post", true, answer, 12, false], "recover"]);
  await reporter.processAvailable();
  expect(trace.at(-1)).toBe("recover");
  expect(trace.length).toBe(5);
  await reporter.stop();
});

it("does not resolve a writer for a missing final answer", async () => {
  for (const steps of [[step("first"), step("last")], [step(null)], []]) {
    const { reporter, trace } = fixture("available", steps);
    reporter.capture(scope, "first", answer);
    await reporter.processAvailable();
    expect(trace).toEqual(["steps", "recover"]);
    await reporter.stop();
  }
});

it("keeps empty answer precedence while looking up the writer before finalizing", async () => {
  const scenarios = [
    ["missing", answer, "connection_unavailable"],
    ["missing", null, "empty_answer"],
    ["available", null, "empty_answer"],
  ] as const;
  for (const [mode, captured, failure] of scenarios) {
    const { reporter, trace } = fixture(mode, [step("last")]);
    reporter.capture(scope, "last", captured);
    await reporter.processAvailable();
    expect(trace).toEqual(["steps", "writer", { ...scope, from: "pending", failure }, "recover"]);
    await reporter.stop();
  }
});
