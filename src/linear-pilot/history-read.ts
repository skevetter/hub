import { z } from "zod";

const id = z.string().min(1).max(255);
const actor = z.object({ id });
const creationTime = z.iso.datetime({ offset: true });
const body = z.string().max(250_000);
const activity = z.object({
  id,
  createdAt: creationTime,
  agentSession: actor,
  user: actor,
  promptAuthor: actor.nullable(),
  signal: z.enum(["auth", "continue", "select", "stop"]).nullable(),
  content: z.discriminatedUnion("__typename", [
    z.object({
      __typename: z.literal("AgentActivityPromptContent"),
      type: z.literal("prompt"),
      body,
    }),
    z.object({
      __typename: z.literal("AgentActivityResponseContent"),
      type: z.literal("response"),
      body,
    }),
  ]),
});

export const PILOT_HISTORY_PAGE_LIMIT = 24;

function sessionPage(limit: number) {
  return z.object({
    agentSession: z.object({
      id,
      issue: actor.nullable(),
      appUser: actor,
      activities: z.object({
        nodes: z.array(activity).max(limit),
        pageInfo: z.object({ hasNextPage: z.boolean(), hasPreviousPage: z.boolean() }),
      }),
    }),
  });
}

const promptPage = sessionPage(1);
const historyPage = sessionPage(PILOT_HISTORY_PAGE_LIMIT);
type PilotHistoryPage = z.infer<typeof historyPage>["agentSession"];

type Send = <T>(
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
) => Promise<T>;

export interface PilotHistoryScope {
  sessionId: string;
  issueId: string;
  appUserId: string;
  allowedHumanProviderUserId: string;
}

const activityPageFields = `
  id
  appUser { id }
  issue { id }
  activities
`;

const activityNodes = `
  nodes {
    id createdAt signal
    agentSession { id }
    user { id }
    promptAuthor { id }
    content {
      __typename
      ... on AgentActivityPromptContent { type body }
      ... on AgentActivityResponseContent { type body }
    }
  }
  pageInfo { hasNextPage hasPreviousPage }
`;

const anchorQuery = `query PaseoPilotPrompt($sessionId: String!, $activityId: ID!) {
    agentSession(id: $sessionId) {
      ${activityPageFields}(first: 1, filter: { agentSessionId: { eq: $sessionId }, id: { eq: $activityId } }) {
        ${activityNodes}
      }
    }
  }
`;

const historyQuery = `query PaseoPilotHistory($sessionId: String!, $before: DateTimeOrDuration!) {
    agentSession(id: $sessionId) {
      ${activityPageFields}(first: 24, orderBy: createdAt, filter: {
        agentSessionId: { eq: $sessionId }
        createdAt: { lt: $before }
        type: { in: ["prompt", "response"] }
      }) {
        ${activityNodes}
      }
    }
  }
`;

function matchesSession(page: PilotHistoryPage, scope: PilotHistoryScope) {
  return (
    page.id === scope.sessionId &&
    page.appUser.id === scope.appUserId &&
    page.issue?.id === scope.issueId &&
    page.activities.nodes.every((row) => row.agentSession.id === scope.sessionId)
  );
}

function isOwnerPrompt(row: z.infer<typeof activity>, scope: PilotHistoryScope) {
  return (
    row.content.type === "prompt" &&
    row.user.id === scope.allowedHumanProviderUserId &&
    (row.promptAuthor === null || row.promptAuthor.id === scope.allowedHumanProviderUserId) &&
    row.signal === null
  );
}

export async function readPilotPromptPage(
  send: Send,
  scope: PilotHistoryScope,
  expected: { activityId: string; body: string },
): Promise<PilotHistoryPage | undefined> {
  const { agentSession: page } = await send(
    anchorQuery,
    {
      sessionId: scope.sessionId,
      activityId: expected.activityId,
    },
    promptPage,
  );
  const [row] = page.activities.nodes;
  if (
    !matchesSession(page, scope) ||
    page.activities.pageInfo.hasNextPage ||
    page.activities.pageInfo.hasPreviousPage ||
    !row ||
    row.id !== expected.activityId ||
    !isOwnerPrompt(row, scope) ||
    row.content.body !== expected.body
  )
    return undefined;
  return page;
}

export async function readPilotPriorPage(
  send: Send,
  scope: PilotHistoryScope,
  anchorCreatedAt: string,
): Promise<PilotHistoryPage | undefined> {
  const parsed = creationTime.safeParse(anchorCreatedAt);
  if (!parsed.success) return undefined;
  const { agentSession: page } = await send(
    historyQuery,
    {
      sessionId: scope.sessionId,
      before: parsed.data,
    },
    historyPage,
  );
  const cutoff = Date.parse(parsed.data);
  const seen = new Set<string>();
  let previousTime = cutoff;
  for (const row of page.activities.nodes) {
    const time = Date.parse(row.createdAt);
    if (time >= cutoff || time > previousTime || seen.has(row.id)) return undefined;
    previousTime = time;
    seen.add(row.id);
  }
  if (!matchesSession(page, scope) || page.activities.pageInfo.hasPreviousPage) return undefined;
  for (const row of page.activities.nodes) {
    const canUseBody =
      isOwnerPrompt(row, scope) ||
      (row.content.type === "response" &&
        row.user.id === scope.appUserId &&
        row.promptAuthor === null &&
        row.signal === null);
    // Other rows still delimit exchanges.
    if (!canUseBody) row.content.body = "";
  }
  return page;
}
