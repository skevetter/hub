import { createMemoryDatabase } from "../db/memory.js";
import { interactiveSessionStoreContract } from "./store.contract.js";

interactiveSessionStoreContract("Memory", async ({ organizationId, users }) =>
  createMemoryDatabase({
    memberships: users.map((user) => ({
      ...user,
      organizationId,
      organizationSlug: organizationId,
      organizationName: organizationId,
      membershipId: user.userId + "-membership",
    })),
  }),
);
