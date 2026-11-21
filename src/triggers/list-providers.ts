import type { ProviderEventReceiptRecord } from "../db/types.js";

export const LIST_PROVIDERS = [
  "github",
  "github_notification",
  "linear",
  "slack",
  "discord",
  "webhook",
  "manual",
  "schedule",
] as const satisfies readonly (ProviderEventReceiptRecord["provider"] | "webhook")[];

export type ListProvider = (typeof LIST_PROVIDERS)[number];

export const LIST_PROVIDER_LABELS: Record<ListProvider, string> = {
  github: "GitHub",
  github_notification: "GitHub notifications",
  linear: "Linear",
  slack: "Slack",
  discord: "Discord",
  webhook: "Webhook",
  manual: "Manual",
  schedule: "Schedule",
};
