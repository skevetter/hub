import assert from "node:assert/strict";
import { it } from "vitest";
import { tracePilotActivities } from "../../linear-pilot/activities.js";
import { pilotExceptionFields } from "../../linear-pilot/follow-up.js";
import { createLogger } from "../../logger.js";
import { createLinearAgentClient, LinearAgentError } from "./agent.js";
import {
  activityId,
  appViewer,
  completePage,
  hubUrl,
  linearAgentBinding,
  linearAgentFixture,
  sessionId,
} from "./test-utils/agent.js";

const thought = { type: "thought", body: "Working on the task." } as const;
const activity = { sessionId, activityId, content: thought };
function activityResult(appUserId = "app-user-a", success = true, id = activityId) {
  return {
    data: {
      agentActivityCreate: {
        success,
        agentActivity: { id, agentSession: { id: sessionId }, user: { id: appUserId } },
      },
    },
  };
}
const success = activityResult();

function client(fixture: ReturnType<typeof linearAgentFixture>, connection = fixture.a) {
  return createLinearAgentClient({
    ...fixture.options,
    binding: linearAgentBinding(connection),
  });
}

function pilotClient(fixture: ReturnType<typeof linearAgentFixture>) {
  return createLinearAgentClient({
    ...fixture.options,
    binding: linearAgentBinding(fixture.a),
    pilotOperations: true,
  });
}

