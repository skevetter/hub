import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { decodeActivityCursor } from "./activity-cursor.js";
import { migrateLegacyProjectTriggers } from "./migration.js";
import { runReadClock } from "./run-read.js";

const scope = "org/filter";
const key = {
  createdAt: "2026-01-01T00:00:00.123456Z",
  id: "00000000-0000-4000-8000-000000000001",
};
const fields = ["after", key.createdAt, key.id, scope];
const cursorFor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("activity cursor reader", () => {
  it.each([0, 1_000_000])("preserves valid display offset %i", (offset) => {
    assert.deepEqual(decodeActivityCursor(cursorFor([...fields, offset]), scope), {
      direction: "after",
      key,
      offset,
    });
  });

  it.each([null, "7", -1, 0.5, 1_000_001])("ignores invalid display offset %s", (offset) => {
    assert.deepEqual(decodeActivityCursor(cursorFor([...fields, offset]), scope), {
      direction: "after",
      key,
    });
  });

  it.each([
    undefined,
    "",
    "a".repeat(513),
    "YR",
    "AA==",
    Buffer.from("{").toString("base64url"),
    cursorFor(null),
    cursorFor({ fields }),
    cursorFor(fields.slice(0, 3)),
    cursorFor([...fields, 0, 1]),
    cursorFor(["sideways", ...fields.slice(1)]),
    cursorFor(["after", "2026-02-31T00:00:00.123456Z", key.id, scope]),
    cursorFor(["after", key.createdAt, "not-a-uuid", scope]),
    cursorFor(["after", key.createdAt, key.id, "wrong"]),
    cursorFor(["after", key.createdAt, key.id, "\u{1F30A}"]),
  ])("rejects invalid cursor %.20s", (cursor) => {
    assert.equal(decodeActivityCursor(cursor, scope), undefined);
  });
});

it("seeds one clock per client using only cached run reads with safe sequences", () => {
  const client = new QueryClient();
  const other = new QueryClient();
  for (const [index, data] of [
    null,
    undefined,
    60,
    {},
    { sequence: "60" },
    { sequence: 50.25 },
    { sequence: Infinity },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: -1 },
  ].entries()) {
    client.setQueryData(["run-events", index], data);
  }
  client.setQueryData(["other", 0], { sequence: 80 });
  client.setQueryData(["run-detail", 0], { sequence: 40 });
  client.setQueryData(["run-events", 40], { sequence: 42 });
  const clock = runReadClock(client);
  assert.equal(clock.issue(), 43);
  client.setQueryData(["run-detail", 0], { sequence: 90 });
  assert.equal(runReadClock(client), clock);
  assert.equal(clock.issue(), 44);
  assert.equal(runReadClock(other).issue(), 1);
  client.clear();
  other.clear();
});

it("propagates the exact missing-bundle error and releases the project lock", async () => {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  const project = await database.createProject({
    organizationId: "org",
    name: "Broken",
    slug: "broken",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "manual" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "broken",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  const migrate = vi.spyOn(database, "migrateProjectTriggers");
  const lock = vi.spyOn(database, "withAdvisoryLock");
  await assert.rejects(migrateLegacyProjectTriggers(database), {
    name: "Error",
    message: `cannot migrate project broken: active revision ${revision.id} has no authored bundle`,
  });
  const lockKey = `project-trigger-migration:${project.id}`;
  assert.equal(lock.mock.calls.at(0)?.[0], lockKey);
  assert.equal(migrate.mock.calls.length, 0);
  assert.equal(await database.withAdvisoryLock(lockKey, async () => "released"), "released");
  assert.equal((await database.listPendingProjectTriggerMigrations()).length, 1);
});
