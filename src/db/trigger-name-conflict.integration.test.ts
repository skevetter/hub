import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, it } from "vitest";
import { classifyFailure, respondWithFailure } from "../failures/index.js";
import { createLogger } from "../logger.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { TriggerNameConflictError } from "./errors.js";
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
  throw new Error("expected the save to be refused");
}

describe.each(["pglite", "memory"] as const)("a duplicate trigger name on %s", (engine) => {
  let runtime: DatabaseRuntime | undefined;
  let database: Database;
  let directory: string | undefined;

  beforeAll(async () => {
    if (engine === "memory") {
      database = createMemoryDatabase();
      return;
    }
    directory = await mkdtemp(join(tmpdir(), "hub-trigger-name-"));
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

  it("is a conflict when a second trigger takes the name", async () => {
    await saveTrigger(database, { organizationId: "org-a", name: "taken" });
    const error = await rejection(
      saveTrigger(database, { organizationId: "org-a", name: "taken" }),
    );

    assert.ok(error instanceof TriggerNameConflictError);
    assert.equal(classifyFailure(error), "conflict");
  });

  it("is a conflict when a rename takes the name", async () => {
    await saveTrigger(database, { organizationId: "org-a", name: "first" });
    const second = await saveTrigger(database, { organizationId: "org-a", name: "second" });
    const error = await rejection(
      saveTrigger(database, { organizationId: "org-a", name: "first", triggerId: second.id }),
    );

    assert.ok(error instanceof TriggerNameConflictError);
  });

  it("is allowed in another organization", async () => {
    await saveTrigger(database, { organizationId: "org-a", name: "shared" });
    await saveTrigger(database, { organizationId: "org-b", name: "shared" });
  });

  it("shows the prepared message, below ERROR, with no reference or database text", async () => {
    await saveTrigger(database, { organizationId: "org-a", name: "logged" });
    const error = await rejection(
      saveTrigger(database, { organizationId: "org-a", name: "logged" }),
    );
    const stream = new CaptureStream();
    const result = respondWithFailure(
      error,
      { operation: "trigger.save", component: "triggers" },
      {
        fallback: "Hub couldn't save this trigger.",
        conflict: "A trigger with this name already exists.",
      },
      { logger: createLogger(stream) },
    );

    assert.equal(result.error.message, "A trigger with this name already exists.");
    assert.match(stream.text, /"failureKind":"conflict"/u);
    assert.match(stream.text, new RegExp(`"level":${WARN}`, "u"));
  });
});
