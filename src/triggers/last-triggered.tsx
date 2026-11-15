/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- a row cell passes its timestamp as the primary slot */
import { RelativeTime } from "../components/app/relative-time.js";
import { statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { recentRunsLabel, type RecentRuns } from "./recent-runs.js";

/** The latest run's time, over how the last 24 hours of runs went. */
export function LastTriggered({
  lastTriggered,
  recentRuns,
}: {
  lastTriggered: { status: string; receivedAt: string } | null;
  recentRuns: RecentRuns;
}) {
  if (lastTriggered === null) return <span className="text-muted-foreground">Never</span>;
  const summary = recentRunsLabel(recentRuns, statusLabel(lastTriggered.status));
  return (
    <TwoLine
      primary={<RelativeTime value={lastTriggered.receivedAt} />}
      {...(summary === undefined ? {} : { secondary: summary })}
    />
  );
}
