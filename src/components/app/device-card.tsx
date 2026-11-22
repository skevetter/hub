import { Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "../ui/skeleton.js";
import { Card } from "./card.js";
import { RelativeTime } from "./relative-time.js";
import { StatusPill, type StatusTone } from "./status-pill.js";
import { SummaryPanel, type SummaryRow } from "./summary-panel.js";
import { TwoLine } from "./two-line.js";

const STATUS = {
  connected: { label: "Connected", tone: "success" },
  offline: { label: "Offline", tone: "neutral" },
  revoked: { label: "Revoked", tone: "danger" },
} satisfies Record<string, { label: string; tone: StatusTone }>;

const IDENTITY = "flex min-w-0 items-start gap-3";
const STATUS_ROW = "flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground";
const GLYPH = "size-8 shrink-0 rounded-md";

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
        <div className={IDENTITY}>
          <span
            className={`flex items-center justify-center bg-muted text-muted-foreground ${GLYPH}`}
          >
            <Monitor aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0">
            <TwoLine primary={name} secondary={id} mono heading />
          </div>
        </div>
        {actions}
      </div>
      <div className={STATUS_ROW}>
        <StatusPill tone={tone}>{label}</StatusPill>
        <span>
          Last seen <RelativeTime value={lastSeenAt} />
        </span>
      </div>
      <SummaryPanel label={name} rows={details} inline />
    </Card>
  );
}

export function DeviceCardSkeleton({ detailCount }: { detailCount: 2 | 3 }) {
  const facts =
    detailCount === 3 ? ["providers", "profiles", "permissions"] : ["providers", "permissions"];
  return (
    <div aria-busy="true" aria-hidden="true">
      <Card>
        <div className={IDENTITY}>
          <Skeleton className={GLYPH} />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <Skeleton className="h-5 w-32 max-w-full" />
            <div className="grid gap-1">
              <Skeleton className="h-4 w-64 max-w-full" />
              <Skeleton className="h-3 w-24 sm:hidden" />
            </div>
          </div>
        </div>
        <div className={STATUS_ROW}>
          <Skeleton className="h-5 w-20 rounded-sm" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="grid min-w-0 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))]">
          {facts.map((fact) => (
            <div key={fact} className="grid min-w-0 content-start gap-1">
              <Skeleton className="h-4 w-20" />
              {fact === "permissions" ? (
                <div className="grid min-w-0 gap-2">
                  <div className="grid gap-1">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-5 w-4/5" />
                  </div>
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-14 w-full" />
                </div>
              ) : (
                <Skeleton className="h-5 w-40 max-w-full" />
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
