import assert from "node:assert/strict";
import { ProblemSchema } from "../public-api/contracts.js";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { RunStream } from "./index.js";
import type { DatabaseRuntime } from "../db/runtime/index.js";
import {
  createStreamHarness,
  FOREIGN,
  ORGANIZATION,
  StreamReader,
  streamRequest,
  type StreamHarness,
} from "./test-utils.js";

function browserRequest(runId: string, organization = "stream") {
  return new Request(`http://localhost/api/v1/runs/${runId}/events?organization=${organization}`, {
    headers: { cookie: "session=member", "x-request-id": "stream-request" },
  });
}

function trackQueryCompletion(runtime: DatabaseRuntime) {
  const pending = new Set<Promise<unknown>>();
  const originalQuery = runtime.query.bind(runtime);
  runtime.query = new Proxy(originalQuery, {
    apply(operation, receiver: unknown, args: unknown[]) {
      const result: unknown = Reflect.apply(operation, receiver, args);
      if (result instanceof Promise) {
        pending.add(result);
        void result.finally(() => pending.delete(result)).catch(() => undefined);
      }
      return result;
    },
  });
  return {
    async settle() {
      while (true) {
        await setImmediate();
        if (pending.size === 0) return;
        await Promise.all(pending);
      }
    },
    restore() {
      runtime.query = originalQuery;
    },
  };
}

