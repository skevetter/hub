import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
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

it("runs the documented manual close and fences later prompts in the retired thread", async () => {
  const doc = await readFile(new URL("../../docs/linear-pilot.md", import.meta.url), "utf8");
  const procedure = doc.split("## Manual close procedure\n")[1]?.split("\n## ")[0];
  const statements = [...(procedure ?? "").matchAll(/^```sql\n([\s\S]*?)^```$/gmu)].map(
    ([, sql]) => sql!,
  );
  assert.equal(statements.length, 2, "manual close must document the list and close SQL blocks");
  const [list, close] = statements;

  const dir = await mkdtemp(join(tmpdir(), "hub-pilot-manual-close-"));
  try {
    const { runtime, locks } = await embeddedDatabaseRuntime(dir);
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
      const native = await startFixtureSession(database, {
        ...request,
        nativeRequester: { workspaceId: authority.workspaceId, identityId: mapped.identity.id },
      });
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
        },
      ]);
      const closeSession = (id: string, profileId = profile.id) =>
        runtime.transaction((tx) => tx.query(close!, [id, profileId]));
      const untouched = [{ sessions_closed: 0, bindings_retired: 0, events_written: 0 }];
      expect((await closeSession(web.id)).rows).toEqual(untouched);
      expect((await closeSession(native.id, randomUUID())).rows).toEqual(untouched);
      expect((await closeSession(native.id)).rows).toEqual([
        { sessions_closed: 1, bindings_retired: 1, events_written: 1 },
      ]);
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
        appendBusy: async () => true,
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
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
