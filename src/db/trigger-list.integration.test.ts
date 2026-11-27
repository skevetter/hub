import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PAGE_SIZES } from "../components/app/page-size.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { eventDefinition } from "../triggers/configuration/events.js";
import { LIST_PROVIDERS, type ListProvider } from "../triggers/list-providers.js";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "./runtime/index.js";
import { createPostgresTestRuntime } from "./test-utils/runtime.js";
import type { Database, OrganizationTriggerRecord, TriggerListRequest } from "./types.js";

const ORGANIZATION = "trigger-page-org";
const OTHER_ORGANIZATION = "trigger-page-foreign";
const COLLATION_ORGANIZATION = "trigger-page-collation";
const EVENTS = [
  "manual.run",
  "github.push",
  "github.notification",
  "linear.issue_assigned",
  "slack.mention",
  "discord.mention",
  "schedule.tick",
] as const;
const PROVIDER_PREFIXES: Record<ListProvider, string> = {
  manual: "manual.",
  webhook: "manual.",
  github: "github.",
  github_notification: "github.notification",
  linear: "linear.",
  slack: "slack.",
  discord: "discord.",
  schedule: "schedule.",
};
const YAML = `name: sample
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Run task
`;

describe.each(["postgres", "pglite", "memory"] as const)("trigger list pages on %s", (engine) => {
  let runtime: DatabaseRuntime | undefined;
  let database: Database;
  let cleanup: (() => Promise<void>) | undefined;
  const fixture: { trigger: OrganizationTriggerRecord; events: readonly string[] }[] = [];

  beforeAll(async () => {
    if (engine === "postgres") {
      const container = await new PostgreSqlContainer("postgres:17")
        .withEnvironment({ POSTGRES_INITDB_ARGS: "--locale=en_US.utf8" })
        .start();
      cleanup = async () => {
        await container.stop();
      };
      ({ runtime, database } = await createPostgresTestRuntime(container.getConnectionUri()));
    } else if (engine === "pglite") {
      const directory = await mkdtemp(join(tmpdir(), "hub-trigger-paging-"));
      cleanup = () => rm(directory, { recursive: true, force: true });
      const bundle = await embeddedDatabaseRuntime(directory);
      runtime = bundle.runtime;
      await runtime.migrate();
      database = createDatabase(runtime, bundle.locks);
    } else {
      database = createMemoryDatabase();
    }
    await runtime?.query(
      "insert into organization (id, name, slug) values ($1, 'Fixture', 'fixture'), ($2, 'Other', 'other')",
      [ORGANIZATION, OTHER_ORGANIZATION],
    );
    for (let index = 127; index >= 0; index -= 1) {
      const name = `sample-${String(index).padStart(3, "0")}`;
      const on = EVENTS[index % EVENTS.length] ?? "manual.run";
      const events = index === 127 ? ([on, "discord.mention"] as const) : [on];
      const trigger = await createTrigger(database, ORGANIZATION, {
        name,
        enabled: index % 2 === 0,
        events,
      });
      fixture.push({ trigger, events });
    }
    const special = await createTrigger(database, ORGANIZATION, {
      name: "special_name",
      enabled: true,
      events: ["manual.run"],
    });
    fixture.push({ trigger: special, events: ["manual.run"] });
    await createTrigger(database, OTHER_ORGANIZATION, {
      name: "sample-000",
      enabled: true,
      events: ["manual.run"],
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await runtime?.close();
    } finally {
      await cleanup?.();
    }
  });

  it("combines literal name, enabled state and provider filters inside the organization", async () => {
    const read = async (request: Partial<TriggerListRequest>) =>
      (await database.listOrganizationTriggerPage(ORGANIZATION, { limit: 100, ...request }))
        .records;
    assert.equal((await read({ enabled: false })).length, 64);
    const matches = await read({ nameContains: "SpEcIaL_", enabled: true, provider: "webhook" });
    assert.deepEqual(
      matches.map(({ name }) => name),
      ["special_name"],
    );
    for (const query of ["%", "!", "\\"]) assert.deepEqual(await read({ nameContains: query }), []);
    assert.equal((await read({ nameContains: "_" })).length, 1);
    for (const provider of LIST_PROVIDERS) {
      const matchesEvent = (source: string) => source.startsWith(PROVIDER_PREFIXES[provider]);
      const expected = fixture
        .filter(({ events }) => events.some(matchesEvent))
        .map(({ trigger }) => trigger.id)
        .toSorted();
      assert.deepEqual((await read({ provider })).map(({ id }) => id).toSorted(), expected);
    }
    const [foreign] = (
      await database.listOrganizationTriggerPage(OTHER_ORGANIZATION, { limit: 15 })
    ).records;
    assert.ok(foreign);
    assert.equal(await database.findOrganizationTrigger(ORGANIZATION, foreign.id), undefined);
    assert.equal(
      await database.hasOrganizationTriggerEvent(ORGANIZATION, "github.notification"),
      true,
    );
    assert.equal(
      await database.hasOrganizationTriggerEvent(OTHER_ORGANIZATION, "github.notification"),
      false,
    );
  });

  it("orders punctuation and digits identically when walking both keyset directions", async () => {
    if (engine === "postgres") {
      const locale = await runtime?.query<{ datcollate: string }>(
        "select datcollate from pg_database where datname = current_database()",
      );
      assert.equal(locale?.rows[0]?.datcollate, "en_US.utf8");
    }
    await runtime?.query(
      "insert into organization (id, name, slug) values ($1, 'Collation fixture', 'collation')",
      [COLLATION_ORGANIZATION],
    );
    const expected = ["a--z", "a-b", "a-c", "a0", "a_-", "a_a", "a_b", "ab", "b"];
    for (const name of expected.toReversed()) {
      await createTrigger(database, COLLATION_ORGANIZATION, {
        name,
        enabled: true,
        events: ["manual.run"],
      });
    }
    const read = (position?: TriggerListRequest["position"]) =>
      database.listOrganizationTriggerPage(COLLATION_ORGANIZATION, {
        limit: 3,
        ...(position === undefined ? {} : { position }),
      });
    const first = await read();
    assert.ok(first.next);
    const second = await read({ direction: "next", key: first.next });
    assert.ok(second.next);
    const last = await read({ direction: "next", key: second.next });
    assert.equal(last.next, null);
    assert.deepEqual(
      [...first.records, ...second.records, ...last.records].map(({ name }) => name),
      expected,
    );
    assert.ok(last.previous);
    const back = await read({ direction: "previous", key: last.previous });
    assert.deepEqual(
      back.records.map(({ name }) => name),
      expected.slice(3, 6),
    );
    assert.ok(back.previous);
    const start = await read({ direction: "previous", key: back.previous });
    assert.deepEqual(
      start.records.map(({ name }) => name),
      expected.slice(0, 3),
    );
    assert.equal(start.previous, null);
    const unpaged = await database.listOrganizationTriggers(COLLATION_ORGANIZATION);
    assert.deepEqual(
      unpaged.map(({ name }) => name),
      expected,
    );
  });

  it.each(PAGE_SIZES)("walks names in both directions at size %i", async (limit) => {
    const expected = fixture.map(({ trigger }) => trigger.name).toSorted();
    const read = (position?: TriggerListRequest["position"]) =>
      database.listOrganizationTriggerPage(ORGANIZATION, {
        limit,
        ...(position === undefined ? {} : { position }),
      });
    let offset = 0;
    let page = await read();
    for (;;) {
      assert.deepEqual(
        page.records.map(({ name }) => name),
        expected.slice(offset, offset + limit),
      );
      if (page.next === null) break;
      offset += limit;
      page = await read({ direction: "next", key: page.next });
    }
    assert.equal(offset + page.records.length, expected.length);
    while (page.previous !== null) {
      offset -= limit;
      page = await read({ direction: "previous", key: page.previous });
      assert.deepEqual(
        page.records.map(({ name }) => name),
        expected.slice(offset, offset + limit),
      );
    }
    assert.equal(offset, 0);
  });
});

async function createTrigger(
  database: Database,
  organizationId: string,
  {
    name,
    enabled,
    events,
  }: {
    name: string;
    enabled: boolean;
    events: readonly (typeof EVENTS)[number][];
  },
) {
  const compiled = compileTriggerDocument(YAML);
  const [event] = compiled.events;
  assert.ok(event);
  return database.saveOrganizationTrigger({
    organizationId,
    name,
    enabled,
    format: "single_run",
    yaml: YAML,
    normalizedConfiguration: {
      environments: [compiled.environment],
      triggers: events.map((on, index) => ({
        ...event,
        name: `${event.name}-${index}`,
        on,
        filters: eventDefinition(on).origin === "hub" ? {} : { from_users: ["fixture-actor"] },
      })),
    },
    contentHash: name,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    createdByUserId: null,
    routes: [],
  });
}
