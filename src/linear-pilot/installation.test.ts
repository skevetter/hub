import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { QueryHandle } from "../db/runtime/index.js";
import type { LinearPilotConfig } from "./config.js";
import { qualifyLinearPilotDelivery, resolveLinearPilotInstallation } from "./installation.js";
import { createdPayload, objectAt } from "./test-utils/intake-fixtures.js";

const config: LinearPilotConfig = {
  hubOrganizationId: "hub-organization",
  linearOrganizationId: "linear-workspace",
  allowedHumanId: "linear-human",
  profileId: "32624952-2c32-4b06-92a4-fc6e6c9f224d",
};
const app = "registered-app";
const metadata = {
  connectionId: "46f932bf-a23e-423e-b5d2-b3a1067794e2",
  organizationId: config.hubOrganizationId,
  workspaceId: config.linearOrganizationId,
  applicationId: app,
  appUserId: "installed-app-user",
  ownerUserId: "hub-owner",
  profileVersion: 3,
};

function createdDelivery() {
  const payload = createdPayload();
  payload["organizationId"] = config.linearOrganizationId;
  payload["oauthClientId"] = app;
  payload["appUserId"] = metadata.appUserId;
  const session = objectAt(payload, "agentSession");
  session["id"] = "AC897CAB-5D7F-4EB4-B10A-3998B9C437AA";
  session["organizationId"] = config.linearOrganizationId;
  session["appUserId"] = metadata.appUserId;
  session["creatorId"] = config.allowedHumanId;
  objectAt(session, "creator")["id"] = config.allowedHumanId;
  objectAt(session, "comment")["userId"] = config.allowedHumanId;
  return payload;
}

describe("Linear pilot installation lookup", () => {
  it("reads only installation and owner metadata for the configured workspace and registered app", async () => {
    const db: QueryHandle = { query: async () => ({ rows: [], rowCount: 0 }) };
    vi.spyOn(db, "query").mockImplementation(async (sql, params) => {
      assert.deepEqual(params, [
        config.hubOrganizationId,
        config.linearOrganizationId,
        app,
        config.profileId,
        config.allowedHumanId,
      ]);
      assert.match(sql, /profile\.access = 'private'/u);
      assert.match(sql, /owner\.role = 'owner'/u);
      assert.match(sql, /not exists\s*\(/iu);
      assert.doesNotMatch(sql, /\b(?:access_token|refresh_token|scopes|linear_template)\b/u);
      return { rows: [metadata], rowCount: 1 };
    });

    assert.deepEqual(await resolveLinearPilotInstallation(db, config, app), {
      ...metadata,
      oauthClientId: app,
    });
  });

  it("returns no installation when current owner, profile, or app authority is absent", async () => {
    const db: QueryHandle = { query: async () => ({ rows: [], rowCount: 0 }) };

    assert.equal(await resolveLinearPilotInstallation(db, config, app), undefined);
  });

  it("rejects the wrong signed workspace or human before resolving even installation metadata", async () => {
    const db: QueryHandle = { query: async () => assert.fail("called the installation resolver") };
    const workspace = { ...createdDelivery(), organizationId: "other-workspace" };
    const human = createdDelivery();
    objectAt(human, "agentSession")["creatorId"] = "other-human";

    assert.equal(await qualifyLinearPilotDelivery(db, config, app, workspace), undefined);
    assert.equal(await qualifyLinearPilotDelivery(db, config, app, human), undefined);
  });

  it("requires corroborated signed owner evidence and returns the current installation and canonical session", async () => {
    const db: QueryHandle = { query: async () => ({ rows: [], rowCount: 0 }) };
    vi.spyOn(db, "query").mockResolvedValue({ rows: [metadata], rowCount: 1 });
    const qualified = await qualifyLinearPilotDelivery(db, config, app, createdDelivery());
    assert(qualified);
    assert.equal(qualified.installation.ownerUserId, metadata.ownerUserId);
    assert.equal(qualified.event.nativeSessionId, "ac897cab-5d7f-4eb4-b10a-3998b9c437aa");
    assert.equal(qualified.event.teamId, "team-77e1");

    const unproven = createdDelivery();
    objectAt(objectAt(unproven, "agentSession"), "comment")["userId"] = "automation";
    assert.equal(await qualifyLinearPilotDelivery(db, config, app, unproven), undefined);
  });
});
