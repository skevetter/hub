import { z } from "zod";
import { DELEGATION_HISTORY_LIMIT, delegationReadback } from "../../linear-pilot/delegation.js";
import {
  readPilotPriorPage,
  readPilotPromptPage,
  type PilotHistoryScope,
} from "../../linear-pilot/history-read.js";
import type { QueryHandle } from "../../db/runtime/index.js";
import type { LinearConnectionRecord, LinearConnectionRefreshOperation } from "../../db/types.js";
import {
  hasRequiredLinearScopes,
  hasUsableLinearAccessToken,
  LinearApiError,
  LinearCredentialError,
  requestLinearAgentGraphql,
  type createLinearApiClient,
  type LinearConnectionBinding,
} from "./client.js";

export const LINEAR_AGENT_FALLBACK_TITLE = "Linear agent session";

const requestTimeoutMs = 8_000;
const pageSize = 50;
const displayNameLimit = 256;
const id = z.string().min(1).max(255);
const ref = z.object({ id });
const workspaceRef = ref.extend({ organization: ref });
const user = workspaceRef.extend({
  active: z.boolean(),
  app: z.boolean(),
  name: z.string(),
  displayName: z.string(),
});
const pageFlags = z.object({ hasNextPage: z.boolean(), hasPreviousPage: z.boolean() });
const cursor = z.string().min(1).max(1024);
const state = ref.extend({ type: z.string(), archivedAt: z.string().nullable(), team: ref });
const sessionOwner = ref.extend({ appUser: ref });

const activityKind = z.enum(["thought", "action", "elicitation", "response", "error"]);
const body = z.string().min(1).max(20_000);
const historyScope = z.strictObject({
  sessionId: id,
  issueId: id,
  appUserId: id,
  allowedHumanProviderUserId: id,
});
const historyPrompt = z.strictObject({ activityId: z.uuid(), body });
const historyAnchorTime = z.iso.datetime({ offset: true });
const activityContentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("thought"), body }),
  z.strictObject({
    type: z.literal("action"),
    action: body,
    parameter: body,
    result: body.optional(),
  }),
  z.strictObject({ type: z.literal("elicitation"), body }),
  z.strictObject({ type: z.literal("response"), body }),
  z.strictObject({ type: z.literal("error"), body }),
]);
const linkInput = z.strictObject({ sessionId: id, url: z.url().max(2048) });
const membersInput = z.strictObject({ teamId: id, after: cursor.optional() });
const beginInput = z.strictObject({ teamId: id, issueId: id });

export type LinearAgentActivityContent = z.infer<typeof activityContentSchema>;

const contentTypename = {
  thought: "AgentActivityThoughtContent",
  action: "AgentActivityActionContent",
  elicitation: "AgentActivityElicitationContent",
  response: "AgentActivityResponseContent",
  error: "AgentActivityErrorContent",
} satisfies Record<z.infer<typeof activityKind>, string>;

const continueSignal = z.literal("continue").optional();
const returnedSignal = z.literal("continue").nullable().optional();

const activityIdSchema = z.uuidv4();
const activity = ref.extend({
  id: activityIdSchema,
  agentSession: ref,
  user: ref,
  signal: returnedSignal,
});
const activityInput = z.strictObject({
  sessionId: id,
  activityId: activityIdSchema,
  content: activityContentSchema,
  ephemeral: z.boolean().optional(),
  signal: continueSignal,
});
const readbackInput = z.strictObject({
  sessionId: id,
  activityId: activityIdSchema,
  kind: activityKind,
  signal: continueSignal,
});
const createResult = z.object({
  agentActivityCreate: z.object({ success: z.boolean(), agentActivity: activity }),
});
const readbackResult = z.object({
  agentSession: sessionOwner.extend({
    activities: z.object({
      nodes: z
        .array(
          activity.extend({
            content: z.object({ __typename: z.string(), type: activityKind }),
          }),
        )
        .max(1),
      pageInfo: pageFlags,
    }),
  }),
});

