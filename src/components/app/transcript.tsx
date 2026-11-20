import { FollowBottom } from "./follow-bottom.js";
import { EmptyState } from "./empty-state.js";
import { Spinner } from "./loading.js";
import { StatusLine } from "./status-line.js";
import { StatusPill, statusLabel, type StatusTone } from "./status-pill.js";
import { Skeleton } from "../ui/skeleton.js";

export type DeliveryStatus = "delivered" | "queued" | "not_sent" | "unknown";
export type ToolStatus = "running" | "completed" | "failed" | "canceled";

/**
 * `seq` is the daemon's position for the entry. A Hub message the daemon has not yet echoed has
 * none: it is queued, unsent, or of unknown fate, and sits after everything the agent has said.
 */
export type TranscriptItem = { id: string } & (
  | {
      kind: "human";
      author: string;
      /** `null` once the body has expired; the entry stays as a place marker. */
      text: string | null;
      status: DeliveryStatus;
      seq: number | null;
    }
  | { kind: "assistant"; text: string; truncated: boolean; seq: number }
  | { kind: "tool"; name: string; status: ToolStatus; seq: number }
  | { kind: "boundary"; label: string; seq: number }
);

const DELIVERY: Record<DeliveryStatus, { tone: StatusTone; label: string }> = {
  delivered: { tone: "success", label: "Delivered" },
  queued: { tone: "neutral", label: "Queued" },
  not_sent: { tone: "danger", label: "Not sent" },
  unknown: { tone: "warning", label: "Delivery unknown" },
};

const TOOL_TONE: Record<ToolStatus, StatusTone> = {
  running: "neutral",
  completed: "success",
  failed: "danger",
  canceled: "warning",
};

/** Anchored entries by daemon position, then every unanchored Hub message in arrival order. */
export function orderTranscript(items: readonly TranscriptItem[]): TranscriptItem[] {
  const anchored = items.flatMap((item) => (item.seq === null ? [] : [{ item, seq: item.seq }]));
  const unanchored = items.filter((item) => item.seq === null);
  anchored.sort((a, b) => a.seq - b.seq);
  return [...anchored.map(({ item }) => item), ...unanchored];
}

/**
 * The activity feed of one session. Presentational: the caller owns fetching and merging, and
 * passes `announcement` for the few changes worth a screen reader's attention (a delivery
 * settling, a turn ending, an approval). Streamed text is never announced token by token.
 */
export function Transcript({
  items,
  version,
  working = false,
  announcement = "",
}: {
  items: readonly TranscriptItem[];
  /** Moves whenever the feed changes, so a reader at the bottom follows and one above stays put. */
  version: number;
  working?: boolean;
  announcement?: string;
}) {
  const ordered = orderTranscript(items);
  return (
    <div className="grid min-w-0 gap-3">
      {ordered.length === 0 && !working ? (
        <EmptyState title="No messages yet" description="Messages and agent replies appear here." />
      ) : (
        <FollowBottom version={version}>
          <ul className="grid min-w-0 gap-4">
            {ordered.map((item) => (
              <li key={item.id} className="min-w-0">
                <Entry item={item} />
              </li>
            ))}
            {working ? (
              <li className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                Working
              </li>
            ) : null}
          </ul>
        </FollowBottom>
      )}
      <StatusLine>{announcement}</StatusLine>
    </div>
  );
}

function Entry({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "human":
      return (
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{item.author}</span>
            <StatusPill tone={DELIVERY[item.status].tone}>{DELIVERY[item.status].label}</StatusPill>
          </div>
          {item.text === null ? (
            <p className="text-sm text-muted-foreground">Message expired</p>
          ) : (
            <p className="min-w-0 text-sm whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
              {item.text}
            </p>
          )}
        </div>
      );
    case "assistant":
      return (
        <div className="grid min-w-0 gap-1">
          <p className="text-xs text-muted-foreground">Agent</p>
          <p className="min-w-0 text-sm whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {item.text}
          </p>
          {item.truncated ? <p className="text-xs text-muted-foreground">Reply cut short</p> : null}
        </div>
      );
    case "tool":
      return (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono" title={item.name}>
            {item.name}
          </span>
          <StatusPill tone={TOOL_TONE[item.status]}>{statusLabel(item.status)}</StatusPill>
        </div>
      );
    default:
      return (
        <p className="min-w-0 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {item.label}
        </p>
      );
  }
}

/** The feed's own box: a few entries of varying length, so nothing moves when it fills. */
export function TranscriptSkeleton() {
  return (
    <div className="grid gap-4" aria-hidden="true">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
