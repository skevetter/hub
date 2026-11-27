import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { respondWithFailure } from "../failures/index.js";
import { createLogger } from "../logger.js";
import {
  disconnectedAgentValidator,
  acceptingAgentValidator,
} from "../test-utils/agent-validator.js";
import type { DaemonAgentConfigurationValidator } from "../configuration/store.js";
import { OrganizationTriggerStore } from "./store.js";

const WARN = 40;
const ERROR = 50;

class CaptureStream extends Writable {
  private readonly chunks: string[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(chunk.toString());
    done();
  }
  records(): Record<string, unknown>[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map(parseRecord);
  }
}

function parseRecord(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null) throw new Error("log line is not a record");
  return Object.fromEntries(Object.entries(parsed));
}

function failingDaemon(reason: string): DaemonAgentConfigurationValidator {
  return { validateAgentConfiguration: () => Promise.reject(new Error(reason)) };
}

async function saveWith(
  validator: DaemonAgentConfigurationValidator,
  yaml = TRIGGER,
): Promise<Error> {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  await database.issueEnrollmentToken({
    id: "token",
    verifier: "token-verifier",
    organizationId: "org",
    expiresAt: new Date("2026-08-29T22:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId: "daemon-00000000",
    idempotencyKey: "daemon-key",
    suggestedSlug: "devbox",
    tokenVerifier: "token-verifier",
    serverId: "server",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: ["hub.execute"],
    now: new Date("2026-08-29T21:00:00.000Z"),
  });
  try {
    await new OrganizationTriggerStore(database, "org", validator).save({ yaml, userId: null });
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the save to be refused");
}

function report(error: Error) {
  const stream = new CaptureStream();
  const result = respondWithFailure(
    error,
    { operation: "trigger.save", component: "triggers", organizationSlug: "acme" },
    { fallback: error.message, validation: error.message },
    { logger: createLogger(stream) },
  );
  return { result, record: stream.records()[0] };
}

describe("a refused trigger save", () => {
  it("logs a document the author must fix as validation, below ERROR, with no reference", async () => {
    const error = await saveWith(acceptingAgentValidator(), "name: [unterminated");
    const { result, record } = report(error);

    assert.equal(record?.["failureKind"], "validation");
    assert.equal(record?.["level"], WARN);
    assert.equal(result.error.message, error.message);
  });

  it("logs a daemon the author can connect as validation", async () => {
    const error = await saveWith(disconnectedAgentValidator());
    const { result, record } = report(error);

    assert.equal(record?.["failureKind"], "validation");
    assert.equal(record?.["level"], WARN);
    assert.match(result.error.message, /"devbox" is not connected/u);
    assert.doesNotMatch(result.error.message, /quote reference/u);
  });

  it("still logs a daemon check that failed for another reason as an error", async () => {
    const error = await saveWith(failingDaemon("socket hang up"));
    const { result, record } = report(error);

    assert.equal(record?.["failureKind"], "upstreamUnavailable");
    assert.equal(record?.["level"], ERROR);
    assert.match(result.error.message, /"devbox" could not check this agent: socket hang up/u);
    assert.match(result.error.message, /quote reference/u);
    assert.equal(error.cause instanceof Error, true);
  });

  it("still logs an unexpected failure as an internal error", () => {
    const { record } = report(new Error("relation does not exist"));

    assert.equal(record?.["failureKind"], "internal");
    assert.equal(record?.["level"], ERROR);
  });
});

const TRIGGER = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
  max_runtime: 1h
  idle_timeout: 5m
`;
