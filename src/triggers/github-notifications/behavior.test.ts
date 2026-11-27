import { describe, expect, it, vi } from "vitest";
import { compileHubConfig } from "../../config/compiler.js";
import type { DatabaseRuntime, QueryResult, TransactionHandle } from "../../db/runtime/index.js";
import { embeddedLocks } from "../../db/runtime/locks/index.js";
import {
  createGitHubNotificationsClient,
  GitHubNotificationsError,
  type NotificationFetch,
} from "./client.js";
import { createGitHubNotificationsSource, type NotificationClock } from "./index.js";
import { GitHubNotificationRepository } from "./internal/repository.js";
import { toNotificationPayload } from "./notification.js";
import { createGitHubNotificationPoller, type GitHubNotificationStore } from "./poller.js";
import { thread } from "./test-fixture.js";

const now = new Date("2026-11-14T10:00:00Z");
const listing = { since: now, lastModified: null };

describe("GitHub notification response behavior", () => {
  it("rejects a 304 on a later page and sends the conditional header only once", async () => {
    const fetch = vi
      .fn<NotificationFetch>()
      .mockResolvedValueOnce(
        new Response("[]", {
          headers: {
            link: '<https://api.github.com/notifications?page=2>; rel="next"',
            "x-poll-interval": "0",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { "x-poll-interval": "90" } }),
      );
    const client = createGitHubNotificationsClient({ token: "fake", fetch });
    const error = await client
      .list({ ...listing, lastModified: "cached" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GitHubNotificationsError);
    expect(error).toMatchObject({ status: 304, message: "GitHub notifications returned 304" });
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("if-modified-since")),
    ).toEqual(["cached", null]);
  });

  it.each([
    ["not JSON", "GitHub notifications returned a body that is not JSON."],
    ["[null]", "GitHub notifications returned an unexpected response shape."],
  ])("preserves response errors for %s", async (body, message) => {
    const client = createGitHubNotificationsClient({
      token: "",
      fetch: async () => new Response(body),
    });
    await expect(client.list(listing)).rejects.toThrow(new GitHubNotificationsError(message));
  });

  it("masks a non-Error fetch rejection", async () => {
    const fetch = vi.fn().mockRejectedValue(null);
    const client = createGitHubNotificationsClient({ token: "fake", fetch });
    await expect(client.list(listing)).rejects.toThrow(
      "GitHub notifications request failed: request failed",
    );
  });

  it("caps pagination at forty requests", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("[]", {
          headers: { link: '<https://api.github.com/notifications?page=2>; rel="next"' },
        }),
    );
    const client = createGitHubNotificationsClient({ token: "fake", fetch });
    await expect(client.list(listing)).rejects.toThrow(
      "GitHub notifications exceeded the page limit.",
    );
    expect(fetch).toHaveBeenCalledTimes(40);
  });
});

function unused(): never {
  throw new Error("unexpected database operation");
}

const cursor = { ...listing, nextPollAt: now };
const store: GitHubNotificationStore = {
  exclusive: (operation) => operation(),
  readCursor: async () => cursor,
  saveCursor: unused,
  deliver: unused,
  recordSuccess: async () => {},
  recordFailure: async () => {},
  readStatus: unused,
  countDelivered: unused,
};

it("passes through repository delivery errors and the progress callback", async () => {
  const failure = new Error("delivery failed");
  const deliver = vi.fn().mockRejectedValue(failure);
  const onProgressRequested = vi.fn();
  const poller = createGitHubNotificationPoller({
    client: {
      list: async () => ({
        status: "ok",
        notifications: [thread()],
        lastModified: null,
        pollIntervalSeconds: 0,
      }),
    },
    store: { ...store, deliver },
    pollIntervalMs: 10,
    onProgressRequested,
  });
  await expect(poller.poll(now)).rejects.toBe(failure);
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({
      cursor: { ...listing, nextPollAt: new Date(now.getTime() + 10) },
    }),
    now,
    onProgressRequested,
  );
});

