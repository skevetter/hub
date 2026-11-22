import { createMemoryDatabase } from "../db/memory.js";
import { surfaceStoreContract, surfaceTestTime } from "./store.contract.js";

surfaceStoreContract("Memory", async (tenants) => {
  const database = createMemoryDatabase({
    now: () => surfaceTestTime,
    linearConnections: tenants.map(({ connection }) => connection),
    memberships: tenants.flatMap(({ organizationId, userId }) =>
      [
        { userId, role: "owner" as const },
        { userId: userId + "-member", role: "member" as const },
      ].map((member) => ({
        userId: member.userId,
        role: member.role,
        organizationId,
        organizationSlug: organizationId,
        organizationName: organizationId,
        membershipId: member.userId + "-membership",
      })),
    ),
  });
  return {
    database,
    removeMember: ({ organizationId, userId }) =>
      database.removeMemoryMember(organizationId, userId),
    removeConnection: ({ organizationId, connection }) =>
      database.removeLinearConnection(organizationId, connection.id),
    restoreConnection: ({ connection }) => database.setLinearConnection(connection),
  };
});
