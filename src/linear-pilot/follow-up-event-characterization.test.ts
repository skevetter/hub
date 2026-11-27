import { describe, it, expect } from "vitest";
import { adaptSignedPilotFollowUp } from "./follow-up-event.js";
import type { LinearPilotEvent } from "./intake.js";

const installation = {
  connectionId: "connection",
  organizationId: "org",
  workspaceId: "workspace",
  applicationId: "application",
  appUserId: "app",
};
const event = {
  kind: "prompted",
  activityId: "6A2FEE92-6464-41B9-9EE8-1999C7655DF7",
  workspaceId: "workspace",
  applicationId: "application",
  appUserId: "app",
  nativeSessionId: "session",
  humanId: "owner",
  issueId: "issue",
  teamId: "team",
  message: "",
} satisfies LinearPilotEvent;
const adapted = {
  action: "prompted",
  activityId: event.activityId.toLowerCase(),
  organizationId: "org",
  workspaceId: "workspace",
  applicationId: "application",
  appUserId: "app",
  connectionId: "connection",
  nativeSessionId: "session",
  issueId: "issue",
  teamId: "team",
  userId: "owner",
};

describe("signed follow-up transport", () => {
  it("preserves empty prompt strings and the Stop timestamp", () => {
    expect(adaptSignedPilotFollowUp(event, installation)).toEqual({
      ...adapted,
      body: "",
      signal: null,
    });
    const stop = { ...event, kind: "stop", stopCreatedAtMs: 0 } satisfies LinearPilotEvent;
    expect(adaptSignedPilotFollowUp(stop, installation)).toEqual({
      ...adapted,
      createdAt: "1970-01-01T00:00:00.000Z",
      body: null,
      signal: "stop",
    });
  });

  it("rejects invalid scope, missing bodies and unusable dates", () => {
    const { message: _message, ...withoutMessage } = event;
    const cases: LinearPilotEvent[] = [
      { ...event, kind: "created" },
      { ...event, activityId: "not-uuid" },
      { ...event, teamId: "" },
      { ...event, workspaceId: "other" },
      { ...event, applicationId: "other" },
      { ...event, appUserId: "other" },
      withoutMessage,
      { ...event, kind: "stop" },
      { ...event, kind: "stop", stopCreatedAtMs: Number.MAX_SAFE_INTEGER },
    ];
    for (const input of cases)
      expect(adaptSignedPilotFollowUp(input, installation)).toBeUndefined();
  });
});
