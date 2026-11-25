import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { composeEntitlements } from "../auth/entitlements.js";
import { createAuthServer } from "../auth/server.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { HomeDashboard } from "../home/dashboard.js";
import { ProjectTenantResolver } from "../projects/access.js";
import { AttentionDashboard } from "./dashboard.js";
import {
  attentionSnapshotRequest as snapshot,
  markFailedRunsSeenRequest as markSeen,
} from "./functions.js";

const app = vi.hoisted((): { attentionDashboard?: AttentionDashboard } => ({}));
vi.mock("../server/runtime.js", () => ({ getApplication: () => Promise.resolve(app) }));

const origin = "http://localhost:3000";
const foreign = "foreign";
const credentials = { email: "reader@example.test", password: randomBytes(24).toString("hex") };
let fixture: Awaited<ReturnType<typeof startInstance>>;

beforeAll(async () => {
  fixture = await startInstance();
  app.attentionDashboard = new AttentionDashboard(fixture.database, fixture.auth);
}, 30_000);

afterAll(async () => {
  delete app.attentionDashboard;
  await fixture?.close();
});

it.each(["absent", foreign])("rejects %s with the same tenant resolution as Home", async (slug) => {
  const { auth, database, request } = fixture;
  const home = new HomeDashboard(database, auth, () => false);
  await expect(home.snapshot(request(), slug)).rejects.toMatchObject({
    name: "TenantRouteNotFoundError",
  });
  const unavailable = { status: "error", error: { message: "Organization unavailable." } };
  expect(await snapshot(request(), slug)).toEqual(unavailable);
  expect(await markSeen(request("POST", origin), slug)).toEqual(unavailable);
});

it("requires a same-origin POST and does not write a marker on rejection", async () => {
  const { accountId, database, organizationId, request, slug } = fixture;
  const rejected = {
    status: "error",
    error: { message: "Hub could not mark runs as seen. Try again." },
  };
  const refererOnly = request("POST");
  refererOnly.headers.set("referer", origin);
  expect(await markSeen(refererOnly, slug)).toEqual(rejected);
  expect(await markSeen(request("POST", "https://foreign.test"), slug)).toEqual(rejected);
  expect(await database.readFailedRunsSeenThrough(accountId, organizationId)).toBeNull();
});

it("counts only the active tenant's failures and drops them after Mark seen", async () => {
  const { database, organizationId, request, slug } = fixture;
  const sessionRead = vi.spyOn(database, "readSessionAttention");
  try {
    await seedFailedRun(database, foreign, "Foreign job");
    expect(await snapshot(request(), slug)).toMatchObject({ status: "ok", data: { items: [] } });
    await seedFailedRun(database, organizationId, "Local job");
    const before = await snapshot(request(), slug);
    assert.equal(before.status, "ok");
    expect(before.data.items).toMatchObject([
      {
        id: "runs:failed",
        title: "1 run failed",
        action: { to: `/o/${slug}/activity` },
        dismiss: { label: "Mark seen" },
      },
    ]);
    expect(before.data.items[0]?.detail).toContain("Local job");
    expect(await markSeen(request("POST", origin), slug)).toEqual({ status: "ok", data: null });
    expect(await snapshot(request(), slug)).toMatchObject({ status: "ok", data: { items: [] } });
    expect((await database.countFailedRunsSince(foreign, new Date(0), null)).count).toBe(1);
    expect(sessionRead).not.toHaveBeenCalled();
  } finally {
    sessionRead.mockRestore();
  }
});

it("counts a run whose event arrived before Mark seen and which fails after it", async () => {
  const { database, organizationId, request, slug } = fixture;
  const running = await seedRunningRun(database, organizationId, "Slow job");
  await seedFailedRun(database, organizationId, "Quick job");
  expect(await markSeen(request("POST", origin), slug)).toEqual({ status: "ok", data: null });
  expect(await snapshot(request(), slug)).toMatchObject({ status: "ok", data: { items: [] } });

  await failRun(database, running);
  const after = await snapshot(request(), slug);
  assert.equal(after.status, "ok");
  expect(after.data.items).toMatchObject([{ id: "runs:failed", title: "1 run failed" }]);
  expect(after.data.items[0]?.detail).toContain("Slow job");

  expect(await markSeen(request("POST", origin), slug)).toEqual({ status: "ok", data: null });
  expect(await snapshot(request(), slug)).toMatchObject({ status: "ok", data: { items: [] } });
});

