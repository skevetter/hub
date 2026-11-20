import { Link } from "@tanstack/react-router";
import type { LinkProps } from "@tanstack/react-router";

import { Button } from "../ui/button.js";

/** Where a control leads. Absent means there is no page that way, and the control is disabled. */
export type PaginationTarget = Pick<LinkProps, "to" | "search" | "params">;

/**
 * Newer and Older controls under a list read by keyset: the reader moves one page at a time and
 * never jumps, so there is no page count, only the range on screen. Both controls are links, so
 * the page is in the address and back, reload and sharing land on the same rows.
 */
export function Pagination({
  label,
  range,
  newer,
  older,
}: {
  label: string;
  /** The rows on screen, such as "26 to 50". */
  range: string;
  newer: PaginationTarget | null;
  older: PaginationTarget | null;
}) {
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3 pt-3">
      <span className="text-xs text-muted-foreground">{range}</span>
      <div className="flex gap-2">
        <PageLink target={newer}>Newer</PageLink>
        <PageLink target={older}>Older</PageLink>
      </div>
    </nav>
  );
}

function PageLink({ target, children }: { target: PaginationTarget | null; children: string }) {
  if (target === null) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link {...target}>{children}</Link>
    </Button>
  );
}
