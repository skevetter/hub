const DAY_MS = 24 * 60 * 60_000;

/** What happened to a trigger's runs in the last 24 hours. */
export interface RecentRuns {
  total: number;
  succeeded: number;
  /** Runs that failed or timed out. */
  failed: number;
}

/** Counts the runs received in the 24 hours before `now`. Callers pass at most their newest runs. */
export function summarizeRecentRuns(
  runs: readonly { status: string; receivedAt: string }[],
  now: Date,
): RecentRuns {
  const since = now.getTime() - DAY_MS;
  const summary: RecentRuns = { total: 0, succeeded: 0, failed: 0 };
  for (const run of runs) {
    if (Date.parse(run.receivedAt) < since) continue;
    summary.total++;
    if (run.status === "succeeded") summary.succeeded++;
    else if (run.status === "failed" || run.status === "timed_out") summary.failed++;
  }
  return summary;
}

/**
 * The line under "Last triggered". One failed run among many reads as "1 of 12 failed", not as
 * the trigger failing. Undefined when there were no runs in the window. Runs that have not
 * finished are not counted as failures, so a window of only running runs falls back to `latest`.
 */
export function recentRunsLabel(recent: RecentRuns, latest: string): string | undefined {
  if (recent.total === 0) return undefined;
  if (recent.failed === 0) return recent.succeeded === recent.total ? "Succeeded" : latest;
  if (recent.failed === recent.total) return "Failed";
  return `${String(recent.failed)} of ${String(recent.total)} failed`;
}