it("records a non-Error poll failure without recording a success", async () => {
  const clock: NotificationClock = { now: () => now, every: () => () => {} };
  const recordFailure = vi.fn();
  const recordSuccess = vi.fn();
  const poller = { poll: vi.fn().mockRejectedValue("\u2603".repeat(600)) };
  const source = createGitHubNotificationsSource(
    { ...store, recordFailure, recordSuccess },
    { token: "fake", pollIntervalMs: 10, clock },
    poller,
  );
  await source.start(async () => {});
  await source.stop();
  expect(recordFailure).toHaveBeenCalledExactlyOnceWith(now, "\u2603".repeat(200));
  expect(recordSuccess).not.toHaveBeenCalled();
});

function triggerRow() {
  const environment = { name: "target", kind: "daemon", daemon: "devbox", cwd: "/workspace" };
  const step = {
    id: "run",
    environment: "target",
    max_runtime: "1h",
    idle_timeout: "10m",
    agent: { provider: "codex", mode: "full-access" },
    prompt: [{ text: "go" }],
    auto_archive: true,
    background: false,
  };
  return {
    organization_id: "org",
    runtime_project_id: "project",
    configuration_revision_id: "revision",
    normalized_configuration: compileHubConfig({
      environments: [environment],
      triggers: [{ name: "poll", on: "github.notification", max_runtime: "1h", steps: [step] }],
    }),
  };
}

function recordingRepository(responses: QueryResult[]) {
  const transaction: TransactionHandle = { query: unused, drizzle: unused, rollback: unused };
  const query = vi.spyOn(transaction, "query");
  for (const response of responses) query.mockResolvedValueOnce(response);
  const runtime: DatabaseRuntime = {
    query: unused,
    transaction: (operation) => operation(transaction),
    drizzle: unused,
    migrate: unused,
    close: unused,
  };
  return {
    repository: new GitHubNotificationRepository(runtime, embeddedLocks()),
    calls: query.mock.calls,
  };
}

it("preserves receipt SQL and parameter order, and skips run creation on a conflict", async () => {
  const { repository, calls } = recordingRepository([
    { rows: [triggerRow()], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 },
  ]);
  const notification = thread({ id: "id", title: "\u2603", url: null });
  const progress = vi.fn();
  const batch = { threads: [notification], limit: 1, cursor, stoppedCursor: unused };
  await expect(repository.deliver(batch, now, progress)).resolves.toEqual({
    started: 0,
    deferred: false,
  });
  expect(calls.map(([sql]) => sql)).toEqual([
    `select t.organization_id, t.runtime_project_id,
      p.active_configuration_revision_id as configuration_revision_id, r.normalized_configuration
    from organization_triggers t
    join projects p on p.id = t.runtime_project_id
    join project_configuration_revisions r on r.id = p.active_configuration_revision_id
    where t.enabled and r.normalized_configuration @> $1::jsonb
    order by t.organization_id, t.id`,
    `select organization_id from provider_event_receipts
    where organization_id = any($1::text[]) and delivery_id = $2`,
    `insert into provider_event_receipts
      (id, organization_id, provider, delivery_id, source, repo, payload, received_at, accepted_routes)
      values ($1, $2, 'github_notification', $3, $4, $5, $6, $7, $8)
      on conflict (organization_id, delivery_id) do nothing`,
    `insert into github_notification_cursors (source, last_modified, since, next_poll_at, updated_at)
    values ($1, $2, $3, $4, $5)
    on conflict (source) do update
    set last_modified = excluded.last_modified, since = excluded.since,
        next_poll_at = excluded.next_poll_at, updated_at = excluded.updated_at`,
  ]);
  const deliveryId = "id:2026-11-14T10:00:00Z";
  expect(calls.map(([, params]) => params)).toEqual([
    ['{"triggers":[{"on":"github.notification"}]}'],
    [["org"], deliveryId],
    [
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      "org",
      deliveryId,
      "github.notification",
      "acme/webapp",
      { github_notification: toNotificationPayload(notification) },
      now,
      '[{"projectId":"project","configurationRevisionId":"revision","connectionId":null,"resourceId":null}]',
    ],
    ["notifications", null, now, now, now],
  ]);
  expect(progress).not.toHaveBeenCalled();
});
