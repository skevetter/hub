import { Check, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * How far through a short list the reader is, one segment per step. It is a progress bar to a
 * screen reader and a row of marks to everyone else; the count itself is said by whoever renders
 * this, in words, so the bar never has to be read to know the number.
 */
export function ChecklistProgress({
  label,
  done,
  total,
}: {
  label: string;
  done: number;
  total: number;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${String(done)} of ${String(total)} done`}
      className="flex gap-1"
    >
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn("h-1 flex-1 rounded-full", index < done ? "bg-success" : "bg-border")}
        />
      ))}
    </div>
  );
}

/** The steps themselves. A list, so the count and the order are announced. */
export function Checklist({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="grid divide-y divide-border">
      {children}
    </ul>
  );
}

export type ChecklistItemState = "done" | "todo" | "attention";

/**
 * One step: a mark for its state, what it is, the line that says what to do or what was done,
 * and at most one way to do it. A finished step steps back to the muted colour so the eye lands
 * on what is left. On a narrow screen the action drops under the text instead of squeezing it.
 */
export function ChecklistItem({
  state,
  stateLabel,
  title,
  hint,
  action,
  children,
}: {
  state: ChecklistItemState;
  /** The state in words, e.g. "Done" or "Cannot run agents". Read aloud, and shown for `attention`. */
  stateLabel: string;
  title: string;
  hint?: ReactNode;
  /** The one next action: a link or a button. */
  action?: ReactNode;
  /** Something to copy and run elsewhere, under the hint. */
  children?: ReactNode;
}) {
  return (
    <li className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 py-3 first:pt-0 last:pb-0">
      <StateMark state={state} />
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-64 gap-1">
          <p className={cn("text-sm", state === "done" && "text-muted-foreground")}>
            {title}
            {state === "attention" ? (
              <span className="text-warning">
                {" · "}
                {stateLabel}
              </span>
            ) : (
              <span className="sr-only"> {stateLabel}</span>
            )}
          </p>
          {hint === undefined ? null : (
            <p className="min-w-0 wrap-anywhere text-sm text-muted-foreground">{hint}</p>
          )}
          {children === undefined ? null : <div className="mt-1 min-w-0">{children}</div>}
        </div>
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>
    </li>
  );
}

function StateMark({ state }: { state: ChecklistItemState }) {
  if (state === "done") {
    return (
      <span
        aria-hidden="true"
        className="grid size-5 place-items-center rounded-full bg-success-surface text-success"
      >
        <Check className="size-3" />
      </span>
    );
  }
  if (state === "attention") {
    return (
      <span
        aria-hidden="true"
        className="grid size-5 place-items-center rounded-full bg-warning-surface text-warning"
      >
        <TriangleAlert className="size-3" />
      </span>
    );
  }
  return <span aria-hidden="true" className="size-5 rounded-full border border-input" />;
}
