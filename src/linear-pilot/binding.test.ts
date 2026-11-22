import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseRuntime, TransactionHandle } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import { PILOT_POLICY_REVISION, PilotBindings, validPilotAuthority } from "./binding.js";
import type {
  PilotAdmitInput,
  PilotAdmitResult,
  PilotAdvanceInput,
  PilotAuthority,
  PilotIdentityStore,
  PilotNativeOrigin,
} from "./binding.js";

const reached = new Error("reached the database");

function recordingBackend() {
  const calls: string[] = [];
  const trap = async (): Promise<never> => {
    calls.push("call");
    throw reached;
  };
  const runtime: DatabaseRuntime = {
    query: trap,
    transaction: trap,
    drizzle: () => {
      calls.push("call");
      throw reached;
    },
    migrate: trap,
    close: trap,
  };
  const locks: Locks = { withLock: trap, withTxLock: trap, tryTxLock: trap };
  const identities: PilotIdentityStore = {
    createSurfaceIdentity: trap,
    findSurfaceIdentity: trap,
  };
  return {
    calls,
    runtime,
    locks,
    identities,
    pilot: new PilotBindings(runtime, locks, identities),
  };
}

function authority(): PilotAuthority {
  return {
    organizationId: "org",
    workspaceId: "workspace",
    applicationId: "app",
    appUserId: "app-user",
    connectionId: randomUUID(),
    profileId: randomUUID(),
    ownerUserId: "owner",
    humanProviderUserId: "human",
    teamIds: ["team-a", "team-b"],
  };
}

function origin(): PilotNativeOrigin {
  return {
    nativeSessionId: "native",
    issueId: "issue",
    teamId: "team-a",
    actorProviderUserId: "human",
  };
}

function nonprivateProfileBackend(base: PilotAuthority) {
  const { runtime, locks, identities, calls } = recordingBackend();
  const query: TransactionHandle["query"] = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes("from linear_connections") || sql.includes("from member where")) {
      return { rows: [{}], rowCount: 1 };
    }
    if (
      sql.includes("from surface_bindings") ||
      sql.includes("from surface_policies") ||
      sql.includes("from member_identities")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("from interactive_session_profiles")) {
      const profile = {
        status: "active",
        access: "organization",
        version: 1,
        createdByUserId: base.ownerUserId,
      };
      return { rows: [profile], rowCount: 1 };
    }
    calls.push(sql);
    throw reached;
  });
  const transaction: DatabaseRuntime["transaction"] = (operation) =>
    operation({
      query,
      drizzle: () => runtime.drizzle(),
      rollback: () => {
        throw reached;
      },
    });
  return {
    calls,
    pilot: new PilotBindings(
      { ...runtime, transaction },
      { ...locks, withTxLock: async () => {} },
      identities,
    ),
  };
}

// Small deterministic generator so a failing case replays from its seed and index.
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const SEED = 20261121;

