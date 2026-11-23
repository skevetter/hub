import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyLinearPilotCompanionComment,
  MAX_PILOT_PARSE_CHARS,
  MAX_PILOT_MESSAGE_CHARS,
  precheckLinearPilotScope,
  verifyLinearPilotIntake,
  type DelegationFallback,
  type LinearPilotIntakeResult,
  type LinearPilotRefusal,
} from "./intake.js";
import {
  clone,
  createdPayload,
  INSTALLATION,
  mutate,
  objectAt as objectAtPath,
  pick,
  PILOT_CONFIG,
  promptedPayload,
  randomId,
  REPLAY_SEED,
  rng,
  stopPayload,
  type Json,
  type JsonObject,
} from "./test-utils/intake-fixtures.js";

function intake(payload: unknown, installation = INSTALLATION, config = PILOT_CONFIG) {
  return verifyLinearPilotIntake({ config, installation, payload });
}

function refused(payload: unknown): LinearPilotRefusal {
  const result = intake(payload);
  if (result.ok) throw new Error("expected refusal");
  return result.reason;
}

function accepted(payload: unknown) {
  const result = intake(payload);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}`);
  return result.event;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyLinearPilotIntake created", () => {
  it("accepts an owner mention with corroborated signed evidence and returns only ids and text", () => {
    expect(accepted(createdPayload())).toEqual({
      kind: "created",
      workspaceId: "lin-org-91c2",
      applicationId: "app-record-52ab",
      appUserId: "app-user-e077",
      nativeSessionId: "session-c0de",
      humanId: "human-owner-4d18",
      issueId: "issue-a1b2",
      teamId: "team-77e1",
      message: "@paseo check the flaky export",
    });
  });

  it("ignores extension fields instead of copying them into the event", () => {
    const body = { ...createdPayload(), promptContext: "<issue>SECRET-CONTEXT</issue>" };
    expect(JSON.stringify(accepted(body))).not.toContain("SECRET-CONTEXT");
  });

  it("refuses a missing or non-owner creator even with an unproven comment", () => {
    const session = ["agentSession"];
    const payload = mutate(createdPayload(), [...session, "comment", "userId"], null);
    expect(refused(mutate(payload, [...session, "creatorId"], null))).toBe("missing_creator");
    expect(refused(mutate(payload, [...session, "creatorId"], undefined))).toBe("missing_creator");
    expect(refused(mutate(payload, [...session, "creatorId"], "human-other-0001"))).toBe(
      "not_owner",
    );
  });

  it("requires readback for a comment-less owner start and refuses other creators", () => {
    const s = ["agentSession"];
    for (const absent of [undefined, null]) {
      let payload = createdPayload();
      for (const key of ["comment", "commentId", "sourceCommentId"]) {
        payload = mutate(payload, [...s, key], absent);
      }
      expect(accepted(payload)).toMatchObject({ kind: "created", pendingDelegation: true });
      expect(accepted(payload)).not.toHaveProperty("message");
      expect(accepted(payload)).not.toHaveProperty("delegationFallback");
      const other = mutate(payload, [...s, "creatorId"], "other-human");
      expect(precheckLinearPilotScope({ config: PILOT_CONFIG, payload: other })).toEqual({
        ok: false,
        reason: "not_owner",
      });
      expect(refused(other)).toBe("not_owner");
      expect(refused(mutate(payload, [...s, "issue"], absent))).toBe("malformed");
    }
  });

  it.each<[string[], Json | undefined, DelegationFallback]>([
    [["comment"], null, "comment_missing"],
    [["commentId"], undefined, "comment_id_mismatch"],
    [["commentId"], "comment-other", "comment_id_mismatch"],
    [["comment", "issueId"], undefined, "comment_issue_mismatch"],
    [["comment", "issueId"], "issue-other", "comment_issue_mismatch"],
    [["comment", "userId"], null, "comment_author_mismatch"],
    [["comment", "userId"], "human-other-0001", "comment_author_mismatch"],
    [["sourceCommentId"], "comment-other", "source_mismatch"],
  ])("requires readback for unproven owner comment field %j = %j (%s)", (path, value, stage) => {
    const event = accepted(mutate(createdPayload(), ["agentSession", ...path], value));
    expect(event).toMatchObject({
      kind: "created",
      pendingDelegation: true,
      delegationFallback: stage,
    });
    expect(event).not.toHaveProperty("message");
  });

  it("refuses a session whose issue is missing or inconsistent", () => {
    const s = ["agentSession"];
    expect(refused(mutate(createdPayload(), [...s, "issue", "id"], "issue-other"))).toBe(
      "session_mismatch",
    );
    expect(refused(mutate(createdPayload(), [...s, "issueId"], null))).toBe("malformed");
    expect(refused(mutate(createdPayload(), [...s, "issue"], null))).toBe("malformed");
    expect(refused(mutate(createdPayload(), [...s, "creator", "id"], "human-other-0001"))).toBe(
      "session_mismatch",
    );
  });

  it("uses the linked comment text when its source matches", () => {
    const body = mutate(createdPayload(), ["agentSession", "sourceCommentId"], "comment-5e5e");
    expect(accepted(body)).toEqual(accepted(createdPayload()));
  });

  it("bounds the comment text: empty and over-limit refuse, the limit itself passes", () => {
    const at = (text: Json) => mutate(createdPayload(), ["agentSession", "comment", "body"], text);
    expect(accepted(at("x".repeat(MAX_PILOT_MESSAGE_CHARS))).message).toHaveLength(
      MAX_PILOT_MESSAGE_CHARS,
    );
    expect(refused(at("x".repeat(MAX_PILOT_MESSAGE_CHARS + 1)))).toBe("oversized");
    expect(refused(at(""))).toBe("unqualified_content");
    expect(refused(at("  \n "))).toBe("unqualified_content");
    expect(refused(at(7))).toBe("unqualified_content");
  });
});

describe("verifyLinearPilotIntake prompted and stop", () => {
  it("prompted uses the activity author, activity id and typed content", () => {
    expect(accepted(promptedPayload())).toEqual({
      kind: "prompted",
      workspaceId: "lin-org-91c2",
      applicationId: "app-record-52ab",
      appUserId: "app-user-e077",
      nativeSessionId: "session-c0de",
      humanId: "human-owner-4d18",
      issueId: "issue-a1b2",
      teamId: "team-77e1",
      activityId: "activity-9a9a",
      message: "also cover the retry path",
    });
  });

  it("prompted does not need the session creator or comment", () => {
    let body = mutate(promptedPayload(), ["agentSession", "creatorId"], "human-other-0001");
    body = mutate(body, ["agentSession", "comment"], null);
    body = mutate(body, ["agentSession", "issue"], undefined);
    const event = accepted(body);
    expect(event.kind).toBe("prompted");
    expect(event).not.toHaveProperty("teamId");
  });

  it("stop is decided before any body requirement", () => {
    const event = accepted(stopPayload());
    expect(event).toEqual({
      kind: "stop",
      workspaceId: "lin-org-91c2",
      applicationId: "app-record-52ab",
      appUserId: "app-user-e077",
      nativeSessionId: "session-c0de",
      humanId: "human-owner-4d18",
      issueId: "issue-a1b2",
      teamId: "team-77e1",
      activityId: "activity-5709",
      stopCreatedAtMs: Date.UTC(2026, 10, 21, 10),
    });
    const contents: (Json | undefined)[] = [
      undefined,
      null,
      "text",
      [],
      { body: 7 },
      { type: "other" },
    ];
    for (const content of contents) {
      const body = mutate(stopPayload(), ["agentActivity", "content"], content);
      expect(accepted(body).kind).toBe("stop");
    }
  });

  it("stop carries the signed activity creation time only when it is a strict UTC timestamp", () => {
    const at = ["agentActivity", "createdAt"];
    const ms = (value: Json | undefined) => accepted(mutate(stopPayload(), at, value));
    for (const [signed, canonical] of [
      ["2026-11-21T10:00:00Z", "2026-11-21T10:00:00.000Z"],
      ["2026-11-21T10:00:00.2Z", "2026-11-21T10:00:00.200Z"],
      ["2026-11-21T10:00:00.25Z", "2026-11-21T10:00:00.250Z"],
      ["2026-11-21T10:00:00.251Z", "2026-11-21T10:00:00.251Z"],
      ["2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
    ] as const) {
      const timestamp = ms(signed).stopCreatedAtMs;
      if (timestamp === undefined) throw new Error(`missing Stop timestamp for ${signed}`);
      expect(timestamp, signed).toBe(Date.parse(canonical));
      expect(new Date(timestamp).toISOString()).toBe(canonical);
    }
    for (const bad of [
      undefined,
      null,
      "",
      "yesterday",
      "2026-11-21",
      "2026-11-21T10:00:00",
      "2026-11-21T10:00:00+02:00",
      "2026-11-21T10:00:00.2501Z",
      "2026-11-21T10:00:00Z\n",
      "2026-02-31T10:00:00.000Z",
      "2026-02-29T10:00:00.000Z",
      "2026-11-21T24:00:00.000Z",
      "2026-11-21T25:00:00.000Z",
      "2026-11-21T10:60:00.000Z",
      "2026-11-21T10:00:60.000Z",
      1_800_000_000_000,
      true,
      {},
    ]) {
      const event = ms(bad);
      const label = JSON.stringify(bad) ?? "undefined";
      expect(event.kind, label).toBe("stop");
      expect(event, label).not.toHaveProperty("stopCreatedAtMs");
    }
  });

  it("normalizes a four-digit UTC year below 100 as signed", () => {
    const stamp = "0099-01-01T00:00:00.000Z";
    const event = accepted(mutate(stopPayload(), ["agentActivity", "createdAt"], stamp));
    expect(event.stopCreatedAtMs).toBe(Date.parse(stamp));
  });

  it("created and prompted events never carry a stop time", () => {
    expect(accepted(createdPayload())).not.toHaveProperty("stopCreatedAtMs");
    expect(accepted(promptedPayload())).not.toHaveProperty("stopCreatedAtMs");
  });

  it("stop still needs the exact owner and session", () => {
    const a = ["agentActivity"];
    expect(refused(mutate(stopPayload(), [...a, "userId"], "human-other-0001"))).toBe(
      "activity_mismatch",
    );
    expect(refused(mutate(stopPayload(), [...a, "user", "id"], "human-other-0001"))).toBe(
      "activity_mismatch",
    );
    expect(refused(mutate(stopPayload(), [...a, "agentSessionId"], "session-other"))).toBe(
      "activity_mismatch",
    );
    expect(refused(mutate(stopPayload(), [...a, "id"], undefined))).toBe("malformed");
    expect(refused(mutate(stopPayload(), ["agentActivity"], null))).toBe("malformed");
  });

  it("refuses an author who is not the owner and an owner id equal to the app user", () => {
    expect(
      refused(mutate(promptedPayload(), ["agentActivity", "userId"], "human-other-0001")),
    ).toBe("activity_mismatch");
    let body = mutate(promptedPayload(), ["agentActivity", "userId"], "human-other-0001");
    body = mutate(body, ["agentActivity", "user"], null);
    expect(refused(body)).toBe("not_owner");
    const config = { ...PILOT_CONFIG, allowedHumanId: INSTALLATION.appUserId };
    let own = mutate(promptedPayload(), ["agentActivity", "userId"], INSTALLATION.appUserId);
    own = mutate(own, ["agentActivity", "user", "id"], INSTALLATION.appUserId);
    expect(intake(own, INSTALLATION, config)).toEqual({ ok: false, reason: "not_owner" });
  });

  it("accepts only the prompt shape and signals the pilot qualifies", () => {
    const a = ["agentActivity"];
    for (const signal of ["continue", "auth", "select", "STOP", "Stop", " stop", 1, true]) {
      expect(refused(mutate(promptedPayload(), [...a, "signal"], signal))).toBe(
        "unsupported_signal",
      );
    }
    expect(accepted(mutate(promptedPayload(), [...a, "signal"], undefined)).kind).toBe("prompted");
    const content = (value: Json | undefined) =>
      mutate(promptedPayload(), [...a, "content"], value);
    expect(refused(content(undefined))).toBe("unqualified_content");
    expect(refused(content(null))).toBe("unqualified_content");
    expect(refused(content("text"))).toBe("unqualified_content");
    expect(refused(content({ type: "response", body: "x" }))).toBe("unqualified_content");
    expect(refused(content({ type: "prompt" }))).toBe("unqualified_content");
    expect(refused(content({ type: "prompt", body: " " }))).toBe("unqualified_content");
    expect(refused(content({ type: "prompt", body: 5 }))).toBe("unqualified_content");
    expect(refused(content({ type: "prompt", body: "x", action: "go" }))).toBe(
      "unqualified_content",
    );
    expect(refused(content({ type: "prompt", body: "x", title: 5 }))).toBe("unqualified_content");
    expect(accepted(content({ type: "prompt", body: "x", title: "t" })).message).toBe("x");
    expect(accepted(content({ type: "prompt", body: "x", title: null })).message).toBe("x");
  });

  it("refuses a second, different body location as ambiguous and keeps an identical one", () => {
    const ambiguous = mutate(promptedPayload(), ["agentActivity", "body"], "another text");
    expect(refused(ambiguous)).toBe("unqualified_content");
    const same = mutate(promptedPayload(), ["agentActivity", "body"], "also cover the retry path");
    expect(accepted(same).message).toBe("also cover the retry path");
    const guideOnly = mutate(promptedPayload(), ["agentActivity", "content"], undefined);
    expect(refused(mutate(guideOnly, ["agentActivity", "body"], "text"))).toBe(
      "unqualified_content",
    );
  });

  it("bounds the prompt text", () => {
    const at = (text: string) =>
      mutate(promptedPayload(), ["agentActivity", "content"], { type: "prompt", body: text });
    expect(accepted(at("y".repeat(MAX_PILOT_MESSAGE_CHARS))).message).toHaveLength(
      MAX_PILOT_MESSAGE_CHARS,
    );
    expect(refused(at("y".repeat(MAX_PILOT_MESSAGE_CHARS + 1)))).toBe("oversized");
  });
});

describe("verifyLinearPilotIntake scope", () => {
  it("enforces the exact signed organization, app and nested session identity", () => {
    for (const make of [createdPayload, promptedPayload, stopPayload]) {
      expect(refused(mutate(make(), ["organizationId"], "lin-org-other"))).toBe(
        "workspace_mismatch",
      );
      expect(refused(mutate(make(), ["organizationId"], undefined))).toBe("workspace_mismatch");
      expect(refused(mutate(make(), ["appUserId"], "app-user-other"))).toBe("app_mismatch");
      expect(refused(mutate(make(), ["oauthClientId"], "client-other"))).toBe("app_mismatch");
      expect(refused(mutate(make(), ["oauthClientId"], undefined))).toBe("app_mismatch");
      expect(refused(mutate(make(), ["agentSession", "organizationId"], "lin-org-other"))).toBe(
        "session_mismatch",
      );
      expect(refused(mutate(make(), ["agentSession", "appUserId"], "app-user-other"))).toBe(
        "session_mismatch",
      );
      expect(refused(mutate(make(), ["agentSession", "id"], undefined))).toBe("malformed");
      expect(refused(mutate(make(), ["agentSession"], null))).toBe("malformed");
    }
  });

  it("refuses when the resolved connection is not the configured pilot installation", () => {
    const wrongHub = { ...INSTALLATION, organizationId: "hub-org-other" };
    const wrongWorkspace = { ...INSTALLATION, workspaceId: "lin-org-other" };
    expect(intake(createdPayload(), wrongHub)).toEqual({
      ok: false,
      reason: "installation_mismatch",
    });
    expect(intake(createdPayload(), wrongWorkspace)).toEqual({
      ok: false,
      reason: "installation_mismatch",
    });
  });

  it("refuses unsupported events and actions and non-record bodies", () => {
    expect(refused(mutate(createdPayload(), ["type"], "PermissionChange"))).toBe(
      "unsupported_event",
    );
    expect(refused(mutate(createdPayload(), ["type"], undefined))).toBe("unsupported_event");
    for (const action of ["stopped", "removed", "Created", "", null, 3]) {
      expect(refused(mutate(createdPayload(), ["action"], action))).toBe("unsupported_action");
    }
    for (const value of [null, undefined, "x", 4, [], [createdPayload()], true]) {
      expect(refused(value)).toBe("malformed");
    }
  });

  it("rejects ids outside the bounded charset in every authority position", () => {
    for (const bad of ["", " id", "id ", "a\nb", "x".repeat(129), 7, "dröp", "a/b"]) {
      expect(refused(mutate(createdPayload(), ["agentSession", "id"], bad))).toBe("malformed");
      expect(refused(mutate(createdPayload(), ["organizationId"], bad))).toBe("workspace_mismatch");
    }
  });

  it("does not trust inherited or exotic properties", () => {
    const inherited = { __proto__: { type: "AgentSessionEvent" } };
    expect(refused(inherited)).toBe("malformed");
    const exotic = { __proto__: createdPayload() };
    expect(refused(exotic)).toBe("malformed");
    const poisoned = JSON.parse(
      JSON.stringify(createdPayload()).replace("{", '{"__proto__":{"organizationId":"x"},'),
    ) as unknown;
    expect(accepted(poisoned).kind).toBe("created");
  });

  it("never logs or leaks the body on delegation fallback", () => {
    const sinks = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
    ];
    const body = mutate(
      createdPayload(),
      ["agentSession", "comment", "userId"],
      "human-other-0001",
    );
    const withSecret = mutate(body, ["agentSession", "comment", "body"], "TOP-SECRET-COMMENT");
    const result = intake(withSecret);
    expect(result).toMatchObject({ ok: true, event: { pendingDelegation: true } });
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET-COMMENT");
    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
  });
});

describe("verifyLinearPilotIntake generated cases", () => {
  // Replay a failure with PILOT_FUZZ_SEED=<seed>; the seed is part of every failure message.
  const CASES = 3_000;

  const BREAKING: { path: string[]; values: (Json | undefined)[]; applies: string[] }[] = [
    { path: ["organizationId"], values: ["lin-org-x", null, 5, undefined, ""], applies: ["all"] },
    { path: ["appUserId"], values: ["app-x", null, undefined], applies: ["all"] },
    { path: ["oauthClientId"], values: ["client-x", undefined, 0], applies: ["all"] },
    { path: ["agentSession", "id"], values: [null, undefined, "bad id"], applies: ["all"] },
    { path: ["agentSession", "appUserId"], values: ["app-x", undefined], applies: ["all"] },
    { path: ["agentSession", "organizationId"], values: ["org-x", null], applies: ["all"] },
    { path: ["agentSession", "issueId"], values: [null, undefined], applies: ["all"] },
    { path: ["agentSession", "creatorId"], values: ["human-x", null], applies: ["created"] },
    { path: ["agentSession", "comment", "body"], values: ["", null, 9], applies: ["created"] },
    { path: ["agentActivity", "userId"], values: ["human-x", null], applies: ["prompted", "stop"] },
    {
      path: ["agentActivity", "agentSessionId"],
      values: ["session-x", undefined],
      applies: ["prompted", "stop"],
    },
    { path: ["agentActivity", "signal"], values: ["auth", "continue", 1], applies: ["prompted"] },
    { path: ["agentActivity", "content"], values: [null, "x", {}], applies: ["prompted"] },
  ];

  const NEUTRAL: { path: string[]; make: (next: () => number) => Json }[] = [
    { path: ["promptContext"], make: (n) => `ctx ${randomId(n, "")}` },
    { path: ["guidance"], make: (n) => [{ body: randomId(n, "g") }] },
    { path: ["previousComments"], make: (n) => [{ id: randomId(n, "c"), body: randomId(n, "") }] },
    { path: ["webhookId"], make: (n) => randomId(n, "w") },
    { path: ["extension"], make: (n) => ({ [randomId(n, "k")]: randomId(n, "v") }) },
    { path: ["agentSession", "status"], make: (n) => randomId(n, "st") },
    {
      path: ["agentSession", "url"],
      make: (n) => `https://linear.example.test/${randomId(n, "")}`,
    },
    { path: ["agentSession", "sourceMetadata"], make: (n) => ({ note: randomId(n, "") }) },
    { path: ["agentSession", "summary"], make: (n) => randomId(n, "sum") },
  ];

  const BASES: Record<string, () => JsonObject> = {
    created: createdPayload,
    prompted: promptedPayload,
    stop: stopPayload,
  };
  function baseFor(kind: string): JsonObject {
    const make = BASES[kind];
    if (make === undefined) throw new Error(`unknown kind ${kind}`);
    return make();
  }

  it(`${CASES} generated payloads: only owner-bound well-formed input yields an event (seed ${REPLAY_SEED})`, () => {
    const next = rng(REPLAY_SEED);
    const outcomes = { accepted: 0, refused: 0 };
    for (let n = 0; n < CASES; n += 1) {
      const kind = pick(next, ["created", "prompted", "stop"]);
      let body = baseFor(kind);
      const label = `case ${n} kind ${kind} seed ${REPLAY_SEED}`;
      // Neutral noise never changes the verdict.
      for (const noise of NEUTRAL.filter(() => next() < 0.4)) {
        body = mutate(body, noise.path, noise.make(next));
      }
      const breaker = next() < 0.55 ? pick(next, BREAKING) : undefined;
      const applies =
        breaker !== undefined &&
        (breaker.applies.includes("all") || breaker.applies.includes(kind));
      if (breaker !== undefined && applies) {
        body = mutate(body, breaker.path, pick(next, breaker.values));
      }
      // A stop ignores content by design, so a content breaker cannot refuse it.
      const result = intake(body);
      const again = intake(clone(body));
      expect(again, label).toEqual(result);
      const mustRefuse = breaker !== undefined && applies;
      if (mustRefuse) {
        expect(result.ok, label).toBe(false);
        outcomes.refused += 1;
      } else {
        expect(result.ok, label).toBe(true);
        outcomes.accepted += 1;
      }
      if (result.ok) {
        expect(result.event.humanId, label).toBe(PILOT_CONFIG.allowedHumanId);
        expect(result.event.workspaceId, label).toBe(PILOT_CONFIG.linearOrganizationId);
        expect(result.event.kind, label).toBe(kind);
        expect(
          Object.keys(result.event).every((k) => KEYS.has(k)),
          label,
        ).toBe(true);
        if (kind === "stop") {
          expect(result.event.stopCreatedAtMs, label).toBe(Date.UTC(2026, 10, 21, 10));
        } else {
          expect(result.event, label).not.toHaveProperty("stopCreatedAtMs");
        }
      }
    }
    // Controls: the generator exercised both verdicts, not just one.
    expect(outcomes.accepted).toBeGreaterThan(CASES * 0.3);
    expect(outcomes.refused).toBeGreaterThan(CASES * 0.2);
  });

  it(`${CASES} arbitrary JSON values never throw and never yield an event (seed ${REPLAY_SEED})`, () => {
    const next = rng(REPLAY_SEED + 1);
    const junk = (depth: number): Json => {
      const roll = next();
      if (depth > 3 || roll < 0.35) {
        return pick(next, [null, true, 0, -1, 1.5, "", "x", "AgentSessionEvent", "created"]);
      }
      if (roll < 0.55) return Array.from({ length: Math.floor(next() * 3) }, () => junk(depth + 1));
      const keys = [
        "type",
        "action",
        "organizationId",
        "agentSession",
        "agentActivity",
        "id",
        "issue",
      ];
      const out: JsonObject = {};
      for (const key of keys) if (next() < 0.5) out[key] = junk(depth + 1);
      return out;
    };
    for (let n = 0; n < CASES; n += 1) {
      const value = junk(0);
      const label = `junk ${n} seed ${REPLAY_SEED + 1}`;
      let result: LinearPilotIntakeResult | undefined;
      expect(() => {
        result = intake(value);
      }, label).not.toThrow();
      expect(result?.ok, label).toBe(false);
    }
  });

  it("returns within a fixed bound for a body-limit payload of ignored fields", () => {
    const body = createdPayload();
    body["previousComments"] = Array.from({ length: 4_000 }, (_, i) => ({
      id: `c${i}`,
      body: "z".repeat(200),
    }));
    body["guidance"] = Array.from({ length: 4_000 }, () => ({ body: "g".repeat(100) }));
    let deep: JsonObject = {};
    const head = deep;
    for (let i = 0; i < 2_000; i += 1) {
      const child: JsonObject = {};
      deep["next"] = child;
      deep = child;
    }
    body["extension"] = head;
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) expect(intake(body).ok).toBe(true);
    // 200 calls over roughly 1.5 MB of ignored fields: nothing walks them.
    expect(performance.now() - started).toBeLessThan(250);
  });
});

