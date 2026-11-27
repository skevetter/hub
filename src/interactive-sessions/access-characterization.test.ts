import { describe, expect, it } from "vitest";
import { capabilities } from "./access.js";

describe("session capability rules", () => {
  it("keeps owner, admin, starter and participant rights distinct", () => {
    const session = { organizationId: "a", startedByUserId: "starter" };
    const controller = { userId: "starter", role: "controller" as const };
    const viewer = { userId: "other", role: "viewer" as const };
    const rows = [
      ["a", "starter", "member", "111111"],
      ["a", "other", "member", "100000"],
      ["a", "absent", "member", "000000"],
      ["a", "absent", "owner", "101101"],
      ["a", "other", "admin", "101101"],
      ["b", "starter", "owner", "000000"],
    ] as const;
    for (const [organizationId, userId, role, expected] of rows) {
      const rights = capabilities({ organizationId, userId, role }, session, [controller, viewer]);
      expect(Object.values(rights).map(Number).join("")).toBe(expected);
    }
  });

  it("requires a Linear requester identity and an owner who started the session", () => {
    const session = { organizationId: "a", startedByUserId: "starter", origin: "linear" } as const;
    const rows = [
      ["owner", "identity", "controller", "110000"],
      ["owner", "identity", "viewer", "100000"],
      ["owner", null, "controller", "000000"],
      ["owner", "", "controller", "000000"],
      ["admin", "identity", "controller", "000000"],
      ["member", "identity", "controller", "000000"],
    ] as const;
    for (const [role, requesterIdentityId, participantRole, expected] of rows) {
      const rights = capabilities(
        { organizationId: "a", userId: "starter", role },
        { ...session, requesterIdentityId },
        [{ userId: "starter", role: participantRole }],
      );
      expect(Object.values(rights).map(Number).join("")).toBe(expected);
    }
  });
});
