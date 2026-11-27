import { expect, it } from "vitest";
import { toAgentExecutionRecord } from "./mappers.js";
import type { AgentExecutionRow } from "./pg.js";

const startedAt = new Date("2026-01-01");
const leaseExpiresAt = new Date("2026-01-02");
const completedAt = new Date("2026-01-03");

function execution(delivery: unknown, acknowledgements: unknown) {
  const row: AgentExecutionRow = {
    id: "execution",
    project_id: "project",
    organization_id: "org",
    configuration_revision_id: "config",
    status: "running",
    started_at: startedAt,
    completed_at: null,
    completed_by_agent_at: null,
    machine_id: null,
    deadline_at: null,
    idle_deadline_at: null,
    result: null,
    trigger_context: null,
    output_context: null,
    reaction_state: null,
    completion_token_hash: null,
    reply_claimed_at: null,
    reply_claim_count: 0,
    output_emissions: {},
    output_delivery_attempts: delivery,
    launch_intent: null,
    agent_session_id: null,
    agent_session_action: null,
    daemon_id: null,
    daemon_agent_id: null,
    workflow_step_run_id: null,
    hub_action: null,
    hub_action_completed_at: null,
    hub_action_ready_at: null,
    hub_action_acknowledgements: acknowledgements,
  };
  return toAgentExecutionRecord(row);
}

const pending = {
  outputType: "message",
  status: "pending",
  startedAt,
  leaseExpiresAt,
  completedAt: null,
};

it("keeps valid attempts in input order and rejects malformed records, statuses, and dates", () => {
  const attempts = execution(
    {
      pending,
      nonRecord: "invalid",
      badType: { ...pending, outputType: 0 },
      badStatus: { ...pending, status: "bad" },
      badStart: { ...pending, startedAt: "bad" },
      badLease: { ...pending, leaseExpiresAt: 0 },
      badCompletion: { ...pending, completedAt: undefined },
      succeeded: { ...pending, status: "succeeded", completedAt: completedAt.toISOString() },
      failed: { ...pending, status: "failed", completedAt },
    },
    null,
  ).outputDeliveryAttempts;
  expect(Object.keys(attempts)).toEqual(["pending", "succeeded", "failed"]);
  expect(attempts).toEqual({
    pending: {
      id: "pending",
      outputType: "message",
      status: "pending",
      startedAt,
      leaseExpiresAt,
      completedAt: null,
    },
    succeeded: {
      id: "succeeded",
      outputType: "message",
      status: "succeeded",
      startedAt,
      leaseExpiresAt,
      completedAt,
    },
    failed: {
      id: "failed",
      outputType: "message",
      status: "failed",
      startedAt,
      leaseExpiresAt,
      completedAt,
    },
  });
  expect(Object.keys(attempts["pending"] ?? {})).toEqual([
    "id",
    "outputType",
    "status",
    "startedAt",
    "leaseExpiresAt",
    "completedAt",
  ]);
  expect(execution([], null).outputDeliveryAttempts).toEqual({});
});

it("keeps the observed value when a completion getter changes during validation", () => {
  let reads = 0;
  const changing = {
    ...pending,
    get completedAt() {
      return ++reads === 3 ? null : undefined;
    },
  };
  const result = execution({ changing }, null).outputDeliveryAttempts["changing"];
  expect(reads).toBe(3);
  expect(result).toEqual({
    id: "changing",
    outputType: "message",
    status: "pending",
    startedAt,
    leaseExpiresAt,
    completedAt: undefined,
  });
  expect(Object.keys(result ?? {})).toEqual([
    "id",
    "outputType",
    "status",
    "startedAt",
    "leaseExpiresAt",
    "completedAt",
  ]);
});

it("maps finish acknowledgements, preserves generation field order, and rejects invalid call data", () => {
  const terminal = {
    terminal_at: startedAt.toISOString(),
    idle_at: "invalid",
    stop_interrupt_generation: "token",
  };
  const acknowledgement = (call: unknown) =>
    execution({}, { ...terminal, finish_execution_call: call }).hubActionAcknowledgements;
  for (const status of ["running", "completed", "failed", "canceled"]) {
    const result = acknowledgement({ status, observed_at: completedAt, call_id: "call" });
    expect(Object.keys(result)).toEqual([
      "terminalAt",
      "idleAt",
      "finishExecutionCall",
      "stopInterruptGeneration",
    ]);
    expect(result).toEqual({
      terminalAt: startedAt,
      idleAt: null,
      finishExecutionCall: { callId: "call", status, observedAt: completedAt },
      stopInterruptGeneration: "token",
    });
    expect(Object.keys(result.finishExecutionCall ?? {})).toEqual([
      "callId",
      "status",
      "observedAt",
    ]);
  }
  expect(
    acknowledgement({ status: "running", observed_at: completedAt }).finishExecutionCall,
  ).toEqual({
    callId: null,
    status: "running",
    observedAt: completedAt,
  });
  for (const invalid of [
    null,
    {},
    { status: "bad", observed_at: completedAt },
    { status: "running", observed_at: "invalid" },
    { status: "running", observed_at: completedAt, call_id: 1 },
  ]) {
    expect(acknowledgement(invalid).finishExecutionCall).toBe(null);
  }
  expect(execution({}, []).hubActionAcknowledgements).toEqual({
    terminalAt: null,
    idleAt: null,
    finishExecutionCall: null,
  });
});