const KEYS = new Set([
  "kind",
  "stopCreatedAtMs",
  "workspaceId",
  "applicationId",
  "appUserId",
  "nativeSessionId",
  "humanId",
  "issueId",
  "teamId",
  "activityId",
  "message",
]);

describe("classifyLinearPilotCompanionComment", () => {
  const base = {
    config: PILOT_CONFIG,
    workspaceId: PILOT_CONFIG.linearOrganizationId,
    authorId: PILOT_CONFIG.allowedHumanId,
  };

  async function decide(body: unknown, handle: string | null = "paseo") {
    return classifyLinearPilotCompanionComment({ ...base, body, resolveHandle: () => handle });
  }

  async function suppressed(body: string, handle = "paseo") {
    return (await decide(body, handle)).suppress;
  }

  it("suppresses an owner comment with the verified handle in prose, ignoring case", async () => {
    expect(await decide("@paseo hello")).toEqual({ suppress: true });
    expect(await suppressed("hey @PASEO, can you look?")).toBe(true);
    expect(await suppressed("@Paseo")).toBe(true);
    expect(await suppressed("hey @paseo", "@Paseo")).toBe(true);
    expect(await suppressed("(@paseo)")).toBe(true);
    expect(await suppressed("done.@paseo")).toBe(true);
    expect(await suppressed("@paseo.")).toBe(true);
  });

  it("requires boundaries on both sides of the token", async () => {
    for (const text of [
      "@paseo2",
      "@paseo_bot",
      "@paseo-bot",
      "@paseoé",
      "@paseo\u0301",
      "x@paseo",
      "me@paseo.com",
      "@@paseo",
      "@paseo@x",
      "é@paseo",
      "_@paseo",
      "-@paseo",
      "1@paseo",
      "@pasee",
      "@pase",
      "paseo",
    ]) {
      expect(await suppressed(text), text).toBe(false);
    }
  });

  it("ignores inline code and fenced or indented code, and counts prose around it", async () => {
    for (const text of [
      "`@paseo`",
      "`` `@paseo` ``",
      "```\n@paseo\n```",
      "~~~\n@paseo\n~~~",
      "```js\nconst a = '@paseo';\n```",
      "para\n\n    @paseo",
      "> `@paseo`",
      "> ```\n> @paseo\n> ```",
      "text `@paseo` and x@paseo",
    ]) {
      expect(await suppressed(text), text).toBe(false);
    }
    expect((await decide("`@paseo`")).suppress).toBe(false);
    expect(await decide("`@paseo`")).toEqual({ suppress: false, reason: "code_only" });
    expect(await suppressed("`code` then @paseo please")).toBe(true);
    expect(await suppressed("```\n@paseo\n```\n\nand @paseo here")).toBe(true);
  });

  it("quoted prose counts and quoted code does not", async () => {
    expect(await suppressed("> @paseo please")).toBe(true);
    expect(await suppressed('he said "@paseo can you check"')).toBe(true);
    expect(await suppressed("> quoted\n> @paseo again")).toBe(true);
    expect(await suppressed("- item @paseo")).toBe(true);
    expect(await suppressed("> ```\n> @paseo\n> ```")).toBe(false);
  });

  it("matches only the exact pilot workspace and owner and asks for no handle otherwise", async () => {
    const resolveHandle = vi.fn(() => "paseo");
    interface Over {
      workspaceId?: string;
      authorId?: string | null | undefined;
      body?: unknown;
    }
    const call = (over: Over) =>
      classifyLinearPilotCompanionComment({
        ...base,
        body: "@paseo hi",
        ...over,
        resolveHandle,
      });
    expect(await call({ workspaceId: "lin-org-other" })).toEqual({
      suppress: false,
      reason: "workspace_mismatch",
    });
    expect(await call({ authorId: "human-other-0001" })).toEqual({
      suppress: false,
      reason: "owner_mismatch",
    });
    expect((await call({ authorId: null })).suppress).toBe(false);
    expect((await call({ authorId: undefined })).suppress).toBe(false);
    expect((await call({ body: "no mention here" })).suppress).toBe(false);
    expect((await call({ body: 42 })).suppress).toBe(false);
    expect(resolveHandle).not.toHaveBeenCalled();
    expect((await call({})).suppress).toBe(true);
    expect(resolveHandle).toHaveBeenCalledTimes(1);
  });

  it("refuses to guess when the verified handle is absent or not a single token", async () => {
    for (const handle of [null, "", "@", "two words", "a@b", "x".repeat(65), "tab\tname"]) {
      expect(await decide("@paseo hi", handle), String(handle)).toEqual({
        suppress: false,
        reason: "handle_unusable",
      });
    }
    const missing = await classifyLinearPilotCompanionComment({
      ...base,
      body: "@paseo",
      resolveHandle: () => undefined,
    });
    expect(missing.suppress).toBe(false);
  });

  it("escapes regex syntax in the handle and propagates a failing lookup", async () => {
    expect(await suppressed("hi @a.b", "a.b")).toBe(true);
    expect(await suppressed("hi @axb", "a.b")).toBe(false);
    expect(await suppressed("hi @a+", "a+")).toBe(true);
    await expect(
      classifyLinearPilotCompanionComment({
        ...base,
        body: "@paseo",
        resolveHandle: () => {
          throw new Error("lookup failed");
        },
      }),
    ).rejects.toThrow("lookup failed");
  });

  it("leaves bare URLs and raw HTML out of prose", async () => {
    expect(await suppressed("see https://example.test/@paseo now")).toBe(false);
    expect(await suppressed("<span>@paseo</span>")).toBe(true);
    expect(await suppressed("<!-- @paseo -->")).toBe(false);
    expect(await suppressed("[@paseo](https://example.test)")).toBe(true);
  });

  {
    const PROSE_WITH = [
      "hey @paseo look",
      "@PASEO please",
      "(@Paseo)",
      "> quoted @paseo here",
      "**@paseo** do it",
      "thanks @paseo.",
      "@paseo, hi",
      '"@paseo" said me',
      "# heading @paseo",
    ];
    const PROSE_WITHOUT = [
      "mail me@paseo.com",
      "@paseo2 no",
      "x@paseo",
      "@@paseo",
      "@paseo_bot",
      "@paseo-bot",
      "@paseoé",
      "é@paseo",
      "@pasee",
      "plain text",
      "paseo without sign",
    ];
    const CODE = [
      "`@paseo`",
      "`` `@paseo` ``",
      "```\n@paseo\n```",
      "~~~\n@paseo\n~~~",
      "    @paseo",
      "```js\nconst a = '@paseo';\n```",
      "> `@paseo`",
      "> ```\n> @paseo\n> ```",
      "`@paseo` and x@paseo",
    ];

    it(`2,000+ generated comments agree with an independent oracle (seed ${REPLAY_SEED})`, async () => {
      const next = rng(REPLAY_SEED + 2);
      const counts = { yes: 0, no: 0 };
      const total = 2_400;
      for (let n = 0; n < total; n += 1) {
        const parts: string[] = [];
        let expected = false;
        for (let i = 0, length = 1 + Math.floor(next() * 4); i < length; i += 1) {
          const roll = next();
          if (roll < 0.3) {
            parts.push(pick(next, PROSE_WITH));
            expected = true;
          } else if (roll < 0.65) parts.push(pick(next, PROSE_WITHOUT));
          else parts.push(pick(next, CODE));
        }
        const body = parts.join("\n\n");
        const label = `comment ${n} seed ${REPLAY_SEED + 2}: ${JSON.stringify(body)}`;
        const resolveHandle = vi.fn(() => "paseo");
        const author = next() < 0.8 ? PILOT_CONFIG.allowedHumanId : "human-other-0001";
        const space = next() < 0.8 ? PILOT_CONFIG.linearOrganizationId : "lin-org-other";
        const decision = await classifyLinearPilotCompanionComment({
          config: PILOT_CONFIG,
          workspaceId: space,
          authorId: author,
          body,
          resolveHandle,
        });
        const authorized =
          author === PILOT_CONFIG.allowedHumanId && space === PILOT_CONFIG.linearOrganizationId;
        expect(decision.suppress, label).toBe(authorized && expected);
        if (!authorized) expect(resolveHandle, label).not.toHaveBeenCalled();
        if (authorized && expected) counts.yes += 1;
        else counts.no += 1;
      }
      expect(counts.yes).toBeGreaterThan(total * 0.2);
      expect(counts.no).toBeGreaterThan(total * 0.2);
    });
  }

  it("classifies delimiter-heavy comments at the parse limit and far above it within a fixed bound", async () => {
    const unit = [
      "[",
      "*",
      "`",
      "> ",
      "- ",
      "_",
      "\\",
      "~",
      "<",
      "(",
      "![",
      "|",
      "    ",
      "](",
      "1. ",
    ];
    const started = performance.now();
    for (const piece of unit) {
      for (const size of [MAX_PILOT_PARSE_CHARS, 1_000_000]) {
        const filler = piece.repeat(Math.floor((size - 8) / piece.length));
        const decision = await decide(`${filler}\n\n@paseo`);
        expect(typeof decision.suppress).toBe("boolean");
      }
    }
    // 15 shapes at the parse limit and at the webhook body limit: one parser pass at most each.
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it(`random delimiter pools at the parse limit stay within a per-comment bound (seed ${REPLAY_SEED})`, async () => {
    const tokens = [
      "[",
      "]",
      "(",
      ")",
      "*",
      "_",
      "`",
      "~",
      "<",
      ">",
      "!",
      "\\",
      "|",
      "a",
      " ",
      "\n",
    ];
    const more = [
      "- ",
      "1. ",
      "> ",
      "**",
      "[a](",
      "](",
      "<a ",
      "```",
      "~~~",
      "    ",
      "[^1]: ",
      "&amp;",
    ];
    const next = rng(REPLAY_SEED + 3);
    let worst = 0;
    for (let n = 0; n < 300; n += 1) {
      const pool = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
        pick(next, next() < 0.5 ? tokens : more),
      );
      let body = "";
      while (body.length < MAX_PILOT_PARSE_CHARS - 8) body += pick(next, pool);
      const started = performance.now();
      await decide(`${body.slice(0, MAX_PILOT_PARSE_CHARS - 8)}\n\n@paseo`);
      worst = Math.max(worst, performance.now() - started);
    }
    expect(worst).toBeLessThan(1_000);
  });

  it("reports a handle-bearing body too large or too deep to parse as ambiguous, never suppressed", async () => {
    const unclassifiable = { suppress: false, reason: "unclassifiable", ambiguous: true };
    expect(await decide(`${"x ".repeat(MAX_PILOT_PARSE_CHARS)} @paseo`)).toEqual(unclassifiable);
    expect(await decide(`> > > > > > > > @paseo`)).toEqual(unclassifiable);
    expect(await decide(`- - - - - - - - @paseo`)).toEqual(unclassifiable);
    expect(await decide(`${"(".repeat(200)} @paseo`)).toEqual(unclassifiable);
    // Without the handle there is nothing to be ambiguous about, however large.
    expect(await decide(`${"x ".repeat(MAX_PILOT_PARSE_CHARS)} @someone`)).toEqual({
      suppress: false,
      reason: "no_handle",
    });
    // Just under the limit is parsed and classified normally.
    expect(await suppressed(`${"x ".repeat(MAX_PILOT_PARSE_CHARS / 2 - 8)} @paseo`)).toBe(true);
  });
});

describe("precheckLinearPilotScope", () => {
  const check = (payload: unknown) => precheckLinearPilotScope({ config: PILOT_CONFIG, payload });

  it("passes the owner in the pilot workspace for each event kind", () => {
    for (const make of [createdPayload, promptedPayload, stopPayload]) {
      expect(check(make())).toEqual({ ok: true });
    }
  });

  it("refuses another workspace or another human with a bare reason", () => {
    expect(check(mutate(createdPayload(), ["organizationId"], "lin-org-other"))).toEqual({
      ok: false,
      reason: "workspace_mismatch",
    });
    expect(check(mutate(createdPayload(), ["organizationId"], undefined))).toEqual({
      ok: false,
      reason: "workspace_mismatch",
    });
    const creator = mutate(createdPayload(), ["agentSession", "creatorId"], "human-other-0001");
    expect(check(creator)).toEqual({ ok: false, reason: "not_owner" });
    expect(check(mutate(createdPayload(), ["agentSession", "creatorId"], null))).toEqual({
      ok: false,
      reason: "not_owner",
    });
    const author = mutate(promptedPayload(), ["agentActivity", "userId"], "human-other-0001");
    expect(check(author)).toEqual({ ok: false, reason: "not_owner" });
    expect(check(mutate(stopPayload(), ["agentActivity"], null))).toEqual({
      ok: false,
      reason: "not_owner",
    });
  });

  it("refuses non-session events, unknown actions and non-record bodies", () => {
    expect(check(mutate(createdPayload(), ["type"], "PermissionChange"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(check(mutate(createdPayload(), ["action"], "removed"))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    for (const value of [null, undefined, "x", 4, [], true]) {
      expect(check(value)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("checks only the signed scope fields before a provider or credential read", () => {
    const reads: PropertyKey[] = [];
    let enumerations = 0;
    const provider = vi.fn();
    const track = (record: JsonObject) =>
      new Proxy(record, {
        get(target, key): unknown {
          reads.push(key);
          return Reflect.get(target, key);
        },
        ownKeys(target) {
          enumerations += 1;
          return Reflect.ownKeys(target);
        },
      });

    const wrongWorkspace = track({ ...createdPayload(), organizationId: "lin-org-other" });
    const otherHuman = track({
      ...createdPayload(),
      agentSession: track({
        ...objectAtPath(createdPayload(), "agentSession"),
        creatorId: "human-other-0001",
      }),
    });
    for (const payload of [wrongWorkspace, otherHuman]) {
      if (check(payload).ok) provider();
    }

    expect(provider).not.toHaveBeenCalled();
    expect(enumerations).toBe(0);
    expect(reads).toEqual([
      "action",
      "type",
      "organizationId",
      "action",
      "type",
      "organizationId",
      "agentSession",
      "creatorId",
    ]);
  });

  it(`never refuses what full intake accepts and never admits another human (seed ${REPLAY_SEED})`, () => {
    const next = rng(REPLAY_SEED + 4);
    const paths: string[][] = [
      ["organizationId"],
      ["agentSession", "creatorId"],
      ["agentActivity", "userId"],
      ["agentSession", "comment", "userId"],
      ["agentActivity", "content"],
      ["agentSession", "issueId"],
    ];
    const values: (Json | undefined)[] = ["lin-org-x", "human-x", null, undefined, 3, ""];
    let admitted = 0;
    for (let n = 0; n < 3_000; n += 1) {
      let body = pick(next, [createdPayload, promptedPayload, stopPayload])();
      for (const path of paths) {
        if (path[0] === "agentActivity" && body["agentActivity"] === undefined) continue;
        if (next() < 0.25) body = mutate(body, path, pick(next, values));
      }
      const label = `case ${n} seed ${REPLAY_SEED + 4}`;
      const full = intake(body);
      const pre = check(body);
      if (full.ok) {
        expect(pre, label).toEqual({ ok: true });
        admitted += 1;
      }
      if (pre.ok) {
        const holder = body["action"] === "created" ? "agentSession" : "agentActivity";
        const key = body["action"] === "created" ? "creatorId" : "userId";
        expect(body["organizationId"], label).toBe(PILOT_CONFIG.linearOrganizationId);
        expect(objectAtPath(body, holder)[key], label).toBe(PILOT_CONFIG.allowedHumanId);
      }
    }
    expect(admitted).toBeGreaterThan(300);
  });

  it("reads a fixed handful of fields regardless of payload size", () => {
    const body = createdPayload();
    body["previousComments"] = Array.from({ length: 4_000 }, (_, i) => ({
      id: `c${i}`,
      body: "z".repeat(200),
    }));
    const started = performance.now();
    for (let i = 0; i < 2_000; i += 1) expect(check(body).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
