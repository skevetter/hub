import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";
import { Card } from "./card.js";

/**
 * An overview figure. The number is bigger, never heavier, and sits in a fixed-height box so a
 * tile does not resize when its data resolves — the loading, empty, and loaded states occupy
 * the same space.
 */
export function StatTile({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: LucideIcon;
}) {
  return (
    <Card>
      {/* Tiles in a row share the tallest one's height; each keeps its figure on the same line. */}
      <div className="grid content-start gap-3 self-start">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4" />}
          {label}
        </div>
        <div className="grid min-h-11 content-start gap-1">
          <p className="text-2xl leading-none tabular-nums">{value}</p>
          <p className="min-h-5 text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
    </Card>
  );
}

/** The same box before its number is known, so the row does not move when the figures land. */
export function StatTileSkeleton() {
  return (
    <Card>
      <div aria-hidden="true" className="grid gap-3">
        <Skeleton className="h-5 w-24" />
        <div className="grid min-h-11 content-start gap-1">
          <Skeleton className="h-6 w-10" />
          <Skeleton className="h-5 w-20" />
        </div>
      </div>
    </Card>
  );
}

const GRID_COLUMNS = {
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  // Five leaves one tile alone on a phone's last row; it takes the row rather than half of it.
  5: "grid-cols-2 max-lg:[&>*:last-child]:col-span-2 lg:grid-cols-5",
} as const;

/**
 * A row of tiles. Three stack on a phone; four or five sit two across there, because a column
 * of five figures is a page of scrolling before anything else is seen.
 */
export function StatGrid({
  columns = 3,
  children,
}: {
  columns?: keyof typeof GRID_COLUMNS;
  children: ReactNode;
}) {
  return <div className={cn("grid gap-4", GRID_COLUMNS[columns])}>{children}</div>;
}
