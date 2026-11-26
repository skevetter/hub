import { runListState } from "../components/app/state-label.js";
import type { HomeSnapshot } from "./dashboard.js";

/**
 * Enabled triggers whose newest run is in a state that needs a person. The count reads the state's
 * tone, so it agrees with how Activity colours that run. A switched-off or never-run trigger has
 * a quiet state, so it is not failing.
 */
export function failingTriggers(snapshot: Pick<HomeSnapshot, "triggers" | "triggerRuns">): number {
  const latest = new Map(snapshot.triggerRuns.map((entry) => [entry.triggerId, entry.latest]));
  return snapshot.triggers.filter(({ id, enabled }) => {
    const run = latest.get(id) ?? null;
    return enabled && run !== null && runListState(run.status).tone === "attention";
  }).length;
}
