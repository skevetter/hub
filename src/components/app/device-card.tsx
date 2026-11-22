import { Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardSkeleton } from "./card.js";
import { RelativeTime } from "./relative-time.js";
import { StatusPill, type StatusTone } from "./status-pill.js";
import { SummaryPanel, type SummaryRow } from "./summary-panel.js";
import { TwoLine } from "./two-line.js";

const STATUS = {
  connected: { label: "Connected", tone: "success" },
  offline: { label: "Offline", tone: "neutral" },
  revoked: { label: "Revoked", tone: "danger" },
} satisfies Record<string, { label: string; tone: StatusTone }>;

export function DeviceCard({
  name,
  id,
  status,
  lastSeenAt,
  details,
  actions,
}: {
  name: string;
  id: string;
  status: keyof typeof STATUS;
  lastSeenAt: string;
  details: readonly SummaryRow[];
  actions?: ReactNode;
}) {
  const { tone, label } = STATUS[status];
  return (
    <Card>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Monitor aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <TwoLine primary={name} secondary={id} mono heading />
          </div>
        </div>
        {actions}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <StatusPill tone={tone}>{label}</StatusPill>
        <span>
          Last seen <RelativeTime value={lastSeenAt} />
        </span>
      </div>
      <SummaryPanel label={name} rows={details} inline />
    </Card>
  );
}

export function DeviceCardSkeleton({ detailCount }: { detailCount: number }) {
  return (
    <div className="min-w-0 motion-reduce:[&_[data-slot=skeleton]]:animate-none">
      <CardSkeleton lines={detailCount + 3} />
    </div>
  );
}
