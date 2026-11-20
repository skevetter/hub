import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { composeEntitlements } from "../auth/entitlements.js";
import { createAuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { deriveChecklist } from "./checklist.js";
import { HomeDashboard } from "./dashboard.js";
import { finishHomeSetupRequest as finish } from "./functions.js";

const app = vi.hoisted((): { homeDashboard?: HomeDashboard } => ({}));
vi.mock("../server/runtime.js", () => ({ getApplication: () => Promise.resolve(app) }));

const ORIGIN = "http://localhost:3000";
const credentials = { email: "operator@example.test", password: randomBytes(24).toString("hex") };
const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, model: gpt-5.4, mode: full-access }
  prompt: Run it
`;

describe("organization checklist completion", () => {
  let fixture: Awaited<ReturnType<typeof startInstance>>;

  beforeEach(async () => {
    fixture = await startInstance();
    app.homeDashboard = fixture.dashboard;
  });

  afterEach(async () => {
    delete app.homeDashboard;
    await fixture.close();
  });

  it("exposes the four steps until completion and keeps it after a connection is removed", async () => {
    await fixture.recordRun();
    const ready = await fixture.snapshot();
    assert.equal(deriveChecklist(ready).complete, true);
    assert.equal(ready.checklistCompletedAt, null);

    const completedAt = await fixture.dashboard.completeChecklist(fixture.post(), fixture.slug);
    assert.equal((await fixture.snapshot()).checklistCompletedAt, completedAt);

    await fixture.runtime.query("delete from slack_connections where organization_id = $1", [
      fixture.organizationId,
    ]);
    const completed = await fixture.snapshot();
    assert.equal(deriveChecklist(completed).completed, 3);
    assert.equal(completed.checklistCompletedAt, completedAt);
    assert.equal(
      await fixture.dashboard.completeChecklist(fixture.post(), fixture.slug),
      completedAt,
    );
  });

  it("requires an Origin header even when the Referer matches, including on replay", async () => {
    await fixture.recordRun();
    const refererOnly = fixture.post();
    refererOnly.headers.set("referer", refererOnly.url);
    refererOnly.headers.delete("origin");
    const rejected = {
      status: "error",
      error: { message: "Reload Home and try again." },
    };

    assert.deepEqual(await finish(refererOnly, fixture.slug), rejected);
    assert.equal((await fixture.snapshot()).checklistCompletedAt, null);
    assert.equal((await finish(fixture.post(), fixture.slug)).status, "ok");
    assert.deepEqual(await finish(refererOnly, fixture.slug), rejected);
  });

  it("refuses to complete setup for an unknown organization in either store", async () => {
    const memory = createMemoryDatabase({ organizationIds: [fixture.organizationId] });
    for (const database of [fixture.database, memory]) {
      await assert.rejects(database.completeHomeChecklist("absent"), {
        message: "organization is unavailable",
      });
      assert.equal(await database.getHomeChecklistCompletedAt("absent"), null);
      assert.equal(await database.getHomeChecklistCompletedAt(fixture.organizationId), null);
      const completedAt = await database.completeHomeChecklist(fixture.organizationId);
      assert.deepEqual(
        await database.getHomeChecklistCompletedAt(fixture.organizationId),
        completedAt,
      );
    }
  });

  it("refuses invalid origins, non-operators, other organizations and premature calls, then returns one timestamp", async () => {
    const { post, slug, runtime } = fixture;
    assert.deepEqual(await finish(post(), slug), {
      status: "error",
      error: { message: "Complete all four checklist steps before finishing setup." },
    });
    await fixture.recordRun();
    await runtime.query(
      "insert into organization (id, name, slug) values ('other', 'Other', 'other')",
    );
    assert.deepEqual(await finish(post(), "other"), {
      status: "error",
      error: { message: "Organization unavailable." },
    });
    assert.deepEqual(await finish(post("https://other.example.test"), slug), {
      status: "error",
      error: { message: "Reload Home and try again." },
    });
    await runtime.query('update "user" set is_instance_operator = false');
    assert.deepEqual(await finish(post(), slug), {
      status: "error",
      error: { message: "Only an instance operator can finish setup." },
    });
    assert.equal((await fixture.snapshot()).checklistCompletedAt, null);

    await runtime.query('update "user" set is_instance_operator = true');
    const results = await Promise.all([finish(post(), slug), finish(post(), slug)]);
    const first = results[0];
    assert.equal(first.status, "ok");
    assert.equal(new Date(first.data.completedAt).toISOString(), first.data.completedAt);
    assert.deepEqual(results[1], first);
    assert.deepEqual(await finish(post(), slug), first);
    assert.equal((await fixture.snapshot()).checklistCompletedAt, first.data.completedAt);
    const other = await runtime.query<{ completed_at: Date | null }>(
      "select home_checklist_completed_at as completed_at from organization where id = 'other'",
    );
    assert.deepEqual(other.rows, [{ completed_at: null }]);
  });
});

async function startInstance() {
  const directory = await mkdtemp(join(tmpdir(), "hub-home-completion-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(directory);
  const database = createDatabase(runtime, locks);
  const entitlements = composeEntitlements(database, runtime);
  const auth = createAuthServer({
    database: runtime,
    locks,
    entitlements: entitlements.service,
    secret: randomBytes(32).toString("hex"),
    baseURL: ORIGIN,
    policy: {
      registrationMode: "invite_only",
      organizationCreation: "disabled",
      bootstrap: undefined,
    },
  });
  const close = async () => {
    await auth.close();
    await entitlements.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await runtime.migrate();
    assert.ok(auth.claimInstance !== undefined);
    assert.equal(
      (await auth.claimInstance(credentials, new Headers({ origin: ORIGIN }))).status,
      "claimed",
    );
    const signedIn = await auth.handle(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(credentials),
      }),
    );
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.getSetCookie()[0]?.split(";")[0];
    assert.ok(cookie !== undefined);
    const organizations = await runtime.query<{ id: string; slug: string }>(
      "select id, slug from organization",
    );
    const organization = organizations.rows[0];
    assert.ok(organization !== undefined);
    const { id: organizationId, slug } = organization;
    const path = `${ORIGIN}/o/${slug}/home`;
    const request = new Request(path, { headers: { cookie } });
    const account = await auth.resolveAccount(request);
    const dashboard = new HomeDashboard(database, auth, () => true);
    const post = (origin = ORIGIN) =>
      new Request(path, { method: "POST", headers: { cookie, origin } });

    return {
      database,
      dashboard,
      organizationId,
      slug,
      post,
      runtime,
      close,
      snapshot: () => dashboard.snapshot(request, slug),
      async recordRun() {
        await runtime.query(
          `insert into slack_connections
             (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token)
           values ($1, 'fixture-team', 'fixture', 'Fixture', 'fixture-bot', 'fixture-token')`,
          [organizationId],
        );
        await enrollTestDaemon(database, organizationId);
        const trigger = await new OrganizationTriggerStore(
          database,
          organizationId,
          acceptingAgentValidator(),
        ).save({
          yaml: triggerYaml,
          userId: account.account.id,
        });
        const projectId = trigger.runtimeProjectId;
        const revision = await database.findActiveProjectConfiguration(projectId);
        assert.ok(revision !== undefined);
        const now = new Date();
        const receipt = await database.persistManualEvent({
          organizationId,
          projectId,
          deliveryId: randomUUID(),
          source: "manual.run",
          payload: {},
          receivedAt: now,
        });
        assert.equal(receipt.status, "accepted");
        await database.createAcceptedTriggerRun({
          organizationId,
          projectId,
          configurationRevisionId: revision.id,
          providerEventReceiptId: receipt.event.providerEventReceiptId,
          configuredTriggerName: trigger.name,
          prompt: "Run it",
          inputs: {},
          triggerContext: {},
          outputContext: {},
          deadlineAt: new Date(now.getTime() + 600_000),
          stepIds: ["run"],
          createdAt: now,
        });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
