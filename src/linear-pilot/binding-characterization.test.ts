import { describe, it, expect, vi } from "vitest";
import type { DatabaseRuntime, QueryRow, TransactionHandle } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import { PilotBindings, type PilotIdentityStore } from "./binding.js";
const authority = {
  organizationId: "org",
  workspaceId: "workspace",
  applicationId: "app",
  appUserId: "app-user",
  connectionId: "feed0000-0000-4000-8000-000000000001",
  profileId: "feed0000-0000-4000-8000-000000000002",
  ownerUserId: "owner",
  humanProviderUserId: "human",
  teamIds: ["team"],
};
const origin = {
  nativeSessionId: "native",
  issueId: "issue",
  teamId: "team",
  actorProviderUserId: "human",
};
const oldId = "feed0000-0000-4000-8000-000000000003";
const nextId = "feed0000-0000-4000-8000-000000000004";
const bindingId = "feed0000-0000-4000-8000-000000000005";
const firstCommandId = "feed0000-0000-4000-8000-000000000006";
const now = new Date(500);
const old = {
  ...authority,
  ...origin,
  id: bindingId,
  sessionId: oldId,
  policyRevision: 2_147_483_647,
  generation: 1,
  createdAt: new Date(0),
  supersededAt: null,
};
const next = {
  ...old,
  id: "feed0000-0000-4000-8000-000000000007",
  sessionId: nextId,
  generation: 2,
  createdAt: now,
};
const input = {
  ...origin,
  expected: {
    bindingId,
    sessionId: oldId,
    generation: 1,
    sessionGeneration: 5,
    turn: 3,
    agentId: "agent",
    firstCommandId,
  },
  nextSessionId: nextId,
  now,
};
const profile = { status: "active", access: "private", version: 7, createdByUserId: "owner" };
const identity = { id: "identity", userId: "owner" };
const active = {
  origin: "linear",
  state: "starting",
  stateReason: null,
  profileId: authority.profileId,
  profileVersion: 7,
  startedByUserId: authority.ownerUserId,
  requesterIdentityId: identity.id,
  closedAt: null,
  closedByUserId: null,
  generation: 1,
  turn: 0,
  commandSeq: 1,
  daemonAgentId: null,
  daemonWorkspaceId: null,
};
const closed = {
  ...active,
  state: "closed",
  closedAt: now,
  generation: 5,
  turn: 3,
  daemonAgentId: "agent",
};

const denied = (reason: string) => ({ status: "refused", reason });
function backend(queue: QueryRow[][], identities?: PilotIdentityStore) {
  const executed: string[] = [];
  const queries = vi.fn().mockImplementation(async (sql: string) => {
    executed.push(sql);
    const rows = queue.shift();
    if (rows === undefined) throw new TypeError("unexpected query");
    return { rows, rowCount: rows.length };
  });
  const unexpected = (): never => {
    throw new Error("unexpected dependency");
  };
  const tx: TransactionHandle = { query: queries, drizzle: unexpected, rollback: unexpected };
  const runtime: DatabaseRuntime = {
    query: queries,
    transaction: (run) => run(tx),
    drizzle: unexpected,
    close: unexpected,
    migrate: unexpected,
  };
  const locks: Locks = {
    withTxLock: async () => {},
    withLock: unexpected,
    tryTxLock: unexpected,
  };
  const store = new PilotBindings(
    runtime,
    locks,
    identities ?? {
      findSurfaceIdentity: unexpected,
      createSurfaceIdentity: unexpected,
    },
  );
  return { store, queries, executed };
}

function ownerRows() {
  return [[{}], [], [profile], [{}], [identity]];
}

describe("Linear binding ownership and generation", () => {
  it("stops at each failing owner link without reading a session", async () => {
    const refusals = [
      [[], "access_lost"],
      [[{}], "rolled_out"],
      [[], "profile_unavailable"],
      [[], "owner_mismatch"],
      [[{ ...identity, userId: "other" }], "identity_conflict"],
    ] satisfies [QueryRow[], string][];
    for (const [index, [replacement, reason]] of refusals.entries()) {
      const rows = ownerRows().slice(0, index + 1);
      rows[index] = replacement;
      const { store, queries } = backend([[old], ...rows]);
      expect(await store.find(authority, origin)).toEqual(denied(reason));
      expect(queries).toHaveBeenCalledTimes(rows.length + 1);
    }
  });

  it("preserves session and row-history denials, then returns an exact binding", async () => {
    const cases = [
      [[{ ...old, policyRevision: 1 }], [active], "foreign_binding"],
      [[{ ...old, supersededAt: now }], [active], "history_mismatch"],
      [[{ ...old, teamId: "other" }], [active], "history_mismatch"],
      [[old], [closed], "session_unavailable"],
      [[old], [{ ...active, profileVersion: 8 }], "profile_changed"],
      [[old], [{ ...active, requesterIdentityId: "other" }], "actor_mismatch"],
    ] satisfies [QueryRow[], QueryRow[], string][];
    for (const [bindingRows, sessionRows, reason] of cases) {
      const { store } = backend([bindingRows, ...ownerRows(), sessionRows]);
      expect(await store.find(authority, origin)).toEqual(denied(reason));
    }
    const { store } = backend([[old], ...ownerRows(), [active]]);
    expect(await store.find(authority, origin)).toEqual({ status: "bound", binding: old });
  });

  it("authorizes retirement before replay or insertion and propagates backend errors", async () => {
    const retired = { ...old, supersededAt: now };
    const replay = backend([...ownerRows(), [retired, next], [closed], [{}], [active]]);
    expect(await replay.store.advance(authority, input)).toEqual({
      status: "replayed",
      binding: next,
    });
    const fresh = backend([...ownerRows(), [old], [closed], [{}], [active], [], [{}], [next]]);
    expect(await fresh.store.advance(authority, input)).toEqual({
      status: "advanced",
      binding: next,
    });
    expect(fresh.executed.slice(-2)).toEqual([
      expect.stringContaining("update surface_bindings"),
      expect.stringContaining("insert into surface_bindings"),
    ]);
    const missingCommand = backend([...ownerRows(), [old], [closed], []]);
    expect(await missingCommand.store.advance(authority, input)).toEqual(
      denied("session_unavailable"),
    );
    const failed = backend([...ownerRows(), [old], [closed]]);
    await expect(failed.store.advance(authority, input)).rejects.toThrow("unexpected query");
  });

  it("reports mapping conflicts without changing the existing identity", async () => {
    const conflicting: PilotIdentityStore["createSurfaceIdentity"] = vi
      .fn()
      .mockResolvedValue({ ...identity, userId: "other" });
    const { store } = backend(ownerRows(), {
      findSurfaceIdentity: async () => undefined,
      createSurfaceIdentity: conflicting,
    });
    expect(await store.mapIdentity(authority, "label", now)).toEqual(denied("identity_conflict"));
    expect(conflicting).toHaveBeenCalledTimes(1);
  });
});
