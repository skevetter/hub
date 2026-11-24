import { Link, type AnyRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { AttentionRow, AttentionRowsSkeleton } from "../components/app/attention-row.js";
import { Button } from "../components/ui/button.js";
import type { AttentionItem } from "./contract.js";
import type { useAttention } from "./use-attention.js";

type AttentionPanelProps = ReturnType<typeof useAttention> & {
  onFollow: () => void;
};

export function AttentionPanel({
  snapshot,
  markFailedRunsSeen,
  markSeenPending,
  onFollow,
}: AttentionPanelProps) {
  const { refetch } = snapshot;
  const retry = useCallback(() => refetch(), [refetch]);
  if (snapshot.status === "pending") return <AttentionRowsSkeleton />;
  if (snapshot.status === "error") {
    return (
      <div className="flex items-center justify-between gap-3 py-3">
        <p>Attention could not load.</p>
        <Button
          type="button"
          variant="outline"
          className="max-md:min-h-11"
          disabled={snapshot.isFetching}
          onClick={retry}
        >
          Try again
        </Button>
      </div>
    );
  }
  const { items } = snapshot.data;
  if (items.length === 0) return <p className="py-3 text-muted-foreground">Nothing needs you.</p>;
  return (
    <ul>
      {items.map((item) => (
        <AttentionRow key={item.id} title={item.title} detail={item.detail}>
          <AttentionAction item={item} items={items} onFollow={onFollow} />
          {item.dismiss === undefined ? null : (
            <Button
              type="button"
              variant="ghost"
              className="max-md:min-h-11"
              disabled={markSeenPending}
              onClick={markFailedRunsSeen}
            >
              {item.dismiss.label}
            </Button>
          )}
        </AttentionRow>
      ))}
    </ul>
  );
}

function AttentionAction({
  item,
  items,
  onFollow,
}: {
  item: AttentionItem;
  items: readonly AttentionItem[];
  onFollow: () => void;
}) {
  const { action } = item;
  const ambiguous = items.some(
    (other) => other.id !== item.id && other.action.label === action.label,
  );
  return (
    <Button asChild variant="link" className="max-md:min-h-11">
      <Link<AnyRouter, string, string>
        to={action.to}
        search={action.search}
        aria-label={ambiguous ? `${action.label}: ${item.title}` : undefined}
        onClick={onFollow}
      >
        {action.label}
      </Link>
    </Button>
  );
}
