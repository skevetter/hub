import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { PilotConnection } from "./binding.js";
import { adaptSignedPilotFollowUp } from "./follow-up-event.js";
import type { LinearPilotEvent } from "./intake.js";

const installation: PilotConnection = {
  connectionId: "connection",
  organizationId: "hub-org",
  workspaceId: "workspace",
  applicationId: "app",
  appUserId: "app-user",
};
const event = {
  kind: "stop",
  workspaceId: installation.workspaceId,
  applicationId: installation.applicationId,
  appUserId: installation.appUserId,
  nativeSessionId: "native-session",
  humanId: "owner",
  issueId: "issue",
  teamId: "team",
  activityId: "6A2FEE92-6464-41B9-9EE8-1999C7655DF7",
} satisfies LinearPilotEvent;
const createdAt = "2026-11-21T22:30:00.000Z";

describe("signed pilot follow-up adapter", () => {
  it("carries the signed Stop activity timestamp and canonical activity ID", () => {
    const adapted = adaptSignedPilotFollowUp(
      { ...event, stopCreatedAtMs: Date.parse(createdAt) },
      installation,
    );
    assert.equal(adapted?.createdAt, createdAt);
    assert.equal(adapted?.activityId, event.activityId.toLowerCase());
    assert.equal(adapted?.body, null);
    assert.equal(adapted?.signal, "stop");
  });

  it("refuses a Stop without usable time evidence or an exact installation", () => {
    assert.equal(adaptSignedPilotFollowUp(event, installation), undefined);
    assert.equal(
      adaptSignedPilotFollowUp(
        { ...event, stopCreatedAtMs: Number.MAX_SAFE_INTEGER },
        installation,
      ),
      undefined,
    );
    assert.equal(
      adaptSignedPilotFollowUp(
        { ...event, stopCreatedAtMs: Date.parse(createdAt) },
        {
          ...installation,
          appUserId: "different-app-user",
        },
      ),
      undefined,
    );
  });

  it("carries a verified prompt without a Stop timestamp", () => {
    const prompt: LinearPilotEvent = { ...event, kind: "prompted", message: "follow up" };
    const adapted = adaptSignedPilotFollowUp(prompt, installation);
    assert.equal(adapted?.signal, null);
    assert.equal(adapted?.createdAt, undefined);
    assert.equal(adapted?.body, "follow up");
  });
});
