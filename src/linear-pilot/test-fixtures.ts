export const conversation = {
  organizationId: "hub-org",
  workspaceId: "linear-workspace",
  applicationId: "linear-application",
  appUserId: "linear-app-actor",
  nativeSessionId: "linear-native-session",
  connectionId: "hub-linear-connection",
  issueId: "linear-issue",
  ownerId: "linear-owner",
};

const typenames = {
  prompt: "AgentActivityPromptContent",
  response: "AgentActivityResponseContent",
  thought: "AgentActivityThoughtContent",
  action: "AgentActivityActionContent",
  error: "AgentActivityErrorContent",
  elicitation: "AgentActivityElicitationContent",
};

export interface FixtureActivity {
  id: string;
  agentSession: { id: string };
  user: { id: string };
  promptAuthor: { id: string } | null;
  createdAt: string;
  signal: string | null;
  content: { type: string; __typename: string; body: string };
}

export function fixtureActivityIds(_sessionId: string, activityId: string) {
  return {
    busy: `busy:${activityId}`,
    response: `response:${activityId}`,
    stop: `stop:${activityId}`,
  };
}

export function fixturePromptId(n: number) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function activity(
  id: string,
  second: number,
  kind: keyof typeof typenames,
  body: string,
  actor = kind === "prompt" ? conversation.ownerId : conversation.appUserId,
): FixtureActivity {
  return {
    id,
    agentSession: { id: conversation.nativeSessionId },
    user: { id: actor },
    promptAuthor: kind === "prompt" ? { id: actor } : null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    signal: null as string | null,
    content: { type: kind, __typename: typenames[kind], body },
  };
}

export function activityPage(nodes: FixtureActivity[]) {
  return {
    id: conversation.nativeSessionId,
    issue: { id: conversation.issueId },
    appUser: { id: conversation.appUserId },
    activities: { nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false } },
  };
}

export const current = { activityId: fixturePromptId(50), body: "What should we do next?" };
export const currentRow = activity(current.activityId, 50, "prompt", current.body);

export const initialRows = [
  activity(
    fixtureActivityIds(conversation.nativeSessionId, fixturePromptId(1)).response,
    2,
    "response",
    "initial application response",
  ),
  activity(fixturePromptId(1), 1, "prompt", "initial owner prompt"),
];