it("the native app sends each typed activity shape and respects ephemeral flags", async () => {
  const fixture = linearAgentFixture((operation) => {
    assert.equal(operation, "PaseoAgentActivityCreate");
    return success;
  });
  const shapes = [
    { content: thought, ephemeral: false },
    { content: thought, ephemeral: true },
    { content: { type: "action", action: "Read", parameter: "Repository" }, ephemeral: true },
    { content: { type: "action", action: "Read", parameter: "Repository", result: "Done" } },
    { content: { type: "elicitation", body: "Which repository?" } },
    { content: { type: "response", body: "The task is complete." } },
    { content: { type: "error", body: "The task could not start." } },
  ] as const;
  for (const shape of shapes) {
    assert.equal(
      await client(fixture).createActivity({ sessionId, activityId, ...shape }),
      activityId,
    );
    const call = fixture.calls.at(-1);
    assert.equal(call?.bearer, "Bearer fake-access-a");
    assert.equal(call?.redirect, "error");
    assert.deepEqual(call?.variables, {
      input: { agentSessionId: sessionId, id: activityId, ...shape },
    });
  }
  const beforeInvalid = fixture.calls.length;
  await assert.rejects(
    client(fixture).createActivity({
      ...activity,
      content: { type: "response", body: "done" },
      ephemeral: true,
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(client(fixture).createActivity({ ...activity, activityId: "non-uuid" }), {
    code: "invalid_input",
  });
  assert.equal(fixture.calls.length, beforeInvalid);
});

it("GraphQL errors or success false never acknowledge delivery", async () => {
  const payloads = [
    { ...success, errors: [{ message: "private provider payload" }] },
    { ...success, errors: { message: "private malformed error" } },
    activityResult("app-user-a", false),
    activityResult("app-user-a", true, "wrong-id"),
    { data: { agentActivityCreate: { success: true, agentActivity: null } } },
  ];
  for (const payload of payloads) {
    const fixture = linearAgentFixture(() => payload);
    await assert.rejects(client(fixture).createActivity(activity), (error: unknown) => {
      assert.ok(error instanceof LinearAgentError);
      assert.doesNotMatch(String(error), /private/u);
      assert.equal(error.cause, undefined);
      assert.equal(error.details, undefined);
      return true;
    });
    assert.equal(fixture.calls.filter(({ query }) => query.startsWith("mutation")).length, 1);
  }
});

it("pilot ACK failures keep only known provider labels even after credential rotation", async () => {
  const body = "Paseo Hub received your request.";
  const refreshToken = 'fake-"refresh';
  const fixture = linearAgentFixture((_operation, { variables }) => {
    assert.deepEqual(variables, {
      input: {
        agentSessionId: sessionId,
        id: activityId,
        content: { type: "thought", body },
        ephemeral: false,
      },
    });
    return {
      errors: [
        {
          message: ` thought\t activities\u0000\u001b\r\n for ${sessionId}: ${fixture.a.accessToken} ${
            refreshToken
          } ${JSON.stringify(refreshToken).slice(1, -1)} fake-rotated-access fake-rotated-refresh ${JSON.stringify(body)} ${"x".repeat(500)}`,
          extensions: { type: "invalid input", code: "bad_user_input" },
        },
        { message: "Other failure", extensions: { type: "other", code: "other" } },
      ],
    };
  });
  fixture.connections.set(fixture.a.linearOrganizationId, {
    ...fixture.a,
    refreshToken,
    accessTokenExpiresAt: new Date(0),
  });
  const pilot = createLinearAgentClient({
    ...fixture.options,
    binding: linearAgentBinding(fixture.a),
    pilotOperations: true,
  });

  await assert.rejects(
    pilot.createActivity({
      ...activity,
      content: { type: "thought", body },
      ephemeral: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LinearAgentError);
      assert.equal(error.code, "request_failed");
      assert.equal(error.status, 200);
      assert.equal(error.message, "Linear agent provider request failed");
      assert.deepEqual(error.details, {
        linearErrorType: "invalid input",
        linearErrorKinds: ["BAD_USER_INPUT", "other"],
      });
      return true;
    },
  );
});

it("pilot logs do not expose private provider messages, types or codes", async () => {
  const fixture = linearAgentFixture(() => ({
    errors: [
      {
        message: "private message canary",
        extensions: { type: "private type canary", code: "private code canary" },
      },
      { message: "second private message", extensions: { code: "another private code" } },
    ],
  }));
  const records: string[] = [];
  const logger = createLogger({ write: (record) => records.push(record) });
  await assert.rejects(pilotClient(fixture).createActivity(activity), (error: unknown) => {
    assert.ok(error instanceof LinearAgentError);
    assert.deepEqual(error.details, { linearErrorType: "other", linearErrorKinds: ["other"] });
    logger.warn(pilotExceptionFields(error), "Linear pilot delivery failed");
    return true;
  });
  assert.equal(records.length, 1);
  assert.match(records[0]!, /"linearErrorType":"other"/u);
  assert.match(records[0]!, /"linearErrorKinds":\["other"\]/u);
  assert.doesNotMatch(records[0]!, /linearErrorText|private/iu);
});

it("traces the provider type when an activity readback fails closed", async () => {
  const fixture = linearAgentFixture(() => ({
    errors: [{ message: "Read unavailable", extensions: { type: "internal error" } }],
  }));
  const records: string[] = [];
  const logger = createLogger({ write: (record) => records.push(record) });
  const traced = tracePilotActivities(pilotClient(fixture), (operation, error) =>
    logger.warn({ operation, ...pilotExceptionFields(error) }, "Linear pilot delivery failed"),
  );
  assert.equal(await traced.isActivityConfirmed({ sessionId, activityId, kind: "thought" }), false);
  assert.equal(records.length, 1);
  assert.match(records[0]!, /"operation":"readActivity"/u);
  assert.match(records[0]!, /"linearErrorType":"internal error"/u);
});

it("keeps exact SDK error types and maps the old authentication label to other", async () => {
  const cases = [
    ["authentication error", "authentication error", "INPUT_ERROR"],
    ["internal error", "internal error", "GRAPHQL_VALIDATION_FAILED"],
    ["authentication", "other", "GRAPHQL_PARSE_FAILED"],
  ] as const;
  for (const [type, expectedType, code] of cases) {
    const fixture = linearAgentFixture(() => ({
      errors: [{ message: "Synthetic failure", extensions: { type, code } }],
    }));
    await assert.rejects(pilotClient(fixture).createActivity(activity), {
      details: { linearErrorType: expectedType, linearErrorKinds: [code] },
    });
  }
});

it("pilot requests without a body classify the selected error type and known codes", async () => {
  const fixture = linearAgentFixture(() => ({
    errors: [
      { message: "Other failure", extensions: { type: "A", code: "other" } },
      {
        message: `Slow down reads for ${sessionId}`,
        extensions: { type: "ratelimited", code: "RATELIMITED" },
      },
    ],
  }));
  const pilot = createLinearAgentClient({
    ...fixture.options,
    binding: linearAgentBinding(fixture.a),
    pilotOperations: true,
  });
  await assert.rejects(
    pilot.readPilotHistory(
      {
        sessionId,
        issueId: "pilot-issue",
        appUserId: fixture.a.appUserId,
        allowedHumanProviderUserId: "pilot-owner",
      },
      "2026-01-01T00:00:06.000Z",
    ),
    (error: unknown) => {
      assert.ok(error instanceof LinearAgentError);
      assert.deepEqual(error.details, {
        linearErrorType: "ratelimited",
        linearErrorKinds: ["other", "RATELIMITED"],
      });
      return true;
    },
  );
});

it("a wrong workspace app actor or missing pilot scope sends no operation", async () => {
  const fixture = linearAgentFixture(() => activityResult("app-user-b"));
  for (const binding of [
    { ...linearAgentBinding(fixture.a), linearOrganizationId: fixture.b.linearOrganizationId },
    { ...linearAgentBinding(fixture.a), appUserId: fixture.b.appUserId },
    { ...linearAgentBinding(fixture.a), organizationId: fixture.b.organizationId },
    { ...linearAgentBinding(fixture.a), id: fixture.b.id },
    { ...linearAgentBinding(fixture.a), providerApplicationId: "other-app" },
  ]) {
    await assert.rejects(
      createLinearAgentClient({
        ...fixture.options,
        authorize: async () => true,
        binding,
      }).createActivity(activity),
      { code: "connection_not_owned" },
    );
  }
  for (const missing of fixture.a.scopes) {
    fixture.connections.set(fixture.a.linearOrganizationId, {
      ...fixture.a,
      scopes: fixture.a.scopes.filter((scope) => scope !== missing),
      accessTokenExpiresAt: new Date(0),
    });
    await assert.rejects(client(fixture).createActivity(activity), { code: "scope_missing" });
  }
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.refreshTokens, []);
  fixture.approved.delete(fixture.b.id);
  const lookups = fixture.lookups.length;
  await assert.rejects(client(fixture, fixture.b).readAppViewer(), { code: "policy_required" });
  assert.equal(fixture.lookups.length, lookups);
  assert.deepEqual(fixture.calls, []);
  fixture.approved.add(fixture.b.id);
  assert.equal(await client(fixture, fixture.b).createActivity(activity), activityId);
  assert.ok(fixture.calls.every(({ bearer }) => bearer === "Bearer fake-access-b"));
});

it("activity readback is bounded to the exact native session", async () => {
  const owner = { id: "app-user-a" };
  const row = {
    id: activityId,
    agentSession: { id: sessionId },
    user: owner,
    content: { __typename: "AgentActivityThoughtContent", type: "thought" },
  };
  const intent = { sessionId, activityId, kind: "thought" } as const;
  const session = { id: sessionId, appUser: owner };
  for (const [returnedSession, nodes, pageInfo, confirmed] of [
    [session, [row], completePage, true],
    [{ ...session, id: "sibling-session" }, [row], completePage, false],
    [{ ...session, appUser: { id: "app-user-b" } }, [row], completePage, false],
    [session, [{ ...row, id: "another-activity" }], completePage, false],
    [session, [{ ...row, user: { id: "app-user-b" } }], completePage, false],
    [session, [{ ...row, agentSession: { id: "sibling-session" } }], completePage, false],
    [
      session,
      [{ ...row, content: { __typename: "AgentActivityResponseContent", type: "response" } }],
      completePage,
      false,
    ],
    [session, [row, row], completePage, false],
    [session, [row], { ...completePage, hasNextPage: true }, false],
    [session, [row], { ...completePage, hasPreviousPage: true }, false],
    [session, [], completePage, false],
  ] as const) {
    const fixture = linearAgentFixture((operation, call) => {
      assert.equal(operation, "PaseoAgentActivityReadback");
      assert.match(call.query, /\$activityId: ID!/u);
      assert.match(call.query, /first: 1, filter: \{ id: \{ eq: \$activityId \} \}/u);
      assert.deepEqual(call.variables, { sessionId, activityId });
      return { data: { agentSession: { ...returnedSession, activities: { nodes, pageInfo } } } };
    });
    assert.equal(await client(fixture).isActivityConfirmed(intent), confirmed);
    assert.equal(fixture.calls.length, 2);
  }
  const failed = linearAgentFixture(() => ({ errors: [{ message: "unavailable" }] }));
  assert.equal(await client(failed).isActivityConfirmed(intent), false);
  assert.equal(failed.calls.length, 2);
});

const pilotActivityId = "e27e05f1-2df9-48d9-bcd1-f62989048b85";
const nonV4ActivityId = "bc3df002-8eba-517f-8202-a571fcd5daf5";
const pilotActivity = { ...activity, activityId: pilotActivityId };
const pilotReadback = { sessionId, activityId: pilotActivityId, kind: "thought" } as const;

it("pilot history reads only a verified prompt and a bounded preceding page through L1", async () => {
  const createdAt = "2026-01-01T00:00:06.000Z";
  const owner = { id: "pilot-owner" };
  const appUser = { id: "app-user-a" };
  const issue = { id: "active-issue" };
  const prompt = {
    id: activityId,
    createdAt,
    agentSession: { id: sessionId },
    user: owner,
    promptAuthor: owner,
    signal: null,
    content: { __typename: "AgentActivityPromptContent", type: "prompt", body: "Owner prompt" },
  };
  const fixture = linearAgentFixture((operation) => ({
    data: {
      agentSession: {
        id: sessionId,
        appUser,
        issue,
        activities: {
          nodes: operation === "PaseoPilotPrompt" ? [prompt] : [],
          pageInfo: completePage,
        },
      },
    },
  }));
  const options = { ...fixture.options, binding: linearAgentBinding(fixture.a) };
  const pilot = createLinearAgentClient({ ...options, pilotOperations: true });
  const scope = {
    sessionId,
    issueId: issue.id,
    appUserId: appUser.id,
    allowedHumanProviderUserId: owner.id,
  };
  const anchor = { activityId, body: prompt.content.body };

  await assert.rejects(createLinearAgentClient(options).readPilotPrompt(scope, anchor), {
    code: "invalid_input",
  });
  assert.equal(fixture.lookups.length, 0);
  assert.equal(
    (await pilot.readPilotPrompt(scope, anchor))?.activities.nodes[0]?.content.body,
    anchor.body,
  );
  assert.deepEqual(fixture.calls.at(-1)?.variables, { sessionId, activityId });
  assert.equal(
    await pilot.readPilotPrompt({ ...scope, issueId: "other-issue" }, anchor),
    undefined,
  );
  assert.equal((await pilot.readPilotHistory(scope, createdAt))?.activities.nodes.length, 0);
  assert.deepEqual(fixture.calls.at(-1)?.variables, { sessionId, before: createdAt });
  assert.match(fixture.calls.at(-1)?.query ?? "", /first: 24/u);

  fixture.approved.delete(fixture.a.id);
  const previousLookups = fixture.lookups.length;
  await assert.rejects(pilot.readPilotHistory(scope, createdAt), { code: "policy_required" });
  assert.equal(fixture.lookups.length, previousLookups);
});

it("pilot UUIDv4 round-trips through create and exact readback", async () => {
  let resultId = pilotActivityId;
  const fixture = linearAgentFixture((operation, call) => {
    if (operation === "PaseoAgentActivityCreate") {
      assert.deepEqual(call.variables, {
        input: { agentSessionId: sessionId, id: pilotActivityId, content: thought },
      });
      return activityResult("app-user-a", true, resultId);
    }
    assert.equal(operation, "PaseoAgentActivityReadback");
    assert.deepEqual(call.variables, { sessionId, activityId: pilotActivityId });
    const appUser = { id: "app-user-a" };
    const row = {
      id: resultId,
      agentSession: { id: sessionId },
      user: appUser,
      content: { __typename: "AgentActivityThoughtContent", type: "thought" },
    };
    return {
      data: {
        agentSession: {
          id: sessionId,
          appUser,
          activities: { nodes: [row], pageInfo: completePage },
        },
      },
    };
  });
  const options = {
    ...fixture.options,
    binding: linearAgentBinding(fixture.a),
    pilotOperations: true as const,
  };
  const pilot = createLinearAgentClient(options);
  assert.equal(await pilot.createActivity(pilotActivity), pilotActivityId);
  assert.equal(await pilot.isActivityConfirmed(pilotReadback), true);
  resultId = activityId;
  await assert.rejects(pilot.createActivity(pilotActivity), { code: "mutation_unconfirmed" });
  assert.equal(await pilot.isActivityConfirmed(pilotReadback), false);
  const calls = fixture.calls.length;
  await assert.rejects(pilot.createActivity({ ...activity, activityId: nonV4ActivityId }), {
    code: "invalid_input",
  });
  await assert.rejects(
    pilot.isActivityConfirmed({ ...pilotReadback, activityId: nonV4ActivityId }),
    {
      code: "invalid_input",
    },
  );
  assert.equal(fixture.calls.length, calls);
});

it("pilot UUIDv5 is refused by the default client before authority lookup or transport", async () => {
  const fixture = linearAgentFixture();
  const defaultClient = client(fixture);
  await assert.rejects(
    defaultClient.createActivity({ ...pilotActivity, activityId: nonV4ActivityId }),
    {
      code: "invalid_input",
    },
  );
  await assert.rejects(
    defaultClient.isActivityConfirmed({ ...pilotReadback, activityId: nonV4ActivityId }),
    {
      code: "invalid_input",
    },
  );
  assert.deepEqual(fixture.lookups, []);
  assert.deepEqual(fixture.calls, []);
});

it("pilot busy response requires the continue signal in mutation and exact readback", async () => {
  const content = { type: "response", body: "The earlier turn is still running." } as const;
  const request = { ...pilotActivity, content, signal: "continue" } as const;
  const readback = { ...pilotReadback, kind: "response", signal: "continue" } as const;
  let returnedSignal: "continue" | "stop" | null = "continue";
  const appUser = { id: "app-user-a" };
  const fixture = linearAgentFixture((operation, call) => {
    assert.match(call.query, /\bsignal\b/u);
    const row = {
      id: pilotActivityId,
      agentSession: { id: sessionId },
      user: appUser,
      signal: returnedSignal,
    };
    if (operation === "PaseoAgentActivityCreate") {
      assert.deepEqual(call.variables, {
        input: { agentSessionId: sessionId, id: pilotActivityId, content, signal: "continue" },
      });
      return { data: { agentActivityCreate: { success: true, agentActivity: row } } };
    }
    assert.equal(operation, "PaseoAgentActivityReadback");
    assert.deepEqual(call.variables, { sessionId, activityId: pilotActivityId });
    return {
      data: {
        agentSession: {
          id: sessionId,
          appUser,
          activities: {
            nodes: [
              { ...row, content: { __typename: "AgentActivityResponseContent", type: "response" } },
            ],
            pageInfo: completePage,
          },
        },
      },
    };
  });
  const opts = { ...fixture.options, binding: linearAgentBinding(fixture.a) };
  const pilot = createLinearAgentClient({ ...opts, pilotOperations: true });
  assert.equal(await pilot.createActivity(request), pilotActivityId);
  assert.equal(await pilot.isActivityConfirmed(readback), true);
  returnedSignal = null;
  await assert.rejects(pilot.createActivity(request), { code: "mutation_unconfirmed" });
  assert.equal(await pilot.isActivityConfirmed(readback), false);
  returnedSignal = "stop";
  assert.equal(await pilot.isActivityConfirmed(readback), false);

  const calls = fixture.calls.length;
  const defaultClient = createLinearAgentClient(opts);
  await assert.rejects(defaultClient.createActivity({ ...request, activityId }), {
    code: "invalid_input",
  });
  await assert.rejects(defaultClient.isActivityConfirmed({ ...readback, activityId }), {
    code: "invalid_input",
  });
  await assert.rejects(pilot.createActivity({ ...request, content: thought }), {
    code: "invalid_input",
  });
  await assert.rejects(pilot.isActivityConfirmed({ ...readback, kind: "thought" }), {
    code: "invalid_input",
  });
  assert.equal(fixture.calls.length, calls);
});

it("addition of the authenticated Hub URL does not overwrite existing URLs", async () => {
  const links = [{ label: "Existing", url: "https://example.test/existing" }];
  const fixture = linearAgentFixture((operation, call) => {
    assert.equal(operation, "PaseoAgentSessionAddHubUrl");
    assert.deepEqual(call.variables, {
      sessionId,
      input: { addedExternalUrls: [{ label: "Open in Paseo Hub", url: hubUrl }] },
    });
    links.push({ label: "Open in Paseo Hub", url: hubUrl });
    return {
      data: {
        agentSessionUpdate: {
          success: true,
          agentSession: { id: sessionId, appUser: { id: "app-user-a" } },
        },
      },
    };
  });
  await client(fixture).addHubUrl({ sessionId, url: hubUrl });
  assert.deepEqual(links, [
    { label: "Existing", url: "https://example.test/existing" },
    { label: "Open in Paseo Hub", url: hubUrl },
  ]);
  await assert.rejects(client(fixture).addHubUrl({ sessionId, url: hubUrl + "?secret=x" }), {
    code: "invalid_input",
  });
  await assert.rejects(
    client(fixture).addHubUrl({ sessionId, url: hubUrl.replace("hub.example", "other.example") }),
    {
      code: "invalid_input",
    },
  );
  assert.equal(fixture.calls.length, 2);
});

it("app handle lookup verifies the viewer actor and workspace before returning a bounded name", async () => {
  const fixture = linearAgentFixture();
  const viewer = appViewer(fixture.a);
  assert.deepEqual(await client(fixture).readAppViewer(), {
    appUserId: viewer.id,
    linearOrganizationId: viewer.organization.id,
    handle: viewer.displayName,
  });
  fixture.setViewer({ ...viewer, displayName: "x".repeat(257) });
  assert.equal((await client(fixture).readAppViewer()).handle, viewer.name);
  fixture.setViewer({ ...viewer, displayName: " ", name: "x".repeat(257) });
  await assert.rejects(client(fixture).readAppViewer(), { code: "invalid_response" });
  for (const mismatch of [
    { id: fixture.b.appUserId },
    { organization: { id: fixture.b.linearOrganizationId } },
    { app: false },
    { active: false },
  ]) {
    fixture.setViewer({ ...viewer, ...mismatch });
    await assert.rejects(client(fixture).readAppViewer(), { code: "connection_not_owned" });
  }
  assert.ok(fixture.calls.every(({ query }) => query.startsWith("query PaseoAgentViewer")));
});

it("uses the shared refresh lease and retains the exact connection and pilot scopes", async () => {
  const fixture = linearAgentFixture(() => success);
  fixture.connections.set(fixture.a.linearOrganizationId, {
    ...fixture.a,
    accessTokenExpiresAt: new Date(0),
  });
  assert.deepEqual(
    await Promise.all([
      client(fixture).createActivity(activity),
      client(fixture).createActivity(activity),
    ]),
    [activityId, activityId],
  );
  assert.deepEqual(fixture.refreshTokens, [fixture.a.refreshToken]);
  assert.ok(fixture.calls.every(({ bearer }) => bearer === "Bearer fake-rotated-access"));
  assert.equal(
    fixture.connections.get(fixture.b.linearOrganizationId)?.accessToken,
    fixture.b.accessToken,
  );

  const downgraded = linearAgentFixture();
  downgraded.setRefreshScopes(downgraded.a.scopes.filter((scope) => scope !== "write"));
  downgraded.connections.set(downgraded.a.linearOrganizationId, {
    ...downgraded.a,
    accessTokenExpiresAt: new Date(0),
  });
  await assert.rejects(client(downgraded).createActivity(activity), { code: "scope_missing" });
  assert.equal(downgraded.refreshTokens.length, 1);
  assert.deepEqual(downgraded.calls, []);
});

it.each([
  ["accessToken", false],
  ["refreshToken", false],
  ["accessToken", true],
  ["refreshToken", true],
] as const)(
  "rejects a stored %s before provider transport (expired: %s)",
  async (field, expired) => {
    const fixture = linearAgentFixture(() => success);
    const connection = { ...fixture.a, accessTokenExpiresAt: expired ? new Date(0) : null };
    fixture.connections.set(connection.linearOrganizationId, connection);
    const token = connection[field];
    assert.ok(token);

    await assert.rejects(
      client(fixture).createActivity({
        ...activity,
        content: { ...thought, body: `Text ${token}` },
      }),
      { code: "credential_in_payload" },
    );
    assert.deepEqual(
      {
        viewer: fixture.calls.filter(({ query }) => query.startsWith("query PaseoAgentViewer"))
          .length,
        mutation: fixture.calls.filter(({ query }) => query.startsWith("mutation")).length,
        refresh: fixture.refreshTokens.length,
      },
      { viewer: 0, mutation: 0, refresh: 0 },
    );
  },
);

it("rejects a newly learned credential after refresh and before GraphQL", async () => {
  const fixture = linearAgentFixture(() => success);
  fixture.connections.set(fixture.a.linearOrganizationId, {
    ...fixture.a,
    accessTokenExpiresAt: new Date(0),
  });

  await assert.rejects(
    client(fixture).createActivity({
      ...activity,
      content: { ...thought, body: "Text fake-rotated-refresh" },
    }),
    { code: "credential_in_payload" },
  );
  assert.deepEqual(
    { graphql: fixture.calls.length, refresh: fixture.refreshTokens.length },
    { graphql: 0, refresh: 1 },
  );
});

it("reads bounded pages of active human members of the exact authorized team and workspace", async () => {
  const organization = { id: "linear-org-a" };
  const member = {
    id: "human-a",
    name: "Example Person",
    displayName: "Example",
    active: true,
    app: false,
    organization,
  };
  let team = {
    id: "team-a",
    organization,
    members: {
      nodes: [
        member,
        { ...member, id: "human-b", active: false },
        { ...member, id: "bot-a", app: true },
        { ...member, id: "foreign-a", organization: { id: "linear-org-b" } },
      ],
      pageInfo: { ...completePage, hasNextPage: true, endCursor: "next-page-a" },
    },
  };
  const fixture = linearAgentFixture((operation, call) => {
    assert.equal(operation, "PaseoAgentTeamUsers");
    assert.match(call.query, /members\(first: 50, after: \$after, includeDisabled: false\)/u);
    assert.doesNotMatch(call.query, /email/u);
    assert.deepEqual(call.variables, { teamId: "team-a", after: "current-page-a" });
    return { data: { team } };
  });
  assert.deepEqual(
    await client(fixture).readEligibleUsers({ teamId: "team-a", after: "current-page-a" }),
    {
      users: [{ id: member.id, displayName: member.displayName }],
      nextCursor: "next-page-a",
    },
  );
  team = { ...team, organization: { id: "linear-org-b" } };
  await assert.rejects(
    client(fixture).readEligibleUsers({ teamId: "team-a", after: "current-page-a" }),
    {
      code: "connection_not_owned",
    },
  );
});

it("updates only the state after proving current delegation and the first started state", async () => {
  const team = { id: "team-a", organization: { id: "linear-org-a" } };
  const state = { id: "backlog-a", type: "backlog", archivedAt: null, team };
  const issue = { id: "issue-a", team, delegate: { id: "app-user-a" }, state };
  const nodes = [
    { ...state, id: "started-late", type: "started", position: 4 },
    { ...state, id: "started-first", type: "started", position: 2 },
    { ...state, id: "archived", type: "started", position: 0, archivedAt: "2024-01-02T00:00:00Z" },
  ];
  for (const [currentIssue, pageInfo, result] of [
    [issue, completePage, "started-first"],
    [{ ...issue, delegate: null }, completePage, undefined],
    [{ ...issue, state: { ...state, type: "completed" } }, completePage, undefined],
    [issue, { ...completePage, hasNextPage: true }, undefined],
  ] as const) {
    const fixture = linearAgentFixture((operation, call) => {
      if (operation === "PaseoAgentIssueStartContext") {
        assert.deepEqual(call.variables, { teamId: "team-a", issueId: "issue-a" });
        return { data: { issue: currentIssue, team: { ...team, states: { nodes, pageInfo } } } };
      }
      assert.equal(operation, "PaseoAgentIssueStart");
      assert.deepEqual(call.variables, { issueId: "issue-a", input: { stateId: "started-first" } });
      return {
        data: {
          issueUpdate: {
            success: true,
            issue: { id: "issue-a", state: { id: "started-first" }, team },
          },
        },
      };
    });
    assert.equal(
      await client(fixture).moveIssueToStarted({ teamId: "team-a", issueId: "issue-a" }),
      result,
    );
    assert.equal(
      fixture.calls.filter(({ query }) => query.startsWith("mutation")).length,
      result === undefined ? 0 : 1,
    );
  }
});

it("rechecks policy after viewer verification before sending a mutation", async () => {
  const fixture = linearAgentFixture(() => success);
  const api = createLinearAgentClient({
    ...fixture.options,
    binding: linearAgentBinding(fixture.a),
    authorize: async () => fixture.calls.length === 0,
  });
  await assert.rejects(api.createActivity(activity), { code: "policy_required" });
  assert.equal(fixture.calls.length, 1);
});

it("an exact activity ID with conflicting session or author evidence stays unconfirmed", async () => {
  for (const result of [
    { id: activityId, agentSession: { id: "other-session" }, user: { id: "app-user-a" } },
    { id: activityId, agentSession: { id: sessionId }, user: { id: "app-user-b" } },
  ]) {
    const fixture = linearAgentFixture(() => ({
      data: { agentActivityCreate: { success: true, agentActivity: result } },
    }));
    await assert.rejects(client(fixture).createActivity(activity), {
      code: "mutation_unconfirmed",
    });
    assert.equal(fixture.calls.length, 2);
  }
});

it("checks policy outside the refresh transaction so a single database connection can refresh", async () => {
  const fixture = linearAgentFixture(() => success);
  fixture.connections.set(fixture.a.linearOrganizationId, {
    ...fixture.a,
    accessTokenExpiresAt: new Date(0),
  });
  let leaseHeld = false;
  const api = createLinearAgentClient({
    ...fixture.options,
    binding: linearAgentBinding(fixture.a),
    authorize: async () => {
      assert.equal(leaseHeld, false);
      return true;
    },
    withLinearConnectionRefresh: (workspaceId, operation) =>
      fixture.options.withLinearConnectionRefresh(workspaceId, async (row, update) => {
        leaseHeld = true;
        try {
          return await operation(row, update);
        } finally {
          leaseHeld = false;
        }
      }),
  });
  assert.equal(await api.createActivity(activity), activityId);
  assert.equal(fixture.refreshTokens.length, 1);
});

it("refuses a pilot refresh when the lease omits its transaction query handle", async () => {
  const fixture = linearAgentFixture();
  fixture.connections.set(fixture.a.linearOrganizationId, {
    ...fixture.a,
    accessTokenExpiresAt: new Date(0),
  });
  let checkedAuthority = false;
  const api = createLinearAgentClient({
    ...fixture.options,
    binding: linearAgentBinding(fixture.a),
    pilotOperations: true,
    authorizeRefresh: async () => {
      checkedAuthority = true;
      return true;
    },
  });
  await assert.rejects(api.readAppViewer(), { code: "policy_required" });
  assert.equal(checkedAuthority, false);
  assert.equal(fixture.refreshTokens.length, 0);
  assert.equal(fixture.calls.length, 0);
});

const generatedActivityShapes = [
  { content: thought, ephemeral: true },
  { content: { type: "action", action: "Read", parameter: "Example" }, ephemeral: false },
  { content: { type: "elicitation", body: "Which item?" } },
  { content: { type: "response", body: "Done." } },
  { content: { type: "error", body: "Unavailable." } },
] as const;

const rejectedActivityShapes = [
  { content: { type: "thought", body: "" } },
  { content: { type: "action", action: "Read", parameter: "" } },
  { content: { type: "response", body: "Done." }, ephemeral: true },
] as const;

function generatedActivityId(index: number) {
  return `b8bcd579-cad0-454e-9d1f-${index.toString(16).padStart(12, "0")}`;
}

function admissionError(
  policy: boolean | undefined,
  bindingMatches: boolean,
  scopesMatch: boolean,
) {
  if (policy !== true) return "policy_required";
  if (!bindingMatches) return "connection_not_owned";
  if (!scopesMatch) return "scope_missing";
  return undefined;
}

function* generatedAdmissionCases(
  connection: ReturnType<typeof linearAgentFixture>["a"],
  other: ReturnType<typeof linearAgentFixture>["b"],
) {
  const exact = linearAgentBinding(connection);
  const bindings = [
    exact,
    { ...exact, id: other.id },
    { ...exact, organizationId: other.organizationId },
    { ...exact, linearOrganizationId: other.linearOrganizationId },
    { ...exact, providerApplicationId: "unrelated-app" },
    { ...exact, appUserId: other.appUserId },
  ];
  const scopeSets = [
    connection.scopes,
    ...connection.scopes.map((removed) => connection.scopes.filter((scope) => scope !== removed)),
  ];
  for (const binding of bindings) {
    for (const policy of [true, false, undefined]) {
      for (const scopes of scopeSets) {
        const code = admissionError(policy, binding === exact, scopes === connection.scopes);
        yield { binding, policy, scopes, code };
      }
    }
  }
}

async function checkGeneratedAdmission({
  api,
  fixture,
  shape,
  index,
  code,
  caseCount,
}: {
  api: ReturnType<typeof createLinearAgentClient>;
  fixture: ReturnType<typeof linearAgentFixture>;
  shape: (typeof generatedActivityShapes)[number] | (typeof rejectedActivityShapes)[number];
  index: number;
  code: string | undefined;
  caseCount: number;
}) {
  const generatedId = generatedActivityId(caseCount);
  const before = fixture.calls.length;
  const beforeLookups = fixture.lookups.length;
  const expectedError = index < generatedActivityShapes.length ? code : "invalid_input";
  const attempt = api.createActivity({ sessionId, activityId: generatedId, ...shape });
  const label = `generated admission case ${caseCount}`;
  if (expectedError !== undefined) {
    await assert.rejects(attempt, { code: expectedError }, label);
    assert.equal(fixture.calls.length, before, label);
  } else {
    assert.equal(await attempt, generatedId, label);
    assert.equal(fixture.calls.length - before, 2, label);
  }
  if (expectedError === "policy_required" || expectedError === "invalid_input") {
    assert.equal(fixture.lookups.length, beforeLookups, label);
  }
  return expectedError === undefined ? 0 : 1;
}

it("rejects generated unauthorized or malformed activity inputs before transport", async () => {
  let caseCount = 0;
  let rejectedCount = 0;
  for (const workspace of ["a", "b"] as const) {
    const fixture = linearAgentFixture((operation, call) => {
      assert.equal(operation, "PaseoAgentActivityCreate");
      assert.equal(call.bearer, `Bearer ${fixture[workspace].accessToken}`);
      const input = call.variables["input"];
      assert.ok(
        input && typeof input === "object" && "id" in input && typeof input.id === "string",
      );
      return activityResult(fixture[workspace].appUserId, true, input.id);
    });
    const connection = fixture[workspace];
    const other = workspace === "a" ? fixture.b : fixture.a;
    for (const { binding, policy, scopes, code } of generatedAdmissionCases(connection, other)) {
      fixture.connections.set(connection.linearOrganizationId, {
        ...connection,
        scopes,
        accessTokenExpiresAt: scopes === connection.scopes ? null : new Date(0),
      });
      const api = createLinearAgentClient({
        ...fixture.options,
        binding,
        authorize: async () => policy,
      });
      for (const [index, shape] of [
        ...generatedActivityShapes,
        ...rejectedActivityShapes,
      ].entries()) {
        rejectedCount += await checkGeneratedAdmission({
          api,
          fixture,
          shape,
          index,
          code,
          caseCount: ++caseCount,
        });
      }
    }
    assert.equal(fixture.refreshTokens.length, 0);
  }
  assert.equal(caseCount, 1_728);
  assert.equal(rejectedCount, 1_718);
});

const generatedReadbackCases = [
  "complete",
  "missing",
  "has next page",
  "has previous page",
  "duplicate rows",
  "wrong session",
  "wrong owner",
  "wrong activity",
  "wrong parent",
  "wrong author",
  "wrong kind",
  "GraphQL error",
] as const;

const generatedContentTypes = {
  thought: "AgentActivityThoughtContent",
  action: "AgentActivityActionContent",
  elicitation: "AgentActivityElicitationContent",
  response: "AgentActivityResponseContent",
  error: "AgentActivityErrorContent",
} as const;

function generatedReadbackPayload(
  scenario: (typeof generatedReadbackCases)[number],
  generatedId: string,
  appUserId: string,
  kind: keyof typeof generatedContentTypes,
) {
  const row = {
    id: scenario === "wrong activity" ? activityId : generatedId,
    agentSession: { id: scenario === "wrong parent" ? "other-session" : sessionId },
    user: { id: scenario === "wrong author" ? "other-actor" : appUserId },
    content:
      scenario === "wrong kind"
        ? { __typename: "AgentActivityPromptContent", type: "prompt" }
        : { __typename: generatedContentTypes[kind], type: kind },
  };
  const nodes = scenario === "missing" ? [] : [row];
  if (scenario === "duplicate rows") nodes.push(row);
  return {
    data: {
      agentSession: {
        id: scenario === "wrong session" ? "other-session" : sessionId,
        appUser: { id: scenario === "wrong owner" ? "other-actor" : appUserId },
        activities: {
          nodes,
          pageInfo: {
            hasNextPage: scenario === "has next page",
            hasPreviousPage: scenario === "has previous page",
          },
        },
      },
    },
    ...(scenario === "GraphQL error" ? { errors: [{ message: "Synthetic readback error" }] } : {}),
  };
}

function* reconciliationVariants() {
  for (const scenario of generatedReadbackCases) {
    for (let variant = 0; variant < 5; variant += 1) yield scenario;
  }
}

function* generatedReconciliationCases() {
  for (const workspace of ["a", "b"] as const) {
    for (const shape of generatedActivityShapes) {
      for (const scenario of reconciliationVariants()) yield { workspace, shape, scenario };
    }
  }
}

it("confirms only exact generated readbacks and never repeats an ambiguous append", async () => {
  let caseCount = 0;
  let confirmedCount = 0;
  for (const { workspace, shape, scenario } of generatedReconciliationCases()) {
    const generatedId = generatedActivityId(1_728 + ++caseCount);
    const label = `generated reconciliation case ${caseCount} (${scenario})`;
    const kind = shape.content.type;
    const fixture = linearAgentFixture((operation) => {
      if (operation === "PaseoAgentActivityCreate") {
        throw new Error("Synthetic lost append response");
      }
      return generatedReadbackPayload(scenario, generatedId, fixture[workspace].appUserId, kind);
    });
    const api = client(fixture, fixture[workspace]);
    await assert.rejects(
      api.createActivity({ sessionId, activityId: generatedId, ...shape }),
      { code: "request_failed" },
      label,
    );
    const confirmed = await api.isActivityConfirmed({ sessionId, activityId: generatedId, kind });
    assert.equal(confirmed, scenario === "complete", label);
    assert.deepEqual(
      fixture.calls.map(({ query }) => /^(?:query|mutation) (\w+)/u.exec(query)?.[1]),
      [
        "PaseoAgentViewer",
        "PaseoAgentActivityCreate",
        "PaseoAgentViewer",
        "PaseoAgentActivityReadback",
      ],
      label,
    );
    assert.ok(
      fixture.calls.every(({ bearer }) => bearer === `Bearer ${fixture[workspace].accessToken}`),
      label,
    );
    assert.deepEqual(
      fixture.calls[1]?.variables,
      { input: { agentSessionId: sessionId, id: generatedId, ...shape } },
      label,
    );
    assert.deepEqual(fixture.calls[3]?.variables, { sessionId, activityId: generatedId }, label);
    assert.equal(fixture.refreshTokens.length, 0, label);
    if (confirmed) confirmedCount += 1;
  }
  assert.equal(caseCount, 600);
  assert.equal(confirmedCount, 50);
});

it("bounds local work for the 20,000-byte activity boundary", async () => {
  const body = "x".repeat(20_000);
  const atLimit = { ...activity, content: { type: "response", body } } as const;
  const oversized = { ...atLimit, content: { ...atLimit.content, body: body + "x" } };

  const accepted = linearAgentFixture((operation, call) => {
    assert.equal(operation, "PaseoAgentActivityCreate");
    const expected = {
      input: { agentSessionId: sessionId, id: activityId, content: atLimit.content },
    };
    assert.ok(
      JSON.stringify(call.variables) === JSON.stringify(expected),
      "boundary input changed",
    );
    return success;
  });
  const allowedClient = client(accepted);
  const writeStart = performance.now();
  assert.equal(await allowedClient.createActivity(atLimit), activityId);
  const writeMs = performance.now() - writeStart;
  assert.equal(accepted.calls.length, 2);
  assert.equal(
    accepted.calls.filter(({ query }) => query.startsWith("query PaseoAgentViewer")).length,
    1,
  );
  assert.equal(accepted.calls.filter(({ query }) => query.startsWith("mutation")).length, 1);
  assert.equal(accepted.refreshTokens.length, 0);

  const refused = linearAgentFixture();
  const refusedClient = client(refused);
  const oversizeStart = performance.now();
  await assert.rejects(refusedClient.createActivity(oversized), { code: "invalid_input" });
  const oversizedMs = performance.now() - oversizeStart;
  assert.equal(refused.calls.length, 0);
  assert.equal(refused.lookups.length, 0);

  refused.approved.delete(refused.a.id);
  const declineStart = performance.now();
  await assert.rejects(refusedClient.createActivity(atLimit), { code: "policy_required" });
  const deniedMs = performance.now() - declineStart;
  assert.equal(refused.calls.length, 0);
  assert.equal(refused.lookups.length, 0);
  assert.equal(refused.refreshTokens.length, 0);

  const boundMs = 1_000;
  const measurements = `write=${writeMs.toFixed(3)}ms oversized=${oversizedMs.toFixed(3)}ms denied=${deniedMs.toFixed(3)}ms`;
  assert.ok(Math.max(writeMs, oversizedMs, deniedMs) < boundMs, measurements);
  process.stdout.write(`Linear activity boundary: ${measurements}\n`);
});