it("acts only on the organization in the address when the session's active organization differs", async () => {
  const { accountId, database, organizationId, request, runtime } = fixture;
  const [addressed, other] = ["pin-addressed", "pin-other"];
  for (const id of [addressed, other]) {
    await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [id]);
    await runtime.query(
      "insert into member (id, organization_id, user_id, role) values ($1, $1, $2, 'member')",
      [id, accountId],
    );
  }
  await runtime.query("update session set active_organization_id = $1", [other]);
  await seedFailedRun(database, addressed, "Addressed job");
  await seedFailedRun(database, other, "Other job");
  const activeMarker = await database.readFailedRunsSeenThrough(accountId, organizationId);

  const before = await snapshot(request(), addressed);
  assert.equal(before.status, "ok");
  expect(before.data.items).toMatchObject([
    { id: "runs:failed", action: { to: `/o/${addressed}/activity` } },
  ]);
  expect(before.data.items[0]?.detail).toContain("Addressed job");
  expect(before.data.items[0]?.detail).not.toContain("Other job");

  expect(await markSeen(request("POST", origin), addressed)).toEqual({ status: "ok", data: null });
  expect(await snapshot(request(), addressed)).toMatchObject({ status: "ok", data: { items: [] } });
  expect(await database.readFailedRunsSeenThrough(accountId, addressed)).not.toBeNull();
  expect(await database.readFailedRunsSeenThrough(accountId, other)).toBeNull();
  expect(await database.readFailedRunsSeenThrough(accountId, organizationId)).toBe(activeMarker);
  const untouched = await snapshot(request(), other);
  assert.equal(untouched.status, "ok");
  expect(untouched.data.items[0]?.detail).toContain("Other job");
});

// Before the reads were folded together a snapshot cost 12 statements besides sign-in, 14 with
// Sessions on. Tenant resolution is measured on its own so an auth change cannot hide a read.
it.each([
  { interactiveSessions: false, reads: 6 },
  { interactiveSessions: true, reads: 7 },
])(
  "reads a snapshot in $reads statements with Sessions $interactiveSessions",
  async ({ interactiveSessions, reads }) => {
    const { accountId, auth, database, request, runtime, slug } = fixture;
    const counting = vi.spyOn(runtime, "query");
    try {
      await new ProjectTenantResolver(database).resolve({
        userId: accountId,
        organizationSlug: slug,
      });
      const tenant = counting.mock.calls.length;
      await new AttentionDashboard(database, auth, { interactiveSessions }).snapshot(
        request(),
        slug,
      );
      expect(counting.mock.calls.length - 2 * tenant).toBe(reads);
    } finally {
      counting.mockRestore();
    }
  },
);

async function seedFailedRun(database: Database, organizationId: string, name: string) {
  await failRun(database, await seedRunningRun(database, organizationId, name));
}

async function failRun(database: Database, runId: string) {
  assert.equal(
    (await database.failWorkflowRun(runId, "failed", "Fixture failure", "work"))?.transitioned,
    true,
  );
}

async function seedRunningRun(database: Database, organizationId: string, name: string) {
  const project = await database.createProject({
    organizationId,
    name,
    slug: `project-${name.toLowerCase().replaceAll(/\W+/gu, "-")}`,
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "attention-fixture",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const receivedAt = new Date(Date.now() - 1000);
  const receipt = await database.persistManualEvent({
    organizationId,
    projectId: project.id,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt,
  });
  assert.equal(receipt.status, "accepted");
  const { run } = await database.createAcceptedTriggerRun({
    organizationId,
    projectId: project.id,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: name,
    prompt: "",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date(Date.now() + 60_000),
    stepIds: ["work"],
  });
  return run.id;
}

async function startInstance() {
  const directory = await mkdtemp(join(tmpdir(), "hub-attention-contract-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(directory);
  const database = createDatabase(runtime, locks);
  const entitlements = composeEntitlements(database, runtime);
  const auth = createAuthServer({
    database: runtime,
    locks,
    entitlements: entitlements.service,
    baseURL: origin,
    secret: randomBytes(32).toString("hex"),
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
    const cookie = await signIn(auth);
    const {
      rows: [organization],
    } = await runtime.query<{ id: string; slug: string }>("select id, slug from organization");
    assert.ok(organization);
    const { id: organizationId, slug } = organization;
    const request = (method = "GET", suppliedOrigin?: string) =>
      new Request(`${origin}/o/${slug}`, {
        method,
        headers: { cookie, ...(suppliedOrigin === undefined ? {} : { origin: suppliedOrigin }) },
      });
    const {
      account: { id: accountId },
    } = await auth.resolveAccount(request());
    await runtime.query(
      "update member set role = 'member' where organization_id = $1 and user_id = $2",
      [organizationId, accountId],
    );
    await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [foreign]);
    return { auth, database, request, organizationId, runtime, slug, accountId, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function signIn(auth: ReturnType<typeof createAuthServer>) {
  if (auth.claimInstance === undefined) throw new Error("claim unavailable");
  const headers = { origin, "content-type": "application/json" };
  assert.equal((await auth.claimInstance(credentials, new Headers(headers))).status, "claimed");
  const response = await auth.handle(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify(credentials),
    }),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}
