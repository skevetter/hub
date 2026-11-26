import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";

export type FigureTone = "attention" | "live";

const TONE: Record<FigureTone, string> = {
  attention: "text-attention-text",
  live: "text-live-text",
};

const FRAME = "grid min-w-0 content-start gap-1 border-t-2 border-foreground pt-3";

/**
 * The number a section is about: a heavy rule, an oversized flush-left numeral, what it counts
 * and at most one line of context. Tone is for a count that needs a person (`attention`) or is
 * in flight (`live`); the unit and caption carry the same meaning in words.
 */
export function Figure({
  value,
  unit,
  children,
  tone,
}: {
  value: string;
  unit: string;
  /** The caption line. */
  children?: ReactNode;
  tone?: FigureTone | undefined;
}) {
  return (
    <div data-slot="figure" className={FRAME}>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className={cn("font-strong text-3xl tabular-nums", tone && TONE[tone])}>{value}</span>
        <span className="text-sm">{unit}</span>
      </p>
      {children === undefined ? null : (
        <p className="wrap-anywhere text-xs text-muted-foreground">{children}</p>
      )}
    </div>
  );
}

/** Figures that lead a page: two across on a phone, three or four from `md`. Owns the space after them. */
export function Figures({
  label,
  columns = 3,
  children,
}: {
  label: string;
  columns?: 3 | 4;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "mb-10 grid grid-cols-2 gap-x-4 gap-y-6 last:mb-0 md:gap-x-6",
        columns === 4 ? "md:grid-cols-4" : "md:grid-cols-3",
      )}
    >
      {children}
    </div>
  );
}

/** The loaded figure's rule, numeral, unit and caption lines, so nothing moves when it arrives. */
export function FigureSkeleton() {
  return (
    <div aria-hidden="true" className={FRAME}>
      <div className="flex items-baseline gap-2">
        <Skeleton className="h-12 w-14 md:h-14" />
        <Skeleton className="h-5 w-20" />
      </div>
      <Skeleton className="h-4 w-32 max-w-full" />
    </div>
  );
}
