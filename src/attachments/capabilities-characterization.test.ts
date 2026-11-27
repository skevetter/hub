import assert from "node:assert/strict";
import { test } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { AttachmentRecord } from "../db/types.js";
import {
  createAttachmentCapabilityRegistry,
  type AttachmentCapabilityRegistration,
  type AttachmentResolver,
} from "./capabilities.js";

const registration: AttachmentCapabilityRegistration = {
  providerEventReceiptId: "receipt",
  organizationId: "org",
  connectionId: "connection",
  provider: "slack",
  sourceId: "source",
  locator: { fileId: "file" },
  filename: 'fi\r\nl"e.txt',
  contentType: "application/octet-stream",
  byteSize: 5,
};

async function fixture() {
  const database = createMemoryDatabase();
  const execution = await database.insertAgentExecution({
    id: "execution/id",
    organizationId: "org",
    projectId: "project",
    machineId: null,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: "revision",
  });
  const record: AttachmentRecord = {
    ...registration,
    id: "attachment/id",
    contentType: "application/octet-stream",
    byteSize: 5,
    createdAt: new Date(0),
  };
  const calls: unknown[][] = [];
  let attachment: AttachmentRecord | undefined = record;
  let current: typeof execution | undefined = execution;
  let now = 123_999;
  const resolvers: { slack?: AttachmentResolver } = {};
  database.insertAttachment = async (input) => {
    calls.push(["insert", input]);
    return record;
  };
  database.findAgentExecutionById = async (id) => {
    calls.push(["execution", id]);
    return current;
  };
  database.findAttachmentForExecution = async (executionId, attachmentId) => {
    calls.push(["attachment", executionId, attachmentId]);
    return attachment;
  };
  const options = {
    database,
    publicBaseUrl: "https://hub.test/subpath",
    authoritySecret: "fixture-secret",
    resolvers,
    now: () => new Date(now),
  };
  const registry = createAttachmentCapabilityRegistry(options);
  const handle = (url = registry.urlFor(record.id, execution.id), method = "GET") =>
    registry.handle(new Request(url, { method }), execution.id, record.id);
  return {
    calls,
    execution,
    record,
    resolvers,
    options,
    registry,
    handle,
    expire: () => {
      now = 1_023_000;
    },
    removeExecution: () => {
      current = undefined;
    },
    removeAttachment: () => {
      attachment = undefined;
    },
  };
}

test("validates registration in field order and produces ordered reference and descriptor keys", async () => {
  const f = await fixture();
  const cases: [Partial<AttachmentCapabilityRegistration>, string][] = [
    [{ providerEventReceiptId: "", connectionId: "" }, "attachment ownership is required"],
    [{ organizationId: "" }, "attachment ownership is required"],
    [{ connectionId: "" }, "attachment connection is required"],
    [{ sourceId: "" }, "invalid attachment source id"],
    [{ sourceId: "s".repeat(256) }, "invalid attachment source id"],
    [{ filename: "" }, "invalid attachment filename"],
    [{ filename: "f".repeat(256) }, "invalid attachment filename"],
    [{ contentType: "t".repeat(256), byteSize: -1 }, "invalid attachment content type"],
    [{ byteSize: -1 }, "invalid attachment byte size"],
    [{ byteSize: 0.5 }, "invalid attachment byte size"],
  ];
  for (const [fields, message] of cases) {
    await assert.rejects(f.registry.register({ ...registration, ...fields }), { message });
  }
  const invalidProvider = { ...registration };
  Reflect.set(invalidProvider, "provider", "SLACK");
  await assert.rejects(f.registry.register(invalidProvider), {
    message: "invalid attachment provider",
  });
  assert.deepEqual(f.calls, []);
  const reference = await f.registry.register(registration);
  assert.deepEqual(f.calls, [["insert", registration]]);
  assert.deepEqual(reference, {
    id: f.record.id,
    filename: f.record.filename,
    content_type: f.record.contentType,
    size: 5,
  });
  assert.deepEqual(Object.keys(reference), ["id", "filename", "content_type", "size"]);
  const descriptor = f.registry.materialize(reference, f.execution.id);
  assert.deepEqual(Object.keys(descriptor), [...Object.keys(reference), "url"]);
  const url = new URL(descriptor.url);
  assert.equal(url.pathname, "/agent-executions/execution%2Fid/attachments/attachment%2Fid");
  assert.deepEqual([...url.searchParams.keys()], ["expires", "signature"]);
  assert.equal(url.searchParams.get("expires"), "1023");
  for (const lifetimeSeconds of [0, -1, 1.5, Infinity]) {
    assert.throws(() => createAttachmentCapabilityRegistry({ ...f.options, lifetimeSeconds }), {
      message: "attachment capability lifetime must be a positive integer",
    });
  }
});

