import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, it } from "vitest";
import { classifyFailure, respondWithFailure } from "../failures/index.js";
import { createLogger } from "../logger.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { OrganizationTriggerNotFoundError, ProjectSlugConflictError } from "./errors.js";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "./runtime/index.js";
import type { Database } from "./types.js";

const WARN = 40;
const YAML = `name: sample
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Run task
`;

class CaptureStream extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString();
    done();
  }
}

function saveTrigger(
  database: Database,
  input: { organizationId: string; name: string; triggerId?: string },
) {
  const compiled = compileTriggerDocument(YAML);
  return database.saveOrganizationTrigger({
    ...input,
    enabled: true,
    format: "single_run",
    yaml: YAML,
    normalizedConfiguration: { environments: [compiled.environment], triggers: compiled.events },
    contentHash: input.name,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    createdByUserId: null,
    routes: [],
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to be refused");
}

function report(error: unknown, messages: { fallback: string }) {
  const stream = new CaptureStream();
  const result = respondWithFailure(
    error,
    { operation: "trigger.save", component: "triggers" },
    messages,
    { logger: createLogger(stream) },
  );
  return { result, log: stream.text };
}

describe.each(["pglite", "memory"] as const)("refused writes on %s", (engine) => {
  let runtime: DatabaseRuntime | undefined;
  let database: Database;
  let directory: string | undefined;

  beforeAll(async () => {
    if (engine === "memory") {
      database = createMemoryDatabase();
      return;
    }
    directory = await mkdtemp(join(tmpdir(), "hub-save-kinds-"));
    const bundle = await embeddedDatabaseRuntime(directory);
    runtime = bundle.runtime;
    await runtime.migrate();
    database = createDatabase(runtime, bundle.locks);
    await runtime.query(
      "insert into organization (id, name, slug) values ('org-a', 'A', 'a'), ('org-b', 'B', 'b')",
    );
  }, 60_000);

  afterAll(async () => {
    await runtime?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it("reports a trigger that another organization owns as not found, without a reference", async () => {
    const owned = await saveTrigger(database, { organizationId: "org-a", name: "owned" });
    const error = await rejection(
      saveTrigger(database, { organizationId: "org-b", name: "owned", triggerId: owned.id }),
    );

    assert.ok(error instanceof OrganizationTriggerNotFoundError);
    assert.equal(classifyFailure(error), "notFound");
    const { result, log } = report(error, { fallback: "organization trigger not found" });
    assert.equal(result.error.message, "organization trigger not found");
    assert.match(log, new RegExp(`"level":${WARN}`, "u"));
  });

  it("reports a trigger ID that no longer exists as not found and creates nothing", async () => {
    const error = await rejection(
      saveTrigger(database, {
        organizationId: "org-a",
        name: "ghost",
        triggerId: "6f1d1e0a-7a5b-4a53-9a0e-2f9d4f3f6c11",
      }),
    );

    assert.ok(error instanceof OrganizationTriggerNotFoundError);
    assert.equal(classifyFailure(error), "notFound");
    const names = (await database.listOrganizationTriggers("org-a")).map((row) => row.name);
    assert.ok(!names.includes("ghost"));
  });

  it("reports a project slug that is taken as a conflict", async () => {
    const project = {
      organizationId: "org-a",
      name: "Taken",
      slug: "taken",
      createdByUserId: null,
    };
    await database.createProject(project);
    const error = await rejection(database.createProject(project));

    assert.ok(error instanceof ProjectSlugConflictError);
    assert.equal(classifyFailure(error), "conflict");
  });

  it("allows the same project slug in another organization", async () => {
    await database.createProject({
      organizationId: "org-a",
      name: "Shared",
      slug: "shared",
      createdByUserId: null,
    });
    await database.createProject({
      organizationId: "org-b",
      name: "Shared",
      slug: "shared",
      createdByUserId: null,
    });
  });
});
