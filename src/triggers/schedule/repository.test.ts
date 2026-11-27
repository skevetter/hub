import { expect, it, vi } from "vitest";
import type { DatabaseRuntime, QueryHandle } from "../../db/runtime/index.js";
import { acceptWorkflowRun } from "../../db/workflow-intake.js";
import { compileTriggerDocument } from "../configuration/index.js";
import { ScheduleRepository } from "./internal/repository.js";
import { scheduleYaml } from "./test-fixture.js";

vi.mock("../../db/workflow-intake.js", () => ({ acceptWorkflowRun: vi.fn() }));

const compiled = compileTriggerDocument(scheduleYaml);
const due = {
  trigger_id: "trigger",
  organization_id: "org",
  runtime_project_id: "project",
  configuration_revision_id: "revision",
  normalized_configuration: {
    environments: [{ ...compiled.environment, daemonId: "daemon-1" }],
    triggers: compiled.events,
  },
  recurrence: { timezone: "Asia/Tokyo", start: "2026-01-01T09:00:00", rule: "FREQ=DAILY" },
  next_at: new Date("2026-01-01T00:00:00Z"),
  active_run_id: null,
};
const now = new Date("2026-01-02T00:00:00Z");

function unexpected(): never {
  throw new Error("Unexpected database operation.");
}

function repository(query: QueryHandle["query"]) {
  const runtime: DatabaseRuntime = {
    query,
    transaction: (operation) => operation({ query, drizzle: unexpected, rollback: unexpected }),
    drizzle: unexpected,
    migrate: unexpected,
    close: unexpected,
  };
  return new ScheduleRepository(runtime);
}

it("records the due wall-clock occurrence and accepts it using the same receipt", async () => {
  vi.mocked(acceptWorkflowRun).mockResolvedValue({ id: "run", created: true });
  const query: QueryHandle["query"] = vi.fn();
  vi.mocked(query)
    .mockResolvedValueOnce({ rows: [due], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });

  expect(await repository(query).tick(now)).toBe(1);
  const deliveryId = "schedule:trigger:2026-01-01T00:00:00.000Z";
  const event = {
    schedule: {
      trigger_id: "trigger",
      scheduled_at: due.next_at.toISOString(),
      timezone: "Asia/Tokyo",
    },
  };
  const receiptId = vi.mocked(query).mock.calls[2]?.[1]?.[0];
  expect(receiptId).toEqual(expect.any(String));
  expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("on conflict"), [
    receiptId,
    "org",
    deliveryId,
    event,
    now,
    '[{"projectId":"project","configurationRevisionId":"revision","connectionId":null,"resourceId":null}]',
  ]);
  expect(acceptWorkflowRun).toHaveBeenCalledWith(
    expect.objectContaining({ query }),
    expect.objectContaining({
      providerEventReceiptId: receiptId,
      configuredTriggerName: "scheduled-scan",
      triggerContext: { provider: "schedule", deliveryId, event },
    }),
  );
  expect(query).toHaveBeenNthCalledWith(4, expect.stringContaining("update trigger_schedules"), [
    "trigger",
    new Date("2026-01-03T00:00:00Z"),
    "run",
  ]);
});
