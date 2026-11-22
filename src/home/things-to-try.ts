import type { HomeSnapshot } from "./dashboard.js";

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

const GITHUB_EXAMPLES: readonly TryExample[] = [
  {
    title: "Review a pull request",
    description: "Reads the diff and comments with what it found.",
    prompt:
      "Review this pull request for bugs and missing tests, and comment with what you found, most serious first.",
  },
  {
    title: "Triage an issue",
    description: "Finds the code an issue is about and proposes a fix.",
    prompt:
      "Read this issue, find the code it is about, and comment with the likely cause and a proposed fix.",
  },
  {
    title: "Fix failing checks",
    description: "Works out why checks fail and pushes a fix to the branch.",
    prompt:
      "Find out why the checks on this pull request fail, fix them, and push the fix to this branch.",
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
): TrySurface[] {
  const surfaces: TrySurface[] = [
    appSurface(snapshot, "linear", "Linear", LINEAR_EXAMPLES, "Comment on an issue"),
    appSurface(
      snapshot,
      "github",
      "GitHub",
      GITHUB_EXAMPLES,
      "Comment on an issue or pull request",
    ),
  ];
  const { sessions } = snapshot;
  if (sessions !== null) {
    surfaces.push({
      key: "sessions",
      label: "Sessions",
      where:
        sessions.profiles === 0
          ? "A session starts from a profile: the daemon, folder and agent it uses. Create one first."
          : "Start a session and send one of these as the first message. The agent works on your daemon.",
      next:
        sessions.profiles === 0
          ? { label: "Create a profile", path: "sessions/profiles" }
          : { label: "New session", path: "sessions/new" },
      examples: SESSION_EXAMPLES,
    });
  }
  return surfaces;
}

function appSurface(
  snapshot: Pick<HomeSnapshot, "connections" | "triggers">,
  provider: "linear" | "github",
  label: string,
  examples: readonly TryExample[],
  action: string,
): TrySurface {
  const connected = snapshot.connections.filter((connection) => connection.provider === provider);
  if (connected.length === 0) {
    return {
      key: provider,
      label,
      where: `${label} is not connected yet. Connect it, then create a trigger that listens to it.`,
      next: { label: `Connect ${label}`, path: "connections" },
      examples,
    };
  }
  const listening = snapshot.triggers.filter(
    ({ enabled, event }) => enabled && listensTo(event, provider),
  );
  const names = connected.map((connection) => connection.label).join(", ");
  if (listening.length === 0) {
    return {
      key: provider,
      label,
      where: `${names} is connected, but no enabled trigger listens to ${label} yet. Create one, then send a prompt.`,
      next: { label: "New trigger", path: "triggers/new" },
      examples,
    };
  }
  return {
    key: provider,
    label,
    where: `${action} in ${names} with one of these. ${listening
      .map(({ name }) => name)
      .join(", ")} decides which events start an agent.`,
    examples,
  };
}

/** GitHub notifications are a personal inbox, not something a comment in a repository reaches. */
function listensTo(event: string, provider: "linear" | "github"): boolean {
  return event.startsWith(`${provider}.`) && event !== "github.notification";
}
