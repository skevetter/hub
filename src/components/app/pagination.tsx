import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { LinkProps } from "@tanstack/react-router";

import { Button } from "../ui/button.js";

/** Where a control leads. Absent means there is no page that way, and the control is disabled. */
export type PaginationTarget = Pick<LinkProps, "to" | "search" | "params">;

/**
 * Newer and Older controls under a list read by keyset: the reader moves one page at a time and
 * never jumps, so there is no page count, only a summary of what is on screen. Both controls are
 * links, so the page is in the address and back, reload and sharing land on the same rows.
 *
 * The pager stays on screen while the next page loads, with its controls inert but still in
 * place, so the key that was pressed keeps its focus. If the control the reader used is gone
 * once the new page arrives, focus goes to the title instead of falling to the document body.
 */
export function Pagination({
  label,
  position,
  fallbackFocusId,
  summary,
  newer,
  older,
}: {
  label: string;
  /** Changes whenever the reader moves. */
  position: string;
  /** The element that takes focus when the control the reader pressed no longer exists. */
  fallbackFocusId: string;
  summary: string;
  newer: PaginationTarget | null;
  older: PaginationTarget | null;
}) {
  const busy = useRouterState({ select: (state) => state.isLoading });
  const moved = useRef(position);
  useEffect(() => {
    if (moved.current === position) return;
    moved.current = position;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.getElementById(fallbackFocusId)?.focus();
    }
  }, [position, fallbackFocusId]);
  return (
    <nav
      aria-label={label}
      aria-busy={busy}
      className="flex items-center justify-between gap-3 pt-3"
    >
      <span className="text-xs text-muted-foreground">{summary}</span>
      <div className="flex gap-2">
        <PageLink target={newer} busy={busy}>
          Newer
        </PageLink>
        <PageLink target={older} busy={busy}>
          Older
        </PageLink>
      </div>
    </nav>
  );
}

function PageLink({
  target,
  busy,
  children,
}: {
  target: PaginationTarget | null;
  busy: boolean;
  children: string;
}) {
  if (target === null) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      {/* oxlint-disable-next-line eslint-plugin-react-perf/jsx-no-new-function-as-prop -- a busy link must not start a second read */}
      <Link {...target} aria-disabled={busy} onClick={(event) => busy && event.preventDefault()}>
        {children}
      </Link>
    </Button>
  );
}
