import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type * as CryptoModule from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { z } from "zod";
import { ReceiptRetention } from "../receipt-retention/index.js";
import { logger } from "../logger.js";
import { beginHttpShutdown, createFetchServer } from "../http/node-server.js";
import { githubSignerUrl } from "../webhooks/contract.js";
import { ProblemSchema, ReceivedWebhookSchema, publicOpenApiDocument } from "./index.js";
import { testSigningSettings, webhookFixture } from "./test-utils/webhook-fixture.js";

const randomFixture = vi.hoisted(() => ({ nextToken: undefined as Buffer | undefined }));

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof CryptoModule>();
  function randomBytes(size: number): Buffer;
  function randomBytes(size: number, callback: Parameters<typeof crypto.randomBytes>[1]): void;
  function randomBytes(size: number, callback?: Parameters<typeof crypto.randomBytes>[1]) {
    if (callback !== undefined) return crypto.randomBytes(size, callback);
    if (size === 32 && randomFixture.nextToken !== undefined) {
      const token = randomFixture.nextToken;
      randomFixture.nextToken = undefined;
      return token;
    }
    return crypto.randomBytes(size);
  }
  return { ...crypto, randomBytes };
});

type Hub = Awaited<ReturnType<typeof webhookFixture>>;
type Signer = Awaited<ReturnType<Hub["createSigner"]>>;
const body = '{"message":"signed sentinel body","status":"failed","actor":"untrusted"}';

function sign(secret: string, bytes: string | Uint8Array): string {
  return "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex");
}

async function signed(
  hub: Hub,
  signer: Signer,
  bytes: string | Uint8Array = body,
  options: {
    signature?: string | null;
    trigger?: string;
    keyId?: string;
    headers?: HeadersInit;
  } = {},
) {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (options.signature !== null) {
    headers.set("x-hub-signature-256", options.signature ?? sign(signer.signingSecret, bytes));
  }
  return hub.application.publicApi.handle(
    new Request(
      githubSignerUrl(
        "http://hub.test",
        options.trigger ?? "build-finished",
        options.keyId ?? signer.summary.id,
      ),
      { method: "POST", headers, body: typeof bytes === "string" ? bytes : Uint8Array.from(bytes) },
    ),
  );
}

async function result(response: Response, status: number) {
  assert.equal(response.status, status, await response.clone().text());
  return ReceivedWebhookSchema.parse(await response.json());
}

async function assertDuplicateIfSuccessful(response: Response) {
  if (response.status === 200) assert.equal((await result(response, 200)).duplicate, true);
}

async function problem(response: Response, status: number, code: string) {
  assert.equal(response.status, status, await response.clone().text());
  const value = ProblemSchema.parse(await response.json());
  assert.equal(value.code, code);
  if (status === 401) assert.equal(response.headers.has("www-authenticate"), false);
  return { ...value, requestId: "fixed" };
}

