import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createMemoryDatabase } from "../db/memory.js";
import type { AcceptedTriggerRunRecord } from "../db/types.js";
import { RunTimelineBus } from "../run-timeline/bus.js";
import { CredentialBackoff } from "./backoff.js";
import { GitHubProgressProvider } from "./github.js";
import { ProgressReporter } from "./index.js";
import { renderProgress } from "./render.js";
import { readRunProgressSettings } from "./settings.js";
import type { ProgressProvider } from "./types.js";

const now = new Date("2026-11-17T10:02:11Z");
const run: AcceptedTriggerRunRecord = {
  id: "run",
  outcome: "accepted",
  status: "running",
  organizationId: "org",
  projectId: "project",
  configurationRevisionId: "revision",
  providerEventReceiptId: "receipt",
  configuredTriggerName: "trigger",
  prompt: "",
  inputs: {},
  values: {},
  triggerContext: {
    provider: "github_notification",
    event: { github_notification: { repo: "acme/widgets", number: 9 } },
  },
  outputContext: {},
  conversation: null,
  createdAt: now,
  deadlineAt: now,
  deadlineKind: null,
  failureReason: null,
  reactionState: null,
  terminalNotificationPendingAt: null,
  terminalNotificationDeliveredAt: null,
  terminalNotificationLeaseExpiresAt: null,
  completedAt: null,
};

await test("renders the body, link, title, and empty result at their exact size limits", () => {
  const title = "Paseo run: Running";
  const body = `${title}\nStarted 10:02:11 UTC. Updated 10:02:11 UTC.\nActivity: 0 tool calls, 0 failed.`;
  const linked = `${body}\nRun details: https://hub.example/a&amp;b/o/space%20%26/activity/run`;
  const input = {
    run,
    provider: "slack",
    steps: [],
    events: [],
    publicBaseUrl: "https://hub.example/a&b/?discard=x",
    organizationSlug: "space &",
  } as const;
  assert.equal(renderProgress({ ...input, maxBodyChars: linked.length }), linked);
  assert.equal(renderProgress({ ...input, maxBodyChars: linked.length - 1 }), body);
  assert.equal(renderProgress({ ...input, maxBodyChars: title.length }), title);
  assert.equal(renderProgress({ ...input, maxBodyChars: title.length - 1 }), "");
});

await test("an unadmitted backoff preserves native errors and callback order", () => {
  const backoff = new CredentialBackoff();
  const loc = { kind: "progress-token" } as const;
  const at = now.getTime();
  const unexpectedReport = () => assert.fail("unexpected rejection report");
  assert.throws(() => backoff.sent(loc, at), {
    name: "TypeError",
    message: "Cannot set properties of undefined (setting 'writeAfter')",
  });
  assert.throws(() => backoff.result(loc, at, "transient", unexpectedReport), {
    name: "TypeError",
    message: "Cannot read properties of undefined (reading 'sequentialFailures')",
  });
  assert.throws(
    () => backoff.result(loc, at, { status: "unavailable", code: "other" }, unexpectedReport),
    { name: "TypeError", message: "Cannot read properties of undefined (reading 'retryAfter')" },
  );
});

await test("shared rejection takes priority over spacing and expires at equality", () => {
  const backoff = new CredentialBackoff();
  const loc = { kind: "progress-token" } as const;
  const slot = backoff.admit(loc, now.getTime());
  assert.ok("release" in slot);
  const cooldown = { rejectedUntil: new Date(now.getTime() + 1000), retryAt: null };
  assert.deepEqual(backoff.admit(loc, now.getTime(), cooldown), { rejected: true });
  assert.deepEqual(backoff.admit(loc, now.getTime() + 1000, cooldown), {
    waitUntil: now.getTime() + 1250,
  });
  slot.release();
});

await test("settings preserve integer validation order and exact diagnostics", () => {
  const environment = {
    PASEO_HUB_TIMELINE_MAX_EVENTS: "50",
    PASEO_HUB_TIMELINE_RETENTION_DAYS: "  00365  ",
    PASEO_HUB_PROGRESS_MIN_EDIT_SECONDS: "  ",
  };
  const parsed = readRunProgressSettings(environment);
  assert.equal(parsed.timelineMaxEvents, 50);
  assert.equal(parsed.retentionDays, 365);
  assert.equal(parsed.minEditSeconds, 20);
  assert.throws(
    () =>
      readRunProgressSettings({
        ...environment,
        PASEO_HUB_TIMELINE_MAX_EVENTS: "49",
        PASEO_HUB_STREAM_MAX_SECONDS: "invalid",
      }),
    { message: "PASEO_HUB_TIMELINE_MAX_EVENTS must be a whole number from 50 to 5000." },
  );
});

function githubFixture(writes: Response[]) {
  const requests: string[] = [];
  const provider = new GitHubProgressProvider({
    database: {
      findTriggerRunForOrganization: async () => run,
      findOrganizationSlugById: async () => "demo",
      findGitHubConnection: async () => undefined,
      findGitHubRepositoryForOrganization: async () => undefined,
    },
    settings: {
      githubToken: "test-progress-token",
      githubOrgs: { demo: ["acme/widgets"] },
      publicRepos: "refuse",
    },
    fetch: async (resource, init) => {
      const request = new Request(resource, init);
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === "/repos/acme/widgets") return Response.json({ id: 31, private: true });
      if (request.method === "GET") return Response.json({ locked: true });
      return writes.shift() ?? Response.json({ id: 18 });
    },
  });
  const destination = provider.destination(run);
  assert.ok(destination);
  return { provider, requests, destination };
}

await test("GitHub checks a scope failure for issue locks and consumes the authorization", async () => {
  const { provider, requests, destination } = githubFixture([Response.json({}, { status: 403 })]);
  const { signal } = new AbortController();
  assert.equal(await provider.authorize(destination.credential, run, signal), "ok");
  assert.deepEqual(await provider.create(destination, "body", signal), {
    status: "unavailable",
    code: "locked",
  });
  assert.deepEqual(await provider.create(destination, "body", signal), {
    status: "refused",
    code: "invalid_credential",
  });
  assert.deepEqual(requests, [
    "GET /repos/acme/widgets",
    "POST /repos/acme/widgets/issues/9/comments",
    "GET /repos/acme/widgets/issues/9",
  ]);
});

await test("GitHub refuses a secret body without submitting a mutation", async () => {
  const { provider, requests, destination } = githubFixture([]);
  const { signal } = new AbortController();
  assert.equal(await provider.authorize(destination.credential, run, signal), "ok");
  assert.deepEqual(await provider.create(destination, "test-progress-token", signal), {
    status: "refused",
    code: "body_contains_secret",
  });
  assert.deepEqual(requests, ["GET /repos/acme/widgets"]);
});

await test("reports receipt lookup errors without inserting a progress message", async () => {
  const database = createMemoryDatabase();
  const events: unknown[] = [];
  database.findProviderEventReceiptById = async (receiptId, mode) => {
    events.push([receiptId, mode]);
    throw new Error("receipt unavailable");
  };
  const provider: ProgressProvider = githubFixture([]).provider;
  const reporter = new ProgressReporter({
    database,
    bus: new RunTimelineBus(),
    providers: [provider],
    settings: readRunProgressSettings({}),
    reportFailure: (code, scope) => events.push([code, scope]),
  });
  reporter.request(run);
  await setImmediate();
  reporter.stop();
  reporter.request(run);
  await setImmediate();
  assert.deepEqual(events, [
    ["receipt", "metadata"],
    ["opt_in_failed", { organizationId: "org", triggerRunId: "run" }],
  ]);
});
