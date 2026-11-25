import { Link, type AnyRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { AttentionRow, AttentionRowsSkeleton } from "../components/app/attention-row.js";
import { Button } from "../components/ui/button.js";
import { actionableAttentionItems } from "./client-state.js";
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
  const actionable = actionableAttentionItems(items);
  const information = items.filter(({ quiet }) => quiet === true);
  return (
    <>
      {actionable.length === 0 ? (
        <p className="py-3 text-muted-foreground">Nothing needs you.</p>
      ) : (
        <ActionableAttention
          items={actionable}
          onFollow={onFollow}
          markSeenPending={markSeenPending}
          markFailedRunsSeen={markFailedRunsSeen}
        />
      )}
      {information.length === 0 ? null : (
        <section aria-label="For information" className="border-t border-border pt-3">
          <h3 className="pb-2 text-muted-foreground">For information</h3>
          <ul>
            {information.map((item) => (
              <AttentionRow key={item.id} quiet title={item.title} detail={item.detail}>
                <AttentionAction item={item} items={items} onFollow={onFollow} />
              </AttentionRow>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ActionableAttention({
  items,
  markFailedRunsSeen,
  markSeenPending,
  onFollow,
}: Pick<AttentionPanelProps, "markFailedRunsSeen" | "markSeenPending" | "onFollow"> & {
  items: readonly AttentionItem[];
}) {
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