describe("pilot binding validation", () => {
  it("marks pilot rows with the largest revision the column accepts", () => {
    expect(PILOT_POLICY_REVISION).toBe(2 ** 31 - 1);
  });

  it("rejects an authority whose human is the app actor or whose teams repeat", () => {
    const base = authority();
    assert.equal(validPilotAuthority(base), true);
    assert.equal(validPilotAuthority({ ...base, humanProviderUserId: base.appUserId }), false);
    assert.equal(validPilotAuthority({ ...base, teamIds: ["team-a", "team-a"] }), false);
    assert.equal(validPilotAuthority({ ...base, teamIds: [] }), false);
  });

  it("admits or refuses 2,000 generated inputs with no database access for refusals", async () => {
    const random = prng(SEED);
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
    const bad = ["", "a\0b", "x".repeat(256), "\u00e9".repeat(128)];
    const uuidBad = ["", "not-a-uuid", randomUUID() + "0", randomUUID().replaceAll("-", "")];
    let valid = 0;
    let refused = 0;
    for (let index = 0; index < 2_000; index++) {
      const base = authority();
      const input: PilotAdmitInput = { ...origin(), sessionId: randomUUID(), now: new Date(0) };
      // Oracle: what the packet says must reach the database, written independently of the code.
      let expectValid = true;
      const corrupt = random() < 0.7;
      if (corrupt) {
        const field = pick([
          "nativeSessionId",
          "issueId",
          "teamId",
          "actorProviderUserId",
          "sessionId",
          "actorSwap",
          "teamOut",
          "now",
        ] as const);
        if (field === "sessionId") input.sessionId = pick(uuidBad);
        else if (field === "actorSwap") input.actorProviderUserId = "other-" + index;
        else if (field === "teamOut") input.teamId = "team-z";
        else if (field === "now") input.now = new Date(Number.NaN);
        else input[field] = pick(bad);
        expectValid = false;
      }
      const { calls, pilot } = recordingBackend();
      let result: PilotAdmitResult | undefined;
      let thrown: unknown;
      try {
        result = await pilot.admit(base, input);
      } catch (error) {
        thrown = error;
      }
      const context = `seed ${SEED} case ${index}`;
      if (expectValid) {
        valid++;
        assert.equal(thrown, reached, context);
        assert.equal(calls.length, 1, context);
      } else {
        refused++;
        assert.equal(result?.status, "refused", context);
        assert.equal(calls.length, 0, context);
      }
    }
    assert.equal(valid + refused, 2_000);
    assert.ok(valid > 400 && refused > 1_000);
  });

  it.each(["find", "admit", "mapIdentity", "advance"] as const)(
    "refuses a nonprivate profile on %s without reaching session or identity writes",
    async (operation) => {
      const base = authority();
      const { pilot, calls } = nonprivateProfileBackend(base);
      const native = origin();
      const now = new Date(0);
      const input = {
        ...native,
        expected: {
          bindingId: randomUUID(),
          sessionId: randomUUID(),
          generation: 1,
          sessionGeneration: 1,
          turn: 1,
          agentId: "agent",
          firstCommandId: randomUUID(),
        },
        nextSessionId: randomUUID(),
        now,
      };
      const run = {
        find: () => pilot.find(base, native),
        admit: () => pilot.admit(base, { ...native, sessionId: input.nextSessionId, now }),
        mapIdentity: () => pilot.mapIdentity(base, "label", now),
        advance: () => pilot.advance(base, input),
      };
      assert.deepEqual(await run[operation](), {
        status: "refused",
        reason: "profile_unavailable",
      });
      assert.deepEqual(calls, []);
    },
  );

  it("validates 2,000 generated advance tuples before opening a transaction", async () => {
    const seed = SEED + 2;
    const random = prng(seed);
    const invalid = [
      (input: PilotAdvanceInput) => {
        input.expected.bindingId = "invalid";
      },
      (input: PilotAdvanceInput) => {
        input.expected.generation = 0;
      },
      (input: PilotAdvanceInput) => {
        input.expected.generation = 2 ** 31;
      },
      (input: PilotAdvanceInput) => {
        input.expected.generation = 1.5;
      },
      (input: PilotAdvanceInput) => {
        input.expected.sessionId = "invalid";
      },
      (input: PilotAdvanceInput) => {
        input.nextSessionId = "";
      },
      (input: PilotAdvanceInput) => {
        input.nextSessionId = input.expected.sessionId.toUpperCase();
      },
      (input: PilotAdvanceInput) => {
        input.now = new Date(Number.NaN);
      },
      (input: PilotAdvanceInput) => {
        input.actorProviderUserId = "other-human";
      },
      (input: PilotAdvanceInput) => {
        input.teamId = "out-of-scope";
      },
      (input: PilotAdvanceInput) => {
        input.issueId = "x".repeat(256);
      },
      (input: PilotAdvanceInput) => {
        input.expected.sessionGeneration = 0;
      },
      (input: PilotAdvanceInput) => {
        input.expected.turn = 0;
      },
      (input: PilotAdvanceInput) => {
        input.expected.agentId = "agent\0id";
      },
      (input: PilotAdvanceInput) => {
        input.expected.firstCommandId = "invalid";
      },
    ];
    let valid = 0;
    for (let index = 0; index < 2_000; index++) {
      const input: PilotAdvanceInput = {
        ...origin(),
        expected: {
          bindingId: randomUUID(),
          generation: 1,
          sessionId: randomUUID(),
          sessionGeneration: 1,
          turn: 1,
          agentId: "agent",
          firstCommandId: randomUUID(),
        },
        nextSessionId: randomUUID(),
        now: new Date(0),
      };
      const outcome = Math.floor(random() * (invalid.length + 1));
      const { calls, pilot } = recordingBackend();
      const context = `seed ${seed} case ${index}`;
      if (outcome === invalid.length) {
        valid++;
        await assert.rejects(pilot.advance(authority(), input), (error) => error === reached);
        assert.equal(calls.length, 1, context);
      } else {
        invalid[outcome]!(input);
        assert.equal((await pilot.advance(authority(), input)).status, "refused", context);
        assert.equal(calls.length, 0, context);
      }
    }
    assert.ok(valid > 100);
  });

  it("refuses 2,000 generated find and map inputs with no database access", async () => {
    const random = prng(SEED + 1);
    const bad = ["", "a\0b", "x".repeat(256)];
    for (let index = 0; index < 2_000; index++) {
      const base = authority();
      const field = (
        [
          "organizationId",
          "workspaceId",
          "applicationId",
          "appUserId",
          "ownerUserId",
          "humanProviderUserId",
        ] as const
      )[Math.floor(random() * 6)]!;
      const broken = { ...base, [field]: bad[Math.floor(random() * bad.length)]! };
      const { calls, pilot } = recordingBackend();
      const context = `seed ${SEED + 1} case ${index}`;
      assert.deepEqual(
        await pilot.find(broken, { ...origin(), actorProviderUserId: broken.humanProviderUserId }),
        { status: "refused", reason: "invalid_input" },
        context,
      );
      assert.deepEqual(
        await pilot.mapIdentity(broken, "label", new Date(0)),
        { status: "refused", reason: "invalid_input" },
        context,
      );
      assert.equal(calls.length, 0, context);
    }
  });
});
