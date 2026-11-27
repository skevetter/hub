import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { DeploymentProjects } from "./index.js";

describe("deployment projects when another writer takes the slug first", () => {
  it("resolves to the project that won instead of failing", async () => {
    const database = createMemoryDatabase({ organizationIds: ["org"] });
    const winner = await database.createProject({
      organizationId: "org",
      name: "default",
      slug: "default",
      createdByUserId: null,
    });
    const missedLookups = { remaining: 2 };
    const lookup = database.findProjectBySlugForOrganization.bind(database);
    database.findProjectBySlugForOrganization = (organizationId, slug) => {
      if (missedLookups.remaining <= 0) return lookup(organizationId, slug);
      missedLookups.remaining -= 1;
      return Promise.resolve(undefined);
    };

    const result = await new DeploymentProjects(database).resolve({
      organizationId: "org",
      dryRun: false,
    });

    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    assert.equal(result.project.id, winner.id);
    assert.equal(result.created, false);
  });
});