const errorMessages = {
  invalid_input: "Invalid Linear agent operation input",
  invalid_response: "Invalid Linear agent operation response",
  mutation_unconfirmed: "Linear agent mutation was unconfirmed",
  policy_required: "Linear agent connection policy is required",
  connection_not_owned: "Linear agent installation did not match the bound connection",
  connection_unavailable: "Linear agent connection is unavailable",
  connection_changed: "Linear agent connection credentials changed",
  scope_missing: "Linear agent connection lacks the pilot scopes",
  reauthorize: "Linear agent connection requires reauthorization",
  credential_in_payload: "Linear agent operation payload contains a credential",
  request_failed: "Linear agent provider request failed",
  cancelled: "Linear agent operation was cancelled or timed out",
} as const;

export interface LinearAgentErrorDetails {
  linearErrorType?: string;
  linearErrorKinds?: readonly string[];
}

export class LinearAgentError extends Error {
  constructor(
    readonly code: keyof typeof errorMessages,
    readonly status?: number,
    readonly details?: LinearAgentErrorDetails,
  ) {
    super(errorMessages[code]);
    this.name = "LinearAgentError";
  }
}

export type LinearAgentOperation =
  | { kind: "viewer" }
  | { kind: "createActivity" | "readActivity"; sessionId: string }
  | {
      kind: "readPilotPrompt" | "readPilotHistory" | "readDelegationOrigin";
      sessionId: string;
      issueId: string;
    }
  | { kind: "addHubUrl"; sessionId: string; url: string }
  | { kind: "readEligibleUsers"; teamId: string }
  | { kind: "moveIssueToStarted"; teamId: string; issueId: string };

type LinearAgentClientOptions = Pick<
  Parameters<typeof createLinearApiClient>[0],
  "connectionForLinearOrganization" | "withLinearConnectionRefresh" | "connectionClient" | "now"
> & {
  binding: LinearConnectionBinding;
  hubBaseUrl: string;
  fetch: typeof fetch;
  /** Enables pilot origin and history reads and response signals. */
  pilotOperations?: true;
  /** Resolve current policy and authority for this exact operation. Setup reads need an explicit policy too. */
  authorize(
    binding: Readonly<LinearConnectionBinding>,
    operation: Readonly<LinearAgentOperation>,
    signal: AbortSignal,
  ): Promise<boolean | undefined>;
  /** Pilot authority must be checked on the lease's connection after it acquires the lock. */
  authorizeRefresh?(
    query: QueryHandle,
    binding: Readonly<LinearConnectionBinding>,
    operation: Readonly<LinearAgentOperation>,
    signal: AbortSignal,
  ): Promise<boolean | undefined>;
};

type Send = <T>(
  query: string,
  variables: Record<string, unknown>,
  data: z.ZodType<T>,
) => Promise<T>;

const delegationOriginQuery = `query PaseoPilotDelegationOrigin($sessionId: String!) {
  agentSession(id: $sessionId) {
    id createdAt appUser { id } creator { id } comment { id } sourceComment { id }
    issue {
      id identifier title description team { id organization { id } }
      delegate { id } assignee { id }
      history(first: ${DELEGATION_HISTORY_LIMIT}, orderBy: createdAt) {
        nodes {
          id createdAt actor { id } botActor { id } toDelegate { id } toAssignee { id }
          triageResponsibilityAutoAssigned
        }
      }
    }
  }
}`;

type RunDelegationRead = (
  operation: LinearAgentOperation,
  variables: { sessionId: string },
  signal: AbortSignal,
  perform: (
    send: Send,
    viewer: z.infer<typeof user>,
    checkCurrent: () => Promise<void>,
  ) => Promise<z.infer<typeof delegationReadback>>,
) => Promise<z.infer<typeof delegationReadback>>;

async function fetchDelegationOrigin(
  send: Send,
  checkCurrent: () => Promise<void>,
  variables: { sessionId: string },
) {
  const result = await send(delegationOriginQuery, variables, delegationReadback);
  await checkCurrent();
  return result;
}