for (const backend of ["embedded", "pooled"] as const) {
  describe(`run stream authorization on ${backend}`, () => {
    let harness: StreamHarness;
    const services: RunStream[] = [];
    beforeAll(async () => {
      harness = await createStreamHarness(backend);
    }, 120_000);
    afterAll(async () => {
      await harness?.close();
    }, 120_000);
    afterEach(async () => {
      try {
        for (const service of services.splice(0)) {
          await service.beginShutdown();
          assert.equal(service.activeStreamCount(), 0);
          assert.equal(service.notifierCount(), 0);
        }
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (harness) {
          harness.setSessionActive(true);
          await harness.runtime!.query(
            "update member set role = 'owner' where id = 'stream-owner-row'",
          );
          await harness.runtime!.query(
            "insert into member (id, organization_id, user_id, role) values ('stream-member-row', 'stream-organization', 'stream-member', 'member') on conflict (id) do nothing",
          );
        }
      }
    });
    function stream() {
      const service = harness.stream();
      services.push(service);
      return service;
    }

    it("accepts a read key, CLI credential and member session, but never falls back from an Authorization header", async () => {
      const run = await harness.createRun();
      const cli = await harness.cli();
      const service = stream();
      for (const request of [
        streamRequest(run.id, harness.key),
        streamRequest(run.id, cli.token),
        browserRequest(run.id),
      ]) {
        const response = await service.handle(request, run.id);
        const reader = new StreamReader(response);
        assert.equal((await reader.event("status")).data["runId"], run.id);
        await reader.cancel();
        assert.equal(service.activeStreamCount(), 0);
        assert.equal(service.notifierCount(), 0);
      }
      for (const request of [
        new Request(`http://localhost/api/v1/runs/${run.id}/events`),
        streamRequest(run.id, "invalid", "", { cookie: "session=member" }),
        streamRequest(run.id, "", "", { authorization: "", cookie: "session=member" }),
      ]) {
        const response = await service.handle(request, run.id);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("www-authenticate"), "Bearer");
        assert.equal(ProblemSchema.parse(await response.json()).code, "unauthorized");
      }
    });

    it("requires the independent read scope and refuses revoked keys and CLI credentials", async () => {
      const run = await harness.createRun();
      const dispatch = await harness.apiKeys!.create(
        ORGANIZATION,
        "stream-owner",
        "dispatch only",
        ["runs:dispatch"],
      );
      const service = stream();
      const insufficient = await service.handle(streamRequest(run.id, dispatch.secret), run.id);
      assert.equal(insufficient.status, 403);
      assert.equal(ProblemSchema.parse(await insufficient.json()).code, "insufficient_scope");
      const read = await harness.apiKeys!.create(ORGANIZATION, "stream-owner", "revoked", [
        "runs:read",
      ]);
      await harness.apiKeys!.revoke(ORGANIZATION, read.summary.id);
      assert.equal((await service.handle(streamRequest(run.id, read.secret), run.id)).status, 401);
      const cli = await harness.cli();
      await harness.cliCredentials!.revoke(ORGANIZATION, cli.id);
      assert.equal((await service.handle(streamRequest(run.id, cli.token), run.id)).status, 401);
    });

    it.each(["removed", "demoted"])(
      "refuses a CLI owner who is %s before initial authorization",
      async (mode) => {
        const run = await harness.createRun();
        const cli = await harness.cli();
        if (mode === "removed")
          await harness.runtime!.query("delete from member where id = 'stream-owner-row'");
        else
          await harness.runtime!.query(
            "update member set role = 'member' where id = 'stream-owner-row'",
          );
        try {
          assert.equal(
            (await stream().handle(streamRequest(run.id, cli.token), run.id)).status,
            401,
          );
        } finally {
          await harness.runtime!.query(
            `insert into member (id, organization_id, user_id, role) values ('stream-owner-row', 'stream-organization', 'stream-owner', 'owner') on conflict (id) do update set role = 'owner'`,
          );
        }
      },
    );

    it("uses one 404 body for foreign, unknown and invalid runs for all auth kinds", async () => {
      const run = await harness.createRun();
      const cli = await harness.cli();
      const service = stream();
      const other = await harness.apiKeys!.create(FOREIGN, "stream-owner", "foreign read", [
        "runs:read",
      ]);
      const factories = [
        (id: string) => streamRequest(id, other.secret),
        (id: string) => streamRequest(id, cli.token),
        (id: string) => browserRequest(id),
      ];
      for (const factory of factories) {
        const unknown = await service.handle(factory(randomUUID()), randomUUID());
        const invalid = await service.handle(factory("invalid"), "invalid");
        assert.equal(unknown.status, 404);
        assert.deepEqual(await invalid.json(), await unknown.json());
      }
      const foreign = await service.handle(streamRequest(run.id, other.secret), run.id);
      const unknown = await service.handle(streamRequest(randomUUID(), other.secret), randomUUID());
      assert.deepEqual(await foreign.json(), await unknown.json());
      const foreignRun = await harness.createRun(["work"], FOREIGN);
      for (const request of [
        streamRequest(foreignRun.id, cli.token),
        browserRequest(foreignRun.id),
      ]) {
        const response = await service.handle(request, foreignRun.id);
        assert.equal(response.status, 404);
        assert.deepEqual(
          await response.json(),
          await (
            await service.handle(
              new Request(request.url, { headers: request.headers }),
              randomUUID(),
            )
          ).json(),
        );
      }
      assert.equal((await service.handle(browserRequest(run.id, "foreign"), run.id)).status, 404);
      await harness.removeMember();
      assert.equal((await service.handle(browserRequest(run.id), run.id)).status, 404);
    });

    it.each([
      "key revocation",
      "scope removal",
      "CLI revocation",
      "owner removal",
      "owner demotion",
      "session expiry",
      "member removal",
    ])("ends an open stream after %s without updating last use", async (mode) => {
      const run = await harness.createRun();
      const key = await harness.apiKeys!.create(ORGANIZATION, "stream-owner", "reauthorize", [
        "runs:read",
      ]);
      const cli = await harness.cli();
      const isCli = mode.startsWith("CLI") || mode.startsWith("owner");
      const isBrowser = mode.startsWith("session") || mode === "member removal";
      const request = isBrowser
        ? browserRequest(run.id)
        : streamRequest(run.id, isCli ? cli.token : key.secret);
      const queries = trackQueryCompletion(harness.runtime!);
      try {
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        });
        const service = stream();
        const reader = new StreamReader(await service.handle(request, run.id));
        await reader.event("status");
        const table = isCli ? "organization_cli_credentials" : "organization_api_keys";
        const id = isCli ? cli.id : key.summary.id;
        const before = await harness.runtime!.query<{ last_used_at: Date }>(
          `select last_used_at from ${table} where id = $1`,
          [id],
        );
        if (mode === "key revocation") await harness.apiKeys!.revoke(ORGANIZATION, key.summary.id);
        if (mode === "scope removal")
          await harness.runtime!.query(
            "update organization_api_keys set scopes = ARRAY['runs:dispatch'] where id = $1",
            [key.summary.id],
          );
        if (mode === "CLI revocation") await harness.cliCredentials!.revoke(ORGANIZATION, cli.id);
        if (mode === "owner removal")
          await harness.runtime!.query("delete from member where id = 'stream-owner-row'");
        if (mode === "owner demotion")
          await harness.runtime!.query(
            "update member set role = 'member' where id = 'stream-owner-row'",
          );
        if (mode === "session expiry") harness.setSessionActive(false);
        if (mode === "member removal") await harness.removeMember();
        for (let tick = 0; tick < 30; tick++) {
          await vi.advanceTimersByTimeAsync(2000);
          await queries.settle();
        }
        const error = await reader.event("error");
        assert.deepEqual(error.data, { code: "unauthorized" });
        assert.equal(error.frame.startsWith("id:"), false);
        await reader.all();
        const after = await harness.runtime!.query<{ last_used_at: Date }>(
          `select last_used_at from ${table} where id = $1`,
          [id],
        );
        assert.deepEqual(after.rows[0], before.rows[0]);
        assert.equal(service.activeStreamCount(), 0);
        assert.equal(service.notifierCount(), 0);
        await setImmediate();
      } finally {
        vi.useRealTimers();
        queries.restore();
        await harness.runtime!.query(
          `insert into member (id, organization_id, user_id, role) values ('stream-owner-row', 'stream-organization', 'stream-owner', 'owner') on conflict (id) do update set role = 'owner'`,
        );
      }
    });

    it("binds read-only credential checks to organization and kind", async () => {
      const key = await harness.apiKeys!.create(ORGANIZATION, "stream-owner", "read check", [
        "runs:read",
      ]);
      const cli = await harness.cli();
      for (const token of [key.secret, cli.token]) {
        const result = await harness.credentials.authorize(
          streamRequest(randomUUID(), token),
          "runs:read",
        );
        assert.equal(result.status, "authorized");
        if (result.status !== "authorized") throw new Error("Expected authorization");
        assert.equal(await harness.credentials.reauthorize(result.access, "runs:read"), true);
        assert.equal(
          await harness.credentials.reauthorize(
            { ...result.access, organizationId: FOREIGN },
            "runs:read",
          ),
          false,
        );
        assert.equal(
          await harness.credentials.reauthorize(
            {
              ...result.access,
              kind: result.access.kind === "apiKey" ? "cliCredential" : "apiKey",
            },
            "runs:read",
          ),
          false,
        );
      }
    });
  });
}
