import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { DatabaseUnavailableError } from "../db/errors.js";
import { runWithFailureTracking } from "../failures/index.js";
import { createLogger } from "../logger.js";
import type {
  PublicAuthorization,
  PublicOperations,
  ReceiveWebhookInput,
  ReceiveWebhookResult,
} from "../public-operations/index.js";
import { DEFAULT_WEBHOOK_OPTIONS, type WebhookOptions } from "../webhook-config.js";
import {
  createPublicApi,
  ProblemSchema,
  publicOpenApiDocument,
  ReceivedWebhookSchema,
} from "./index.js";

const access: PublicAuthorization = {
  kind: "apiKey",
  credentialId: "key-id",
  organizationId: "org-id",
  actor: "sender",
  scopes: ["events:send"],
};

interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

const webhookLogSchema = z
  .object({
    operation: z.literal("webhook.received"),
    keyId: z.string().nullable(),
    trigger: z.string().nullable(),
    status: z.number(),
    code: z.string().nullable(),
    bytes: z.number(),
    durationMs: z.number(),
    deliveryKeyHash: z.string().nullable(),
    duplicate: z.boolean().nullable(),
    limit: z.enum(["ratePerMinute", "maxBytes", "messageBytes", "maxActiveRuns"]).optional(),
  })
  .strict();

function fixture(
  options: {
    access?: PublicAuthorization;
    authorize?: OperationAuthenticator["authorize"];
    receive?: PublicOperations["receiveWebhook"];
    webhookOptions?: WebhookOptions;
    now?: () => number;
  } = {},
) {
  const calls: ReceiveWebhookInput[] = [];
  const logs: { level: string; fields: unknown }[] = [];
  let authCalls = 0;
  const unexpected = (): Promise<never> => Promise.reject(new Error("unexpected operation"));
  const operations: PublicOperations = {
    listTriggers: unexpected,
    validateTrigger: unexpected,
    installTrigger: unexpected,
    listProjects: unexpected,
    listConfigurationResources: unexpected,
    listSetupResources: unexpected,
    validateConfiguration: unexpected,
    installConfiguration: unexpected,
    dispatchManualRun: unexpected,
    issueEnrollmentToken: unexpected,
    receiveWebhook: async (authorization, input) => {
      calls.push(input);
      if (options.receive !== undefined) return options.receive(authorization, input);
      return {
        status: "dispatched",
        deliveryKey: input.deliveryKey,
        providerEventReceiptId: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
        triggerRunId: "f83dc934-02a0-4849-8de7-699110be24ed",
        configuredTriggerName: input.trigger,
        workflowStatus: "running",
        duplicate: false,
      };
    },
  };
  const api = createPublicApi(
    {
      status: "enabled",
      authenticator: {
        reauthorize: async () => true,
        authorize: async (request, scope) => {
          authCalls += 1;
          assert.equal(
            scope,
            new URL(request.url).pathname === "/api/v1/manual-runs"
              ? "runs:dispatch"
              : "events:send",
          );
          if (options.authorize !== undefined) return options.authorize(request, scope);
          if (request.headers.get("authorization") !== "Bearer fake-secret")
            return { status: "unauthorized" };
          return { status: "authorized", access: options.access ?? access };
        },
      },
    },
    operations,
    {
      webhookOptions: options.webhookOptions ?? DEFAULT_WEBHOOK_OPTIONS,
      ...(options.now === undefined ? {} : { now: options.now }),
      logger: {
        info: (fields: unknown) => {
          logs.push({ level: "info", fields });
        },
        warn: (fields: unknown) => {
          logs.push({ level: "warn", fields });
        },
      },
    },
  );
  return { api, calls, logs, authCalls: () => authCalls };
}

function hook(
  body: BodyInit | null = '{"message":"hello"}',
  options: {
    path?: string;
    method?: string;
    contentType?: string | null;
    headers?: Record<string, string>;
    authenticated?: boolean;
  } = {},
): Request {
  const init: StreamingRequestInit = {
    method: options.method ?? "POST",
    headers: {
      ...(options.authenticated === false ? {} : { authorization: "Bearer fake-secret" }),
      ...(options.contentType === null
        ? {}
        : { "content-type": options.contentType ?? "application/json" }),
      ...options.headers,
    },
    ...(body === null ? {} : { body }),
    duplex: "half",
  };
  const request = new Request(
    `https://hub.test${options.path ?? "/api/v1/hooks/build-finished"}`,
    init,
  );
  if (options.contentType === null) request.headers.delete("content-type");
  return request;
}