function delegationOriginReader(
  run: RunDelegationRead,
  requireScope: (input: PilotHistoryScope) => PilotHistoryScope,
) {
  return async function readDelegationOrigin(input: PilotHistoryScope, signal: AbortSignal) {
    const { sessionId, issueId } = requireScope(input);
    const variables = { sessionId };
    return run(
      { kind: "readDelegationOrigin", sessionId, issueId },
      variables,
      signal,
      (send, _viewer, checkCurrent) => fetchDelegationOrigin(send, checkCurrent, variables),
    );
  };
}

export function createLinearAgentClient(options: LinearAgentClientOptions) {
  const binding = Object.freeze({ ...options.binding });
  const hubOrigin = new URL(options.hubBaseUrl).origin;
  const now = options.now ?? (() => new Date());

  function requireHistoryScope(input: PilotHistoryScope) {
    const scope = parse(historyScope, input, "invalid_input");
    if (
      !options.pilotOperations ||
      scope.appUserId !== binding.appUserId ||
      scope.allowedHumanProviderUserId === binding.appUserId
    ) {
      throw new LinearAgentError("invalid_input");
    }
    return scope;
  }

  function checkConnection(connection: LinearConnectionRecord | undefined): LinearConnectionRecord {
    if (connection === undefined) throw new LinearAgentError("connection_unavailable");
    if (
      !binding.providerApplicationId ||
      !binding.appUserId ||
      !binding.linearOrganizationId ||
      connection.id !== binding.id ||
      connection.organizationId !== binding.organizationId ||
      connection.providerApplicationId !== binding.providerApplicationId ||
      !matchesActor(binding, connection.appUserId, connection.linearOrganizationId)
    ) {
      throw new LinearAgentError("connection_not_owned");
    }
    if (!hasRequiredLinearScopes(connection.scopes) || !connection.scopes.includes("write")) {
      throw new LinearAgentError("scope_missing");
    }
    return connection;
  }

  const readConnection = async () =>
    checkConnection(await options.connectionForLinearOrganization(binding.linearOrganizationId));

  async function run<T>(
    operation: LinearAgentOperation,
    inputVariables: Record<string, unknown>,
    callerSignal: AbortSignal | undefined,
    perform: (
      send: Send,
      viewer: z.infer<typeof user>,
      checkCurrent: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([timeout, callerSignal]);
    Object.freeze(operation);

    function checkSignal() {
      if (signal.aborted) throw new LinearAgentError("cancelled");
    }

    async function authorize() {
      checkSignal();
      const authorized = await options.authorize(binding, operation, signal);
      checkSignal();
      if (authorized !== true) throw new LinearAgentError("policy_required");
    }

    await authorize();
    const initial = await readConnection();
    checkSignal();
    const serializedInput = JSON.stringify(inputVariables);
    checkPayloadCredentials(serializedInput, initial);
    if (!hasUsableLinearAccessToken(initial, now())) {
      // Keep the ordinary authorizer outside the lease so it cannot wait for its own connection.
      await authorize();
      const refresh: LinearConnectionRefreshOperation<void> = async (row, update, query) => {
        checkSignal();
        const current = checkConnection(row);
        checkPayloadCredentials(serializedInput, current);
        if (hasUsableLinearAccessToken(current, now())) return;
        const { refreshToken } = current;
        if (refreshToken === null) throw new LinearAgentError("reauthorize");
        if (options.authorizeRefresh !== undefined) {
          if (query === undefined) throw new LinearAgentError("policy_required");
          const authorized = await options.authorizeRefresh(query, binding, operation, signal);
          checkSignal();
          if (authorized !== true) throw new LinearAgentError("policy_required");
        }
        const refreshed = await providerRequest(
          () => options.connectionClient.refresh(refreshToken, signal),
          signal,
          options.pilotOperations,
        );
        // A successful refresh can rotate the token even when a caller cancels.
        await update(refreshed);
      };
      if (options.authorizeRefresh !== undefined) refresh.requireReadCommitted = true;
      await options.withLinearConnectionRefresh(binding.linearOrganizationId, refresh);
    }

    await authorize();
    const connection = await readConnection();
    if (!hasUsableLinearAccessToken(connection, now())) throw new LinearAgentError("reauthorize");
    checkSignal();
    checkPayloadCredentials(serializedInput, connection);

    async function checkCurrent() {
      await authorize();
      const current = await readConnection();
      await authorize();
      if (
        !hasUsableLinearAccessToken(current, now()) ||
        current.accessToken !== connection.accessToken ||
        current.refreshToken !== connection.refreshToken
      ) {
        throw new LinearAgentError("connection_changed");
      }
    }

    const send: Send = async (query, variables, schema) => {
      await checkCurrent();
      const serialized = JSON.stringify(variables);
      checkPayloadCredentials(serialized, initial);
      checkPayloadCredentials(serialized, connection);
      const response = await providerRequest(
        () =>
          requestLinearAgentGraphql(
            options.fetch,
            connection.accessToken,
            query,
            variables,
            signal,
            now,
          ),
        signal,
        options.pilotOperations,
      );
      checkSignal();
      return parse(
        z.object({ data: schema, errors: z.never().optional() }),
        response,
        "invalid_response",
      ).data;
    };

    const { viewer } = await send(
      `query PaseoAgentViewer { viewer { id organization { id } active app displayName name } }`,
      {},
      z.object({ viewer: user }),
    );
    if (
      !viewer.active ||
      !viewer.app ||
      !matchesActor(binding, viewer.id, viewer.organization.id)
    ) {
      throw new LinearAgentError("connection_not_owned");
    }
    return perform(send, viewer, checkCurrent);
  }
  return {
    readDelegationOrigin: delegationOriginReader(run, requireHistoryScope),
    async readPilotPrompt(
      input: PilotHistoryScope,
      expected: z.input<typeof historyPrompt>,
      signal?: AbortSignal,
    ) {
      const scope = requireHistoryScope(input);
      const prompt = parse(historyPrompt, expected, "invalid_input");
      const { sessionId, issueId } = scope;
      return run(
        { kind: "readPilotPrompt", sessionId, issueId },
        { sessionId, activityId: prompt.activityId },
        signal,
        (send) => readPilotPromptPage(send, scope, prompt),
      );
    },

    async readPilotHistory(input: PilotHistoryScope, before: string, signal?: AbortSignal) {
      const scope = requireHistoryScope(input);
      const anchor = parse(historyAnchorTime, before, "invalid_input");
      const { sessionId, issueId } = scope;
      return run(
        { kind: "readPilotHistory", sessionId, issueId },
        { sessionId, before: anchor },
        signal,
        (send) => readPilotPriorPage(send, scope, anchor),
      );
    },

    async createActivity(
      input: z.input<typeof activityInput>,
      signal?: AbortSignal,
    ): Promise<string> {
      const {
        sessionId,
        activityId: expectedId,
        content,
        ephemeral,
        signal: expectedSignal,
      } = parse(activityInput, input, "invalid_input");
      if (ephemeral === true && content.type !== "thought" && content.type !== "action") {
        throw new LinearAgentError("invalid_input");
      }
      if (expectedSignal && (!options.pilotOperations || content.type !== "response")) {
        throw new LinearAgentError("invalid_input");
      }
      const variables = {
        input: {
          agentSessionId: sessionId,
          id: expectedId,
          content,
          ...(ephemeral === undefined ? {} : { ephemeral }),
          ...(expectedSignal ? { signal: expectedSignal } : {}),
        },
      };
      const operation = { kind: "createActivity", sessionId } as const;
      return run(operation, variables, signal, async (send, viewer) => {
        const { agentActivityCreate: result } = await send(
          `mutation PaseoAgentActivityCreate($input: AgentActivityCreateInput!) {
            agentActivityCreate(input: $input) { success agentActivity { id agentSession { id } user { id }${expectedSignal ? " signal" : ""} } }
          }`,
          variables,
          createResult,
        );
        requireMutation(
          result.success &&
            result.agentActivity.id === expectedId &&
            result.agentActivity.agentSession.id === sessionId &&
            result.agentActivity.user.id === viewer.id &&
            (expectedSignal === undefined || result.agentActivity.signal === expectedSignal),
        );
        return result.agentActivity.id;
      });
    },

    /** False means unconfirmed. Even a complete empty page cannot authorize an append. */
    async isActivityConfirmed(
      input: z.input<typeof readbackInput>,
      signal?: AbortSignal,
      onFailure?: (error: unknown) => void,
    ): Promise<boolean> {
      const {
        sessionId,
        activityId,
        kind,
        signal: expectedSignal,
      } = parse(readbackInput, input, "invalid_input");
      if (expectedSignal && (!options.pilotOperations || kind !== "response")) {
        throw new LinearAgentError("invalid_input");
      }
      const variables = { sessionId, activityId };
      try {
        return await run(
          { kind: "readActivity", sessionId },
          variables,
          signal,
          async (send, viewer, checkCurrent) => {
            const { agentSession } = await send(
              activityReadbackQuery(expectedSignal !== undefined),
              variables,
              readbackResult,
            );
            const {
              nodes: [row],
              pageInfo,
            } = agentSession.activities;
            await checkCurrent();
            return (
              agentSession.id === sessionId &&
              agentSession.appUser.id === viewer.id &&
              !pageInfo.hasNextPage &&
              !pageInfo.hasPreviousPage &&
              row !== undefined &&
              row.id === activityId &&
              row.agentSession.id === sessionId &&
              row.user.id === viewer.id &&
              row.content.type === kind &&
              row.content.__typename === contentTypename[kind] &&
              (expectedSignal === undefined || row.signal === expectedSignal)
            );
          },
        );
      } catch (error) {
        try {
          onFailure?.(error);
        } catch {
          // Diagnostics cannot change an unconfirmed readback into a rejection.
        }
        return false;
      }
    },

    async addHubUrl(input: z.input<typeof linkInput>, signal?: AbortSignal): Promise<void> {
      const { sessionId, url } = parse(linkInput, input, "invalid_input");
      const target = new URL(url);
      if (
        !["https:", "http:"].includes(target.protocol) ||
        target.origin !== hubOrigin ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        !/^\/o\/[a-z0-9_-]+\/sessions\/[a-z0-9_-]+\/?$/iu.test(target.pathname)
      ) {
        throw new LinearAgentError("invalid_input");
      }
      const variables = {
        sessionId,
        input: { addedExternalUrls: [{ label: "Open in Paseo Hub", url: target.href }] },
      };
      await run(
        { kind: "addHubUrl", sessionId, url: target.href },
        variables,
        signal,
        async (send, viewer) => {
          const { agentSessionUpdate: result } = await send(
            `mutation PaseoAgentSessionAddHubUrl($sessionId: String!, $input: AgentSessionUpdateInput!) {
            agentSessionUpdate(id: $sessionId, input: $input) { success agentSession { id appUser { id } } }
          }`,
            variables,
            z.object({
              agentSessionUpdate: z.object({ success: z.boolean(), agentSession: sessionOwner }),
            }),
          );
          requireMutation(
            result.success &&
              result.agentSession.id === sessionId &&
              result.agentSession.appUser.id === viewer.id,
          );
        },
      );
    },

    async readAppViewer(signal?: AbortSignal) {
      return run({ kind: "viewer" }, {}, signal, async (_send, viewer, checkCurrent) => {
        const handle = safeDisplayName(viewer);
        if (handle === undefined) throw new LinearAgentError("invalid_response");
        await checkCurrent();
        return { appUserId: viewer.id, linearOrganizationId: viewer.organization.id, handle };
      });
    },

    async readEligibleUsers(input: z.input<typeof membersInput>, signal?: AbortSignal) {
      const variables = parse(membersInput, input, "invalid_input");
      const { teamId, after } = variables;
      return run(
        { kind: "readEligibleUsers", teamId },
        variables,
        signal,
        async (send, viewer, checkCurrent) => {
          const { team } = await send(
            `query PaseoAgentTeamUsers($teamId: String!, $after: String) {
            team(id: $teamId) {
              id organization { id }
              members(first: ${pageSize}, after: $after, includeDisabled: false) {
                nodes { id name displayName active app organization { id } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
            variables,
            z.object({
              team: workspaceRef.extend({
                members: z.object({
                  nodes: z.array(user).max(pageSize),
                  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: cursor.nullable() }),
                }),
              }),
            }),
          );
          if (!matchesTeam(team, teamId, viewer.organization.id))
            throw new LinearAgentError("connection_not_owned");
          const { nodes, pageInfo } = team.members;
          const nextCursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
          if (pageInfo.hasNextPage && (nextCursor === null || nextCursor === after)) {
            throw new LinearAgentError("invalid_response");
          }
          const users = new Map<string, { id: string; displayName: string }>();
          for (const candidate of nodes) {
            const displayName = safeDisplayName(candidate);
            if (
              candidate.active &&
              !candidate.app &&
              candidate.id !== viewer.id &&
              candidate.organization.id === viewer.organization.id &&
              displayName !== undefined
            ) {
              users.set(candidate.id, { id: candidate.id, displayName });
            }
          }
          await checkCurrent();
          return { users: [...users.values()], nextCursor };
        },
      );
    },

    /** The authority check must establish a qualified human delegation before this method runs. */
    async moveIssueToStarted(
      input: z.input<typeof beginInput>,
      signal?: AbortSignal,
    ): Promise<string | undefined> {
      const variables = parse(beginInput, input, "invalid_input");
      const { teamId, issueId } = variables;
      const operation = { kind: "moveIssueToStarted", teamId, issueId } as const;
      return run(operation, variables, signal, async (send, viewer) => {
        const { team, issue } = await send(
          `query PaseoAgentIssueStartContext($teamId: String!, $issueId: String!) {
            team(id: $teamId) {
              id organization { id }
              states(first: ${pageSize}, includeArchived: false) {
                nodes { id type position archivedAt team { id } }
                pageInfo { hasNextPage hasPreviousPage }
              }
            }
            issue(id: $issueId) {
              id team { id organization { id } } delegate { id }
              state { id type archivedAt team { id } }
            }
          }`,
          variables,
          z.object({
            team: workspaceRef.extend({
              states: z.object({
                nodes: z.array(state.extend({ position: z.number() })).max(pageSize),
                pageInfo: pageFlags,
              }),
            }),
            issue: ref.extend({ team: workspaceRef, delegate: ref.nullable(), state }),
          }),
        );
        const organizationId = viewer.organization.id;
        if (
          issue.id !== issueId ||
          !matchesTeam(issue.team, teamId, organizationId) ||
          !matchesTeam(team, teamId, organizationId) ||
          issue.delegate?.id !== viewer.id ||
          issue.state.team.id !== teamId ||
          issue.state.archivedAt !== null ||
          !["triage", "backlog", "unstarted"].includes(issue.state.type) ||
          team.states.pageInfo.hasNextPage ||
          team.states.pageInfo.hasPreviousPage ||
          team.states.nodes.some((candidate) => candidate.team.id !== teamId)
        ) {
          return undefined;
        }
        const destination = team.states.nodes
          .filter((candidate) => candidate.type === "started" && candidate.archivedAt === null)
          .sort(
            (left, right) => left.position - right.position || left.id.localeCompare(right.id),
          )[0];
        if (destination === undefined || destination.id === issue.state.id) return undefined;
        const { issueUpdate: result } = await send(
          `mutation PaseoAgentIssueStart($issueId: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $issueId, input: $input) { success issue { id state { id } team { id organization { id } } } }
          }`,
          { issueId, input: { stateId: destination.id } },
          z.object({
            issueUpdate: z.object({
              success: z.boolean(),
              issue: ref.extend({ state: ref, team: workspaceRef }).nullable(),
            }),
          }),
        );
        requireMutation(
          result.success &&
            result.issue?.id === issueId &&
            result.issue.state.id === destination.id &&
            matchesTeam(result.issue.team, teamId, organizationId),
        );
        return destination.id;
      });
    },
  };
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: "invalid_input" | "invalid_response",
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LinearAgentError(code);
  return result.data;
}

function requireMutation(confirmed: boolean): void {
  if (!confirmed) throw new LinearAgentError("mutation_unconfirmed");
}

function checkPayloadCredentials(serialized: string, connection: LinearConnectionRecord) {
  for (const token of [connection.accessToken, connection.refreshToken]) {
    if (token && serialized.includes(JSON.stringify(token).slice(1, -1))) {
      throw new LinearAgentError("credential_in_payload");
    }
  }
}

function matchesActor(binding: LinearConnectionBinding, appUserId: string, organizationId: string) {
  return binding.appUserId === appUserId && binding.linearOrganizationId === organizationId;
}

function matchesTeam(team: z.infer<typeof workspaceRef>, teamId: string, organizationId: string) {
  return team.id === teamId && team.organization.id === organizationId;
}

function safeDisplayName({
  displayName,
  name,
}: Pick<z.infer<typeof user>, "displayName" | "name">) {
  return [displayName, name]
    .map((value) => value.trim())
    .find(
      (value) =>
        value.length > 0 &&
        value.length <= displayNameLimit &&
        !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value),
    );
}

function activityReadbackQuery(includeSignal: boolean) {
  return `query PaseoAgentActivityReadback($sessionId: String!, $activityId: ID!) {
              agentSession(id: $sessionId) {
                id appUser { id }
                activities(first: 1, filter: { id: { eq: $activityId } }) {
                  nodes {
                    id agentSession { id } user { id }${includeSignal ? " signal" : ""}
                    content {
                      __typename
                      ... on AgentActivityThoughtContent { type }
                      ... on AgentActivityActionContent { type }
                      ... on AgentActivityElicitationContent { type }
                      ... on AgentActivityResponseContent { type }
                      ... on AgentActivityErrorContent { type }
                    }
                  }
                  pageInfo { hasNextPage hasPreviousPage }
                }
              }
            }`;
}

const knownErrorTypes: ReadonlySet<string> = new Set([
  "feature not accessible",
  "invalid input",
  "ratelimited",
  "network error",
  "authentication error",
  "forbidden",
  "bootstrap error",
  "unknown",
  "internal error",
  "other",
  "user error",
  "graphql error",
  "lock timeout",
  "usage limit exceeded",
]);
// Linear does not document error codes, so unlisted codes log as "other".
const knownErrorCodes: ReadonlySet<string> = new Set([
  "AUTHENTICATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "RATELIMITED",
  "BAD_USER_INPUT",
  "NOT_FOUND",
  "INTERNAL_SERVER_ERROR",
  "INPUT_ERROR",
  "GRAPHQL_VALIDATION_FAILED",
  "GRAPHQL_PARSE_FAILED",
]);

function safeProviderDetails(error: LinearApiError): LinearAgentErrorDetails {
  const { graphqlErrorType, graphqlCodes } = error;
  return {
    ...(graphqlErrorType === undefined
      ? {}
      : { linearErrorType: knownErrorTypes.has(graphqlErrorType) ? graphqlErrorType : "other" }),
    linearErrorKinds: [
      ...new Set(graphqlCodes.map((code) => (knownErrorCodes.has(code) ? code : "other"))),
    ],
  };
}

async function providerRequest<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  pilotOperations?: true,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (signal.aborted) throw new LinearAgentError("cancelled");
    if (error instanceof LinearCredentialError && error.code === "reauthorize") {
      throw new LinearAgentError("reauthorize");
    }
    if (!(error instanceof LinearApiError)) throw new LinearAgentError("request_failed");
    throw new LinearAgentError(
      "request_failed",
      error.status,
      pilotOperations ? safeProviderDetails(error) : undefined,
    );
  }
}
