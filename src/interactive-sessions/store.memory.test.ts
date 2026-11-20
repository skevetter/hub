import { createMemoryDatabase } from "../db/memory.js";
import { interactiveSessionStoreContract } from "./store.contract.js";

interactiveSessionStoreContract("Memory", async ({ organizationId, users }, now) => {
  let clock = now;
  const database = createMemoryDatabase({
    now: () => clock,
    memberships: users.map((user) => ({
      ...user,
      organizationId,
      organizationSlug: organizationId,
      organizationName: organizationId,
      membershipId: user.userId + "-membership",
    })),
  });
  return {
    database,
    async expireLease(command) {
      clock = new Date(command.claimExpiresAt!.getTime() + 1);
    },
    async readAudit(sessionId) {
      return database
        .listInteractiveSessionAuditEvents(organizationId, sessionId)
        .map(({ action, actorIdentity, evidence }) => ({ action, actorIdentity, evidence }));
    },
  };
});
