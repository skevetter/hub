import { useCallback } from "react";
import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { FollowBottom } from "./follow-bottom.js";
import { EmptyState } from "./empty-state.js";
import { Spinner } from "./loading.js";
import { StatusLine } from "./status-line.js";
import { StatusPill, statusLabel, type StatusTone } from "./status-pill.js";
import { Skeleton } from "../ui/skeleton.js";

import type { DeliveryStatus, ToolStatus, TranscriptItem } from "./transcript-types.js";

export type { DeliveryStatus, ToolStatus, TranscriptItem } from "./transcript-types.js";

const DELIVERY: Record<DeliveryStatus, { tone: StatusTone; label: string }> = {
  sending: { tone: "neutral", label: "Sending" },
  failed: { tone: "danger", label: "Failed" },
  delivered: { tone: "success", label: "Delivered" },
  queued: { tone: "neutral", label: "Queued" },
  not_sent: { tone: "danger", label: "Not sent" },
  unknown: { tone: "warning", label: "Delivery unknown" },
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
  onRetry,
  retryBusy = false,
}: {
  items: readonly TranscriptItem[];
  /** Moves whenever the feed changes, so a reader at the bottom follows and one above stays put. */
  version: number;
  working?: boolean;
  announcement?: string;
  onRetry?: ((id: string) => void) | undefined;
  retryBusy?: boolean;
}) {
  const ordered = orderTranscript(items);
  return (
    <div className="grid min-w-0 gap-3">
      {ordered.length === 0 && !working ? (
        <EmptyState title="No messages yet" description="Messages and agent replies appear here." />
      ) : (
        <FollowBottom version={version} label="Session transcript" maxHeight="min(55vh, 36rem)">
          <ul className="grid min-w-0 gap-4">
            {ordered.map((item) => (
              <li key={item.id} className="min-w-0">
                <Entry item={item} onRetry={onRetry} retryBusy={retryBusy} />
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

function Entry({
  item,
  onRetry,
  retryBusy,
}: {
  item: TranscriptItem;
  onRetry: ((id: string) => void) | undefined;
  retryBusy: boolean;
}) {
  const retry = useCallback(() => onRetry?.(item.id), [item.id, onRetry]);
  switch (item.kind) {
    case "human":
      return (
        <div data-entry="human" className="grid min-w-0 justify-items-end gap-1">
          <div className="flex min-w-0 max-w-full items-center justify-end gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{item.author}</span>
            <StatusPill tone={DELIVERY[item.status].tone}>{DELIVERY[item.status].label}</StatusPill>
            {item.retryable && onRetry !== undefined ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={retry}
                disabled={retryBusy}
              >
                Send again
              </Button>
            ) : null}
          </div>
          {item.text === null ? (
            <p className="text-sm text-muted-foreground">Message expired</p>
          ) : (
            <p className="max-w-xl min-w-0 rounded-xl bg-muted px-3 py-2 text-sm whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
              {item.text}
            </p>
          )}
        </div>
      );
    case "assistant":
      return (
        <div data-entry="assistant" className="grid min-w-0 justify-items-start gap-1">
          <p className="text-xs text-muted-foreground">Agent</p>
          <p className="min-w-0 text-sm whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
            {item.text}
          </p>
          {item.truncated ? <p className="text-xs text-muted-foreground">Reply cut short</p> : null}
        </div>
      );
    case "tool":
      return (
        <p
          data-entry="tool"
          className={cn(
            "flex min-w-0 items-center gap-2 text-xs",
            item.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 truncate font-mono" title={item.name}>
            {item.name}
          </span>
          <span className="shrink-0">{statusLabel(item.status)}</span>
        </p>
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
