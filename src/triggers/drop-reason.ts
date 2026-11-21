import { isTriggerableReceiptSource } from "./configuration/events.js";

export const PROVIDER_EVENT_DROP_REASON_CODES = [
  "no_project_route",
  "no_trigger_for_source",
  "trigger_filters_rejected",
  "configuration_unavailable",
  "unsupported_event",
] as const;

export type ProviderEventDropReasonCode = (typeof PROVIDER_EVENT_DROP_REASON_CODES)[number];

export const GITHUB_LIFECYCLE_RECEIPT = "github_lifecycle";
export const RECEIPT_REASON_CODES = [
  ...PROVIDER_EVENT_DROP_REASON_CODES,
  GITHUB_LIFECYCLE_RECEIPT,
] as const;
export type ReceiptReasonCode = (typeof RECEIPT_REASON_CODES)[number];
export type DisplayedDropReason = ReceiptReasonCode | "other";

const SUMMARIES: Readonly<Record<ReceiptReasonCode, string>> = {
  no_project_route: "No project route is configured for this event.",
  no_trigger_for_source: "No configured trigger handles this event.",
  trigger_filters_rejected: "The event did not pass the configured trigger filters.",
  configuration_unavailable: "The relevant configuration or connection is unavailable.",
  unsupported_event: "Hub could not read this Linear event as a supported trigger event.",
  github_lifecycle: "GitHub sent a connection update that Hub handles outside of triggers.",
};

function isReceiptReasonCode(value: string): value is ReceiptReasonCode {
  return RECEIPT_REASON_CODES.some((code) => code === value);
}

export function providerEventDropReasonSummary(value: string): string | null {
  return isReceiptReasonCode(value) ? SUMMARIES[value] : null;
}

export const ROUTING_DROP_REASONS = ["no_project_route", "no_trigger_for_source"] as const;
export const DROP_REASON_GROUPS = [
  "routing",
  "trigger_filters_rejected",
  "configuration_unavailable",
  "unsupported_event",
  "other",
] as const;
export const DROP_REASON_FILTERS = [...RECEIPT_REASON_CODES, "routing", "other"] as const;

export type DropReasonGroup = (typeof DROP_REASON_GROUPS)[number];
export type DropReasonFilter = (typeof DROP_REASON_FILTERS)[number];

export const DROP_REASON_LABELS: Record<DropReasonFilter, string> = {
  routing: "Missing route or trigger",
  no_project_route: "No project route",
  no_trigger_for_source: "No matching trigger",
  trigger_filters_rejected: "Trigger filters rejected",
  configuration_unavailable: "Configuration unavailable",
  unsupported_event: "Unsupported event",
  github_lifecycle: "GitHub connection update",
  other: "Other reasons",
};

export function dropReasonGroup(
  reason: Exclude<DisplayedDropReason, typeof GITHUB_LIFECYCLE_RECEIPT>,
): DropReasonGroup {
  return reason === "no_project_route" || reason === "no_trigger_for_source" ? "routing" : reason;
}

export function displayedDropReason(reason: string): DisplayedDropReason {
  return isReceiptReasonCode(reason) ? reason : "other";
}

interface Hint {
  text: string;
  action?: "create" | "review" | "connections";
}

const HINTS: Record<DisplayedDropReason, (source: string, location: string) => Hint> = {
  no_project_route: (source, location) => ({
    text: `No enabled trigger is routed to ${source}${location}.`,
    action: "create",
  }),
  no_trigger_for_source: (source, location) => ({
    text: `No enabled trigger listens for ${source}${location}.`,
    action: "create",
  }),
  trigger_filters_rejected: () => ({
    text: "A trigger matched the event but its filters rejected it.",
    action: "review",
  }),
  configuration_unavailable: () => ({
    text: "Check the connection and reconnect it if authorization has expired.",
    action: "connections",
  }),
  unsupported_event: () => ({
    text: "Use a supported Linear issue or comment event with the fields a trigger needs.",
  }),
  github_lifecycle: () => ({
    text: "Check the GitHub connection if a repository is missing.",
    action: "connections",
  }),
  other: () => ({ text: "Check the event source and its trigger configuration." }),
};

export function providerEventDropReasonHint(
  reason: DisplayedDropReason,
  source: string,
  workspace: string | null,
): Hint {
  const hint = HINTS[reason](source, workspace === null ? "" : ` in ${workspace}`);
  if (hint.action === "create" && !isTriggerableReceiptSource(source)) {
    return { text: "Hub has no trigger for this event type." };
  }
  return hint;
}
