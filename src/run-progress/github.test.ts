import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it, vi } from "vitest";
import { z } from "zod";
import { createGitHubAuth } from "../auth/github.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { GitHubConnectionRecord, GitHubRepositoryRecord } from "../db/types.js";
import { logger } from "../logger.js";
import { CredentialBackoff } from "./backoff.js";
import { GitHubProgressProvider } from "./github.js";
import { readRunProgressSettings } from "./settings.js";
import type { ProgressClock, StoredRef } from "./types.js";
import { MessageWriter } from "./writer.js";

const repoPath = "/repos/acme/widgets";
const issuePath = `${repoPath}/issues/9`;
const commentsPath = `${issuePath}/comments`;
const editPath = `${repoPath}/issues/comments/18`;
const organizationId = "hub-organization";
const progressToken = "fake-progress-token";
const installationToken = "fake-installation-token";
const notificationsToken = "fake-notifications-token";
const signal = new AbortController().signal;
const uncertain = { status: "retry", afterMs: 0, notCreated: false, transient: true };
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "pkcs1" },
});

afterEach(() => vi.restoreAllMocks());

async function fixture(path: "app" | "token" = "token") {
  const time = { value: Date.now() };
  const clock: ProgressClock = {
    now: () => time.value,
    monotonic: () => time.value,
    timer(callback, delay) {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
  const database = createMemoryDatabase({
    organizationIds: [organizationId],
    now: () => new Date(time.value),
  });
  let slug = "mapped";
  database.findOrganizationSlugById = async () => slug;
  const connection: GitHubConnectionRecord = {
    id: "connection",
    organizationId,
    slug: "acme",
    installationId: 11,
    accountId: "21",
    accountLogin: "acme",
    accountType: "Organization",
    status: "active",
    providerApplicationId: "app-id",
  };
  const repository: GitHubRepositoryRecord = {
    id: "resource",
    organizationId,
    connectionId: connection.id,
    repositoryId: 31,
    fullName: "acme/widgets",
    defaultBranch: "main",
  };
  const lookup = vi
    .spyOn(database, "findGitHubConnection")
    .mockImplementation(async () => ({ ...connection }));
  const repositoryLookup = vi
    .spyOn(database, "findGitHubRepositoryForOrganization")
    .mockImplementation(async () => ({ ...repository }));
  const requests: Request[] = [];
  const state = {
    private: true,
    locked: false,
    metadata: true,
    oauthScopes: "",
    comments: [] as { id: number; body: string; user: { id: number } }[],
    nextWrite: undefined as Response | undefined,
    writeError: undefined as Error | undefined,
    onRefresh: () => {},
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(request);
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(request.redirect, "manual");
    if (url.pathname === "/app/installations/11/access_tokens") {
      state.onRefresh();
      return Response.json({
        token: installationToken,
        expires_at: new Date(time.value + 3600_000),
      });
    }
    assert.equal(
      request.headers.get("authorization"),
      path === "token" ? `Bearer ${progressToken}` : `token ${installationToken}`,
    );
    if (request.method === "GET") {
      const headers = { "x-oauth-scopes": state.oauthScopes };
      if (url.pathname === repoPath) {
        return Response.json(state.metadata ? { id: 31, private: state.private } : {}, { headers });
      }
      if (url.pathname === issuePath) return Response.json({ locked: state.locked });
      if (url.pathname === "/user" || decodeURIComponent(url.pathname) === "/users/paseo[bot]")
        return Response.json({ id: 23 });
      if (url.pathname === commentsPath) {
        assert.equal(url.searchParams.get("per_page"), "100");
        assert.equal(url.searchParams.has("since"), true);
        return Response.json(state.comments);
      }
    }
    if (state.writeError !== undefined) throw state.writeError;
    const response = state.nextWrite;
    if (response !== undefined) {
      state.nextWrite = undefined;
      return response;
    }
    assert.equal(url.pathname, request.method === "POST" ? commentsPath : editPath);
    const body = z.object({ body: z.string() }).parse(await request.clone().json()).body;
    if (request.method === "POST") {
      const comment = { id: 18 + state.comments.length, body, user: { id: 23 } };
      state.comments.push(comment);
      return Response.json(comment, { status: 201 });
    }
    const edited = state.comments.find(({ id }) => id === 18);
    if (edited !== undefined) edited.body = body;
    return Response.json({ id: 18 });
  };
  const readNotificationToken = vi.fn(() => notificationsToken);
  const settings = readRunProgressSettings({
    PASEO_HUB_PROGRESS_GITHUB_TOKEN: `  ${progressToken}  `,
    PASEO_HUB_PROGRESS_GITHUB_ORGS: "mapped:ACME/Widgets;other:other/*",
    get GITHUB_NOTIFICATIONS_TOKEN() {
      return readNotificationToken();
    },
  });
  const auth = createGitHubAuth({ appId: "app-id", privateKey, fetch, now: () => clock.now() });
  const install = vi.spyOn(auth, "createInstallationOctokit");
  const makeProvider = (overrides: Partial<typeof settings> = {}, withToken = true) =>
    new GitHubProgressProvider({
      database,
      settings: { ...(withToken ? settings : readRunProgressSettings({})), ...overrides },
      ...(path === "app" ? { app: { id: "app-id", slug: "paseo", privateKey, auth } } : {}),
      fetch,
    });
  const provider = makeProvider();
  async function createRun(options: { issue?: number | null; repo?: string } = {}) {
    const { issue = 9, repo = "acme/widgets" } = options;
    const { run } = await database.createAcceptedTriggerRun({
      organizationId,
      projectId: "project",
      configurationRevisionId: "revision",
      providerEventReceiptId: `receipt-${crypto.randomUUID()}`,
      configuredTriggerName: "trigger",
      prompt: "",
      inputs: {},
      triggerContext:
        path === "app"
          ? {}
          : {
              provider: "github_notification",
              event: { github_notification: { repo, number: issue } },
            },
      outputContext:
        path === "token"
          ? { provider: "github_notification" }
          : {
              provider: "github",
              target: { installationId: 11, repository: repo },
              event: { github: { item: issue === null ? null : { number: issue } } },
            },
      stepIds: [],
      createdAt: new Date(time.value),
      deadlineAt: new Date(time.value + 3600_000),
    });
    return run;
  }
  const run = await createRun();
  const target = provider.destination(run)!;
  const ref: StoredRef = { ...target, repositoryId: 31, commentId: 18 };
  const scope = { organizationId, triggerRunId: run.id };
  const authorize = async (writeRef = ref, using = provider) =>
    assert.equal(await using.authorize(writeRef.credential, run, signal), "ok");
  const mutations = () =>
    requests.filter(
      (request) =>
        request.method === "PATCH" ||
        (request.method === "POST" && new URL(request.url).pathname === commentsPath),
    );
  const read = () => database.findRunProgressMessage(organizationId, run.id);
  const writer = () =>
    new MessageWriter({
      database,
      clock,
      settings: { minEditSeconds: 20, maxEdits: 120, retentionDays: 30 },
      backoff: new CredentialBackoff(() => 0.5),
      report: () => {},
      signal,
    });
  const seed = async () => {
    assert.ok(
      await database.insertRunProgressMessageIfAbsent({
        ...scope,
        provider: "github",
        now: new Date(time.value),
      }),
    );
    await event("run_started");
  };
  const event = (kind: "run_started" | "tool_finished") =>
    database.appendRunTimelineEvent({
      ...scope,
      kind,
      at: new Date(time.value),
      origin: "captured",
      data:
        kind === "run_started"
          ? {}
          : { callId: String(time.value), category: "command", status: "completed" },
      maxEvents: 500,
    });
  const advance = (ms: number) => {
    time.value += ms;
  };
  return {
    state,
    requests,
    mutations,
    run,
    target,
    ref,
    scope,
    authorize,
    provider,
    makeProvider,
    database,
    clock,
    read,
    writer,
    seed,
    event,
    advance,
    connection,
    repository,
    lookup,
    repositoryLookup,
    install,
    readNotificationToken,
    createRun,
    rename: (value: string) => {
      slug = value;
    },
  };
}

describe("GitHub run progress", () => {
  it.each(["app", "token"] as const)(
    "creates and patches the same conversation comment using the %s credential",
    async (path) => {
      const f = await fixture(path);
      await f.authorize(f.target);
      const created = await f.provider.create(f.target, "Paseo run: Running", signal);
      assert.deepEqual(created, { status: "ok", ref: f.ref });
      assert.match(f.state.comments[0]!.body, /\n\n<!-- paseo-run-progress:[a-f0-9]{64} -->$/u);
      const initialBody = f.state.comments[0]!.body;
      await f.authorize();
      assert.deepEqual(await f.provider.edit(f.ref, "Paseo run: Succeeded", signal), {
        status: "ok",
      });
      assert.equal(f.state.comments[0]!.body, initialBody.replace("Running", "Succeeded"));
      assert.deepEqual(
        f.mutations().map((request) => [request.method, new URL(request.url).pathname]),
        [
          ["POST", commentsPath],
          ["PATCH", editPath],
        ],
      );
      assert.equal(f.state.comments.length, 1);
      assert.equal(f.readNotificationToken.mock.calls.length, 0);
      if (path === "app")
        assert.deepEqual(
          f.install.mock.calls.map(([, options]) => options?.retries),
          ["off", "off"],
        );
    },
  );

  it.each(["app", "token"] as const)(
    "makes one %s create request on 502 and never recreates the row",
    async (path) => {
      const f = await fixture(path);
      await f.seed();
      f.state.nextWrite = Response.json({ message: "Bad Gateway" }, { status: 502 });
      const writer = f.writer();
      await writer.write(f.scope, f.provider);
      assert.equal((await f.read())?.state, "abandoned");
      assert.equal((await f.read())?.failure, "create_unknown");
      assert.equal(f.mutations().length, 1);
      f.advance(120_000);
      await f.writer().write(f.scope, f.makeProvider());
      assert.equal(f.mutations().length, 1);
    },
  );

  it.each([
    ["POST", 404, {}, { status: "unavailable", code: "target_not_found" }],
    ["PATCH", 404, {}, { status: "gone" }],
    ["POST", 403, {}, { status: "unavailable", code: "locked" }],
    ["POST", 403, { "x-github-sso": "required" }, { status: "unavailable", code: "sso_required" }],
    ["POST", 403, { "retry-after": "8" }, { status: "retry", afterMs: 8000, notCreated: true }],
    [
      "PATCH",
      403,
      { "retry-after": "999" },
      { status: "retry", afterMs: 900_000, notCreated: false },
    ],
    [
      "POST",
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" },
      { status: "retry", afterMs: 0, notCreated: true },
    ],
    ["POST", 429, { "retry-after": "2" }, { status: "retry", afterMs: 2000, notCreated: true }],
    ["POST", 401, {}, { status: "unavailable", code: "credential_rejected" }],
    ["POST", 422, {}, { status: "unavailable", code: "rejected" }],
    ["PATCH", 502, {}, uncertain],
    ["POST", 307, { location: "https://example.test/redirect" }, uncertain],
  ] as const)(
    "maps %s HTTP %i from status and documented metadata",
    async (method, status, headers, expected) => {
      const f = await fixture();
      f.state.locked = status === 403;
      f.state.nextWrite = Response.json(
        { message: "provider text is irrelevant" },
        { status, headers },
      );
      await f.authorize();
      assert.deepEqual(
        await (method === "POST"
          ? f.provider.create(f.ref, "Running", signal)
          : f.provider.edit(f.ref, "Running", signal)),
        expected,
      );
      assert.equal(f.mutations().length, 1);
    },
  );

  it("allows the writer to retry a create only after a confirmed rate-limit rejection", async () => {
    const f = await fixture();
    await f.seed();
    f.state.nextWrite = Response.json(
      { message: "rate limited" },
      {
        status: 429,
        headers: { "retry-after": "5" },
      },
    );
    const writer = f.writer();
    await writer.write(f.scope, f.provider);
    assert.equal((await f.read())?.state, "pending");
    f.advance(4_999);
    await writer.write(f.scope, f.provider);
    assert.equal(f.mutations().length, 1);
    f.advance(1);
    await writer.write(f.scope, f.provider);
    assert.equal((await f.read())?.state, "active");
    assert.equal(f.mutations().length, 2);
    assert.equal(f.state.comments.length, 1);
  });

  it("does not classify a free-text 403 as locked or rate limited", async () => {
    const f = await fixture();
    f.state.nextWrite = Response.json(
      { message: "conversation is locked; secondary rate limit" },
      { status: 403 },
    );
    await f.authorize();
    assert.deepEqual(await f.provider.create(f.ref, "Running", signal), {
      status: "unavailable",
      code: "scope_missing",
    });
  });

  it.each([
    [201, {}],
    [429, { id: 18, message: "too fast" }],
    [429, { status: "201", message: "unexpected status" }],
    [403, { data: { id: 18 }, message: "too fast" }],
    [422, { id: 18, message: "rejected" }],
  ] as const)("does not replay ambiguous HTTP %i responses", async (status, body) => {
    const f = await fixture();
    f.state.nextWrite = Response.json(body, { status, headers: { "retry-after": "1" } });
    await f.authorize();
    assert.deepEqual(await f.provider.create(f.ref, "Running", signal), uncertain);
    assert.equal(f.mutations().length, 1);
  });

  it("does not surface a token from a network exception or error response", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const f = await fixture();
    f.state.oauthScopes = `repo,admin:org,${progressToken}`;
    await f.authorize();
    f.state.writeError = new Error(`fake error: ${progressToken}`);
    const networkFailure = await f.provider.create(f.ref, "Running", signal);
    assert.deepEqual(networkFailure, uncertain);
    await f.authorize();
    f.state.writeError = undefined;
    f.state.nextWrite = Response.json({ message: progressToken }, { status: 422 });
    const rejected = await f.provider.create(f.ref, "Running", signal);
    assert.deepEqual(rejected, { status: "unavailable", code: "rejected" });
    assert.deepEqual(warn.mock.calls, [["GitHub progress token has broader scopes than needed"]]);
    assert.doesNotMatch(
      JSON.stringify([networkFailure, rejected, warn.mock.calls]),
      /fake-progress-token/u,
    );
    assert.equal(f.readNotificationToken.mock.calls.length, 0);
  });

  it("caps response bodies at 1 MiB", async () => {
    const f = await fixture("app");
    await f.authorize();
    f.state.nextWrite = new Response("x".repeat(1024 * 1024 + 1), { status: 201 });
    assert.deepEqual(await f.provider.create(f.ref, "Running", signal), uncertain);
    assert.equal(f.mutations().length, 1);
  });

  it("cancels a stalled response body after five seconds", { timeout: 8000 }, async () => {
    const f = await fixture();
    await f.authorize();
    const cancel = vi.fn();
    f.state.nextWrite = new Response(new ReadableStream({ cancel }), { status: 201 });
    assert.deepEqual(await f.provider.create(f.ref, "Running", signal), uncertain);
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(f.mutations().length, 1);
  });

  it("refuses an unmapped organization, a disallowed repository, and a renamed organization", async () => {
    const f = await fixture();
    const outside = await f.createRun({ repo: "outside/widgets" });
    assert.deepEqual(await f.provider.authorize(f.ref.credential, outside, signal), {
      refused: "repo_not_allowed",
    });
    f.rename("unmapped");
    assert.deepEqual(await f.provider.authorize(f.ref.credential, f.run, signal), {
      refused: "org_not_mapped",
    });
    f.rename("mapped");
    await f.authorize();
    f.rename("renamed");
    assert.deepEqual(await f.provider.edit(f.ref, "Running", signal), {
      status: "refused",
      code: "org_not_mapped",
    });
    assert.equal(f.mutations().length, 0);
  });

  it("refuses missing credentials and runs without an issue number", async () => {
    const f = await fixture();
    const noCredential = f.makeProvider({}, false);
    assert.deepEqual(await noCredential.authorize(f.ref.credential, f.run, signal), {
      unavailable: "no_credential",
    });
    assert.equal(f.provider.destination(await f.createRun({ issue: null })), undefined);
    assert.equal(f.requests.length, 0);
  });

  it.each(["organization", "inactive", "repository"] as const)(
    "refuses an installation with incorrect %s binding",
    async (reason) => {
      const f = await fixture("app");
      if (reason === "organization") f.connection.organizationId = "other-organization";
      if (reason === "inactive") f.connection.status = "suspended";
      if (reason === "repository") f.repositoryLookup.mockResolvedValue(undefined);
      assert.deepEqual(await f.provider.authorize(f.ref.credential, f.run, signal), {
        refused: "installation_not_owned",
      });
      assert.equal(f.requests.length, 0);
    },
  );

  it("checks the installation binding after refresh and again before the edit", async () => {
    const f = await fixture("app");
    f.state.onRefresh = () => {
      f.connection.id = "replacement";
    };
    assert.deepEqual(await f.provider.authorize(f.ref.credential, f.run, signal), {
      refused: "installation_not_owned",
    });
    assert.equal(f.requests.length, 1);
    f.connection.id = "connection";
    await f.authorize();
    f.lookup.mockResolvedValue(undefined);
    assert.deepEqual(await f.provider.edit(f.ref, "Running", signal), {
      status: "refused",
      code: "installation_not_owned",
    });
    assert.equal(f.mutations().length, 0);
  });

  it("does not refresh or use a credential after cancellation", async () => {
    const f = await fixture("app");
    await assert.rejects(f.provider.authorize(f.ref.credential, f.run, AbortSignal.abort()));
    assert.equal(f.install.mock.calls.length, 0);
    await f.authorize();
    const count = f.requests.length;
    assert.deepEqual(await f.provider.edit(f.ref, "Running", AbortSignal.abort()), uncertain);
    assert.equal(f.requests.length, count);
  });

  it.each([{ repository: "other/widgets" }, { issueNumber: 11 }, { repositoryId: 32 }])(
    "refuses a stored reference with a different destination %j",
    async (changed) => {
      const f = await fixture();
      await f.authorize();
      assert.deepEqual(await f.provider.edit({ ...f.ref, ...changed }, "Running", signal), {
        status: "refused",
        code: "target_mismatch",
      });
      assert.equal(f.mutations().length, 0);
    },
  );

  it("refuses public repositories by default and permits an operator override", async () => {
    const f = await fixture();
    f.state.private = false;
    assert.deepEqual(await f.provider.authorize(f.ref.credential, f.run, signal), {
      refused: "public_repository",
    });
    await f.authorize(f.ref, f.makeProvider({ publicRepos: "allow" }));
    assert.equal(f.mutations().length, 0);
  });

  it("stops after three unknown visibility checks even under the allow policy", async () => {
    const f = await fixture();
    f.state.metadata = false;
    assert.deepEqual(
      await f.makeProvider({ publicRepos: "allow" }).authorize(f.ref.credential, f.run, signal),
      {
        unavailable: "visibility_unknown",
      },
    );
    assert.equal(f.requests.length, 3);
    assert.equal(f.mutations().length, 0);
  });

  it.each([20_000, 600_000])(
    "rechecks visibility before the final edit and after the cache expires (%i ms)",
    async (elapsed) => {
      const f = await fixture();
      await f.seed();
      const writer = f.writer();
      await writer.write(f.scope, f.provider);
      assert.equal((await f.read())?.visibility, "private");
      assert.equal((await f.read())?.state, "active");
      f.advance(20_000);
      await f.event("tool_finished");
      await writer.write(f.scope, f.provider);
      assert.equal(f.requests.filter((request) => request.method === "GET").length, 1);
      f.state.private = false;
      f.advance(elapsed);
      if (elapsed < 600_000) await f.database.succeedTriggerRun(f.run.id);
      else await f.event("tool_finished");
      await writer.write(f.scope, f.provider);
      assert.equal((await f.read())?.state, "refused");
      assert.equal((await f.read())?.failure, "visibility_changed");
      assert.equal((await f.read())?.visibility, "public");
      assert.equal(f.mutations().length, 2);
    },
  );

  it.each(["app", "token"] as const)(
    "adopts a %s comment after restart without writing a second comment",
    async (path) => {
      const f = await fixture(path);
      await f.seed();
      const update = f.database.updateRunProgressMessage.bind(f.database);
      const firstWrite = vi
        .spyOn(f.database, "updateRunProgressMessage")
        .mockImplementation(async (input) => {
          if (input.patch.externalRef !== undefined)
            throw new Error("process stopped before recording create");
          return update(input);
        });
      await f.writer().write(f.scope, f.provider);
      firstWrite.mockRestore();
      assert.equal((await f.read())?.state, "creating");
      assert.equal(f.state.comments.length, 1);

      f.advance(60_000);
      const replacement = f.makeProvider();
      const writer = f.writer();
      await writer.write(f.scope, replacement);
      assert.equal((await f.read())?.state, "active");
      assert.deepEqual((await f.read())?.externalRef, f.ref);
      await f.database.succeedTriggerRun(f.run.id);
      await writer.write(f.scope, replacement);
      assert.equal((await f.read())?.state, "finished");
      assert.match(f.state.comments[0]!.body, /Succeeded/u);
      assert.deepEqual(
        f.mutations().map(({ method }) => method),
        ["POST", "PATCH"],
      );
    },
  );

  it("abandons a recovery miss instead of adopting another run's body or actor", async () => {
    const f = await fixture();
    await f.seed();
    const another = await f.createRun();
    const otherTarget = f.provider.destination(another)!;
    assert.equal(await f.provider.authorize(otherTarget.credential, another, signal), "ok");
    await f.provider.create(otherTarget, "Another run", signal);
    const otherBody = f.state.comments[0]!.body;
    await f.authorize();
    assert.deepEqual(await f.provider.create(f.ref, otherBody, signal), {
      status: "refused",
      code: "body_contains_secret",
    });
    const update = f.database.updateRunProgressMessage.bind(f.database);
    const interrupt = vi
      .spyOn(f.database, "updateRunProgressMessage")
      .mockImplementation(async (input) => {
        if (input.patch.externalRef !== undefined) throw new Error("process stopped");
        return update(input);
      });
    await f.writer().write(f.scope, f.provider);
    interrupt.mockRestore();
    assert.equal((await f.read())?.state, "creating");
    f.state.comments[1]!.user.id = 777;
    f.advance(60_000);
    await f.writer().write(f.scope, f.makeProvider());
    assert.equal((await f.read())?.state, "abandoned");
    assert.equal((await f.read())?.externalRef, null);
    assert.equal(f.mutations().length, 2);
  });
});
