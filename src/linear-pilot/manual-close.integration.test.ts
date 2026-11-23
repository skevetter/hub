import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, it, vi } from "vitest";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime, postgresDatabaseRuntime } from "../db/runtime/index.js";
import {
  installation,
  prepareProfile,
  startFixtureSession,
  surfaceTenant,
  surfaceTestTime,
} from "../surfaces/store.contract.js";
import { pilotActivityIds } from "./activities.js";
import { PilotBindings } from "./binding.js";
import {
  createPilotFollowUp,
  type PilotConversation,
  type PilotFollowUpOptions,
} from "./follow-up.js";

async function openManualCloseDatabase(backend: "embedded" | "postgres") {
  if (backend === "postgres") {
    const container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(20_000)
      .start();
    try {
      const bundle = await postgresDatabaseRuntime(container.getConnectionUri());
      return {
        ...bundle,
        cleanup: async () => {
          await container.stop({ timeout: 2_000 });
        },
      };
    } catch (error) {
      await container.stop({ timeout: 2_000 });
      throw error;
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "hub-pilot-manual-close-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    return { ...(await embeddedDatabaseRuntime(dir)), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

it.each(["embedded", "postgres"] as const)(
  "runs the documented manual close on %s and fences later prompts",
  async (backend) => {
    const doc = await readFile(new URL("../../docs/linear-pilot.md", import.meta.url), "utf8");
    const procedure = doc.split("## Manual close procedure\n")[1]?.split("\n## ")[0];
    assert.ok(procedure);
    const statements = [...procedure.matchAll(/^```sql\n([\s\S]*?)^```$/gmu)].map(
      ([, sql]) => sql!,
    );
    assert.equal(statements.length, 2, "manual close must document the list and close SQL blocks");
    const [list, close] = statements;

    const { runtime, locks, cleanup } = await openManualCloseDatabase(backend);
    try {
      await runtime.migrate();
      const tenant = surfaceTenant();
      const { organizationId, userId, connection } = tenant;
      const database = createDatabase(runtime, locks);
      await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
        organizationId,
      ]);
      await runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
        userId,
        userId + "@example.test",
      ]);
      await runtime.query(
        "insert into member (id, organization_id, user_id, role) values ($1, $2, $1, 'owner')",
        [userId, organizationId],
      );
      await runtime.query(
        `insert into linear_connections
          (id, organization_id, linear_organization_id, provider_application_id, slug,
           linear_organization_name, app_user_id, access_token)
         values ($1, $2, $3, $4, $5, $5, $6, $7)`,
        [
          connection.id,
          organizationId,
          connection.linearOrganizationId,
          connection.providerApplicationId,
          connection.slug,
          connection.appUserId,
          "synthetic-token",
        ],
      );
      const { profile, request } = await prepareProfile(database, tenant);
      const authority = {
        ...installation(tenant),
        connectionId: connection.id,
        profileId: profile.id,
        ownerUserId: userId,
        humanProviderUserId: randomUUID(),
        teamIds: ["team"],
      };
      const origin = {
        nativeSessionId: randomUUID(),
        issueId: "issue",
        teamId: "team",
        actorProviderUserId: authority.humanProviderUserId,
      };
      const bindings = new PilotBindings(runtime, locks, database);
      const mapped = await bindings.mapIdentity(authority, "Synthetic owner", surfaceTestTime);
      assert.equal(mapped.status, "mapped");
      const nativeRequest = {
        ...request,
        nativeRequester: { workspaceId: authority.workspaceId, identityId: mapped.identity.id },
      };
      const native = await startFixtureSession(database, nativeRequest);
      const web = await startFixtureSession(database, request);
      const admitted = await bindings.admit(authority, {
        ...origin,
        sessionId: native.id,
        now: surfaceTestTime,
      });
      assert.equal(admitted.status, "created");
      await runtime.query(
        "update interactive_sessions set state = 'running', turn = 1, daemon_agent_id = $2 where id = $1",
        [native.id, "stranded-agent"],
      );
      assert.equal((await bindings.find(authority, origin)).status, "bound");

      const open = await runtime.query(list!, [profile.id]);
      expect(open.rows).toEqual([
        {
          id: native.id,
          state: "running",
          generation: native.generation,
          started_at: native.createdAt,
          native_session_id: origin.nativeSessionId,
          daemon_id: native.daemonId,
          daemon_agent_id: "stranded-agent",
        },
      ]);
      const closeSession = (id: string, profileId = profile.id) =>
        runtime.transaction((tx) => tx.query(close!, [id, profileId]));
      const untouched = [{ sessions_closed: 0, bindings_retired: 0, events_written: 0 }];
      const oneClose = [{ sessions_closed: 1, bindings_retired: 1, events_written: 1 }];
      expect((await closeSession(web.id)).rows).toEqual(untouched);
      expect((await closeSession(native.id, randomUUID())).rows).toEqual(untouched);
      const setRevision = (revision: number) =>
        runtime.query("update surface_bindings set policy_revision = $2 where id = $1", [
          admitted.binding.id,
          revision,
        ]);
      await setRevision(1);
      expect((await closeSession(native.id)).rows).toEqual(untouched);
      expect(
        (await database.findInteractiveSession(organizationId, native.id))?.session.state,
      ).toBe("running");
      await setRevision(admitted.binding.policyRevision);
      expect((await closeSession(native.id)).rows).toEqual(oneClose);
      expect((await closeSession(native.id)).rows).toEqual(untouched);
      expect((await runtime.query(list!, [profile.id])).rows).toEqual([]);

      const closed = await database.findInteractiveSession(organizationId, native.id);
      assert.ok(closed?.session.closedAt instanceof Date);
      expect(closed.session).toMatchObject({
        state: "closed",
        stateReason: null,
        closedByUserId: null,
        generation: native.generation,
        turn: 1,
        daemonAgentId: "stranded-agent",
      });
      const retired = await runtime.query(
        "select superseded_at from surface_bindings where id = $1",
        [admitted.binding.id],
      );
      expect(retired.rows).toEqual([{ superseded_at: closed.session.closedAt }]);
      const state = await runtime.query(
        "select kind, data from interactive_session_events where session_id = $1 and seq = $2",
        [native.id, closed.session.hubSeq],
      );
      expect(state.rows).toEqual([
        {
          kind: "state",
          data: { state: "closed", stateReason: null, generation: native.generation, turn: 1 },
        },
      ]);
      expect((await database.findInteractiveSession(organizationId, web.id))?.session).toEqual(web);
      expect(await bindings.find(authority, origin)).toEqual({
        status: "refused",
        reason: "history_mismatch",
      });

      const scope: PilotConversation = {
        ...authority,
        ...origin,
        ownerId: authority.humanProviderUserId,
      };
      const claim = vi.fn<PilotFollowUpOptions["claim"]>().mockResolvedValue("claimed");
      const appendRefusal = vi.fn<PilotFollowUpOptions["appendRefusal"]>();
      const followUp = createPilotFollowUp({
        withSession: (_scope, run) => run(),
        activityIds: pilotActivityIds,
        async current() {
          const found = await bindings.find(authority, origin);
          if (found.status !== "bound") return undefined;
          return {
            ...scope,
            generation: found.binding.generation,
            policyRevision: found.binding.policyRevision,
            hubSessionId: found.binding.sessionId,
            profileId: profile.id,
            profileVersion: profile.version,
            state: "busy",
            preceding: null,
            agentId: "stranded-agent",
            daemonTurnId: "stranded-turn",
          };
        },
        claim,
        appendRefusal,
        appendBusy: async () => true,
        confirmStop: async () => false,
        readPrompt: async () => undefined,
        readHistory: async () => undefined,
        secrets: async () => [],
        reserve: async () => undefined,
        stopCurrent: async () => "ignored",
      });
      expect(
        await followUp(scope, {
          ...scope,
          action: "prompted",
          activityId: randomUUID(),
          userId: scope.ownerId,
          body: "Synthetic follow-up",
          signal: null,
        }),
      ).toBe("ignored");
      expect(claim).not.toHaveBeenCalled();
      expect(appendRefusal).not.toHaveBeenCalled();

      if (backend === "postgres") {
        const commands = [...procedure.matchAll(/`((?:PREPARE|EXECUTE) pilot_[^`]+)`/gu)].map(
          ([, command]) => command!,
        );
        assert.equal(commands.length, 4);
        const [prepareList, prepareClose, executeList, executeClose] = commands;
        const starting = await startFixtureSession(database, nativeRequest);
        const preparedOrigin = { ...origin, nativeSessionId: randomUUID() };
        const preparedBinding = await bindings.admit(authority, {
          ...preparedOrigin,
          sessionId: starting.id,
          now: surfaceTestTime,
        });
        assert.equal(preparedBinding.status, "created");
        const listCall = executeList!.replace("profile UUID", profile.id);
        const closeCall = executeClose!
          .replace("session UUID", starting.id)
          .replace("profile UUID", profile.id);
        await runtime.transaction(async (tx) => {
          await tx.query(`${prepareList}\n${list}`);
          await tx.query(`${prepareClose}\n${close}`);
          expect((await tx.query(listCall)).rows).toEqual([
            {
              id: starting.id,
              state: "starting",
              generation: starting.generation,
              started_at: starting.createdAt,
              native_session_id: preparedOrigin.nativeSessionId,
              daemon_id: starting.daemonId,
              daemon_agent_id: null,
            },
          ]);
          expect((await tx.query(closeCall)).rows).toEqual(oneClose);
          expect((await tx.query(closeCall)).rows).toEqual(untouched);
          expect((await tx.query(listCall)).rows).toEqual([]);
        });
        expect(
          (await database.findInteractiveSession(organizationId, starting.id))?.session.state,
        ).toBe("closed");
        const command = await runtime.query(
          "select status from interactive_session_commands where session_id = $1 and ordinal = 1",
          [starting.id],
        );
        expect(command.rows).toEqual([{ status: "pending" }]);
      }
    } finally {
      try {
        await runtime.close();
      } finally {
        await cleanup();
      }
    }
  },
  60_000,
);
