import { enabledState, runState, type StateView } from "../components/app/state-label.js";
import type { HomeSnapshot } from "./dashboard.js";

type Latest = HomeSnapshot["triggerRuns"][number]["latest"];

export interface TriggerHealthRow {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  state: StateView;
  /** Runs in the window, and the ones among them that ended badly. */
  total: number;
  failed: number;
  latest: Latest;
}

export interface TriggerHealth {
  /** Worst first: needs a person, then running, then fine, then off. */
  rows: readonly TriggerHealthRow[];
  /** Enabled triggers whose newest run is in a state that needs a person. */
  failing: number;
  running: number;
  paused: number;
  /** The newest of those newest runs, so the reader has one thing to open. */
  latestFailure: { triggerName: string; runId: string; status: string; startedAt: string } | null;
}

/** Home shows the worst rows only; the figures above still count every trigger. */
export const HOME_TRIGGER_ROWS = 10;

const NO_RUNS: StateView = { label: "No runs yet", tone: "off" };
const RANK = { attention: 0, live: 1, done: 2, off: 3 } as const;

export function triggerHealth(
  snapshot: Pick<HomeSnapshot, "triggers" | "triggerRuns">,
): TriggerHealth {
  const runs = new Map(snapshot.triggerRuns.map((entry) => [entry.triggerId, entry]));
  const rows = snapshot.triggers
    .map((trigger) => healthRow(trigger, runs.get(trigger.id)))
    .sort(worstFirst);
  const failing = rows.filter(isFailing);
  return {
    rows,
    failing: failing.length,
    running: rows.filter((row) => row.enabled && row.state.tone === "live").length,
    paused: rows.filter((row) => !row.enabled).length,
    latestFailure: newestFailure(failing),
  };
}

function healthRow(
  trigger: HomeSnapshot["triggers"][number],
  runs: HomeSnapshot["triggerRuns"][number] | undefined,
): TriggerHealthRow {
  const latest = runs?.latest ?? null;
  return {
    id: trigger.id,
    name: trigger.name,
    event: trigger.event,
    enabled: trigger.enabled,
    state: stateOf(trigger.enabled, latest),
    total: runs?.total ?? 0,
    failed: runs?.failed ?? 0,
    latest,
  };
}

function stateOf(enabled: boolean, latest: Latest): StateView {
  if (!enabled) return enabledState(false);
  return latest === null ? NO_RUNS : runState(latest.status);
}

/**
 * Failing is what the row shows in red. Count, sort order and colour all read the state's tone,
 * so the figure can never disagree with the list under it. A switched-off or never-run trigger
 * has a quiet state, so it is not failing.
 */
function isFailing(row: TriggerHealthRow): boolean {
  return row.state.tone === "attention";
}

function newestFailure(failing: readonly TriggerHealthRow[]): TriggerHealth["latestFailure"] {
  const dated = failing.flatMap((row) =>
    row.latest === null ? [] : [{ name: row.name, latest: row.latest }],
  );
  const newest = dated.sort((a, b) => b.latest.startedAt.localeCompare(a.latest.startedAt))[0];
  return newest === undefined
    ? null
    : {
        triggerName: newest.name,
        runId: newest.latest.id,
        status: newest.latest.status,
        startedAt: newest.latest.startedAt,
      };
}

/** A switched-off trigger is the least interesting row, whatever its last run was. */
function rankOf(row: TriggerHealthRow): number {
  return row.enabled ? RANK[row.state.tone] : 4;
}

function worstFirst(a: TriggerHealthRow, b: TriggerHealthRow): number {
  return (
    rankOf(a) - rankOf(b) ||
    (b.latest?.startedAt ?? "").localeCompare(a.latest?.startedAt ?? "") ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}