async function expectProblem(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  const value = ProblemSchema.parse(await response.json());
  assert.equal(value.code, code);
  assert.equal(value.requestId, response.headers.get("x-request-id"));
  assert.ok(value.requestId);
  return value;
}

function nested(depth: number): string {
  return '{"child":'.repeat(depth - 1) + "{}" + "}".repeat(depth - 1);
}

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("webhook HTTP intake", () => {
  it("maps JSON and text without trusting caller actor or parsing JSON prompt tokens", async () => {
    const f = fixture();
    const json = {
      message: "status=failed hello",
      actor: "spoofed",
      status: "failed",
      nested: { data: [1, true, null] },
    };
    const response = await f.api.handle(
      hook(JSON.stringify(json), { headers: { "idempotency-key": "delivery-1" } }),
    );
    assert.equal(response.status, 202);
    assert.equal(ReceivedWebhookSchema.parse(await response.json()).duplicate, false);
    assert.deepEqual(f.calls[0], {
      trigger: "build-finished",
      deliveryKey: "delivery-1",
      input: json.message,
      data: json,
    });
    const text = await f.api.handle(
      hook("status=failed hello", { contentType: 'TeXt/PlAiN; CHARSET="UtF-8"; ignored=yes' }),
    );
    assert.equal(text.status, 202);
    assert.equal(f.calls[1]?.input, "status=failed hello");
    assert.equal(f.calls[1]?.data, undefined);
    assert.match(f.calls[1]?.deliveryKey ?? "", /^[0-9a-f-]{36}$/u);
    assert.notEqual(f.calls[0]?.deliveryKey, f.calls[1]?.deliveryKey);
  });

  it("decodes path segments once and rejects invalid names and trailing slashes", async () => {
    const f = fixture();
    assert.equal(
      (await f.api.handle(hook("{}", { path: "/api/v1/hooks/%62uild-finished" }))).status,
      202,
    );
    assert.equal(f.calls[0]?.trigger, "build-finished");
    for (const path of [
      "/api/v1/hooks/Build",
      "/api/v1/hooks/build/",
      "/api/v1/hooks/build/extra",
      "/api/v1/hooks/%2562uild",
      "/api/v1/hooks/%2f",
      "/api/v1/hooks/%",
      "/api/v1/hooks",
      "/api/v1/hooks/",
    ]) {
      await expectProblem(await f.api.handle(hook("{}", { path })), 404, "trigger_not_found");
    }
    assert.equal(f.authCalls(), 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.logs.length, 9);
  });

  it("refuses all other methods before authentication without CORS or OPTIONS support", async () => {
    const f = fixture();
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await f.api.handle(hook(null, { method, authenticated: false }));
      await expectProblem(response, 405, "method_not_allowed");
      assert.equal(response.headers.get("allow"), "POST");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    assert.equal(f.authCalls(), 0);
    for (const log of f.logs) {
      assert.equal(log.level, "warn");
      const fields = webhookLogSchema.parse(log.fields);
      assert.deepEqual(
        Object.keys(fields).sort(),
        [
          "operation",
          "keyId",
          "trigger",
          "status",
          "code",
          "bytes",
          "durationMs",
          "deliveryKeyHash",
          "duplicate",
        ].sort(),
      );
      assert.equal(fields.keyId, null);
      assert.equal(fields.bytes, 0);
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.logs.length, 6);
    const response = await f.api.handle(
      hook(null, { method: "OPTIONS", path: "/api/v1/hooks/INVALID" }),
    );
    await expectProblem(response, 405, "method_not_allowed");
  });

  it("authenticates only with the header and refuses scope, CLI, and unbound keys before reading", async () => {
    const f = fixture();
    const unauthorized = await f.api.handle(
      hook("bad", {
        authenticated: false,
        path: "/api/v1/hooks/build?token=fake-secret&api_key=fake-secret",
      }),
    );
    await expectProblem(unauthorized, 401, "unauthorized");
    assert.equal(unauthorized.headers.get("www-authenticate"), "Bearer");
    assert.equal(f.logs[0]?.level, "info");
    for (const [authorization, expected] of [
      [{ ...access, actor: null }, "key_actor_required"],
      [{ ...access, kind: "cliCredential" as const }, "key_actor_required"],
    ] as const) {
      const guarded = fixture({ access: authorization });
      const request = hook("not JSON", { contentType: "application/invalid" });
      await expectProblem(await guarded.api.handle(request), 403, expected);
      assert.equal(request.bodyUsed, false);
      assert.equal(guarded.calls.length, 0);
    }
    const scoped = fixture({ authorize: async () => ({ status: "forbidden" }) });
    await expectProblem(await scoped.api.handle(hook("not JSON")), 403, "insufficient_scope");
    assert.equal(scoped.calls.length, 0);
  });

  it("accepts UTF-8 BOM, case-insensitive media types, duplicate keys, empty objects and ignored parameters", async () => {
    const f = fixture();
    const cases: [string, string, string][] = [
      [
        '\ufeff{"message":"first","message":"last"}',
        "APPLICATION/JSON; Charset=UTF-8; vendor=x",
        "last",
      ],
      ["\ufeffhello", "text/plain;charset=utf-8", "hello"],
      ["{}", "application/json", ""],
    ];
    for (const [body, contentType, input] of cases) {
      assert.equal((await f.api.handle(hook(body, { contentType }))).status, 202);
      assert.equal(f.calls.at(-1)?.input, input);
    }
  });

  it("rejects unsupported media and charset before consuming body or bucket tokens", async () => {
    const f = fixture({ webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, burst: 1 } });
    for (const contentType of [
      null,
      "application/xml",
      "application/jsonp",
      "text/html",
      "text/plain;charset=latin1",
      "application/json; charset=utf-16",
      "application/json; charset",
    ]) {
      const request = hook("anything", { contentType });
      await expectProblem(await f.api.handle(request), 415, "unsupported_media_type");
      assert.equal(request.bodyUsed, false);
    }
    assert.equal((await f.api.handle(hook())).status, 202);
  });

  it("rejects malformed, empty, invalid UTF-8, and structurally invalid JSON without invoking", async () => {
    const f = fixture();
    const cases: [BodyInit | null, string, number, string][] = [
      ["", "application/json", 400, "invalid_json"],
      ["{", "application/json", 400, "invalid_json"],
      ["", "text/plain", 400, "invalid_request"],
      ["\ufeff", "text/plain", 400, "invalid_request"],
      [new Uint8Array([0xc3, 0x28]), "text/plain", 400, "invalid_request"],
      [new Uint8Array([0xff]), "application/json", 400, "invalid_request"],
      ['{"message":5}', "application/json", 422, "invalid_input"],
      ['{"message":null}', "application/json", 422, "invalid_input"],
      ...[
        "null",
        "[]",
        "true",
        "1",
        '"text"',
        '{"x":1e999}',
        '{"x":[-1e999]}',
        nested(21),
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`k${index}`, 1])),
        ),
      ].map((body): [BodyInit, string, number, string] => [
        body,
        "application/json",
        422,
        "invalid_body",
      ]),
    ];
    for (const [body, contentType, status, code] of cases)
      await expectProblem(await f.api.handle(hook(body, { contentType })), status, code);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.api.handle(hook(nested(20)))).status, 202);
    assert.equal(
      (
        await f.api.handle(
          hook(
            JSON.stringify(
              Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`k${index}`, 1])),
            ),
          ),
        )
      ).status,
      202,
    );
  });

  it("caps declared and streaming raw bodies and the UTF-8 message independently without taking tokens", async () => {
    const f = fixture({ webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, maxBytes: 1024, burst: 1 } });
    await expectProblem(
      await f.api.handle(hook("{}", { headers: { "content-length": "1025" } })),
      413,
      "payload_too_large",
    );
    await expectProblem(
      await f.api.handle(hook(stream([new Uint8Array(700), new Uint8Array(325)]))),
      413,
      "payload_too_large",
    );
    assert.equal(f.calls.length, 0);
    assert.equal((await f.api.handle(hook())).status, 202);
    assert.equal((await f.api.handle(hook())).status, 429);
    const message = fixture();
    for (const contentType of ["application/json", "text/plain"]) {
      const input = "\u00e9".repeat(32769);
      await expectProblem(
        await message.api.handle(
          hook(contentType === "text/plain" ? input : JSON.stringify({ message: input }), {
            contentType,
          }),
        ),
        413,
        "payload_too_large",
      );
    }
    assert.equal(
      (await message.api.handle(hook("x".repeat(65536), { contentType: "text/plain" }))).status,
      202,
    );
    assert.equal(
      (await message.api.handle(hook(JSON.stringify({ message: "x".repeat(65536) })))).status,
      202,
    );
    assert.equal(
      (
        await fixture({
          webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, maxBytes: 1024 },
        }).api.handle(hook("x".repeat(1024), { contentType: "text/plain" }))
      ).status,
      202,
    );
    const manual = fixture({ webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, maxBytes: 1024 } });
    await expectProblem(
      await manual.api.handle(
        hook("{}", { path: "/api/v1/manual-runs", headers: { "content-length": "1025" } }),
      ),
      413,
      "payload_too_large",
    );
    await expectProblem(
      await manual.api.handle(
        hook(stream([new Uint8Array(700), new Uint8Array(325)]), { path: "/api/v1/manual-runs" }),
      ),
      413,
      "payload_too_large",
    );
  });

  it("checks printable ASCII idempotency and sanitizes request IDs", async () => {
    const f = fixture();
    for (const idempotency of ["", "x".repeat(201), "caf\u00e9", "\u007f"]) {
      await expectProblem(
        await f.api.handle(hook("{}", { headers: { "idempotency-key": idempotency } })),
        400,
        "invalid_request",
      );
    }
    for (const idempotency of ["x", "x".repeat(200), "build number !~"]) {
      assert.equal(
        (await f.api.handle(hook("{}", { headers: { "idempotency-key": idempotency } }))).status,
        202,
      );
      assert.equal(f.calls.at(-1)?.deliveryKey, idempotency);
    }
    for (const requestId of ["safe.ID_1-2", "x".repeat(128)]) {
      assert.equal(
        (await f.api.handle(hook("{}", { headers: { "x-request-id": requestId } }))).headers.get(
          "x-request-id",
        ),
        requestId,
      );
    }
    for (const requestId of ["", "bad id", "bad/id", "x".repeat(129), "unsafe?secret=one"]) {
      const response = await f.api.handle(hook("{}", { headers: { "x-request-id": requestId } }));
      assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/u);
    }
  });

  it("limits only valid parsed authenticated bodies, before calling operations, per key", async () => {
    let now = 0;
    let current = access;
    const f = fixture({
      webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, burst: 1, ratePerMinute: 120 },
      now: () => now,
      authorize: async () => ({ status: "authorized", access: current }),
    });
    await expectProblem(await f.api.handle(hook("bad")), 400, "invalid_json");
    await expectProblem(await f.api.handle(hook("[]")), 422, "invalid_body");
    assert.equal((await f.api.handle(hook())).status, 202);
    const limited = await f.api.handle(hook());
    await expectProblem(limited, 429, "rate_limited");
    assert.equal(limited.headers.get("retry-after"), "1");
    assert.equal(f.calls.length, 1);
    current = { ...access, credentialId: "another-key" };
    assert.equal((await f.api.handle(hook())).status, 202);
    current = access;
    now = 500;
    assert.equal((await f.api.handle(hook())).status, 202);
  });

  it("maps every operation failure and both dispatched and filtered duplicate responses", async () => {
    for (const [result, status, code] of [
      [{ status: "trigger_not_found" }, 404, "trigger_not_found"],
      [{ status: "actor_forbidden" }, 403, "actor_forbidden"],
      [{ status: "key_actor_required" }, 403, "key_actor_required"],
      [
        { status: "invalid_input", issues: [{ path: ["status"], message: "Required" }] },
        422,
        "invalid_input",
      ],
      [{ status: "trigger_busy" }, 429, "trigger_busy"],
      [{ status: "dispatch_conflict" }, 409, "dispatch_conflict"],
      [{ status: "infrastructure_unavailable" }, 503, "infrastructure_unavailable"],
    ] as const) {
      const f = fixture({ receive: async () => result });
      const response = await f.api.handle(hook());
      const body = await expectProblem(response, status, code);
      if (code === "invalid_input") assert.deepEqual(body.issues?.[0]?.path, ["status"]);
      if (code === "trigger_busy") assert.equal(response.headers.get("retry-after"), "30");
    }
    for (const duplicate of [false, true]) {
      for (const filtered of [false, true]) {
        const f = fixture({
          receive: async (_authorization, input): Promise<ReceiveWebhookResult> =>
            filtered
              ? { status: "filtered", duplicate }
              : {
                  status: "dispatched",
                  deliveryKey: input.deliveryKey,
                  providerEventReceiptId: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
                  triggerRunId: "f83dc934-02a0-4849-8de7-699110be24ed",
                  configuredTriggerName: input.trigger,
                  workflowStatus: "running",
                  duplicate,
                },
        });
        const response = await f.api.handle(hook());
        assert.equal(response.status, duplicate ? 200 : 202);
        assert.equal(ReceivedWebhookSchema.parse(await response.json()).duplicate, duplicate);
      }
    }
  });

  it("returns opaque authentication, storage and unexpected failure responses and redacts owner logs", async () => {
    const auth = fixture({
      authorize: async () => {
        throw new DatabaseUnavailableError();
      },
    });
    await expectProblem(await auth.api.handle(hook()), 503, "authentication_unavailable");
    assert.equal(auth.calls.length, 0);
    const unavailable = createPublicApi({ status: "unavailable" }, null, {
      logger: { info() {}, warn() {} },
    });
    await expectProblem(await unavailable.handle(hook()), 503, "infrastructure_unavailable");
    let output = "";
    const logger = createLogger(
      new Writable({
        write(chunk, _encoding, done) {
          output += String(chunk);
          done();
        },
      }),
    );
    for (const [error, status, code] of [
      [new DatabaseUnavailableError(), 503, "infrastructure_unavailable"],
      [new Error("fake-secret body-secret database SQL query"), 500, "internal_error"],
    ] as const) {
      const f = fixture({
        receive: async () => {
          throw error;
        },
      });
      const response = await runWithFailureTracking(
        () => f.api.handle(hook('{"message":"body-secret"}')),
        logger,
      );
      const body = await expectProblem(response, status, code);
      assert.equal(JSON.stringify(body).includes("body-secret"), false);
      assert.equal(f.logs.at(-1)?.level, "info");
    }
    assert.equal(output.includes("fake-secret"), false);
    assert.equal(output.includes("body-secret"), false);
    assert.ok(output.includes('"operation":"public-api.receiveWebhook"'));
  });

  it("logs only the specified fields and hashed delivery identity, with limits on 429 and 413", async () => {
    const f = fixture({ webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, burst: 1 }, now: () => 10 });
    await f.api.handle(
      hook('{"message":"body-secret"}', {
        path: "/api/v1/hooks/build?secret=query-secret",
        headers: { "idempotency-key": "delivery-secret" },
      }),
    );
    assert.deepEqual(f.logs[0], {
      level: "info",
      fields: {
        operation: "webhook.received",
        keyId: "key-id",
        trigger: "build",
        status: 202,
        code: null,
        bytes: Buffer.byteLength('{"message":"body-secret"}'),
        durationMs: 0,
        deliveryKeyHash: createHash("sha256").update("delivery-secret").digest("hex").slice(0, 12),
        duplicate: false,
      },
    });
    await f.api.handle(hook());
    await f.api.handle(hook("{}", { headers: { "content-length": "262145" } }));
    const busy = fixture({ receive: async () => ({ status: "trigger_busy" }) });
    await busy.api.handle(hook());
    assert.equal(webhookLogSchema.parse(f.logs[1]?.fields).limit, "ratePerMinute");
    assert.equal(webhookLogSchema.parse(f.logs[2]?.fields).limit, "maxBytes");
    assert.equal(webhookLogSchema.parse(busy.logs[0]?.fields).limit, "maxActiveRuns");
    assert.equal(f.logs[1]?.level, "warn");
    for (const secret of [
      "fake-secret",
      "body-secret",
      "query-secret",
      "delivery-secret",
      "authorization",
      "headers",
      "keyprefix",
    ])
      assert.equal(JSON.stringify(f.logs).includes(secret), false);
  });
});

