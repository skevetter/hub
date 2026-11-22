import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.js";
import { LinearAgentError } from "../providers/linear/agent.js";
import {
  createPilotFollowUp,
  type PilotFollowUpOptions,
  type PilotTurn,
  type SignedPilotPrompted,
} from "./follow-up.js";
import {
  activityPage,
  conversation,
  current,
  currentRow,
  fixtureActivityIds,
  fixturePromptId,
  initialRows,
} from "./test-fixtures.js";

const scope = { ...conversation, teamId: "linear-team" };
const delivered: SignedPilotPrompted = {
  ...scope,
  action: "prompted",
  activityId: current.activityId,
  body: current.body,
  userId: scope.ownerId,
  signal: null,
};

function fixture(state: PilotTurn["state"] = "complete") {
  const turn: PilotTurn = {
    ...scope,
    generation: 1,
    policyRevision: 3,
    hubSessionId: "prior-hub-session",
    profileId: "private-profile",
    profileVersion: 2,
    state,
    preceding: { activityId: fixturePromptId(1), kind: "answer" },
    agentId: "prior-agent",
    daemonTurnId: "prior-daemon-turn",
  };
  const dispatchInitial = vi
    .fn<(prompt: string) => Promise<"started" | "unconfirmed">>()
    .mockResolvedValue("started");
  const options = {
    withSession: async <T>(_scope: typeof scope, run: () => Promise<T>) => run(),
    activityIds: fixtureActivityIds,
    current: vi.fn<PilotFollowUpOptions["current"]>().mockResolvedValue(turn),
    claim: vi.fn<PilotFollowUpOptions["claim"]>().mockResolvedValue("claimed"),
    appendBusy: vi.fn<PilotFollowUpOptions["appendBusy"]>().mockResolvedValue(true),
    readPrompt: vi
      .fn<PilotFollowUpOptions["readPrompt"]>()
      .mockResolvedValue(activityPage([currentRow])),
    readHistory: vi
      .fn<PilotFollowUpOptions["readHistory"]>()
      .mockResolvedValue(activityPage(initialRows)),
    secrets: vi.fn<PilotFollowUpOptions["secrets"]>().mockResolvedValue([]),
    reserve: vi
      .fn<PilotFollowUpOptions["reserve"]>()
      .mockResolvedValue({ hubSessionId: "fresh-hub-session", generation: 2, dispatchInitial }),
    stopCurrent: vi.fn<PilotFollowUpOptions["stopCurrent"]>().mockResolvedValue("stopped"),
  } satisfies PilotFollowUpOptions;
  return { options, turn, dispatchInitial, handle: createPilotFollowUp(options) };
}

