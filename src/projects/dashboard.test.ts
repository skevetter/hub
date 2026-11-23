import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { ProjectDashboard } from "./dashboard.js";

describe("project dashboard activity read models", () => {
  it("uses canonical Linear health in project and organization snapshots", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "owner",
        },
      ],
    });
    await database.createProject({
      organizationId: "org-1",
      name: "Hub",
      slug: "hub",
      createdByUserId: "user-1",
    });
    database.organizationConnectionUsage = () =>
      Promise.resolve({
        github: [],
        discord: [],
        slack: [],
        linear: [
          {
            id: "expired",
            organizationId: "org-1",
            slug: "expired",
            providerApplicationId: "linear-client",
            linearOrganizationId: "linear-expired",
            linearOrganizationName: "Expired",
            appUserId: "linear-app-user",
            accessToken: "expired-token",
            refreshToken: null,
            accessTokenExpiresAt: new Date("2000-01-01T00:00:00.000Z"),
            scopes: ["read", "comments:create", "app:assignable", "app:mentionable"],
          },
          {
            id: "refreshable",
            organizationId: "org-1",
            slug: "refreshable",
            providerApplicationId: "linear-client",
            linearOrganizationId: "linear-refreshable",
            linearOrganizationName: "Refreshable",
            appUserId: "linear-app-user",
            accessToken: "expired-token",
            refreshToken: "refresh-token",
            accessTokenExpiresAt: new Date("2000-01-01T00:00:00.000Z"),
            scopes: ["read", "comments:create", "app:assignable", "app:mentionable"],
          },
        ],
      });

    const dashboard = new ProjectDashboard(database, accountAuth());
    const request = new Request("https://hub.test/o/acme/projects/hub");
    const [organization, project] = await Promise.all([
      dashboard.organizationSnapshot(request, { organizationSlug: "acme" }),
      dashboard.projectSnapshot(request, {
        organizationSlug: "acme",
        projectSlug: "hub",
      }),
    ]);

    for (const snapshot of [organization, project]) {
      assert.deepEqual(
        snapshot.connections.linear.map((connection) => ({
          id: connection.id,
          requiresReauthorization: connection.requiresReauthorization,
        })),
        [
          { id: "expired", requiresReauthorization: true },
          { id: "refreshable", requiresReauthorization: false },
        ],
      );
    }
  });

  it("omits payload-bearing evidence from lists and retains it in detail", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "owner",
        },
        {
          userId: "user-1",
          organizationId: "org-2",
          organizationName: "Other",
          organizationSlug: "other",
          membershipId: "membership-2",
          role: "owner",
        },
      ],
    });
    const project = await database.createProject({
      organizationId: "org-1",
      name: "Hub",
      slug: "hub",
      createdByUserId: "user-1",
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "dashboard-read-model",
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id, []);
    const rawPayload = { body: "payload-".repeat(20_000) };
    const triggerContext = { provider: "manual", body: "trigger-".repeat(20_000) };
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: project.id,
      deliveryId: "dashboard-large-payload",
      source: "manual.dashboard",
      payload: rawPayload,
      receivedAt: new Date("2026-08-06T12:00:00.000Z"),
    });
    if (receipt.status !== "accepted") throw new Error("dashboard receipt was not accepted");
    const run = await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "dashboard-run",
      prompt: "run",
      inputs: {},
      triggerContext,
      outputContext: {},
      deadlineAt: new Date("2026-08-06T13:00:00.000Z"),
      stepIds: ["step"],
    });
    const storedActivity = await database.findOrganizationActivityRun("org-1", run.run.id);
    assert.ok(storedActivity);
    assert.equal(storedActivity.run.id, run.run.id);
    assert.deepEqual(storedActivity.receipt.payload, rawPayload);
    assert.deepEqual(
      storedActivity.steps.map((step) => step.stepId),
      ["step"],
    );
    assert.equal(await database.findOrganizationActivityRun("org-2", run.run.id), undefined);
    assert.equal(
      await database.findOrganizationActivityRun("org-1", "00000000-0000-4000-8000-000000000000"),
      undefined,
    );
    const unroutedPayload = { body: "unrouted-".repeat(20_000) };
    const unroutedReceipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: project.id,
      deliveryId: "dashboard-unrouted-large-payload",
      source: "manual.dashboard",
      payload: unroutedPayload,
      receivedAt: new Date("2026-08-06T12:01:00.000Z"),
    });
    if (unroutedReceipt.status !== "accepted") throw new Error("unrouted receipt was not accepted");
    await database.markProviderEventDropped(
      unroutedReceipt.event.providerEventReceiptId,
      "trigger_filters_rejected",
    );
    const dashboard = new ProjectDashboard(database, accountAuth());
    const request = new Request("https://hub.test/o/acme/projects/hub");
    const list = await dashboard.projectSnapshot(request, {
      organizationSlug: "acme",
      projectSlug: "hub",
    });
    assert.equal("rawPayload" in list.activity[0]!, false);
    assert.equal("triggerContext" in list.activity[0]!, false);

    const detail = await dashboard.activityRunSnapshot(request, {
      organizationSlug: "acme",
      projectSlug: "hub",
      runId: run.run.id,
    });
    assert.deepEqual(detail.activity.rawPayload, rawPayload);
    assert.deepEqual(detail.activity.triggerContext, triggerContext);

    const organizationDetail = await dashboard.activityRunDetail(request, {
      organizationSlug: "acme",
      runId: run.run.id,
    });
    assert.ok(organizationDetail);
    assert.equal(organizationDetail.run.id, run.run.id);
    assert.equal(organizationDetail.run.prompt, "run");
    for (const key of [
      "rawPayload",
      "triggerContext",
      "outputContext",
      "inputs",
      "values",
      "deliveryId",
      "providerEventReceiptId",
    ]) {
      assert.equal(key in organizationDetail.run, false);
    }
    assert.deepEqual(
      organizationDetail.steps.map((step) => step.stepId),
      ["step"],
    );
    assert.equal(organizationDetail.steps[0]?.isAgent, false);
    assert.equal(organizationDetail.steps[0]?.completion, null);
    assert.equal(organizationDetail.steps[0]?.output, null);
    assert.equal(
      await dashboard.activityRunDetail(request, {
        organizationSlug: "other",
        runId: run.run.id,
      }),
      null,
    );
    assert.equal(
      await dashboard.activityRunDetail(request, {
        organizationSlug: "acme",
        runId: "00000000-0000-4000-8000-000000000000",
      }),
      null,
    );
    await assert.rejects(
      dashboard.activityRunDetail(request, {
        organizationSlug: "inaccessible",
        runId: run.run.id,
      }),
      { name: "TenantRouteNotFoundError" },
    );
    const anonymous = new ProjectDashboard(database, {
      ...accountAuth(),
      resolveAccount: () => Promise.reject(new Error("unauthenticated")),
    });
    await assert.rejects(
      anonymous.activityRunDetail(request, { organizationSlug: "acme", runId: run.run.id }),
      /unauthenticated/,
    );

    const organization = await dashboard.organizationSnapshot(request, {
      organizationSlug: "acme",
    });
    assert.equal("unroutedEvents" in organization, false);
    assert.doesNotMatch(
      JSON.stringify(organization),
      /dashboard-unrouted-large-payload|unrouted-unrouted/u,
    );
  });

  it("projects bounded webhook display data without adding receipt payloads to activity lists", async () => {
    const database = createMemoryDatabase({
      memberships: ["acme", "other"].map((slug, index) => ({
        userId: "user-1",
        organizationId: `org-${String(index + 1)}`,
        organizationName: slug,
        organizationSlug: slug,
        membershipId: `membership-${slug}`,
        role: "owner" as const,
      })),
    });
    const project = await database.createProject({
      organizationId: "org-1",
      name: "Hub",
      slug: "hub",
      createdByUserId: "user-1",
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: {},
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "webhook-display",
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id, []);
    const prompt = `${"x".repeat(120)}private tail`;
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: project.id,
      deliveryId: "webhook-display",
      source: "webhook.received",
      payload: {
        actor: "ci-partner",
        trigger: "build-finished",
        input: prompt,
        data: { internal: "raw-payload-only" },
      },
      receivedAt: new Date("2026-11-16T12:00:00.000Z"),
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") throw new Error("webhook receipt was not accepted");
    const { run } = await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "build-finished",
      prompt,
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date("2026-11-16T13:00:00.000Z"),
      stepIds: [],
    });
    const records = await database.listProjectActivityRuns(project.id, 10);
    assert.equal(records[0]?.webhookActor, "ci-partner");
    assert.equal("payload" in records[0].receipt, false);
    const dashboard = new ProjectDashboard(database, accountAuth());
    const request = new Request("https://hub.test/o/acme/projects/hub");
    const list = await dashboard.projectSnapshot(request, {
      organizationSlug: "acme",
      projectSlug: "hub",
    });
    const detail = await dashboard.activityRunDetail(request, {
      organizationSlug: "acme",
      runId: run.id,
    });
    const legacyDetail = await dashboard.activityRunSnapshot(request, {
      organizationSlug: "acme",
      projectSlug: "hub",
      runId: run.id,
    });
    assert.ok(detail);
    assert.equal(detail.run.prompt, null);
    for (const activity of [list.activity[0]!, detail.run, legacyDetail.activity]) {
      assert.equal(activity.provider, "manual");
      assert.equal(activity.source, "webhook.received");
      assert.equal(activity.webhookSummary?.headline, "Webhook from ci-partner");
      assert.equal(activity.webhookSummary?.actor, "ci-partner");
      assert.equal(activity.webhookSummary?.triggerName, "build-finished");
      assert.equal(activity.webhookSummary?.prompt?.length, 120);
      assert.equal(activity.webhookSummary?.prompt?.slice(0, 119), "x".repeat(119));
      assert.equal(JSON.stringify(activity.webhookSummary).includes("private tail"), false);
      assert.equal(JSON.stringify(activity.webhookSummary).includes("raw-payload-only"), false);
    }
    assert.equal(JSON.stringify(detail.run).includes("raw-payload-only"), false);
    assert.equal("rawPayload" in list.activity[0]!, false);
    assert.equal(
      await dashboard.activityRunDetail(request, { organizationSlug: "other", runId: run.id }),
      null,
    );
  });
});

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
