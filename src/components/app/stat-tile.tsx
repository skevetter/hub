import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";
import { Card } from "./card.js";

/** Keep the tile and skeleton dimensions aligned as mobile labels and details wrap. */
export function StatTile({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: LucideIcon;
}) {
  return <StatTileLayout label={label} value={value} detail={detail} icon={icon} />;
}

/** Use the loaded tile's slots so wrapped text has the same space before loading. */
export function StatTileSkeleton() {
  return <StatTileLayout placeholder />;
}

function StatTileLayout({
  label,
  value,
  detail,
  icon: Icon,
  placeholder = false,
}: {
  label?: ReactNode;
  value?: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon | undefined;
  placeholder?: boolean;
}) {
  return (
    <Card>
      <div aria-hidden={placeholder || undefined} className="grid content-start gap-3 self-start">
        <div className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground max-sm:min-h-10 max-sm:items-start">
          {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4 shrink-0" />}
          {placeholder ? <Skeleton className="h-5 w-24 max-w-full" /> : label}
        </div>
        <div className="grid content-start gap-1">
          <div className="min-h-6 text-2xl leading-none tabular-nums">
            {placeholder ? <Skeleton className="h-6 w-10" /> : value}
          </div>
          <div className="min-h-8 text-xs text-muted-foreground">
            {placeholder ? <Skeleton className="h-5 w-20 max-w-full" /> : detail}
          </div>
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
