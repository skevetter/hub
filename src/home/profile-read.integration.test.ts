import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import { HomeDashboard } from "./dashboard.js";

it("Home reads profile availability without loading an unbounded list of full profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-home-profiles-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(directory);
  const db = createDatabase(runtime, locks);
  try {
    await runtime.migrate();
    await runtime.query(
      "insert into organization (id, name, slug) values ('acme', 'Acme', 'acme')",
    );
    await runtime.query(
      `insert into "user" (id, name, email) values ('owner', 'Owner', 'owner@example.test')`,
    );
    await runtime.query(`insert into member (id, organization_id, user_id, role) values
      ('membership', 'acme', 'owner', 'owner')`);
    await enrollTestDaemon(db, "acme");
    await runtime.query(
      `insert into interactive_session_profiles
         (id, organization_id, name, daemon_id, cwd, provider, status)
       select gen_random_uuid(), 'acme', 'Fixture ' || n, $1, '/repo', 'codex',
              case when n = 1 then 'active' else 'disabled' end
       from generate_series(1, 10001) n`,
      [TEST_DAEMON_ID],
    );
    const auth: AuthServer = {
      handle: vi.fn(),
      resources: vi.fn(),
      resolveOrganizationAccess: vi.fn(),
      resolveAccount: async () => ({
        session: { id: "session-1", activeOrganizationId: "acme" },
        account: { id: "owner", name: "Owner", email: "owner@example.test" },
        isInstanceOperator: false,
      }),
      rejectCookieMutation: vi.fn(),
      close: vi.fn(),
    };
    const list = vi.spyOn(db, "listSessionProfiles");
    const dashboard = new HomeDashboard(db, auth, () => true, { interactiveSessions: true });
    const snapshot = await dashboard.snapshot(new Request("https://hub.test/o/acme/home"), "acme");
    assert.ok(snapshot.sessions);
    assert.equal(
      list.mock.calls.length,
      0,
      "the Home snapshot must leave profiles to the client query",
    );
    assert.equal(Object.hasOwn(snapshot.sessions, "profiles"), false);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
