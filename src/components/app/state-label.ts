/** Red for needs a person, ultramarine for live, ink for done, grey for off. */
export type StateTone = "attention" | "live" | "done" | "off";

/** The pill's tones. They alias the state inks until every pill is retired. */
export type StatusTone = "success" | "warning" | "danger" | "neutral";

/** What a person reads and the ink it takes. Every pill, block and sentence about a state reads this. */
export interface StateView {
  label: string;
  tone: StateTone;
}

export type ConnectionState =
  | "connected"
  | "notConfigured"
  | "disconnected"
  | "requiresReauthorization"
  | "suspended";
export type DaemonState = "connected" | "offline" | "revoked";
export type SessionState =
  | "starting"
  | "running"
  | "idle"
  | "waiting_permission"
  | "stopping"
  | "failed"
  | "closed";

/**
 * A machine status as a sentence: `in_progress` reads "In progress". One home for the three
 * casing strategies the dashboard grew, none of which agreed on what a two-word status looked like.
 */
export function statusLabel(value: string): string {
  const words = value.replaceAll(/[_-]+/gu, " ").trim().toLowerCase();
  if (words === "") return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const RUN: ReadonlyMap<string, StateView> = new Map([
  ["running", { label: "Running", tone: "live" }],
  ["succeeded", { label: "Succeeded", tone: "done" }],
  ["failed", { label: "Failed", tone: "attention" }],
  ["timed_out", { label: "Timed out", tone: "attention" }],
  ["canceled", { label: "Canceled", tone: "off" }],
  ["rejected", { label: "Rejected", tone: "attention" }],
]);

const NEEDS_AUTHORIZATION: StateView = { label: "Needs authorization", tone: "attention" };
const NOT_SET_UP: StateView = { label: "Not set up", tone: "off" };
const CONNECTION: Record<ConnectionState, StateView> = {
  connected: { label: "Connected", tone: "done" },
  notConfigured: NOT_SET_UP,
  disconnected: NOT_SET_UP,
  requiresReauthorization: NEEDS_AUTHORIZATION,
  suspended: NEEDS_AUTHORIZATION,
};

const DAEMON: Record<DaemonState, StateView> = {
  connected: { label: "Connected", tone: "done" },
  offline: { label: "Offline", tone: "off" },
  revoked: { label: "Revoked", tone: "attention" },
};

const SESSION: Record<SessionState, StateView> = {
  starting: { label: "Starting", tone: "live" },
  running: { label: "Running", tone: "live" },
  idle: { label: "Idle", tone: "off" },
  waiting_permission: { label: "Waiting for approval", tone: "attention" },
  stopping: { label: "Stopping", tone: "live" },
  failed: { label: "Failed", tone: "attention" },
  closed: { label: "Closed", tone: "off" },
};

const STOPPED: StateView = { label: "Stopped", tone: "off" };

/** A run or one of its steps. A status this module does not know reads as off, in sentence case. */
export function runState(status: string): StateView {
  return RUN.get(status) ?? { label: statusLabel(status), tone: "off" };
}

export function connectionState(status: ConnectionState): StateView {
  return CONNECTION[status];
}

export function daemonState(status: DaemonState): StateView {
  return DAEMON[status];
}

export function sessionState(state: SessionState, reason?: string | null): StateView {
  return state === "idle" && reason === "stopped_by_person" ? STOPPED : SESSION[state];
}

/** A trigger or a session profile: on, or switched off. */
export function enabledState(enabled: boolean): StateView {
  return enabled ? { label: "Enabled", tone: "done" } : { label: "Disabled", tone: "off" };
}

const PILL_TONE: Record<StateTone, StatusTone> = {
  attention: "danger",
  live: "success",
  done: "success",
  off: "neutral",
};

/** A pill outside a row still speaks the pill's tones; this is the one place that maps them. */
export function pillTone(tone: StateTone): StatusTone {
  return PILL_TONE[tone];
}
