import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearAgentClient, LinearAgentError } from "../providers/linear/agent.js";
import {
  completePage,
  linearAgentBinding,
  linearAgentConnection,
  linearAgentFixture,
} from "../providers/linear/test-utils/agent.js";
import { formatRunReply } from "../run-replies/format.js";
import {
  createLinearPilotActivities,
  pilotActivityIds,
  type LinearPilotAcceptedEvent,
} from "./activities.js";

const now = 1_700_000_000_000;
const binding = linearAgentBinding(linearAgentConnection("pilot"));
const created = {
  decision: "accepted",
  kind: "created",
  binding,
  nativeSessionId: "2138c045-6eb6-4cde-a191-84d4bdee87cd",
  interactionId: "initial",
  receivedAt: now,
  actorProviderUserId: "linear-owner",
  allowedHumanProviderUserId: "linear-owner",
  publishAnswer: true,
} as const satisfies LinearPilotAcceptedEvent;
const prompted = { ...created, kind: "prompted", interactionId: "prompt-1" } as const;
const busyPrompt = { ...prompted, interactionId: "busy-prompt" };
const stop = { ...prompted, kind: "stop" } as const;
const answer = { text: "Done.", truncated: false };

function fixture() {
  const createActivity = vi.fn(async (input: { activityId: string }, _signal?: AbortSignal) => {
    return input.activityId;
  });
  const isActivityConfirmed = vi.fn(async (_input: unknown, _signal?: AbortSignal) => false);
  const clientFor = vi.fn(() => ({ createActivity, isActivityConfirmed }));
  const newWriter = () => createLinearPilotActivities({ clientFor, now: () => now });
  return { ...newWriter(), newWriter, clientFor, createActivity, isActivityConfirmed };
}

