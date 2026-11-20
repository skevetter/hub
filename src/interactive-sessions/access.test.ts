import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "vitest";

it("capabilities: starter and admins may stop, only controllers may send, non-participant members may not view", async () => {
  const { capabilities } = await import("./access.js");
  const organizationId = "org";
  const session = { id: randomUUID(), organizationId, startedByUserId: "starter" };
  const participants = [
    { userId: "controller", role: "controller" as const },
    { userId: "viewer", role: "viewer" as const },
  ];
  const rights = (
    userId: string,
    role: "owner" | "admin" | "member" = "member",
    org = organizationId,
  ) => capabilities({ organizationId: org, userId, role }, session, participants);
  assert.equal(rights("starter").stop, true);
  assert.equal(rights("starter").view, false);
  assert.equal(rights("starter").send, false);
  assert.equal(rights("admin", "admin").stop, true);
  assert.equal(rights("admin", "admin").send, false);
  assert.equal(rights("owner", "owner").view, true);
  assert.equal(rights("controller").send, true);
  assert.equal(rights("controller").stop, false);
  assert.equal(rights("viewer").view, true);
  assert.equal(rights("viewer").send, false);
  assert.equal(rights("outsider").view, false);
  assert.equal(rights("admin", "admin", "foreign").view, false);
});
