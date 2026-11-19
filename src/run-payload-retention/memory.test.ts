import assert from "node:assert/strict";
import { it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { logger } from "../logger.js";
import { createStreamHarness, streamRequest } from "../run-stream/test-utils.js";
import { ProjectDashboard } from "../projects/dashboard.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { TriggerDashboard } from "../triggers/dashboard.js";
import { RunPayloadRetention } from "./index.js";

const NOW = new Date("2026-11-18T00:00:00Z");
const CUTOFF = new Date("2026-10-19T00:00:00Z");
const OLD = new Date(CUTOFF.getTime() - 1);
const MARKER = "raw-sentinel-memory";
const MEMBERSHIP = {
  userId: "user",
  organizationId: "org",
  organizationSlug: "org",
  organizationName: "Organization",
  membershipId: "membership",
  role: "owner" as const,
};

const auth: AuthServer = {
  handle: async () => new Response(),
  resources: async () => {
    throw new Error("unused");
  },
  resolveOrganizationAccess: async () => {
    throw new Error("unused");
  },
  resolveAccount: async () => ({
    session: { id: "session", activeOrganizationId: "org" },
    account: { id: "user", name: "User", email: "user@example.test" },
    isInstanceOperator: false,
  }),
  rejectCookieMutation: () => undefined,
  close: async () => undefined,
};

it("redacts memory records and serves expired run views while the receipt remains visible to a live sibling", async () => {
  const database = createMemoryDatabase({ now: () => OLD, memberships: [MEMBERSHIP] });
  const project = await database.createProject({
    organizationId: "org",
    name: "Project",
    slug: "project",
    createdByUserId: "user",
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "expiry-memory",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: "org",
    projectId: project.id,
    deliveryId: "shared",
    source: "webhook.received",
    payload: { actor: MARKER, message: MARKER },
    receivedAt: OLD,
  });
  assert.ok(receipt.status === "accepted");
  const input = {
    organizationId: "org",
    projectId: project.id,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    prompt: MARKER,
    inputs: { text: MARKER },
    triggerContext: { text: MARKER },
    outputContext: { text: MARKER },
    deadlineAt: NOW,
    stepIds: ["script"],
  };
  const old = await database.createAcceptedTriggerRun({ ...input, configuredTriggerName: "old" });
  const live = await database.createAcceptedTriggerRun({ ...input, configuredTriggerName: "live" });
  const step = await database.findWorkflowStepRunByTriggerRun(old.run.id);
  assert.ok(step);
  await database.startWorkflowScriptStep({ stepRunId: step.id, startedAt: OLD, deadlineAt: NOW });
  await database.updateWorkflowScriptStep(step.id, {
    status: "succeeded",
    at: OLD,
    output: { exit_code: 0, output_tail: MARKER, truncated: false },
  });
  await database.succeedTriggerRun(old.run.id);
  const claim = await database.claimPendingWorkflowRunTerminalNotification(OLD, 1);
  assert.ok(claim);
  assert.equal(claim.id, old.run.id);
  await database.markWorkflowRunTerminalNotificationDelivered(
    claim.id,
    claim.terminalNotificationGeneration,
    OLD,
    null,
  );
  assert.equal(await database.expireRunPayloadChunk(old.run.id, CUTOFF, NOW), "expiring");
  assert.equal((await database.findWorkflowStepRunById(step.id))?.output, null);
  assert.equal(await database.setWorkflowScriptStepOutput(step.id, { text: MARKER }), undefined);
  assert.equal(await database.expireRunPayloadChunk(old.run.id, CUTOFF, NOW), "expiring");
  assert.equal(await database.expireRunPayloadChunk(old.run.id, CUTOFF, NOW), "expired");

  const projectDashboard = new ProjectDashboard(database, auth);
  const triggers = new TriggerDashboard(database, auth, acceptingAgentValidator());
  const request = new Request("https://hub.test/o/org/projects/project");
  const snapshots = await Promise.all([
    projectDashboard.activityRunSnapshot(request, {
      organizationSlug: "org",
      projectSlug: "project",
      runId: old.run.id,
    }),
    projectDashboard.activityRunDetail(request, { organizationSlug: "org", runId: old.run.id }),
    triggers.runDetail(request, "org", old.run.id),
  ]);
  assert.ok(snapshots.every((value) => value !== null));
  assert.doesNotMatch(JSON.stringify(snapshots), /raw-sentinel-memory/u);
  assert.equal(snapshots[0].activity.payloadExpiredAt, NOW.toISOString());
  assert.equal(snapshots[1]?.steps[0]?.payloadSummary?.exitCode, 0);
  assert.equal(snapshots[2]?.timeline.expired, true);
  assert.equal(snapshots[2]?.progressUnavailable, true);
  assert.match(
    JSON.stringify(await database.findProjectActivityRun(project.id, live.run.id)),
    /raw-sentinel-memory/u,
  );
});

it("keeps retry logs free of database diagnostics and lets shutdown cancel the scheduled retry", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const scan = vi.fn().mockRejectedValue(new Error(MARKER));
  const expire = vi.fn();
  const retention = new RunPayloadRetention(
    {
      scanRunPayloads: scan,
      scanUnknownTemporaryCredentials: vi.fn().mockResolvedValue([]),
      backfillTemporaryCredentialFact: vi.fn(),
      expireRunPayloadChunk: expire,
      scanAuxiliaryPayloads: vi.fn(),
      expireLaunchIntent: vi.fn(),
      reduceSessionOptions: vi.fn(),
    },
    {
      mode: "count",
      retentionDays: 30,
      maxRunsPerPass: 50,
    },
  );
  try {
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(scan.mock.calls.length, 1);
    assert.equal(warn.mock.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(warn.mock.calls), /raw-sentinel-memory/u);
    await retention.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(scan.mock.calls.length, 1);
    assert.equal(expire.mock.calls.length, 0);
  } finally {
    await retention.stop();
    warn.mockRestore();
    vi.useRealTimers();
  }
});

it("returns the existing SSE 410 on initial open and reconnect after payload expiry", async () => {
  const harness = await createStreamHarness("memory");
  const stream = harness.stream({ retentionDays: 365 });
  try {
    const run = await harness.createRun();
    const completed = await harness.database.succeedTriggerRun(run.id);
    assert.ok(completed?.run.completedAt);
    const at = completed.run.completedAt;
    const claim = await harness.database.claimPendingWorkflowRunTerminalNotification(at, 1000);
    assert.ok(claim);
    await harness.database.markWorkflowRunTerminalNotificationDelivered(
      run.id,
      claim.terminalNotificationGeneration,
      at,
      null,
    );
    const cutoff = new Date(at.getTime() + 1);
    assert.equal(await harness.database.expireRunPayloadChunk(run.id, cutoff, cutoff), "expiring");
    for (const lastEventId of [undefined, "1"]) {
      const request = streamRequest(run.id, harness.key);
      if (lastEventId !== undefined) request.headers.set("last-event-id", lastEventId);
      const response = await stream.handle(request, run.id);
      assert.equal(response.status, 410);
      assert.match(await response.text(), /timeline_expired/u);
    }
  } finally {
    await stream.beginShutdown();
    await harness.close();
  }
});
