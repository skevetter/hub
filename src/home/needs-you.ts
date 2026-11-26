import type { HomeSnapshot } from "./dashboard.js";
import { triggerHealth, type TriggerHealth } from "./trigger-health.js";

export interface NeedsYou {
  failing: number;
  latestFailure: TriggerHealth["latestFailure"];
  /** Labels of the apps whose grant no longer covers what Hub needs. */
  unauthorizedApps: readonly string[];
  daemons: { total: number; offline: number; cannotExecute: number };
  stopped: HomeSnapshot["stoppedTriggers"];
}

/** The four things that need a person. Each reads as zero when it is fine, never as absent. */
export function needsYou(data: HomeSnapshot): NeedsYou {
  const health = triggerHealth(data);
  const offline = data.daemons.filter(({ presence }) => presence !== "connected");
  const cannotExecute = data.daemons.filter(({ canExecute }) => !canExecute);
  return {
    failing: health.failing,
    latestFailure: health.latestFailure,
    unauthorizedApps: data.connections
      .filter(({ needsAuthorization }) => needsAuthorization)
      .map(({ label }) => label),
    daemons: {
      total: new Set([...offline, ...cannotExecute].map(({ id }) => id)).size,
      offline: offline.length,
      cannotExecute: cannotExecute.length,
    },
    stopped: data.stoppedTriggers,
  };
}