const unavailable = "Attachment unavailable or link expired. Request a new attachment link.";

async function checkResponse(response: Response, status: number, body: string) {
  assert.equal(response.status, status);
  assert.equal(await response.text(), body);
}

test("denies requests before querying unrelated attachment state", async () => {
  const f = await fixture();
  const url = f.registry.urlFor(f.record.id, f.execution.id);
  await checkResponse(
    await f.handle(url, "POST"),
    405,
    "Attachment links must be opened with GET.",
  );
  for (const query of [
    "",
    "?expires=1023",
    "?expires=wrong&signature=a",
    "?expires=9007199254740992&signature=a",
    "?expires=1023&signature=a",
    "?expires=1023&signature=" + Buffer.alloc(32).toString("base64url"),
  ]) {
    await checkResponse(await f.handle(new URL(url).origin + query), 404, unavailable);
  }
  await checkResponse(await f.handle(f.registry.urlFor(f.record.id, "other")), 404, unavailable);
  f.expire();
  await checkResponse(await f.handle(url), 404, unavailable);
  assert.deepEqual(f.calls, []);
  f.removeAttachment();
  await checkResponse(await f.handle(), 404, unavailable);
  f.removeExecution();
  await checkResponse(await f.handle(), 404, unavailable);
  assert.deepEqual(f.calls, [
    ["execution", f.execution.id],
    ["attachment", f.execution.id, f.record.id],
    ["execution", f.execution.id],
  ]);
});

test("preserves resolver error messages and correlates 502 responses", async () => {
  const f = await fixture();
  const reject = async () => {
    throw new Error("provider failure");
  };
  const cases = [
    [undefined, "Hub cannot retrieve this attachment because its provider is unavailable."],
    [
      reject,
      "Hub couldn't retrieve this attachment from its provider. Check the provider connection.",
    ],
    [
      async () => new Response(null, { status: 429 }),
      "The attachment provider rate limited Hub. Wait before requesting a new link.",
    ],
    [
      async () => new Response(null, { status: 404 }),
      "The attachment provider couldn't return this file. Check the provider connection and request a new link.",
    ],
  ] as const;
  for (const [resolver, text] of cases) {
    if (resolver === undefined) delete f.resolvers.slack;
    else f.resolvers.slack = resolver;
    const response = await f.handle();
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(
      body.replace(
        /quote reference [\da-f-]{36} when reporting it\.$/u,
        "quote reference UUID when reporting it.",
      ),
      `${text} If it happens again, quote reference UUID when reporting it.`,
    );
  }
});

test("looks up execution and attachment before resolving and preserves only download headers", async () => {
  const f = await fixture();
  const sources: Record<string, string>[] = [
    {},
    { "content-encoding": "gzip", "content-length": "50" },
    { "content-type": "image/png", "content-length": "4" },
  ];
  for (const source of sources) {
    f.calls.length = 0;
    const headers = new Headers({
      etag: '"tag"',
      "last-modified": "yesterday",
      "x-private": "ignored",
    });
    for (const [name, value] of Object.entries(source)) headers.set(name, value);
    f.resolvers.slack = async (input) => {
      f.calls.push(["resolve", Object.keys(input), input]);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers });
    };
    const response = await f.handle();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.bytes(), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(Object.fromEntries(response.headers), {
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="fi__l_e.txt"',
      ...(source["content-encoding"] ? {} : { "content-length": source["content-length"] ?? "5" }),
      "content-type": source["content-type"] ?? "application/octet-stream",
      etag: '"tag"',
      "last-modified": "yesterday",
    });
    assert.deepEqual(f.calls, [
      ["execution", f.execution.id],
      ["attachment", f.execution.id, f.record.id],
      [
        "resolve",
        ["executionId", "organizationId", "connectionId", "locator"],
        {
          executionId: f.execution.id,
          organizationId: "org",
          connectionId: "connection",
          locator: { fileId: "file" },
        },
      ],
    ]);
  }
});