describe("Linear pilot follow-up admission", () => {
  it("rejects unrelated input before loading a binding or calling Linear", async () => {
    const f = fixture();
    for (const changed of [
      { action: "created" },
      { applicationId: "other-app" },
      { appUserId: "other-actor" },
      { workspaceId: "other-workspace" },
      { connectionId: "other-connection" },
      { nativeSessionId: "other-session" },
      { issueId: "other-issue" },
      { teamId: "other-team" },
      { userId: "other-owner" },
      { signal: "continue" },
      { body: "   " },
      { activityId: "" },
    ]) {
      expect(await f.handle(scope, { ...delivered, ...changed })).toBe("ignored");
    }
    expect(f.options.current).not.toHaveBeenCalled();
    expect(f.options.claim).not.toHaveBeenCalled();
    expect(f.options.readPrompt).not.toHaveBeenCalled();
    expect(f.options.reserve).not.toHaveBeenCalled();
  });

  it("does not admit against a stale, mismatched or fenced binding", async () => {
    const f = fixture();
    for (const row of [
      undefined,
      { ...f.turn, workspaceId: "other-workspace" },
      { ...f.turn, issueId: "other-issue" },
      { ...f.turn, generation: 0 },
      { ...f.turn, state: "fenced" as const },
    ]) {
      f.options.current.mockResolvedValue(row);
      expect(await f.handle(scope, delivered)).toBe("ignored");
    }
    expect(f.options.claim).not.toHaveBeenCalled();
    expect(f.options.readHistory).not.toHaveBeenCalled();
    expect(f.dispatchInitial).not.toHaveBeenCalled();
  });

  it("does no history read for duplicate receipts, busy turns or unverified prompts", async () => {
    const f = fixture("busy");
    expect(await f.handle(scope, delivered)).toBe("busy");
    expect(f.options.appendBusy).toHaveBeenCalledWith(
      expect.objectContaining({
        activityId: current.activityId,
        ids: fixtureActivityIds(scope.nativeSessionId, current.activityId),
      }),
    );
    f.options.current.mockResolvedValue({ ...f.turn, state: "complete" });
    f.options.claim.mockResolvedValueOnce("duplicate").mockResolvedValueOnce("unconfirmed");
    expect(await f.handle(scope, delivered)).toBe("duplicate");
    expect(await f.handle(scope, delivered)).toBe("unconfirmed");
    expect(f.options.readPrompt).not.toHaveBeenCalled();
    f.options.readPrompt.mockResolvedValue(activityPage([]));
    expect(await f.handle(scope, delivered)).toBe("ignored");
    expect(f.options.readHistory).not.toHaveBeenCalled();
    expect(f.dispatchInitial).not.toHaveBeenCalled();
  });

  it("reserves from exact metadata before handing the only prompt copy to dispatch", async () => {
    const f = fixture();
    expect(await f.handle(scope, delivered)).toBe("started");
    const ids = fixtureActivityIds(scope.nativeSessionId, current.activityId);
    expect(f.options.readHistory).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ activityId: current.activityId }),
      24,
    );
    expect(f.options.reserve).toHaveBeenCalledWith({
      scope,
      turn: f.turn,
      activityId: current.activityId,
      ids,
    });
    expect(f.options.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      f.dispatchInitial.mock.invocationCallOrder[0]!,
    );
    expect(f.dispatchInitial).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("initial application response"),
    );
  });

  it("never starts when reservation or dispatch cannot be proven", async () => {
    const f = fixture();
    f.options.reserve
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("write result lost"))
      .mockResolvedValueOnce({
        hubSessionId: f.turn.hubSessionId,
        generation: 2,
        dispatchInitial: f.dispatchInitial,
      });
    expect(await f.handle(scope, delivered)).toBe("unconfirmed");
    expect(await f.handle(scope, delivered)).toBe("unconfirmed");
    expect(await f.handle(scope, delivered)).toBe("unconfirmed");
    expect(f.dispatchInitial).not.toHaveBeenCalled();
    f.dispatchInitial.mockRejectedValueOnce(new Error("send result lost"));
    expect(await f.handle(scope, delivered)).toBe("unconfirmed");
    expect(f.dispatchInitial).toHaveBeenCalledOnce();
  });

  it.each([
    { error: new TypeError("private-token-canary private-body-canary"), code: "TypeError" },
    { error: new LinearAgentError("policy_required"), code: "policy_required" },
    {
      error: new LinearAgentError("request_failed", 200, {
        linearErrorType: "invalid input",
        linearErrorKinds: ["BAD_USER_INPUT"],
        linearErrorText: "Linear GraphQL invalid activity ID",
      }),
      code: "request_failed",
      status: 200,
    },
    { error: "private-token-canary private-body-canary", code: "unknown_error" },
  ])("logs safe diagnostics for $code", async ({ error, code, status }) => {
    const f = fixture();
    if (error instanceof Error) {
      error.name = "private-name-canary";
      error.message = "private-token-canary private-body-canary";
    }
    f.options.reserve.mockRejectedValueOnce(error);
    const records: string[] = [];
    const logger = createLogger({ write: (record) => records.push(record) });
    const reportFailure = vi.fn((failure) => logger.warn(failure, "Linear pilot delivery failed"));
    const handle = createPilotFollowUp({ ...f.options, reportFailure });

    expect(await handle(scope, delivered)).toBe("unconfirmed");
    const details = error instanceof LinearAgentError ? error.details : undefined;
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith({
      sessionId: scope.nativeSessionId,
      failureCode: code,
      operation: "prompted",
      ...(status === undefined ? {} : { httpStatus: status }),
      ...details,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toContain(`"failureCode":"${code}"`);
    expect(records[0]).toContain('"operation":"prompted"');
    if (status === undefined) {
      expect(records[0]).not.toContain('"httpStatus"');
    } else {
      expect(records[0]).toContain(`"httpStatus":${status}`);
    }
    if (details) expect(JSON.parse(records[0]!)).toMatchObject(details);
    expect(records[0]).not.toMatch(/private-(token|body|name)-canary/u);
  });
});
