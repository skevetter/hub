import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";

/**
 * The one bordered surface. Anything that would otherwise be a hand-rolled `rounded-* border
 * bg-card p-*` div is this, so every card on the dashboard has the same radius, the same
 * padding, and the same distance from its title to its body. Title and description are
 * optional: a card with neither is just the box.
 */
export function Card({
  icon,
  title,
  description,
  status,
  action,
  children,
  className,
  label,
}: {
  /** A glyph identifying what the card is about, beside its title. */
  icon?: ReactNode;
  title?: string;
  description?: string;
  /** The overall state of this card, normally a `StatusPill`. */
  status?: ReactNode;
  /** A single trailing link or button belonging to the card, not to its body. */
  action?: ReactNode;
  /** Optional: a card that is only a title and an action is still a card. */
  children?: ReactNode;
  /** Placement in a parent grid only. Never used to change how the card looks. */
  className?: string;
  /** Exposes a named region when the card is a destination on the page. */
  label?: string;
}) {
  const heading = title === undefined ? null : <h2 className="text-sm text-foreground">{title}</h2>;
  const titled =
    title !== undefined ||
    description !== undefined ||
    status !== undefined ||
    action !== undefined;
  return (
    <section
      aria-label={label}
      className={cn(
        "grid min-w-0 gap-4 rounded-xl border bg-card p-6",
        status !== undefined && "content-start",
        className,
      )}
    >
      {titled ? (
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon === undefined ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  "flex shrink-0 items-center [&>svg]:size-4",
                  status !== undefined && "mt-0.5 self-start",
                )}
              >
                {icon}
              </span>
            )}
            <div className="grid min-w-0 gap-1">
              {status === undefined ? (
                heading
              ) : (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {heading}
                  {status}
                </div>
              )}
              {description === undefined ? null : (
                <p className="text-sm text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          {action === undefined ? null : <div className="shrink-0">{action}</div>}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** The same box before its contents are known, so nothing moves when they land. */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" className="grid min-w-0 gap-3 rounded-xl border bg-card p-6">
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton key={line} className={cn("h-4", line === 0 ? "w-40" : "w-full")} />
      ))}
    </div>
  );
}
