import { Card } from "../components/app/card.js";
import { WarningAlert } from "../components/app/failure-alert.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill, type StatusTone } from "../components/app/status-pill.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { Button } from "../components/ui/button.js";
import type { NotificationState, NotificationStatusView } from "./notification-status.js";

export const NOTIFICATION_DOCS_URL =
  "https://github.com/skevetter/hub/blob/main/docs/github-notifications.md#set-up";

const STATE_PILL: Record<NotificationState, { tone: StatusTone; label: string }> = {
  polling: { tone: "success", label: "Polling" },
  error: { tone: "danger", label: "Error" },
  off: { tone: "neutral", label: "Off" },
  starting: { tone: "neutral", label: "Starting" },
  stalled: { tone: "warning", label: "Stalled" },
};

const NOTIFICATION_DOCS_ACTION = (
  <Button asChild variant="outline" size="sm">
    <a href={NOTIFICATION_DOCS_URL} rel="noreferrer">
      Setup steps
    </a>
  </Button>
);

function whenOrNever(value: string | null, empty: string) {
  return value === null ? (
    <span className="text-muted-foreground">{empty}</span>
  ) : (
    <RelativeTime value={value} />
  );
}

function rows(status: NotificationStatusView): readonly SummaryRow[] {
  const pill = STATE_PILL[status.state];
  const result: SummaryRow[] = [
    { label: "Status", value: <StatusPill tone={pill.tone}>{pill.label}</StatusPill> },
    { label: "Last poll", value: whenOrNever(status.lastSuccessAt, "Not yet") },
    { label: "Next poll", value: whenOrNever(status.nextPollAt, "Not scheduled") },
    {
      label: "Delivered in the last 24 hours",
      value: <span className="tabular-nums">{status.delivered24h}</span>,
    },
  ];
  if (status.lastError !== null) {
    result.push({
      label: "Last error",
      value: <span className="text-muted-foreground">{status.lastError}</span>,
    });
  }
  return result;
}

/** The health of the GitHub notification poll, for an organization that has a trigger for it. */
export function NotificationStatusCard({ status }: { status: NotificationStatusView }) {
  return (
    <Card title="GitHub notifications" description="Hub polls GitHub for your notifications.">
      {status.state === "off" ? (
        <WarningAlert title="Polling is off" action={NOTIFICATION_DOCS_ACTION}>
          <p>
            <span className="font-mono">GITHUB_NOTIFICATIONS_TOKEN</span> is not set on the Hub, so
            these triggers never run.
          </p>
        </WarningAlert>
      ) : null}
      <SummaryPanel label="GitHub notifications" rows={rows(status)} />
    </Card>
  );
}
