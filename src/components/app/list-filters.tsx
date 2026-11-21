import { useId, type ChangeEventHandler, type ReactNode } from "react";

export function ListFilters({ children }: { children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label="Filters"
      className="mb-3 flex flex-wrap items-end gap-x-3 gap-y-2"
    >
      {children}
    </div>
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
        className="h-8 min-w-0 truncate rounded-md border border-input bg-background px-2.5"
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
