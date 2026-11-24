import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useId,
  type ChangeEventHandler,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button } from "../ui/button.js";
import { LIST_RESULT_ACTION } from "./list-result-announcement.js";
import type { PaginationTarget } from "./pagination.js";

export function ListFilters({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div
      id={id}
      role="group"
      aria-label="Filters"
      tabIndex={-1}
      className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-2"
    >
      {children}
    </div>
  );
}

export function ClearListFilters({
  target,
  focusId,
}: {
  target: PaginationTarget;
  focusId: string;
}) {
  const moveFocus = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      // The Clear filters link can unmount when the next results arrive.
      document.getElementById(focusId)?.focus();
    },
    [focusId],
  );
  return (
    <Button variant="outline" size="sm" asChild>
      <Link {...target} state={LIST_RESULT_ACTION} onClick={moveFocus}>
        Clear filters
      </Link>
    </Button>
  );
}

export interface ListFilterOption {
  value: string;
  label: string;
}

export function ListFilterSelect({
  name,
  label,
  allLabel,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  allLabel: string;
  options: readonly ListFilterOption[];
  value: string | undefined;
  onChange: ChangeEventHandler<HTMLSelectElement>;
}) {
  const id = useId();
  const missing = value !== undefined && !options.some((option) => option.value === value);
  return (
    <div className="grid min-w-0 max-w-48 gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        name={name}
        className="h-8 min-w-0 truncate rounded-sm border border-input bg-background px-2.5"
        value={value ?? ""}
        onChange={onChange}
      >
        <option value="">{allLabel}</option>
        {missing ? <option value={value}>Unavailable</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
