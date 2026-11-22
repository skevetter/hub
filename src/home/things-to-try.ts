import type { HomeSnapshot } from "./dashboard.js";
import type { ProfileAvailability } from "./checklist.js";

export type TrySurfaceKey = "linear" | "github" | "sessions";

export interface TryExample {
  title: string;
  /** What the agent does with it, in one line. */
  description: string;
  /** The text to send. Written to work as it stands, with nothing to fill in. */
  prompt: string;
}

export interface TrySurface {
  key: TrySurfaceKey;
  label: string;
  /** Where the prompt goes, and what has to exist for it to start an agent. */
  where: string;
  /** The one thing still missing, as a link to where it is made. Absent when nothing is. */
  next?: { label: string; path: string };
  examples: readonly TryExample[];
}

const LINEAR_EXAMPLES: readonly TryExample[] = [
  {
    title: "Plan the work",
    description: "Reads the issue and its comments, then replies with a plan.",
    prompt:
      "Read this issue and its comments, then reply with a step-by-step plan and the questions that are still open.",
  },
  {
    title: "Find the cause",
    description: "Investigates a bug report in the repository before changing anything.",
    prompt:
      "Reproduce this bug in the repository, find the cause, and reply with what you found. Do not change any code yet.",
  },
  {
    title: "Make the change",
    description: "Implements the issue on a branch and reports back.",
    prompt:
      "Implement this issue on a new branch, run the tests, and reply with a summary of the change and anything you could not finish.",
  },
];

const GITHUB_PULL_REQUEST_EXAMPLES: readonly TryExample[] = [
  {
    title: "Review a pull request",
    description: "Reads the diff and comments with what it found.",
    prompt:
      "Review this pull request for bugs and missing tests, and comment with what you found, most serious first.",
  },
  {
    title: "Summarize the changes",
    description: "Summarizes the diff for a reviewer.",
    prompt:
      "Read the pull request diff and comment with what changed and how a reviewer can verify it.",
  },
  {
    title: "Investigate failing checks",
    description: "Finds the cause of a failed check and proposes a fix.",
    prompt:
      "Find out why the checks on this pull request fail and comment with the cause and a proposed fix.",
  },
];

const SESSION_EXAMPLES: readonly TryExample[] = [
  {
    title: "Get oriented",
    description: "A first message for a repository the agent has not seen.",
    prompt:
      "Read this repository and tell me how it is laid out, how to run the tests, and what looks risky.",
  },
  {
    title: "Review my branch",
    description: "Compares the current branch with main and lists problems.",
    prompt:
      "Review the changes on the current branch against main and list the problems you find, most serious first.",
  },
  {
    title: "Fix a failing test",
    description: "Runs the tests and works on the first failure with you.",
    prompt:
      "Run the test suite, pick the first failing test, explain why it fails, and propose a fix before you change anything.",
  },
];

/**
 * The examples, each with the one thing still standing between the reader and trying it. What is
 * missing is read from records: a connection, an enabled trigger that listens to that app, a
 * session profile. Sessions are left out entirely while the feature is off.
 */
export function thingsToTry(
  snapshot: Pick<HomeSnapshot, "connections" | "triggers" | "sessions">,
  profiles: ProfileAvailability = null,
  canManageProfiles = false,
): TrySurface[] {
  const surfaces: TrySurface[] = [
    appSurface(snapshot, "linear", "Linear"),
    appSurface(snapshot, "github", "GitHub"),
  ];
  const { sessions } = snapshot;
  if (sessions !== null && profiles !== null) {
    surfaces.push({
      key: "sessions",
      label: "Sessions",
      ...sessionGuidance(profiles, canManageProfiles),
      examples: SESSION_EXAMPLES,
    });
  }
  return surfaces;
}

function sessionGuidance(
  profiles: NonNullable<ProfileAvailability>,
  canManage: boolean,
): Pick<TrySurface, "where" | "next"> {
  if (profiles === "checking") return { where: "Checking session profiles." };
  if (profiles === "unavailable") return { where: "Session profiles could not be loaded." };
  if (profiles > 0) {
    return {
      where: "Choose an active profile and send one of these as the first message.",
      next: { label: "New session", path: "sessions/new" },
    };
  }
  return canManage
    ? {
        where: "Create a session profile to choose the daemon, folder and agent.",
        next: { label: "Create a profile", path: "sessions/profiles" },
      }
    : { where: "Ask an organization admin to create a session profile." };
}

