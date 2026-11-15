import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHubRuntime } from "../../app.js";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "../../db/runtime/index.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { ScheduleTestDaemon } from "../schedule/test-daemon.js";
import { OrganizationTriggerStore } from "../store.js";
import { TriggerDocumentError } from "../configuration/index.js";
import { createGitHubNotificationsClient } from "./client.js";
import type { NotificationClock } from "./index.js";
import { createGitHubNotificationPoller } from "./poller.js";
import { notificationYaml, thread } from "./test-fixture.js";

const TOKEN = "fake-notification-token-0001";
const INTERVAL_MS = 60_000;
const T0 = new Date("2026-11-14T10:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

const flightdeck = thread({
  id: "1001",
  repo: "ThermAI-Group/flightdeck",
  reason: "mention",
  updated_at: "2026-11-14T10:00:30Z",
  title: "Fix the flaky deploy check",
});
const terraform = thread({
  id: "2002",
  repo: "ThermAI-Group/terraform",
  reason: "review_requested",
  updated_at: "2026-11-14T10:00:40Z",
  title: "Rotate the state bucket",
  url: "https://api.github.com/repos/ThermAI-Group/terraform/pulls/7",
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** A fetch that serves queued responses and records every request. Nothing reaches the network. */
function fakeGitHub() {
  const queue: Response[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  return {
    requests,
    reply(body: unknown, headers: Record<string, string> = {}, status = 200) {
      queue.push(
        new Response(status === 304 ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      );
    },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, headers: Object.fromEntries(new Headers(init.headers)) });
      const next = queue.shift();
      if (next === undefined) throw new Error("no queued GitHub response");
      return next;
    },
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hub-notifications-"));
  const bundle: DatabaseRuntimeBundle = await embeddedDatabaseRuntime(join(root, "database"));
  await bundle.runtime.migrate();
  const database = createDatabase(bundle.runtime, bundle.locks);
  await bundle.runtime.query(
    "insert into organization (id, name, slug) values ('notify-org', 'Notify test', 'notify-test')",
  );
  await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier: "notify-test-token",
    organizationId: "notify-org",
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  });
  const daemonId = randomUUID();
  await database.enrollDaemon({
    daemonId,
    idempotencyKey: randomUUID(),
    suggestedSlug: "devbox",
    tokenVerifier: "notify-test-token",
    serverId: randomUUID(),
    daemonPublicKey: "public",
    credentialVerifier: "credential",
    permissions: ["hub.execute"],
    now: new Date(),
  });
  cleanup = async () => {
    await bundle.runtime.close();
    await rm(root, { recursive: true, force: true });
  };
  const github = fakeGitHub();
  const store = new OrganizationTriggerStore(database, "notify-org", acceptingAgentValidator());
  const poller = createGitHubNotificationPoller({
    client: createGitHubNotificationsClient({ token: TOKEN, fetch: github.fetch }),
    store: database.githubNotifications,
    pollIntervalMs: INTERVAL_MS,
  });
  return {
    bundle,
    database,
    daemonId,
    github,
    store,
    poller,
    async runsByTrigger() {
      const rows = await bundle.runtime.query<{ name: string; delivery_id: string }>(
        `select r.configured_trigger_name as name, e.delivery_id
        from trigger_runs r join provider_event_receipts e on e.id = r.provider_event_receipt_id
        order by e.delivery_id, r.configured_trigger_name`,
      );
      return rows.rows.map(({ name, delivery_id }) => `${name} <- ${delivery_id}`);
    },
    async count(table: "provider_event_receipts" | "trigger_runs" | "workflow_wakeups") {
      return (
        await bundle.runtime.query<{ count: number }>(
          `select count(*)::integer as count from ${table}`,
        )
      ).rows[0]!.count;
    },
  };
}

describe("github notification polling", () => {
  it("replays nothing on the first run, then fans out to every matching enabled trigger", async () => {
    const fixture = await setup();
    const { store, github, poller } = fixture;
    await store.save({ yaml: notificationYaml("all-notifications"), userId: null });
    await store.save({
      yaml: notificationYaml(
        "flightdeck-mentions",
        "      repo: thermai-group/FLIGHTDECK\n      reason: mention\n",
      ),
      userId: null,
    });
    await store.save({
      yaml: notificationYaml("terraform-reviews", "      reason: review_requested\n"),
      userId: null,
    });
    await store.save({
      yaml: notificationYaml("title-prefix", '      pattern: "Rotate"\n      contains: bucket\n'),
      userId: null,
    });
    await store.save({
      yaml: notificationYaml("disabled", "", false),
      userId: null,
    });

    // First run: cursor is set to now, GitHub is not asked, nothing starts.
    expect(await poller.poll(T0)).toMatchObject({ started: 0 });
    expect(github.requests).toHaveLength(0);
    expect(await fixture.count("provider_event_receipts")).toBe(0);

    github.reply([flightdeck, terraform], {
      "last-modified": "Sat, 14 Nov 2026 10:01:00 GMT",
      "x-poll-interval": "60",
    });
    const second = await poller.poll(after(INTERVAL_MS));
    expect(second.started).toBe(5);
    const request = new URL(github.requests[0]!.url);
    expect(request.searchParams.get("since")).toBe("2026-11-14T10:00:00Z");
    expect(request.searchParams.get("all")).toBe("true");
    expect(request.searchParams.get("participating")).toBe("true");
    expect(github.requests[0]!.headers["if-modified-since"]).toBeUndefined();

    expect(await fixture.runsByTrigger()).toEqual([
      "all-notifications <- 1001:2026-11-14T10:00:30Z",
      "flightdeck-mentions <- 1001:2026-11-14T10:00:30Z",
      "all-notifications <- 2002:2026-11-14T10:00:40Z",
      "terraform-reviews <- 2002:2026-11-14T10:00:40Z",
      "title-prefix <- 2002:2026-11-14T10:00:40Z",
    ]);
    // One receipt per organization and thread update; each matching trigger has its own run.
    expect(await fixture.count("provider_event_receipts")).toBe(2);
    expect(await fixture.count("trigger_runs")).toBe(5);
    expect(await fixture.count("workflow_wakeups")).toBe(5);
    const receipt = (
      await fixture.bundle.runtime.query<{
        provider: string;
        source: string;
        repo: string;
        payload: unknown;
      }>(
        "select provider, source, repo, payload from provider_event_receipts where delivery_id = '1001:2026-11-14T10:00:30Z'",
      )
    ).rows[0]!;
    expect(receipt).toMatchObject({
      provider: "github_notification",
      source: "github.notification",
      repo: "ThermAI-Group/flightdeck",
    });
    expect(receipt.payload).toEqual({
      github_notification: {
        repo: "ThermAI-Group/flightdeck",
        thread_id: "1001",
        subject_type: "PullRequest",
        title: "Fix the flaky deploy check",
        number: 42,
        html_url: "https://github.com/ThermAI-Group/flightdeck/pull/42",
        reason: "mention",
        updated_at: "2026-11-14T10:00:30Z",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });

  it("does not start a second run when the same thread update arrives again", async () => {
    const fixture = await setup();
    await fixture.store.save({ yaml: notificationYaml("all-notifications"), userId: null });
    await fixture.poller.poll(T0);
    fixture.github.reply([flightdeck], { "last-modified": "stamp-1" });
    await fixture.poller.poll(after(INTERVAL_MS));
    expect(await fixture.count("trigger_runs")).toBe(1);

    // The overlap window returns the thread again, and a 304 returns nothing.
    fixture.github.reply([flightdeck], { "last-modified": "stamp-2" });
    expect(await fixture.poller.poll(after(2 * INTERVAL_MS))).toMatchObject({ started: 0 });
    expect(fixture.github.requests[1]!.headers["if-modified-since"]).toBe("stamp-1");
    fixture.github.reply(null, {}, 304);
    expect(await fixture.poller.poll(after(3 * INTERVAL_MS))).toMatchObject({ started: 0 });
    expect(fixture.github.requests[2]!.headers["if-modified-since"]).toBe("stamp-2");
    expect(await fixture.count("trigger_runs")).toBe(1);

    // A later update to the same thread is new work.
    fixture.github.reply([{ ...flightdeck, updated_at: "2026-11-14T10:05:00Z" }]);
    expect(await fixture.poller.poll(after(4 * INTERVAL_MS))).toMatchObject({ started: 1 });
    expect(await fixture.count("provider_event_receipts")).toBe(2);
  });

  it("is safe when two deliveries overlap and when two processes poll together", async () => {
    const fixture = await setup();
    await fixture.store.save({ yaml: notificationYaml("all-notifications"), userId: null });
    await fixture.poller.poll(T0);
    const cursor = await fixture.database.githubNotifications.readCursor();
    const now = after(INTERVAL_MS);
    const next = { ...cursor!, nextPollAt: after(2 * INTERVAL_MS) };
    const [first, second] = await Promise.all([
      fixture.database.githubNotifications.deliver([flightdeck], next, now),
      fixture.database.githubNotifications.deliver([flightdeck], next, now),
    ]);
    expect([first, second].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await fixture.count("trigger_runs")).toBe(1);

    fixture.github.reply([terraform]);
    fixture.github.reply([terraform]);
    const results = await Promise.all([
      fixture.poller.poll(after(3 * INTERVAL_MS)),
      fixture.poller.poll(after(3 * INTERVAL_MS)),
    ]);
    expect(results.map(({ started }) => started).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(fixture.github.requests).toHaveLength(1);
  });

  it("keeps the cursor when GitHub fails, then catches up", async () => {
    const fixture = await setup();
    await fixture.store.save({ yaml: notificationYaml("all-notifications"), userId: null });
    await fixture.poller.poll(T0);
    fixture.github.reply({ message: "Bad credentials" }, {}, 401);
    await expect(fixture.poller.poll(after(INTERVAL_MS))).rejects.toThrow(
      "GitHub notifications returned 401: Bad credentials",
    );
    expect((await fixture.database.githubNotifications.readCursor())!.since).toEqual(T0);
    fixture.github.reply([flightdeck]);
    expect(await fixture.poller.poll(after(2 * INTERVAL_MS))).toMatchObject({ started: 1 });
    expect(new URL(fixture.github.requests[1]!.url).searchParams.get("since")).toBe(
      "2026-11-14T10:00:00Z",
    );
  });

  it("rolls back receipts and runs with the cursor when delivery fails", async () => {
    const fixture = await setup();
    await fixture.store.save({ yaml: notificationYaml("all-notifications"), userId: null });
    await fixture.poller.poll(T0);
    await fixture.bundle.runtime.query(
      "alter table workflow_wakeups add constraint reject_test_wakeup check (false) not valid",
    );
    fixture.github.reply([flightdeck]);
    await expect(fixture.poller.poll(after(INTERVAL_MS))).rejects.toThrow();
    expect(await fixture.count("provider_event_receipts")).toBe(0);
    expect((await fixture.database.githubNotifications.readCursor())!.since).toEqual(T0);
    await fixture.bundle.runtime.query(
      "alter table workflow_wakeups drop constraint reject_test_wakeup",
    );
    fixture.github.reply([flightdeck]);
    expect(await fixture.poller.poll(after(2 * INTERVAL_MS))).toMatchObject({ started: 1 });
  });

  it("rejects from_users and unsupported filters when the trigger is saved", async () => {
    const fixture = await setup();
    const rejected = await fixture.store
      .save({
        yaml: notificationYaml("allowlisted", '      from_users: ["octocat"]\n'),
        userId: null,
      })
      .catch((error: unknown) => error);
    if (!(rejected instanceof TriggerDocumentError)) throw new Error("expected a document error");
    expect(rejected.issues).toEqual([
      expect.objectContaining({
        path: ["on", "github.notification", "filters", "from_users"],
        message:
          "github.notification has no commenter or author, so it does not accept from_users.",
      }),
    ]);
    await expect(
      fixture.store.save({
        yaml: notificationYaml("labelled", "      labels: [bug]\n"),
        userId: null,
      }),
    ).rejects.toThrow("supports only these filters");
    expect(await fixture.store.list()).toEqual([]);
  });

  it("saves a repo filter without a GitHub connection or repository", async () => {
    const fixture = await setup();
    const saved = await fixture.store.save({
      yaml: notificationYaml("unconnected", "      repo: ThermAI-Group/flightdeck\n"),
      userId: null,
    });
    expect(saved.enabled).toBe(true);
    const routes = await fixture.bundle.runtime.query("select * from project_trigger_routes");
    expect(routes.rows).toEqual([]);
  });

  it("starts a run through the hub runtime and hands the notification to the agent", async () => {
    const fixture = await setup();
    const connection = new ScheduleTestDaemon();
    let tick: (() => void) | undefined;
    let now = T0;
    const clock: NotificationClock = {
      now: () => now,
      every(callback) {
        tick = callback;
        return () => {};
      },
    };
    fixture.github.reply([flightdeck]);
    const runtime = createHubRuntime({
      database: fixture.database,
      entitlements: createUnlimitedEntitlementsService(),
      publicApi: { status: "unavailable" },
      publicBaseUrl: "http://notify.test",
      completionTokenSecret: "notify-test-secret",
      executionDeadlineClock: { now: () => now.getTime(), schedule: () => () => {} },
      daemonConnectionForId: (id) => (id === fixture.daemonId ? connection : undefined),
      githubNotifications: {
        token: TOKEN,
        pollIntervalMs: INTERVAL_MS,
        fetch: fixture.github.fetch,
        clock,
      },
    });
    try {
      await fixture.store.save({ yaml: notificationYaml("notify-run"), userId: null });
      await runtime.start();
      // start() ran the first poll, which only set the cursor.
      await expect.poll(() => fixture.database.githubNotifications.readCursor()).toBeDefined();
      expect(fixture.github.requests).toHaveLength(0);
      now = after(INTERVAL_MS);
      tick!();
      await expect.poll(() => fixture.count("trigger_runs")).toBe(1);
      await runtime.processWorkflowOutbox();
      await expect.poll(() => connection.launches.length).toBe(1);
      await expect.poll(() => connection.prompts.length).toBe(1);
      expect(connection.prompts[0]).toContain("Fix the flaky deploy check");
      expect(connection.prompts[0]).toContain(
        "https://github.com/ThermAI-Group/flightdeck/pull/42",
      );
      expect(connection.prompts[0]).not.toContain(TOKEN);
      expect(
        (await fixture.database.listOrganizationRunsSince("notify-org", new Date(0), 10)).map(
          ({ triggerName, source, provider }) => ({ triggerName, source, provider }),
        ),
      ).toEqual([
        {
          triggerName: "notify-run",
          source: "github.notification",
          provider: "github_notification",
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });
});
