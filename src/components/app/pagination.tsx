import { Link, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, type ChangeEvent, type MouseEvent } from "react";
import type { LinkProps } from "@tanstack/react-router";

import { Button } from "../ui/button.js";
import { PAGE_SIZES, parsePageSize, rememberPageSize, type PageSize } from "./page-size.js";
import { LIST_RESULT_ACTION, useListResultAnnouncement } from "./list-result-announcement.js";

/** Where a control leads. Absent means there is no page that way, and the control is disabled. */
export type PaginationTarget = Pick<LinkProps, "to" | "search" | "params">;

interface PageSizeControl {
  value: PageSize;
  accountId: string;
  onChange: (size: PageSize) => void;
}

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
  announcement = summary,
  newer,
  older,
  pageSize,
  previousLabel = "Newer",
  nextLabel = "Older",
}: {
  label: string;
  /** Changes whenever the reader moves. */
  position: string;
  /** The element that takes focus when the control the reader pressed no longer exists. */
  fallbackFocusId: string;
  summary: string;
  announcement?: string;
  newer: PaginationTarget | null;
  older: PaginationTarget | null;
  pageSize?: PageSizeControl;
  previousLabel?: string;
  nextLabel?: string;
}) {
  const busy = useRouterState({ select: (state) => state.isLoading });
  const message = useListResultAnnouncement(announcement);
  const liveContent = message === null ? null : <span key={message.key}>{message.text}</span>;
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
      className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3"
    >
      <span className="mr-auto text-xs text-muted-foreground">{summary}</span>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveContent}
      </span>
      {pageSize === undefined ? null : <RowsPerPage {...pageSize} busy={busy} />}
      <div className="flex gap-2">
        <PageLink target={newer} busy={busy}>
          {previousLabel}
        </PageLink>
        <PageLink target={older} busy={busy}>
          {nextLabel}
        </PageLink>
      </div>
    </nav>
  );
}

function RowsPerPage({ value, accountId, onChange, busy }: PageSizeControl & { busy: boolean }) {
  const id = useId();
  const select = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      if (busy) return;
      const size = parsePageSize(event.currentTarget.value);
      if (size === undefined || size === value) return;
      rememberPageSize(accountId, size);
      onChange(size);
    },
    [accountId, busy, onChange, value],
  );
  return (
    <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
      <label htmlFor={id}>Rows per page</label>
      <select
        id={id}
        className="h-7 rounded-sm border border-input bg-background px-2.5 text-foreground"
        value={value}
        onChange={select}
        aria-disabled={busy}
      >
        {PAGE_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    </div>
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
  const preventWhileBusy = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (busy) event.preventDefault();
    },
    [busy],
  );
  if (target === null) {
    return (
      <Button variant="outline" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" asChild>
      <Link {...target} state={LIST_RESULT_ACTION} aria-disabled={busy} onClick={preventWhileBusy}>
        {children}
      </Link>
    </Button>
  );
}
