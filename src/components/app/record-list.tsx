import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * A short list of records inside a card, for the times a table would be wrong: the records are
 * already grouped by the card's own subject, so a header row would only repeat it.
 *
 * A table is still the answer for a page-level list of many records with real columns. Reach for
 * this when a card owns a handful of rows and the only columns are "what it is" and "what state
 * it is in" — four provider cards each listing their own connections, not one connections table.
 */
export function RecordList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="grid divide-y divide-border">
      {children}
    </ul>
  );
}

/**
 * One record: what it is on the left, its state and its actions on the right. The row owns the
 * distance to its neighbours so no card decides that for itself.
 */
export function RecordRow({
  children,
  lead,
  status,
  actions,
  busy,
}: {
  /** The identity of the record, normally a `TwoLine`. */
  children: ReactNode;
  /** Its state as a leading `StateBlock`: left of the record, or above it on a phone. */
  lead?: ReactNode;
  /** Its state, always a `StatusPill`. */
  status?: ReactNode;
  /** Its actions, always behind a `RowActions` kebab. */
  actions?: ReactNode;
  busy?: boolean;
}) {
  return (
    <li
      data-slot="record-row"
      aria-busy={busy || undefined}
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 py-3 first:pt-0 last:pb-0",
        lead !== undefined && "max-md:flex-col max-md:items-start",
      )}
    >
      {lead}
      <div className={cn("min-w-0", lead !== undefined && "md:flex-1")}>{children}</div>
      {lead !== undefined && status === undefined && actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">
          {status}
          {actions}
        </div>
      )}
    </li>
  );
}