describe("webhook OpenAPI contract", () => {
  it("documents path and header schemas, both raw forms, success statuses and retry/method headers", () => {
    const operation = publicOpenApiDocument.paths?.["/api/v1/hooks/{trigger}"]?.post;
    assert.ok(operation);
    assert.deepEqual(Reflect.get(operation, "x-required-scopes"), ["events:send"]);
    const serialized = JSON.stringify(operation);
    assert.ok(serialized.includes('"in":"path"'));
    assert.ok(serialized.includes('"name":"trigger"'));
    assert.ok(serialized.includes('"name":"idempotency-key"'));
    assert.ok(serialized.includes('"name":"x-request-id"'));
    const responses = z
      .record(
        z.string(),
        z
          .object({
            content: z.record(z.string(), z.unknown()).optional(),
            headers: z.record(z.string(), z.unknown()).optional(),
          })
          .loose(),
      )
      .parse(operation.responses);
    for (const status of ["200", "202"]) {
      const content = responses[status]?.content;
      assert.ok(content);
      assert.ok(content["application/json"]);
      assert.equal(content["application/problem+json"], undefined);
    }
    assert.ok(responses["429"]?.headers?.["Retry-After"]);
    assert.ok(responses["405"]?.headers?.["Allow"]);
    const body = z
      .object({ content: z.record(z.string(), z.unknown()) })
      .parse(operation.requestBody);
    assert.ok(body.content["application/json"]);
    assert.ok(body.content["text/plain"]);
    assert.ok(JSON.stringify(publicOpenApiDocument.components?.schemas).includes("Build finished"));
  });
});
