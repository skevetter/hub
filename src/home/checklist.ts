import type { HomeSnapshot } from "./dashboard.js";

/**
 * What the reader has to do next, derived from what the organization has. Every state is a fact
 * about a connection, daemon, trigger, run or session.
 */
export type ChecklistStep =
  | {
      key: "app";
      /** `setup`: this Hub has no provider app at all, so there is nothing to connect yet. */
      state: "done" | "pending" | "setup";
    }
  | {
      key: "daemon";
      /** `cannotRun`: a daemon is enrolled, but none was allowed to run Hub automations. */
      state: "done" | "pending" | "cannotRun";
    }
  | { key: "trigger"; state: "done" | "pending" }
  | { key: "run"; state: "done" | "pending" }
  /** A session profile exists: the daemon, folder and agent a session starts from. */
  | { key: "profile"; state: "done" | "pending" }
  /** The reader started or participates in a session. */
  | { key: "session"; state: "done" | "pending" };

export interface Checklist {
  steps: readonly ChecklistStep[];
  completed: number;
  complete: boolean;
}

export type ChecklistFacts = Pick<
  HomeSnapshot,
  "appsConfigured" | "connections" | "daemons" | "triggers" | "runs" | "sessions"
>;

function appState(snapshot: ChecklistFacts): Extract<ChecklistStep, { key: "app" }>["state"] {
  if (snapshot.connections.some(({ needsAuthorization }) => !needsAuthorization)) return "done";
  if (snapshot.connections.length > 0) return "pending";
  return snapshot.appsConfigured ? "pending" : "setup";
}

function daemonState(
  snapshot: Pick<ChecklistFacts, "daemons">,
): Extract<ChecklistStep, { key: "daemon" }>["state"] {
  if (snapshot.daemons.some((daemon) => daemon.canExecute)) return "done";
  return snapshot.daemons.length > 0 ? "cannotRun" : "pending";
}

export function canFinishSetup(
  snapshot: Pick<ChecklistFacts, "connections" | "daemons" | "triggers" | "runs">,
): boolean {
  return (
    snapshot.connections.length > 0 &&
    daemonState(snapshot) === "done" &&
    snapshot.triggers.length > 0 &&
    snapshot.runs.length > 0
  );
}

/**
 * With sessions off the list is the four automation steps. With sessions on the daemon leads,
 * because a session needs nothing else, and the session steps come before the app: talking to an
 * agent is the shortest way to see Hub work.
 */
export function deriveChecklist(snapshot: ChecklistFacts): Checklist {
  const app: ChecklistStep = { key: "app", state: appState(snapshot) };
  const daemon: ChecklistStep = { key: "daemon", state: daemonState(snapshot) };
  const automation: ChecklistStep[] = [
    { key: "trigger", state: snapshot.triggers.length > 0 ? "done" : "pending" },
    { key: "run", state: snapshot.runs.length > 0 ? "done" : "pending" },
  ];
  const { sessions } = snapshot;
  const steps: ChecklistStep[] =
    sessions === null
      ? [app, daemon, ...automation]
      : [
          daemon,
          { key: "profile", state: sessions.profiles > 0 ? "done" : "pending" },
          { key: "session", state: sessions.started ? "done" : "pending" },
          app,
          ...automation,
        ];
  const completed = steps.filter((step) => step.state === "done").length;
  return { steps, completed, complete: completed === steps.length };
}