describe("GitHub signer webhook intake", () => {
  let hub: Hub;
  let target: Awaited<ReturnType<Hub["save"]>>;

  beforeAll(async () => {
    hub = await webhookFixture({ maxBytes: 1024 }, { signing: testSigningSettings() });
    target = await hub.save();
  });

  afterAll(async () => hub?.close());

  it("rejects every invalid proof uniformly before storage or last-use changes", async () => {
    const signer = await hub.createSigner(target.id);
    const valid = sign(signer.signingSecret, body);
    const responses = [];
    for (const options of [
      { signature: null },
      { signature: sign("wrong", body) },
      { signature: sign(signer.signingSecret, body + " ") },
      { signature: valid.slice(0, -1) },
      { signature: valid.slice(0, -1) + "w" },
      { signature: valid.slice(0, 7) + valid.slice(7).toUpperCase() },
      { signature: valid + ", " + valid },
      { signature: null, headers: { "x-hub-signature": "sha1=invalid" } },
      { headers: { authorization: "Bearer discarded" } },
      { headers: { "x-paseo-signature": "v1" } },
      { keyId: randomUUID() },
      { keyId: hub.key.summary.id },
    ])
      responses.push(await problem(await signed(hub, signer, body, options), 401, "unauthorized"));
    for (const response of responses) assert.deepEqual(response, responses[0]);
    assert.equal(
      (await hub.keys.list("webhook-a")).find(({ id }) => id === signer.summary.id)?.lastUsedAt,
      null,
    );
  });

  it("authenticates the exact bytes, hides other targets, and retains only one receipt per raw body", async () => {
    const signer = await hub.createSigner(target.id);
    const invalidActor = await hub.createSigner(target.id, "other-actor");
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(" " + body + "\n")]);
    await problem(
      await signed(hub, signer, raw, { signature: sign(signer.signingSecret, body) }),
      401,
      "unauthorized",
    );
    await problem(await signed(hub, signer, raw, { trigger: "another" }), 404, "trigger_not_found");
    await problem(await signed(hub, invalidActor, raw), 404, "trigger_not_found");
    await problem(
      await signed(hub, signer, raw, { headers: { "idempotency-key": "user-choice" } }),
      400,
      "invalid_request",
    );
    const digest = createHash("sha256").update(raw).digest("hex");
    const first = await result(
      await signed(hub, signer, raw, { headers: { "x-github-delivery": "first" } }),
      202,
    );
    assert.ok("triggerRunId" in first);
    const expectedKey = "github-sha256:" + digest;
    assert.equal(first.deliveryKey, expectedKey);
    const run = await hub.database.findTriggerRunById(first.triggerRunId);
    assert.ok(run);
    assert.match(run.prompt, /signed sentinel body/u);
    const receipt = await hub.database.findProviderEventReceiptById(first.providerEventReceiptId);
    assert.equal(
      receipt?.deliveryId,
      "public-signature-" +
        createHash("sha256")
          .update(JSON.stringify(["webhook-a", signer.summary.id, digest]))
          .digest("hex"),
    );
    assert.equal(z.object({ actor: z.string() }).parse(receipt?.payload).actor, "sender");
    const duplicate = await result(
      await signed(hub, signer, raw, {
        headers: {
          "x-github-delivery": "changed",
          "x-github-event": "untrusted",
          "idempotency-key": expectedKey,
        },
      }),
      200,
    );
    assert.deepEqual(duplicate, { ...first, duplicate: true });
    const distinct = await result(await signed(hub, signer, body), 202);
    assert.ok("triggerRunId" in distinct);
    assert.notEqual(distinct.triggerRunId, first.triggerRunId);
  });

  it("enforces representation and byte limits before dispatch", async () => {
    const signer = await hub.createSigner(target.id);
    for (const headers of [
      { "content-type": "text/plain" },
      { "content-type": "application/json; charset=latin1" },
      { "content-encoding": "gzip" },
    ])
      await problem(await signed(hub, signer, body, { headers }), 415, "unsupported_media_type");
    await problem(
      await signed(hub, signer, body, { headers: { "content-length": "1025" } }),
      413,
      "payload_too_large",
    );
    await problem(await signed(hub, signer, " ".repeat(1025)), 413, "payload_too_large");
    await problem(await signed(hub, signer, Buffer.from([0xff])), 400, "invalid_request");
    await problem(await signed(hub, signer, '{"bad":"\\u0000"}'), 422, "invalid_body");
    await problem(await signed(hub, signer, "{"), 400, "invalid_json");
  });

  it("keeps dedupe through rotation, checks expiry before cleanup, retires and revokes", async () => {
    const signer = await hub.createSigner(target.id);
    const id = signer.summary.id;
    const first = await result(await signed(hub, signer), 202);
    const rotate = (current: string, overlapSeconds = 3600) =>
      hub.runtime.transaction((client) =>
        hub.keys.signing.rotate(client, "webhook-a", {
          id,
          expectedCurrentVersionId: current,
          overlapSeconds,
        }),
      );
    const originalId = signer.summary.authentication.currentVersionId!;
    const rotated = await rotate(originalId);
    assert.equal(rotated.authentication.previousVersionId, originalId);
    const activeId = rotated.authentication.currentVersionId!;
    await assert.rejects(rotate(activeId, 0), /rotation_in_progress/u);
    assert.deepEqual(await result(await signed(hub, signer), 200), { ...first, duplicate: true });
    assert.deepEqual(
      await result(await signed(hub, { ...signer, signingSecret: rotated.signingSecret }), 200),
      { ...first, duplicate: true },
    );
    await hub.runtime.query(
      "update organization_webhook_secrets set accept_until = clock_timestamp() where api_key_id = $1 and slot = 'previous'",
      [id],
    );
    await problem(await signed(hub, signer), 401, "unauthorized");
    const latest = await rotate(activeId);
    await hub.runtime.transaction((client) =>
      hub.keys.signing.retire(client, "webhook-a", { id, expectedPreviousVersionId: activeId }),
    );
    await problem(
      await signed(hub, { ...signer, signingSecret: rotated.signingSecret }),
      401,
      "unauthorized",
    );
    const current = { ...signer, signingSecret: latest.signingSecret };
    assert.equal((await signed(hub, current)).status, 200);
    assert.equal(await hub.keys.revoke("webhook-a", id), true);
    assert.equal(
      (
        await hub.runtime.query(
          "select 1 from organization_webhook_secrets where api_key_id = $1",
          [id],
        )
      ).rowCount,
      0,
    );
    await problem(await signed(hub, current), 401, "unauthorized");
  });

  it("refuses the discarded token through either Bearer route", async () => {
    const tokenBytes = Buffer.alloc(32, 0x52);
    randomFixture.nextToken = tokenBytes;
    const signer = await hub.createSigner(target.id).finally(() => {
      randomFixture.nextToken = undefined;
    });
    const discarded = signer.summary.prefix + "_" + tokenBytes.toString("base64url");
    const verifier = await hub.runtime.query<{ verifier: string }>(
      "select verifier from organization_api_keys where id = $1",
      [signer.summary.id],
    );
    assert.equal(
      verifier.rows[0]?.verifier,
      createHash("sha256").update(discarded).digest("base64url"),
    );
    for (const path of ["/api/v1/hooks/build-finished", "/api/v1/manual-runs"]) {
      const response = await hub.application.publicApi.handle(
        new Request("http://hub.test" + path, {
          method: "POST",
          headers: { authorization: "Bearer " + discarded, "content-type": "application/json" },
          body,
        }),
      );
      assert.equal(response.status, 401);
    }
  });

  it("does not disclose signing material, request proof, or untrusted body in logs or stored records", async () => {
    const signer = await hub.createSigner(target.id);
    const watched = [
      signer.signingSecret,
      sign(signer.signingSecret, body),
      "signed sentinel body",
      testSigningSettings().keyring.get("test-master")!.toString("base64"),
      "public-signature-",
    ];
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const accepted = await signed(hub, signer);
      const rejected = await signed(hub, signer, body, { signature: sign("wrong", body) });
      assert.equal(accepted.status, 202);
      assert.equal(rejected.status, 401);
      const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
      const ordinary =
        JSON.stringify(await hub.keys.list("webhook-a")) +
        (await accepted.text()) +
        (await rejected.text());
      const dump = JSON.stringify(
        (
          await hub.runtime.query(
            "select to_jsonb(keys) as key, to_jsonb(slots) as slot from organization_api_keys keys join organization_webhook_secrets slots on slots.api_key_id = keys.id where keys.id = $1",
            [signer.summary.id],
          )
        ).rows,
      );
      for (const secret of watched) {
        assert.ok(!logged.includes(secret));
        assert.ok(!ordinary.includes(secret));
        assert.ok(!dump.includes(secret));
      }
      assert.match(logged, /"matchedSlot":"current"/u);
      assert.match(logged, /"failureCategory":"auth_rejected"/u);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("fails readiness globally if an eligible version loses its master", async () => {
    const isolated = await webhookFixture({}, { signing: testSigningSettings() });
    try {
      const trigger = await isolated.save();
      const broken = await isolated.createSigner(trigger.id);
      const other = await isolated.createSigner(trigger.id);
      await isolated.keys.signing.checkReadiness();
      await isolated.runtime.query(
        "update organization_webhook_secrets set master_key_id = 'missing' where api_key_id = $1",
        [broken.summary.id],
      );
      await problem(await signed(isolated, broken), 503, "authentication_unavailable");
      await problem(await signed(isolated, other), 503, "authentication_unavailable");
      await problem(
        await signed(isolated, other, body, { keyId: randomUUID() }),
        503,
        "authentication_unavailable",
      );
      assert.equal((await isolated.send("build-finished")).status, 202);
    } finally {
      await isolated.close();
    }
  });

  it("keeps signing off without affecting Bearer delivery", async () => {
    const off = await webhookFixture();
    try {
      const response = await off.application.publicApi.handle(
        new Request(githubSignerUrl("http://hub.test", "build-finished", hub.key.summary.id), {
          method: "POST",
          headers: {
            "x-hub-signature-256": sign("fake", body),
            "content-type": "application/json",
          },
          body,
        }),
      );
      await problem(response, 401, "unauthorized");
      await off.save();
      assert.equal((await off.send("build-finished")).status, 202);
    } finally {
      await off.close();
    }
  });

  it.each([false, true])(
    "accepts Bearer deliveries with signature headers when signing enabled is %s",
    async (enabled) => {
      const fixture = enabled ? hub : await webhookFixture();
      try {
        if (!enabled) await fixture.save();
        const proof = {
          "x-hub-signature": "sha1=deadbeef",
          "x-hub-signature-256": sign("wrong secret", body),
          "x-paseo-signature": "forwarded metadata",
        };
        const accepted = await fixture.send("build-finished", JSON.parse(body) as unknown, {
          deliveryKey: "bearer-forwarded-signatures",
          headers: proof,
        });
        assert.equal((await result(accepted, 202)).duplicate, false);
        const unauthorized = await fixture.send(
          "build-finished",
          {},
          { secret: null, headers: proof },
        );
        assert.equal(unauthorized.status, 401);
        assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
      } finally {
        if (!enabled) await fixture.close();
      }
    },
  );

  it("refuses a same-name replacement between authorization and persistence", async () => {
    const temporary = await hub.save("recreated");
    const signer = await hub.createSigner(temporary.id);
    const persist = hub.database.persistManualEvent.bind(hub.database);
    hub.database.persistManualEvent = async (input) => {
      await hub.runtime.query("delete from organization_triggers where id = $1", [temporary.id]);
      const replacement = await hub.save("recreated");
      assert.notEqual(replacement.id, temporary.id);
      return persist(input);
    };
    try {
      await problem(
        await signed(hub, signer, body, { trigger: "recreated" }),
        404,
        "trigger_not_found",
      );
      assert.equal(
        (
          await hub.runtime.query(
            "select 1 from provider_event_receipts where payload->>'trigger' = 'recreated'",
          )
        ).rowCount,
        0,
      );
    } finally {
      hub.database.persistManualEvent = persist;
    }
  });

  it("settles simultaneous and permanently filtered deliveries identically in both dispatch stores", async () => {
    for (const memory of [false, true]) {
      const isolated = await webhookFixture({}, { signing: testSigningSettings(), memory });
      try {
        const filtered = await isolated.save("build-finished", { filtered: true });
        const signer = await isolated.createSigner(filtered.id);
        const filteredBody = '{"message":"filtered","status":"passed"}';
        assert.deepEqual(await result(await signed(isolated, signer, filteredBody), 202), {
          status: "filtered",
          duplicate: false,
        });
        if (!memory) {
          await new ReceiptRetention(isolated.runtime).runBatch(
            new Date(Date.now() + 8 * 24 * 3600_000),
          );
        }
        const active = await isolated.save("build-finished", { triggerId: filtered.id });
        assert.deepEqual(await result(await signed(isolated, signer, filteredBody), 200), {
          status: "filtered",
          duplicate: true,
        });

        const persist = isolated.database.persistManualEvent.bind(isolated.database);
        const persisted = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let first = true;
        isolated.database.persistManualEvent = async (input) => {
          const saved = await persist(input);
          if (first) {
            first = false;
            persisted.resolve();
            await resume.promise;
          }
          return saved;
        };
        const pending = signed(isolated, signer);
        await persisted.promise;
        try {
          const second = await signed(isolated, signer);
          assert.ok(second.status === 200 || second.status === 409);
          await assertDuplicateIfSuccessful(second);
        } finally {
          resume.resolve();
        }
        assert.equal((await result(await pending, 202)).duplicate, false);
        assert.equal(
          (await isolated.database.listTriggerRunsForProject(active.runtimeProjectId, 10)).length,
          1,
        );
      } finally {
        await isolated.close();
      }
    }
  });

  it("exposes the signer-only OpenAPI operation and response formats", () => {
    const operation =
      publicOpenApiDocument.paths?.["/api/v1/hooks/{trigger}/signers/{keyId}"]?.post;
    assert.ok(operation);
    assert.deepEqual(operation.security, [{ githubWebhookSignature: [] }]);
    assert.match(JSON.stringify(operation.parameters), /"name":"keyId"/u);
    assert.doesNotMatch(JSON.stringify(operation.responses?.["401"]), /WWW-Authenticate/u);
    assert.doesNotMatch(JSON.stringify(operation.requestBody), /text\/plain/u);
    for (const status of [200, 202, 401, 404, 413, 415, 503])
      assert.ok(operation.responses?.[status]);
  });

  it("returns bounded TCP responses for signed requests and stops admission during shutdown", async () => {
    const signer = await hub.createSigner(target.id);
    const server = createFetchServer((request) => hub.application.publicApi.handle(request));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const path = new URL(githubSignerUrl("http://hub.test", "build-finished", signer.summary.id))
      .pathname;
    const header = `POST ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\n`;
    const mac = "X-Hub-Signature-256: " + sign(signer.signingSecret, body) + "\r\n";
    const exchange = async (input: string) => {
      const socket = createConnection(address.port, "127.0.0.1");
      socket.setTimeout(5000, () => socket.destroy(new Error("local socket timed out")));
      socket.write(input);
      try {
        let received = "";
        for await (const chunk of socket) received += String(chunk);
        return received;
      } finally {
        socket.destroy();
      }
    };
    try {
      assert.match(
        await exchange(header + mac + "Content-Length: 1025\r\n\r\n"),
        /^HTTP\/1.1 413/u,
      );
      assert.match(
        await exchange(
          header + mac + "Transfer-Encoding: chunked\r\n\r\n401\r\n" + " ".repeat(1025) + "\r\n",
        ),
        /^HTTP\/1.1 413/u,
      );
      const length = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
      assert.match(await exchange(header + mac + mac + length + body), /^HTTP\/1.1 401/u);
      assert.match(
        await exchange(header + mac + length + body.replace("signed", "mutate")),
        /^HTTP\/1.1 401/u,
      );
      const shutdown = beginHttpShutdown(server);
      assert.match(await exchange(header + mac + length + body), /^HTTP\/1.1 503/u);
      await shutdown.drained;
      assert.equal(shutdown.activeRequests, 0);
    } finally {
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
    }
  });
});