function appSurface(
  snapshot: Pick<HomeSnapshot, "connections" | "triggers">,
  provider: "linear" | "github",
  label: string,
): TrySurface {
  const connected = snapshot.connections.filter((connection) => connection.provider === provider);
  const examples = provider === "linear" ? LINEAR_EXAMPLES : GITHUB_PULL_REQUEST_EXAMPLES;
  if (connected.length === 0) {
    return {
      key: provider,
      label,
      where: `${label} is not connected yet. Connect it, then create a comment trigger with a reply output.`,
      next: { label: `Connect ${label}`, path: "connections" },
      examples,
    };
  }
  const healthy = connected.filter(({ needsAuthorization }) => !needsAuthorization);
  if (healthy.length === 0) {
    return {
      key: provider,
      label,
      where: `${label} needs authorization before a comment can start a trigger.`,
      next: { label: "Open connections", path: "connections" },
      examples,
    };
  }
  const listening = snapshot.triggers.flatMap((trigger) => {
    const comment = COMMENT_EVENTS.get(trigger.event);
    return trigger.enabled && comment !== undefined && trigger.event.startsWith(`${provider}.`)
      ? [{ trigger, comment }]
      : [];
  });
  const matching =
    listening.find(
      ({ trigger }) => trigger.hasReplyOutput && typeof trigger.commentPrefix === "string",
    ) ??
    listening.find(({ trigger }) => trigger.hasReplyOutput) ??
    listening[0];
  if (matching === undefined) {
    const name = healthy[0]?.label;
    return {
      key: provider,
      label,
      where: `${name ?? label} is connected. Create a comment trigger with a reply output to use these prompts.`,
      next: { label: "New trigger", path: "triggers/new" },
      examples,
    };
  }
  const { trigger, comment } = matching;
  const { commentPrefix } = trigger;
  if (trigger.hasReplyOutput === true && typeof commentPrefix !== "string") {
    return {
      key: provider,
      label,
      where: `${trigger.name} only starts for comments that match its filters.`,
      next: { label: "Open trigger", path: `triggers/${trigger.id}` },
      examples: [],
    };
  }
  const location = healthy.length === 1 ? ` in ${healthy[0]?.label ?? label}` : "";
  return {
    key: provider,
    label,
    where:
      trigger.hasReplyOutput === true
        ? `${comment.action}${location} with one of these where ${trigger.name} is configured to run.`
        : `${trigger.name} needs a reply output for the answer to appear on the ${comment.pullRequest ? "pull request" : "issue"}.`,
    examples:
      typeof commentPrefix === "string" ? commentExamples(trigger.event, commentPrefix) : [],
  };
}

const ISSUE_COMMENT = { action: "Comment on an issue", pullRequest: false } as const;
const PULL_REQUEST_COMMENT = { action: "Comment on a pull request", pullRequest: true } as const;
const COMMENT_EVENTS = new Map<string, { action: string; pullRequest: boolean }>([
  ["linear.comment_created", ISSUE_COMMENT],
  ["github.issue_comment_created", ISSUE_COMMENT],
  ["github.pull_request_comment_created", PULL_REQUEST_COMMENT],
  ["github.issue_comment", PULL_REQUEST_COMMENT],
  [
    "github.pull_request_review_comment",
    { action: "Leave an inline review comment on a pull request", pullRequest: true },
  ],
]);

export function isTryCommentEvent(event: string): boolean {
  return COMMENT_EVENTS.has(event);
}

export function commentExamples(event: string, prefix: string): readonly TryExample[] {
  const examples =
    COMMENT_EVENTS.get(event)?.pullRequest === true
      ? GITHUB_PULL_REQUEST_EXAMPLES
      : LINEAR_EXAMPLES;
  return prefix === ""
    ? examples
    : examples.map(({ title, description, prompt }) => ({
        title,
        description,
        prompt: `${prefix} ${prompt}`,
      }));
}
