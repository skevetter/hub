import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useCallback, useId, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { LoadingLine, Spinner } from "./loading.js";

export interface ComboboxOption {
  /** The stored value. May be empty for an explicit "no choice" option. */
  value: string;
  label: string;
  /** Extra words the search should match, e.g. a provider name or an alias. */
  keywords?: readonly string[];
  /** The quiet second line under the label. */
  detail?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface ComboboxProps<T extends ComboboxOption> {
  id: string;
  /** The accessible name, when no `FormField` label points at this control. */
  label?: string;
  value: string;
  options: readonly T[];
  onChange: (option: T) => void;
  /** What the closed trigger says when nothing is chosen, e.g. "Select a model". */
  placeholder: string;
  /**
   * What the search box says. Defaults to the trigger's own placeholder with an ellipsis, which
   * is right when the trigger names the thing; name it separately when the search is doing
   * something the trigger's words do not describe, e.g. "Search models...".
   */
  searchPlaceholder?: string;
  /** The options are still arriving. The list says so rather than saying there are none. */
  loading?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** Replaces the default label-over-detail line inside an option. */
  renderOption?: (option: T) => ReactNode;
  /** What to say when the search matches nothing, e.g. "No repositories found." */
  empty: string;
  /**
   * The rest of a `FormField`'s wiring, so a labelled combobox is `{...control}` like every
   * other control rather than an id threaded through by hand.
   */
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

/**
 * Pick one of many, with search. The one dropdown on the dashboard: a model, a repository, an
 * event type. It hands back the whole option rather than its value, so a caller that needs the
 * record behind the choice does not have to look it up again.
 *
 * A value that is no longer among the options is shown, marked unavailable, rather than
 * silently reading as empty — a trigger pointing at a model the daemon stopped offering must
 * say so instead of looking unset.
 */
export function Combobox<T extends ComboboxOption>(props: ComboboxProps<T>) {
  const {
    value,
    options,
    onChange,
    placeholder,
    searchPlaceholder,
    loading = false,
    renderOption,
  } = props;
  const [open, setOpen] = useState(false);
  const listId = useId();
  const choose = useCallback(
    (option: T) => {
      onChange(option);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={props.id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          {...comboboxAria(props)}
          disabled={props.disabled ?? false}
          data-value={value}
          className="h-auto min-h-8 w-full min-w-0 justify-between py-1 text-left whitespace-normal"
        >
          <ComboboxTriggerContent
            options={options}
            value={value}
            placeholder={placeholder}
            loading={loading}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popper-anchor-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder ?? `${placeholder}\u2026`} />
          <CommandList id={listId}>
            <ComboboxOptions
              options={options}
              value={value}
              loading={loading}
              empty={props.empty}
              renderOption={renderOption}
              choose={choose}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function comboboxAria({
  label,
  required,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: Pick<
  ComboboxProps<ComboboxOption>,
  "label" | "required" | "aria-invalid" | "aria-describedby"
>) {
  return {
    ...(label === undefined ? {} : { "aria-label": label }),
    ...(required ? { "aria-required": true } : {}),
    ...(invalid === undefined ? {} : { "aria-invalid": invalid }),
    ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
  };
}

function ComboboxTriggerContent({
  options,
  value,
  placeholder,
  loading,
}: Pick<ComboboxProps<ComboboxOption>, "options" | "value" | "placeholder"> & {
  loading: boolean;
}) {
  const selected = comboboxSelection(options, value);
  return (
    <>
      <span
        className={cn(
          "flex min-w-0 items-center gap-2",
          selected === undefined && value === "" && "text-muted-foreground",
        )}
      >
        {selected?.icon}
        <span className="wrap-anywhere">{comboboxLabel(options, value, placeholder, loading)}</span>
      </span>
      {loading ? (
        <Spinner className="opacity-50" />
      ) : (
        <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 opacity-50" />
      )}
    </>
  );
}

function ComboboxOptions<T extends ComboboxOption>({
  options,
  value,
  empty,
  loading,
  renderOption,
  choose,
}: Pick<ComboboxProps<T>, "options" | "value" | "empty"> & {
  loading: boolean;
  renderOption: ComboboxProps<T>["renderOption"];
  choose: (option: T) => void;
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <LoadingLine>{"Loading\u2026"}</LoadingLine>
      </div>
    );
  }
  return (
    <>
      <CommandEmpty>{empty}</CommandEmpty>
      {options.map((option) => (
        <ComboboxItem
          key={option.value}
          option={option}
          selected={option.value === value}
          renderOption={renderOption}
          choose={choose}
        />
      ))}
    </>
  );
}

function ComboboxItem<T extends ComboboxOption>({
  option,
  selected,
  renderOption,
  choose,
}: {
  option: T;
  selected: boolean;
  renderOption: ComboboxProps<T>["renderOption"];
  choose: (option: T) => void;
}) {
  const select = useCallback(() => choose(option), [choose, option]);
  return (
    <CommandItem
      // cmdk needs a nonempty search value even for an explicit "no choice" option.
      value={option.value === "" ? option.label : option.value}
      {...(option.keywords === undefined ? {} : { keywords: [...option.keywords] })}
      {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
      data-value={option.value}
      onSelect={select}
    >
      <CheckIcon aria-hidden="true" className={cn(selected ? "opacity-100" : "opacity-0")} />
      {option.icon}
      {renderOption === undefined ? (
        <span className="grid min-w-0 gap-0.5 wrap-anywhere">
          <span>{option.label}</span>
          {option.detail === undefined ? null : (
            <span className="text-xs text-muted-foreground">{option.detail}</span>
          )}
        </span>
      ) : (
        renderOption(option)
      )}
    </CommandItem>
  );
}

/** The option a stored value refers to, or `undefined` when it refers to nothing on offer. */
export function comboboxSelection<T extends ComboboxOption>(
  options: readonly T[],
  value: string,
): T | undefined {
  return options.find((option) => option.value === value);
}

/**
 * What the closed trigger reads: the choice, the placeholder, or a value that has gone away.
 *
 * "Gone away" is a claim about the options, so it waits for them. While they are still arriving
 * the stored value is shown as it is — a value that has not been looked up yet is not a value
 * that was withdrawn.
 */
export function comboboxLabel(
  options: readonly ComboboxOption[],
  value: string,
  placeholder: string,
  loading = false,
): string {
  const selected = comboboxSelection(options, value);
  if (selected !== undefined) return selected.label;
  if (value === "") return placeholder;
  return loading ? value : `${value} (unavailable)`;
}
