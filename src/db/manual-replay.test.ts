import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { ManualRunRejected } from "../triggers/manual/provider.js";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime } from "./runtime/index.js";
import type { Database, PersistManualEventInput } from "./types.js";

const ORGANIZATION_A = "manual-replay-org-a";
const ORGANIZATION_B = "manual-replay-org-b";

interface Harness {
  database: Database;
  deactivateProject: (projectId: string) => Promise<void>;
  close: () => Promise<void>;
}

async function memoryHarness(): Promise<Harness> {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION_A, ORGANIZATION_B] });
  return {
    database,
    deactivateProject: async (projectId) => {
      const project = await database.findProjectForOrganization(ORGANIZATION_A, projectId);
      assert.ok(project);
      project.status = "archived";
      project.archivedAt = new Date();
      project.activeConfigurationRevisionId = null;
    },
    close: () => database.close(),
  };
}

async function embeddedHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "hub-manual-replay-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
  try {
    await runtime.migrate();
    await runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Manual A', 'manual-a'), ($2, 'Manual B', 'manual-b')",
      [ORGANIZATION_A, ORGANIZATION_B],
    );
  } catch (error) {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    database: createDatabase(runtime, locks),
    deactivateProject: async (projectId) => {
      await runtime.query(
        "update projects set status = 'archived', archived_at = clock_timestamp(), active_configuration_revision_id = null where id = $1",
        [projectId],
      );
    },
    close: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function projectWithConfiguration(database: Database, organizationId = ORGANIZATION_A) {
  const project = await database.createProject({
    organizationId,
    name: "Manual replay",
    slug: randomUUID(),
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: randomUUID(),
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  return { project, revision };
}

function delivery(projectId: string, organizationId = ORGANIZATION_A): PersistManualEventInput {
  return {
    organizationId,
    projectId,
    deliveryId: randomUUID(),
    source: "webhook.received",
    payload: {
      trigger: "build-finished",
      actor: "ci-partner",
      input: "original prompt",
      data: { message: "original prompt", failures: 2, nested: { retained: true } },
      source: "webhook.received",
    },
    receivedAt: new Date("2026-01-02T03:04:05.000Z"),
  };
}

const backends = [
  ["in-memory", memoryHarness],
  ["embedded PostgreSQL", embeddedHarness],
] as const;

describe.each(backends)("manual receipt replay (%s)", (_name, open) => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await open();
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it("replays the original receipt, route, source and payload after configuration changes", async () => {
    const { database } = harness;
    const { project, revision } = await projectWithConfiguration(database);
    const original = delivery(project.id);
    const fresh = await database.persistManualEvent(original);
    assert.equal(fresh.status, "accepted");
    assert.notEqual(fresh.replayed, true);
    if (fresh.status !== "accepted") throw new Error("expected accepted receipt");
    const receipt = await database.findProviderEventReceiptByDeliveryId(
      original.deliveryId,
      ORGANIZATION_A,
    );
    assert.ok(receipt);
    const replacement = await projectWithConfiguration(database);
    await harness.deactivateProject(project.id);

    const replayed = await database.persistManualEvent({
      ...original,
      projectId: replacement.project.id,
      source: "manual.run",
      payload: { input: "replacement prompt" },
      receivedAt: new Date("2026-02-03T04:05:06.000Z"),
    });
    assert.equal(replayed.status, "accepted");
    assert.equal(replayed.replayed, true);
    if (replayed.status !== "accepted") throw new Error("expected replayed receipt");
    assert.deepEqual(replayed.event, fresh.event);
    assert.equal(replayed.event.configurationRevisionId, revision.id);
    assert.deepEqual(
      await database.findProviderEventReceiptByDeliveryId(original.deliveryId, ORGANIZATION_A),
      receipt,
    );
  });

  it("isolates colliding delivery ids by organization", async () => {
    const { database } = harness;
    const firstProject = await projectWithConfiguration(database, ORGANIZATION_A);
    const secondProject = await projectWithConfiguration(database, ORGANIZATION_B);
    const original = delivery(firstProject.project.id);
    const other = {
      ...original,
      organizationId: ORGANIZATION_B,
      projectId: secondProject.project.id,
      payload: { input: "other organization" },
    };
    const first = await database.persistManualEvent(original);
    const second = await database.persistManualEvent(other);
    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    assert.notEqual(first.replayed, true);
    assert.notEqual(second.replayed, true);
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("expected accepted receipts");
    }
    assert.notEqual(first.event.providerEventReceiptId, second.event.providerEventReceiptId);
    for (const [input, accepted] of [
      [original, first],
      [other, second],
    ] as const) {
      const replayed = await database.persistManualEvent({ ...input, payload: {} });
      assert.deepEqual(replayed, { ...accepted, replayed: true });
    }
  });

  it("rejects missing or inactive configuration with a typed error before storing a receipt", async () => {
    const { database } = harness;
    const unconfigured = await database.createProject({
      organizationId: ORGANIZATION_A,
      name: "Unconfigured",
      slug: randomUUID(),
      createdByUserId: null,
    });
    const inactive = await projectWithConfiguration(database);
    await harness.deactivateProject(inactive.project.id);
    for (const projectId of [randomUUID(), unconfigured.id, inactive.project.id]) {
      const input = delivery(projectId);
      await assert.rejects(
        database.persistManualEvent(input),
        (error: unknown) =>
          error instanceof ManualRunRejected && error.code === "configuration_not_found",
      );
      assert.equal(
        await database.findProviderEventReceiptByDeliveryId(input.deliveryId, ORGANIZATION_A),
        undefined,
      );
    }
  });

  it("rejects another organization's active project without storing a receipt", async () => {
    const { database } = harness;
    const { project } = await projectWithConfiguration(database, ORGANIZATION_A);
    const input = delivery(project.id, ORGANIZATION_B);
    await assert.rejects(
      database.persistManualEvent(input),
      (error: unknown) =>
        error instanceof ManualRunRejected && error.code === "configuration_not_found",
    );
    for (const organizationId of [ORGANIZATION_A, ORGANIZATION_B]) {
      assert.equal(
        await database.findProviderEventReceiptByDeliveryId(input.deliveryId, organizationId),
        undefined,
      );
    }
  });

  it("retains a committed drop reason while replaying an accepted receipt", async () => {
    const { database } = harness;
    const { project } = await projectWithConfiguration(database);
    const input = delivery(project.id);
    const fresh = await database.persistManualEvent(input);
    assert.equal(fresh.status, "accepted");
    if (fresh.status !== "accepted") throw new Error("expected accepted receipt");
    await database.markProviderEventDropped(
      fresh.event.providerEventReceiptId,
      "trigger_filters_rejected",
    );
    const dropped = await database.findProviderEventReceiptByDeliveryId(
      input.deliveryId,
      ORGANIZATION_A,
    );
    assert.equal(dropped?.droppedReason, "trigger_filters_rejected");

    assert.deepEqual(await database.persistManualEvent({ ...input, payload: {} }), {
      ...fresh,
      replayed: true,
    });
    assert.deepEqual(
      await database.findProviderEventReceiptByDeliveryId(input.deliveryId, ORGANIZATION_A),
      dropped,
    );
  });
});
