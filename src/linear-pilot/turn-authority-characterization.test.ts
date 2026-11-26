import { describe, it, expect, vi } from "vitest";
import type { QueryHandle } from "../db/runtime/index.js";
import type { PilotFindResult } from "./binding.js";
import { authorizeBoundPilotTurn, authorizePilotTurnRefresh } from "./turn-authority.js";

const authority = {
  organizationId: "org",
  workspaceId: "workspace",
  applicationId: "app",
  appUserId: "app-user",
  connectionId: "connection",
  profileId: "profile",
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
const session = {
  id: "session",
  organizationId: "org",
  origin: "linear" as const,
  profileId: "profile",
  profileVersion: 7,
  startedByUserId: "owner",
};
const grant = {
  authority,
  origin,
  sessionId: session.id,
  commandId: "command",
  bindingGeneration: 2,
  profileVersion: 7,
};

function result(sessionId: string, generation: number): PilotFindResult {
  return {
    status: "bound",
    binding: {
      ...authority,
      ...origin,
      id: "binding",
      sessionId,
      generation,
      policyRevision: 1,
      createdAt: new Date(0),
      supersededAt: null,
    },
  };
}

describe("locally admitted Linear turn", () => {
  it("denies each stale grant before consulting the binding", async () => {
    const find = async (): Promise<never> => {
      throw new Error("unexpected lookup");
    };
    for (const rejected of [
      undefined,
      { ...grant, sessionId: "other" },
      { ...grant, commandId: "other" },
      { ...grant, authority: { ...authority, organizationId: "other" } },
      { ...grant, authority: { ...authority, profileId: "other" } },
      { ...grant, authority: { ...authority, ownerUserId: "other" } },
      { ...grant, profileVersion: 8 },
    ]) {
      expect(await authorizeBoundPilotTurn(find, rejected, session, "command", 2)).toBe(false);
    }
    expect(
      await authorizeBoundPilotTurn(find, grant, { ...session, origin: "web" }, "command"),
    ).toBe(false);
    expect(await authorizeBoundPilotTurn(find, grant, session, "command", 3)).toBe(false);
  });

  it("checks current binding, generation and session and preserves lookup errors", async () => {
    const cases = [
      [{ status: "none" }, false],
      [{ status: "refused", reason: "identity_unmapped" }, false],
      [result("other", 2), false],
      [result("session", 3), false],
      [result("session", 2), true],
    ] satisfies [PilotFindResult, boolean][];
    for (const [row, expected] of cases) {
      const find = async (...args: unknown[]) => {
        expect(args).toEqual([authority, origin]);
        return row;
      };
      expect(await authorizeBoundPilotTurn(find, grant, session, "command")).toBe(expected);
    }
    const find = async () => {
      throw new TypeError("lookup failed");
    };
    await expect(authorizeBoundPilotTurn(find, grant, session, "command")).rejects.toThrow(
      "lookup failed",
    );
  });

  it("reads the local command first and uses its query handle for the binding", async () => {
    for (const rows of [[], [session]]) {
      const read = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
      const query: QueryHandle = { query: read };
      const find = async (...args: unknown[]) => {
        expect(args).toEqual([authority, origin, query]);
        return result("session", 2);
      };
      expect(await authorizePilotTurnRefresh(query, find, grant)).toBe(rows.length === 1);
      const [[sql, args] = []] = read.mock.calls;
      expect(sql).toContain("command.kind = 'message' and command.ordinal = 1");
      expect(args).toEqual(["org", "session", "command", "owner"]);
    }
  });
});
