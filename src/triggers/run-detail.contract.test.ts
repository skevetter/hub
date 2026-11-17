import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { readRunProgressSettings } from "../run-progress/settings.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { TriggerDashboard } from "./dashboard.js";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const memberships = ["one", "two"].map((name) => ({
  userId: "reader",
  organizationId: name,
  organizationName: name,
  organizationSlug: name,
  membershipId: `member-${name}`,
  role: "member" as const,
}));
const auth: AuthServer = {
  handle: async () => new Response(),
  resources: async () => {
    throw new Error("unused");
  },
  resolveOrganizationAccess: async () => {
    throw new Error("unused");
  },
  resolveAccount: async () => ({
    session: { id: "session", activeOrganizationId: "one" },
    account: { id: "reader", name: "Reader", email: "reader@example.test" },
    isInstanceOperator: false,
  }),
  rejectCookieMutation: () => undefined,
  close: async () => undefined,
};
const request = new Request("https://hub.test/o/one/activity");

for (const backend of ["memory", "embedded"] as const)
  describe(`run detail reads on ${backend}`, () => {
    let database: Database;
    let close: () => Promise<void>;
    let dashboard: TriggerDashboard;
    let projectId: string;
    beforeAll(async () => {
      if (backend === "memory") {
        database = createMemoryDatabase({ memberships });
        close = async () => undefined;
      } else {
        const root = await mkdtemp(join(tmpdir(), "hub-run-detail-"));
        const bundle = await embeddedDatabaseRuntime(join(root, "database"));
        await bundle.runtime.migrate();
        await bundle.runtime.query(
          "insert into organization (id, name, slug) values ('one', 'one', 'one'), ('two', 'two', 'two')",
        );
        await bundle.runtime.query(
          "insert into \"user\" (id, name, email) values ('reader', 'Reader', 'reader@example.test')",
        );
        await bundle.runtime.query(
          "insert into member (id, organization_id, user_id, role) values ('member-one', 'one', 'reader', 'member'), ('member-two', 'two', 'reader', 'member')",
        );
        database = createDatabase(bundle.runtime, bundle.locks);
        close = async () => {
          await bundle.runtime.close();
          await rm(root, { recursive: true, force: true });
        };
      }
      const project = await database.createProject({
        organizationId: "one",
        name: "Runtime",
        slug: "runtime",
        createdByUserId: null,
      });
      projectId = project.id;
      dashboard = new TriggerDashboard(database, auth, acceptingAgentValidator(), {
        now: () => NOW,
        runProgress: readRunProgressSettings({ PASEO_HUB_RUN_TIMELINE: "true" }),
      });
    });
    afterAll(async () => {
      await close?.();
    });

    async function createRun() {
      const revision = await database.insertProjectConfigurationRevision({
        projectId,
        sourceKind: "manual",
        sourceEvidence: {},
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: randomUUID(),
      });
      await database.activateProjectConfigurationRevision(projectId, revision.id, []);
      const receipt = await database.persistManualEvent({
        organizationId: "one",
        projectId,
        deliveryId: randomUUID(),
        source: "manual.run",
        payload: { private: "not returned" },
        receivedAt: NOW,
      });
      if (receipt.status !== "accepted") throw new Error("receipt rejected");
      return (
        await database.createAcceptedTriggerRun({
          organizationId: "one",
          projectId,
          configurationRevisionId: revision.id,
          providerEventReceiptId: receipt.event.providerEventReceiptId,
          configuredTriggerName: "Review",
          prompt: "private prompt",
          inputs: {},
          triggerContext: {},
          outputContext: {},
          deadlineAt: new Date(NOW.getTime() + 3600000),
          stepIds: ["review", "later"],
        })
      ).run;
    }

    it("returns the same unavailable shape for foreign and unknown runs for detail and polling", async () => {
      const run = await createRun();
      assert.equal(await dashboard.runDetail(request, "two", run.id), null);
      assert.equal(await dashboard.runDetail(request, "two", randomUUID()), null);
      assert.equal(await dashboard.runEvents(request, "two", run.id, 0), null);
      assert.equal(await dashboard.runEvents(request, "two", randomUUID(), 0), null);
      const detail = await dashboard.runDetail(request, "one", run.id);
      assert.ok(detail);
      assert.equal(detail.run.configuredTriggerName, "Review");
      assert.equal(detail.steps.length, 2);
      assert.equal(detail.progress, null);
      assert.equal(detail.progressMessagesEnabled, false);
      assert.doesNotMatch(
        JSON.stringify(detail),
        /private prompt|not returned|rawPayload|externalRef/u,
      );
    });

    it("pages stored rows after the cursor without leaking ownership fields and preserves the seal and origin", async () => {
      const run = await createRun();
      for (let index = 0; index < 103; index += 1)
        await database.appendRunTimelineEvent({
          organizationId: "one",
          triggerRunId: run.id,
          kind: "turn_started",
          at: NOW,
          data: {},
          origin: "derived",
        });
      const initial = await dashboard.runDetail(request, "one", run.id);
      assert.ok(initial);
      assert.equal(initial.timeline.events.length, 100);
      const tail = await dashboard.runEvents(request, "one", run.id, 100);
      assert.deepEqual(
        tail?.events.map((event) => event.seq),
        [101, 102, 103],
      );
      assert.equal(tail?.sealedSeq, null);
      assert.equal(tail?.origin, "derived");
      assert.equal(tail?.streamEnabled, false);
      assert.doesNotMatch(JSON.stringify(tail), /organizationId|triggerRunId/u);
      await database.failWorkflowRun(run.id, "failed", "synthetic failure");
      const terminal = await dashboard.runEvents(request, "one", run.id, 103);
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.sealedSeq, null);
      await database.appendRunTimelineEvent({
        organizationId: "one",
        triggerRunId: run.id,
        kind: "run_finished",
        at: NOW,
        data: { status: "failed", stepRowsOmitted: 2 },
        origin: "captured",
      });
      const sealed = await dashboard.runEvents(request, "one", run.id, 103);
      assert.equal(sealed?.sealedSeq, 104);
      assert.equal(sealed?.origin, "derived");
      assert.equal(sealed?.events[0]?.kind, "run_finished");
    });

    it("distinguishes unavailable capture-off timelines from retained and reconcilable rows", async () => {
      const run = await createRun();
      const reader = new TriggerDashboard(database, auth, acceptingAgentValidator(), {
        now: () => NOW,
        runProgress: readRunProgressSettings({}),
      });
      assert.equal(
        (await dashboard.runEvents(request, "one", run.id, 0))?.timelineUnavailable,
        false,
      );
      assert.equal(
        (await reader.runDetail(request, "one", run.id))?.timeline.timelineUnavailable,
        true,
      );
      await database.failWorkflowRun(run.id, "failed", "synthetic failure");
      assert.equal((await reader.runEvents(request, "one", run.id, 0))?.timelineUnavailable, true);
      for (let index = 0; index < 103; index += 1) {
        await database.appendRunTimelineEvent({
          organizationId: "one",
          triggerRunId: run.id,
          kind: "turn_started",
          at: NOW,
          data: {},
          origin: "captured",
        });
      }
      const retained = await reader.runEvents(request, "one", run.id, 100);
      assert.equal(retained?.timelineUnavailable, false);
      assert.deepEqual(
        retained?.events.map((event) => event.seq),
        [101, 102, 103],
      );
      assert.equal(retained?.sealedSeq, null);
    });

    it("keeps expired tombstones empty and does not invoke reconciliation", async () => {
      const run = await createRun();
      await database.appendRunTimelineEvent({
        organizationId: "one",
        triggerRunId: run.id,
        kind: "run_started",
        at: NOW,
        data: {},
        origin: "captured",
      });
      await database.failWorkflowRun(run.id, "failed", "expired");
      await database.expireRunTimelines(new Date(Date.now() + 86400000), 500);
      let reconciled = false;
      const reader = new TriggerDashboard(database, auth, acceptingAgentValidator(), {
        now: () => NOW,
        runProgress: readRunProgressSettings({
          PASEO_HUB_RUN_TIMELINE: "true",
          PASEO_HUB_TIMELINE_RETENTION_DAYS: "365",
        }),
        reconciler: {
          reconcileBeforeTerminal: async () => {
            reconciled = true;
          },
        },
      });
      const detail = await reader.runDetail(request, "one", run.id);
      assert.equal(detail?.timeline.expired, true);
      assert.deepEqual(detail?.timeline.events, []);
      assert.equal(reconciled, false);
      assert.equal((await reader.runEvents(request, "one", run.id, 0))?.expired, true);
    });
  });
