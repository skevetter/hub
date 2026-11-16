import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, it } from "vitest";
import { z } from "zod";
import {
  embeddedDatabaseRuntime,
  type DatabaseRuntime,
  type QueryRow,
} from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const LEGACY_REVISION = "129973bbeb5d2021a12627ba66664a1ef8fa110f";
const REVOKED_AT = new Date("2025-01-01T00:00:00Z");
const FUTURE = new Date("2099-01-01T00:00:00Z");
const PAST = new Date("2024-01-01T00:00:00Z");
const ORGANIZATION = "rollback-organization";
const OTHER_ORGANIZATION = "rollback-other-organization";

interface LegacyApiKeys {
  list(
    organizationId: string,
  ): Promise<{ id: string; scopes: readonly string[]; revokedAt: Date | null }[]>;
}

type LegacyApiKeysConstructor = new (runtime: DatabaseRuntime, locks: Locks) => LegacyApiKeys;

interface TokenRow extends QueryRow {
  id: string;
  verifier: string;
  organization_id: string | null;
  issued_by_api_key_id: string | null;
  issued_by_cli_credential_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
}

interface KeyRow extends QueryRow {
  id: string;
  organization_id: string;
  scopes: string[];
  revoked_at: Date | null;
}

describe("webhook key rollback cleanup", () => {
  let directory: string;
  let runtime: DatabaseRuntime;
  let legacyKeys: LegacyApiKeys;
  let rollbackSql: string;
  const ids = {
    mixed: randomUUID(),
    only: randomUUID(),
    oldActive: randomUUID(),
    oldRevoked: randomUUID(),
    activeMixed: randomUUID(),
    activeOnly: randomUUID(),
  };
  const fixtures = [
    {
      id: ids.mixed,
      organizationId: ORGANIZATION,
      scopes: ["configuration:validate", "events:send", "daemons:enroll"],
      revokedAt: REVOKED_AT,
    },
    {
      id: ids.only,
      organizationId: ORGANIZATION,
      scopes: ["events:send"],
      revokedAt: REVOKED_AT,
    },
    {
      id: ids.oldActive,
      organizationId: ORGANIZATION,
      scopes: ["projects:read", "runs:dispatch"],
      revokedAt: null,
    },
    {
      id: ids.oldRevoked,
      organizationId: ORGANIZATION,
      scopes: ["daemons:enroll"],
      revokedAt: REVOKED_AT,
    },
    {
      id: ids.activeMixed,
      organizationId: OTHER_ORGANIZATION,
      scopes: ["events:send", "runs:dispatch"],
      revokedAt: null,
    },
    {
      id: ids.activeOnly,
      organizationId: OTHER_ORGANIZATION,
      scopes: ["events:send"],
      revokedAt: null,
    },
  ];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hub-webhook-rollback-"));
    const bundle = await embeddedDatabaseRuntime(join(directory, "database"));
    runtime = bundle.runtime;
    await runtime.migrate();
    rollbackSql = await readFile(join(REPOSITORY, "docs/webhook-rollback.sql"), "utf8");
    const legacySource = (path: string) =>
      execFileSync("git", ["show", `${LEGACY_REVISION}:${path}`], {
        cwd: REPOSITORY,
        encoding: "utf8",
      });
    const oldKeys = legacySource("src/auth/api-keys.ts");
    const oldContract = legacySource("src/auth/api-key-contract.ts");
    const outfile = join(directory, "legacy-api-keys.cjs");
    await build({
      stdin: {
        contents: oldKeys,
        loader: "ts",
        sourcefile: "legacy-api-keys.ts",
        resolveDir: join(REPOSITORY, "src/auth"),
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      plugins: [
        {
          name: "immutable-key-contract",
          setup(buildContext) {
            buildContext.onResolve({ filter: /^\.\/api-key-contract\.js$/ }, () => ({
              path: "legacy-api-key-contract",
              namespace: "legacy-contract",
            }));
            buildContext.onLoad({ filter: /.*/, namespace: "legacy-contract" }, () => ({
              contents: oldContract,
              loader: "ts",
              resolveDir: REPOSITORY,
            }));
          },
        },
      ],
    });
    const imported: unknown = createRequire(import.meta.url)(outfile);
    const legacyModule = z
      .object({
        OrganizationApiKeys: z.custom<LegacyApiKeysConstructor>(
          (value) => typeof value === "function",
        ),
      })
      .parse(imported);
    legacyKeys = new legacyModule.OrganizationApiKeys(runtime, bundle.locks);

    for (const organizationId of [ORGANIZATION, OTHER_ORGANIZATION]) {
      await runtime.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [
        organizationId,
      ]);
    }
    for (const fixture of fixtures) {
      await runtime.query(
        `insert into organization_api_keys
           (id, organization_id, name, prefix, verifier, scopes, actor, revoked_at)
         values ($1, $2, $3, $3, 'rollback-fixture-verifier', $4, 'rollback-sender', $5)`,
        [fixture.id, fixture.organizationId, fixture.id, fixture.scopes, fixture.revokedAt],
      );
      for (const [state, expiresAt, consumedAt] of [
        ["pending", FUTURE, null],
        ["expired", PAST, null],
        ["consumed", FUTURE, PAST],
      ] as const) {
        const tokenId = randomUUID();
        await runtime.query(
          `insert into daemon_enrollment_tokens
             (id, verifier, organization_id, issued_by_api_key_id, expires_at, consumed_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            tokenId,
            `${fixture.id}-${state}`,
            fixture.organizationId,
            fixture.id,
            expiresAt,
            consumedAt,
          ],
        );
      }
    }
    await runtime.query(
      `insert into daemon_enrollment_tokens (id, verifier, organization_id, expires_at)
       values ($1, 'unrelated-token', $2, $3)`,
      [randomUUID(), ORGANIZATION, FUTURE],
    );
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }, 120_000);

  async function cleanup() {
    const statements = rollbackSql.match(
      /^(BEGIN;)\s*(DO \$rollback\$[\s\S]*\$rollback\$;)\s*(COMMIT;)\s*$/u,
    );
    assert.ok(statements);
    const [, begin, operation, commit] = statements;
    assert.ok(begin && operation && commit);
    await runtime.query(begin);
    try {
      await runtime.query(operation);
      await runtime.query(commit);
    } catch (error) {
      await runtime.query("ROLLBACK");
      throw error;
    }
  }

  async function snapshot() {
    const keys = await runtime.query<KeyRow>(`select * from organization_api_keys order by id`);
    const tokens = await runtime.query<TokenRow>(
      `select * from daemon_enrollment_tokens order by id`,
    );
    return { keys: keys.rows, tokens: tokens.rows };
  }

  it("refuses active keys, atomically cleans revoked keys and restores actual old-binary listing", async () => {
    const original = await snapshot();
    await assert.rejects(cleanup(), /Revoke every events:send API key/u);
    assert.deepEqual(await snapshot(), original);
    await runtime.query(`update organization_api_keys set revoked_at = $2 where id = $1`, [
      ids.activeMixed,
      REVOKED_AT,
    ]);
    const partiallyRevoked = await snapshot();
    await assert.rejects(cleanup(), /Revoke every events:send API key/u);
    assert.deepEqual(await snapshot(), partiallyRevoked);
    await runtime.query(`update organization_api_keys set revoked_at = $2 where id = $1`, [
      ids.activeOnly,
      REVOKED_AT,
    ]);
    await assert.rejects(legacyKeys.list(ORGANIZATION));
    await assert.rejects(legacyKeys.list(OTHER_ORGANIZATION));
    const revoked = await snapshot();

    await runtime.query(`
      create function refuse_rollback_delete() returns trigger language plpgsql as $test$
      begin
        raise exception 'rollback deletion refused';
      end;
      $test$;
    `);
    await runtime.query(`
      create trigger refuse_rollback_delete before delete on organization_api_keys
      for each row execute function refuse_rollback_delete();
    `);
    await assert.rejects(cleanup(), /rollback deletion refused/u);
    assert.deepEqual(await snapshot(), revoked);
    await runtime.query(`drop trigger refuse_rollback_delete on organization_api_keys`);
    await runtime.query(`drop function refuse_rollback_delete()`);

    await cleanup();
    const cleaned = await snapshot();
    const deletedIds = new Set<string>([ids.only, ids.activeOnly]);
    assert.equal(cleaned.keys.length, revoked.keys.length - deletedIds.size);
    for (const key of revoked.keys) {
      const current = cleaned.keys.find((row) => row.id === key.id);
      if (key.id === ids.only || key.id === ids.activeOnly) {
        assert.equal(current, undefined);
      } else if (key.id === ids.mixed) {
        assert.deepEqual(current, {
          ...key,
          scopes: ["configuration:validate", "daemons:enroll"],
        });
      } else if (key.id === ids.activeMixed) {
        assert.deepEqual(current, { ...key, scopes: ["runs:dispatch"] });
      } else {
        assert.deepEqual(current, key);
      }
    }
    assert.equal(cleaned.tokens.length, revoked.tokens.length);
    for (const token of revoked.tokens) {
      const current = cleaned.tokens.find((row) => row.id === token.id);
      assert.ok(current);
      if (
        token.issued_by_api_key_id === null ||
        token.issued_by_api_key_id === ids.oldActive ||
        token.issued_by_api_key_id === ids.oldRevoked ||
        token.consumed_at !== null
      ) {
        assert.deepEqual(current, token);
      } else {
        assert.ok(current.expires_at <= token.expires_at);
        assert.ok(current.expires_at.getTime() <= Date.now());
        if (token.expires_at.getTime() === PAST.getTime()) {
          assert.deepEqual(current.expires_at, token.expires_at);
        }
        assert.deepEqual(current, {
          ...token,
          expires_at: current.expires_at,
          issued_by_api_key_id: deletedIds.has(token.issued_by_api_key_id)
            ? null
            : token.issued_by_api_key_id,
        });
      }
    }
    for (const organizationId of [ORGANIZATION, OTHER_ORGANIZATION]) {
      const listed = await legacyKeys.list(organizationId);
      const expected = cleaned.keys.filter((key) => key.organization_id === organizationId);
      assert.equal(listed.length, expected.length);
      for (const key of listed) {
        const row = expected.find((candidate) => candidate.id === key.id);
        assert.ok(row);
        assert.deepEqual(key.scopes, row.scopes);
        assert.deepEqual(key.revokedAt, row.revoked_at);
      }
    }
    await cleanup();
    assert.deepEqual(await snapshot(), cleaned);
  }, 120_000);
});