type Writer = ReturnType<typeof fixture>;
const writes = [
  {
    name: "ACK",
    kind: "thought",
    run: (w: Writer, attempt: "first-attempt" | "readback-only") => w.acknowledge(created, attempt),
  },
  {
    name: "response",
    kind: "response",
    run: (w: Writer, attempt: "first-attempt" | "readback-only") =>
      w.respond(prompted, attempt, answer, []),
  },
  {
    name: "error",
    kind: "error",
    run: (w: Writer, attempt: "first-attempt" | "readback-only") => w.error(prompted, attempt),
  },
  {
    name: "continuation refusal",
    kind: "error",
    run: (w: Writer, attempt: "first-attempt" | "readback-only") =>
      w.error(prompted, attempt, undefined, "continuation"),
  },
  {
    name: "Stop",
    kind: "response",
    run: (w: Writer, attempt: "first-attempt" | "readback-only") =>
      w.stop(stop, attempt, "confirmed"),
  },
  {
    name: "unconfirmed Stop",
    kind: "error",
    run: (w: Writer, attempt: "first-attempt" | "readback-only") =>
      w.stop(stop, attempt, "unconfirmed"),
  },
  {
    name: "busy reply",
    kind: "response",
    signal: "continue",
    run: (w: Writer, attempt: "first-attempt" | "readback-only") => w.busy(busyPrompt, attempt),
  },
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("pilot activities", () => {
  it("uses a deterministic public refusal only on the exclusive attempt", async () => {
    const w = fixture();
    const event = { ...created, interactionId: created.nativeSessionId };
    const refusal = await w.refuseDelegation(event);
    expect(refusal).toMatchObject({ activityId: "b3b15181-944e-4a14-923f-786fb8ec8433" });
    expect(w.createActivity.mock.calls[0]?.[0]).toMatchObject({
      publicBody: true,
      content: {
        type: "error",
        body: "Paseo could not confirm who started this. Mention @paseo in a comment instead.",
      },
    });
  });

  it.each(writes)(
    "$name reads an uncertain append once; a replay or restart miss cannot append",
    async (testCase) => {
      const { run, kind } = testCase;
      const w = fixture();
      w.createActivity.mockRejectedValueOnce(new LinearAgentError("mutation_unconfirmed"));
      const missed = await run(w, "first-attempt");
      expect(missed.disposition).toBe("unconfirmed");
      if (testCase.name === "response") {
        expect(w.createActivity.mock.calls[0]?.[0]).not.toHaveProperty("publicBody");
      } else {
        expect(w.createActivity.mock.calls[0]?.[0]).toHaveProperty("publicBody", true);
      }
      expect(w.isActivityConfirmed).toHaveBeenCalledWith(
        {
          sessionId: created.nativeSessionId,
          activityId: missed.activityId,
          kind,
          ...("signal" in testCase ? { signal: testCase.signal } : {}),
        },
        expect.any(AbortSignal),
      );
      expect((await run(w, "first-attempt")).disposition).toBe("already-claimed");
      expect(w.isActivityConfirmed).toHaveBeenCalledTimes(1);
      const restarted = { ...w, ...w.newWriter() };
      expect(await run(restarted, "readback-only")).toEqual(missed);
      expect(w.createActivity).toHaveBeenCalledTimes(1);
      expect(w.isActivityConfirmed).toHaveBeenCalledTimes(2);
    },
  );

  it("uses deterministic UUIDv4 vectors with session and exact interaction scope", async () => {
    const w = fixture();
    const ack = await w.acknowledge(created, "first-attempt");
    const terminal = await w.error(prompted, "first-attempt");
    const stopped = await w.newWriter().stop(stop, "readback-only", "confirmed");
    expect(ack.activityId).toBe("e27e05f1-2df9-48d9-bcd1-f62989048b85");
    expect(terminal.activityId).toBe("3a50c1da-e094-4d87-8ecc-184ee3ce95e7");
    expect(stopped.activityId).toBe("d02058c6-64cc-4aca-8619-7a715e355129");
    const ids = pilotActivityIds(prompted.nativeSessionId, prompted.interactionId);
    expect(ids.busy).toBe("36555de3-d9cc-4d56-902e-f2e55a307275");
    const all = [ack.activityId, ...Object.values(ids)];
    expect(new Set(all).size).toBe(4);
    for (const id of all) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab]/u);
    const otherIds = pilotActivityIds(prompted.nativeSessionId, "prompt-2");
    expect(otherIds.busy).not.toBe(ids.busy);
    expect(otherIds.response).not.toBe(ids.response);
    expect(otherIds.stop).not.toBe(ids.stop);
    expect(
      (
        await w
          .newWriter()
          .acknowledge({ ...created, interactionId: "other-initial" }, "readback-only")
      ).activityId,
    ).toBe(ack.activityId);
    expect(ids.response).toBe(terminal.activityId);
    expect(ids.stop).toBe(stopped.activityId);
    const alternate = await w.newWriter().respond(prompted, "readback-only", undefined, []);
    expect(alternate.activityId).toBe(terminal.activityId);
    const otherSession = await w.acknowledge(
      { ...created, nativeSessionId: "other-session" },
      "readback-only",
    );
    expect(otherSession.activityId).not.toBe(ack.activityId);
  });

  it("confirms only the requested activity; a wrong mutation ID requires exact readback", async () => {
    const w = fixture();
    w.createActivity.mockResolvedValueOnce("different-id");
    w.isActivityConfirmed.mockResolvedValueOnce(true);
    const result = await w.respond(prompted, "first-attempt", answer, []);
    expect(result).toMatchObject({ disposition: "confirmed", via: "readback" });
    expect(w.isActivityConfirmed).toHaveBeenCalledExactlyOnceWith(
      { sessionId: prompted.nativeSessionId, activityId: result.activityId, kind: "response" },
      expect.any(AbortSignal),
    );
  });

  it("first activity is a non-ephemeral fixed thought; ACK must be confirmed within ten seconds", async () => {
    vi.useFakeTimers({ now });
    const w = fixture();
    const writer = createLinearPilotActivities({ clientFor: w.clientFor });
    const completion = Promise.withResolvers<string>();
    w.createActivity.mockReturnValueOnce(completion.promise);
    const pending = writer.acknowledge(created, "first-attempt");
    expect(w.createActivity.mock.calls[0]?.[0]).toMatchObject({
      sessionId: created.nativeSessionId,
      content: { type: "thought", body: "Paseo Hub received your request." },
      ephemeral: false,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(w.createActivity.mock.calls[0]?.[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).disposition).toBe("expired");
    expect(w.createActivity.mock.calls[0]?.[1]?.aborted).toBe(true);
    completion.resolve(w.createActivity.mock.calls[0]![0].activityId);
    expect((await writer.acknowledge(created, "readback-only")).disposition).toBe("expired");
    expect(w.isActivityConfirmed).not.toHaveBeenCalled();
  });

  it("confirms an ACK before the deadline using only the remainder of the receipt budget", async () => {
    vi.useFakeTimers({ now: now + 9_997 });
    const w = fixture();
    const writer = createLinearPilotActivities({ clientFor: w.clientFor });
    const completion = Promise.withResolvers<string>();
    w.createActivity.mockReturnValueOnce(completion.promise);
    const pending = writer.acknowledge(created, "first-attempt");
    await vi.advanceTimersByTimeAsync(2);
    completion.resolve(w.createActivity.mock.calls[0]![0].activityId);
    expect(await pending).toMatchObject({ disposition: "confirmed", via: "mutation" });
    expect(w.isActivityConfirmed).not.toHaveBeenCalled();
  });

  it("does no provider work for the wrong event kind, a non-owner error, or a prior abort", async () => {
    const w = fixture();
    const foreign = { ...prompted, actorProviderUserId: "foreign" };
    const unaccepted = { ...created };
    Reflect.set(unaccepted, "decision", "receipt-only");
    expect((await w.acknowledge(unaccepted, "first-attempt")).disposition).toBe("denied");
    expect((await w.acknowledge(prompted, "first-attempt")).disposition).toBe("denied");
    expect((await w.error(foreign, "first-attempt")).disposition).toBe("denied");
    expect(
      (
        await w.stop(
          { ...stop, actorProviderUserId: foreign.actorProviderUserId },
          "first-attempt",
          "unconfirmed",
        )
      ).disposition,
    ).toBe("denied");
    expect(
      (await w.respond(prompted, "first-attempt", answer, [], AbortSignal.abort())).disposition,
    ).toBe("cancelled");
    expect(w.clientFor).not.toHaveBeenCalled();
  });

  it("stops locally when L1 denies current policy or provider access", async () => {
    const w = fixture();
    w.createActivity.mockRejectedValueOnce(new LinearAgentError("policy_required"));
    expect((await w.error(prompted, "first-attempt")).disposition).toBe("denied");
    expect(w.isActivityConfirmed).not.toHaveBeenCalled();
    expect(w.createActivity).toHaveBeenCalledTimes(1);
  });

  it("passes one UUIDv4 to L1 for append and exact readback under current installation authority", async () => {
    const expected = "e27e05f1-2df9-48d9-bcd1-f62989048b85";
    const sessionId = created.nativeSessionId;
    const provider = linearAgentFixture((operation, call) => {
      if (operation === "PaseoAgentActivityCreate") {
        expect(call.variables).toMatchObject({
          input: { agentSessionId: sessionId, id: expected },
        });
        return { errors: [{ message: "synthetic uncertainty" }] };
      }
      expect(operation).toBe("PaseoAgentActivityReadback");
      expect(call.variables).toEqual({ sessionId, activityId: expected });
      const appUser = { id: provider.a.appUserId };
      return {
        data: {
          agentSession: {
            id: sessionId,
            appUser,
            activities: {
              pageInfo: completePage,
              nodes: [
                {
                  id: expected,
                  agentSession: { id: sessionId },
                  user: appUser,
                  content: { __typename: "AgentActivityThoughtContent", type: "thought" },
                },
              ],
            },
          },
        },
      };
    });
    const accepted = { ...created, binding: linearAgentBinding(provider.a) };
    const isAuthorized: Parameters<typeof createLinearAgentClient>[0]["authorize"] = async (
      currentBinding,
      operation,
      signal,
    ) =>
      currentBinding.id === accepted.binding.id &&
      currentBinding.appUserId === accepted.binding.appUserId &&
      currentBinding.linearOrganizationId === accepted.binding.linearOrganizationId &&
      (operation.kind === "createActivity" || operation.kind === "readActivity") &&
      operation.sessionId === sessionId &&
      !signal.aborted;
    const clientFor = (event: LinearPilotAcceptedEvent) => {
      const options = {
        ...provider.options,
        binding: event.binding,
        authorize: isAuthorized,
        pilotOperations: true as const,
      };
      return createLinearAgentClient(options);
    };
    const writer = createLinearPilotActivities({ clientFor, now: () => now });
    expect(await writer.acknowledge(accepted, "first-attempt")).toEqual({
      disposition: "confirmed",
      via: "readback",
      activityId: expected,
    });
    expect(provider.calls.map(({ query }) => query.split("(", 1)[0]?.split(" ", 2)[1])).toEqual([
      "PaseoAgentViewer",
      "PaseoAgentActivityCreate",
      "PaseoAgentViewer",
      "PaseoAgentActivityReadback",
    ]);
    expect(provider.calls.every(({ bearer }) => bearer === "Bearer fake-access-a")).toBe(true);
  });

  it("L1 revocation after the viewer lookup prevents the mutation and readback", async () => {
    const provider = linearAgentFixture();
    const accepted = { ...created, binding: linearAgentBinding(provider.a) };
    const writer = createLinearPilotActivities({
      now: () => now,
      clientFor: (event) => {
        const options = {
          ...provider.options,
          binding: event.binding,
          authorize: async () => provider.calls.length === 0,
          pilotOperations: true as const,
        };
        return createLinearAgentClient(options);
      },
    });
    expect((await writer.acknowledge(accepted, "first-attempt")).disposition).toBe("denied");
    expect(provider.calls.map(({ query }) => query)).toEqual([
      expect.stringContaining("PaseoAgentViewer"),
    ]);
  });

  it("an uncertain terminal fences normal, error and Stop output for the exact interaction", async () => {
    const w = fixture();
    const completion = Promise.withResolvers<string>();
    w.createActivity.mockReturnValueOnce(completion.promise);
    const first = w.respond(prompted, "first-attempt", answer, []);
    expect((await w.error(prompted, "first-attempt")).disposition).toBe("already-claimed");
    expect((await w.stop(stop, "first-attempt", "confirmed")).disposition).toBe("already-claimed");
    const next = await w.stop({ ...stop, interactionId: "prompt-2" }, "first-attempt", "confirmed");
    expect(next.disposition).toBe("confirmed");
    completion.reject(new Error("synthetic lost response"));
    expect((await first).disposition).toBe("unconfirmed");
    expect(w.createActivity).toHaveBeenCalledTimes(2);
  });

  it("publishes one fixed busy response for the new prompt without taking the active turn's terminal slot", async () => {
    const w = fixture();
    const completion = Promise.withResolvers<string>();
    w.createActivity.mockReturnValueOnce(completion.promise);
    const active = w.respond(prompted, "first-attempt", answer, []);
    const busy = await w.busy(busyPrompt, "first-attempt");
    expect(busy.disposition).toBe("confirmed");
    expect(busy.activityId).toBe("ba530874-8c8c-4481-9042-e51d86eebf69");
    expect(busy.activityId).toBe(
      pilotActivityIds(busyPrompt.nativeSessionId, busyPrompt.interactionId).busy,
    );
    expect(busy.activityId).not.toBe(w.createActivity.mock.calls[0]?.[0].activityId);
    expect(w.createActivity.mock.calls[0]?.[0]).not.toHaveProperty("signal");
    expect(w.createActivity.mock.calls[1]?.[0]).toMatchObject({
      signal: "continue",
      content: {
        type: "response",
        body: "Still working on the previous message; reply when I have answered.",
      },
    });
    expect((await w.respond(busyPrompt, "first-attempt", answer, [])).disposition).toBe(
      "already-claimed",
    );
    expect(
      (await w.busy({ ...busyPrompt, actorProviderUserId: "other-human" }, "first-attempt"))
        .disposition,
    ).toBe("denied");
    completion.resolve(w.createActivity.mock.calls[0]![0].activityId);
    expect((await active).disposition).toBe("confirmed");
    expect(w.createActivity).toHaveBeenCalledTimes(2);
  });

  it("says Stopped only for confirmed disengagement of the targeted interaction", async () => {
    const w = fixture();
    await w.stop(stop, "first-attempt", "unconfirmed");
    expect((await w.stop(stop, "first-attempt", "confirmed")).disposition).toBe("already-claimed");
    await w.stop({ ...stop, interactionId: "exact-stopped-target" }, "first-attempt", "confirmed");
    expect(w.createActivity.mock.calls.map(([input]) => input)).toMatchObject([
      { content: { type: "error", body: "Stop requested; I could not confirm it stopped" } },
      { content: { type: "response", body: "Stopped." } },
    ]);
  });

  it("uses P12 Markdown and credential sanitization verbatim, and keeps disabled answers private", async () => {
    const w = fixture();
    const secrets = ["hardwired.test.credential"];
    const raw = {
      text: "| A | B |\n| - | - |\n| One | Two |\n\n```sh\necho hello\n```\n\n@someone hardwired.test.credential lin_oauth_fakesynthetic",
      truncated: false,
    };
    await w.respond(prompted, "first-attempt", raw, secrets);
    expect(w.createActivity.mock.calls[0]?.[0]).toMatchObject({
      content: { type: "response", body: formatRunReply(raw, secrets) },
    });
    expect(JSON.stringify(w.createActivity.mock.calls[0]?.[0])).not.toMatch(
      /hardwired\.test\.credential|lin_oauth_fakesynthetic/u,
    );
    await w.respond(
      { ...prompted, interactionId: "private", publishAnswer: false },
      "first-attempt",
      raw,
      secrets,
    );
    expect(w.createActivity.mock.calls[1]?.[0]).toMatchObject({
      content: { type: "response", body: "Work finished. No answer was posted." },
      publicBody: true,
    });
  });

  it("publishes only fixed safe text for empty or unavailable exact answers", async () => {
    const w = fixture();
    const empty = { text: "  ", truncated: false };
    for (const [i, value] of [empty, undefined].entries()) {
      const event = { ...prompted, interactionId: `missing-${i}` };
      expect((await w.respond(event, "first-attempt", value, [])).disposition).toBe("confirmed");
    }
    expect(w.createActivity.mock.calls.map(([input]) => input)).toMatchObject([
      { content: { type: "response", body: "Work finished. No answer was posted." } },
      { content: { type: "response", body: "Work finished. No answer was posted." } },
    ]);
  });

  it("bounds the local claim backlog and accepts new work after expired claims are dropped", async () => {
    const w = fixture();
    let time = now;
    const writer = createLinearPilotActivities({ clientFor: w.clientFor, now: () => time });
    for (let i = 0; i < 2_048; i++) {
      await writer.error({ ...prompted, interactionId: `backlog-${i}` }, "first-attempt");
    }
    expect((await writer.error(prompted, "first-attempt")).disposition).toBe("capacity");
    expect(w.createActivity).toHaveBeenCalledTimes(2_048);
    time += 60_000;
    expect((await writer.error(prompted, "first-attempt")).disposition).toBe("confirmed");
    expect(w.createActivity).toHaveBeenCalledTimes(2_049);
    expect(w.isActivityConfirmed).not.toHaveBeenCalled();
  });

  it("fences 2,000 deterministic ambiguous, unauthorized, and restarted deliveries", async () => {
    const w = fixture();
    let eligible = 0;
    let appendAttempts = 0;
    let duplicateSuppressions = 0;
    for (let i = 0; i < 2_000; i++) {
      const receivedAt = i % 5 ? now : now - 10_000;
      const knownOwner = i % 7 !== 0;
      const event = {
        ...created,
        nativeSessionId: `generated-session-${i}`,
        interactionId: `generated-interaction-${i}`,
        receivedAt,
        actorProviderUserId: knownOwner ? created.allowedHumanProviderUserId : "non-owner",
      };
      const firstAttempt = i % 3 !== 0;
      const writeError = i % 2 === 0;
      const run = (
        writer: Pick<Writer, "error" | "acknowledge">,
        mode: "first-attempt" | "readback-only",
      ) => (writeError ? writer.error(event, mode) : writer.acknowledge(event, mode));
      if (writeError ? !knownOwner : receivedAt !== now) {
        await run(w, firstAttempt ? "first-attempt" : "readback-only");
        continue;
      }
      eligible++;
      if (firstAttempt) {
        appendAttempts++;
        w.createActivity.mockRejectedValueOnce(new LinearAgentError("mutation_unconfirmed"));
      }
      const result = await run(w, firstAttempt ? "first-attempt" : "readback-only");
      expect(result.disposition).toBe("unconfirmed");
      if (firstAttempt) {
        const duplicate = await run(w, "first-attempt");
        if (duplicate.disposition === "already-claimed") duplicateSuppressions++;
      }
      expect(await run(w.newWriter(), "readback-only")).toEqual(result);
    }
    expect(duplicateSuppressions).toBe(appendAttempts);
    expect(w.createActivity).toHaveBeenCalledTimes(appendAttempts);
    expect(w.isActivityConfirmed).toHaveBeenCalledTimes(eligible * 2);
  });
});
