import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";

const organizationId = "fixture";
const userId = "user";
const now = new Date("2026-11-22T10:00:00Z");

async function runFixture() {
  const db = createMemoryDatabase({
    memberships: [
      {
        userId,
        organizationId,
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership",
        role: "owner",
      },
    ],
  });
  await enrollTestDaemon(db, organizationId);
  const store = new OrganizationTriggerStore(db, organizationId, acceptingAgentValidator());
  const trigger = await store.save({
    userId,
    yaml: `
name: review
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /repo }
  agent: { provider: codex, model: gpt-5.4, mode: full-access }
  prompt: Review this.
`,
  });
  const projectId = trigger.runtimeProjectId;
  const revision = await db.findActiveProjectConfiguration(projectId);
  assert.ok(revision);
  const configurationRevisionId = revision.id;
  async function addRun(id: string, createdAt: Date) {
    const receipt = await db.persistManualEvent({
      organizationId,
      projectId,
      deliveryId: id,
      source: "manual.run",
      payload: {},
      receivedAt: createdAt,
    });
    assert.equal(receipt.status, "accepted");
    const { run } = await db.createAcceptedTriggerRun({
      id,
      organizationId,
      projectId,
      configurationRevisionId: configurationRevisionId,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: trigger.name,
      prompt: "Run",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date(+now + 10000),
      stepIds: ["run"],
      createdAt,
    });
    return run;
  }
  return { db, addRun, triggerId: trigger.id };
}

it("keeps the run order, inclusive cutoff, and current row status", async () => {
  const { db, addRun } = await runFixture();
  const cutoff = new Date(+now - 5000);
  await addRun("a", now);
  await addRun("old", new Date(+cutoff - 1));
  const middle = await addRun("edge", cutoff);
  await addRun("z", now);
  await db.succeedTriggerRun(middle.id);
  assert.deepEqual(
    (await db.listOrganizationRunsSince(organizationId, cutoff, 2)).map(({ id, status }) => [
      id,
      status,
    ]),
    [
      ["z", "running"],
      ["a", "running"],
    ],
  );
  assert.deepEqual(
    (await db.listOrganizationRunsSince(organizationId, cutoff, 3)).map(({ id, status }) => [
      id,
      status,
    ]),
    [
      ["z", "running"],
      ["a", "running"],
      ["edge", "succeeded"],
    ],
  );
  assert.deepEqual(await db.listOrganizationRunsSince("another-org", cutoff, 10), []);
});

it("summarizes a trigger's window and its newest run whatever the window", async () => {
  const { db, addRun, triggerId } = await runFixture();
  const cutoff = new Date(+now - 5000);
  await addRun("before", new Date(+cutoff - 1));
  const edge = await addRun("edge", cutoff);
  await db.failWorkflowRun(edge.id, "failed", "agent_interrupted", "run");
  await addRun("z", now);

  assert.deepEqual(await db.summarizeTriggerRuns(organizationId, cutoff), [
    {
      triggerId,
      total: 2,
      failed: 1,
      latest: { id: "z", status: "running", createdAt: now },
    },
  ]);
  assert.deepEqual(await db.summarizeTriggerRuns(organizationId, new Date(+now + 1)), [
    { triggerId, total: 0, failed: 0, latest: { id: "z", status: "running", createdAt: now } },
  ]);
  assert.deepEqual(await db.summarizeTriggerRuns("another-org", cutoff), []);
});

it("passes over workflow steps once for one or several recent runs", async () => {
  const { db, addRun } = await runFixture();
  const cutoff = new Date(+now - 86400_000);
  await addRun("recent", now);
  for (let index = 0; index < 1000; index += 1) {
    await addRun(`archived-${String(index)}`, new Date(+now - 60 * 86400_000 - index));
  }

  const steps: unknown = Object.getOwnPropertyDescriptor(db, "workflowStepRuns")?.value;
  assert.ok(steps instanceof Map);
  assert.equal(steps.size, 1001);
  const passes = vi.spyOn(steps, "values");
  try {
    const runs = await db.listOrganizationRunsSince(organizationId, cutoff, 50);
    assert.deepEqual(
      runs.map(({ id }) => id),
      ["recent"],
    );
    assert.equal(passes.mock.calls.length, 1);

    await addRun("another", new Date(+now - 5000));
    passes.mockClear();
    const twoRuns = await db.listOrganizationRunsSince(organizationId, cutoff, 50);
    assert.deepEqual(
      twoRuns.map(({ id }) => id),
      ["recent", "another"],
    );
    assert.equal(passes.mock.calls.length, 1);
  } finally {
    passes.mockRestore();
  }
});
