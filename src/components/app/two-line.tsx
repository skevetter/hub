import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * The one way a record shows two facts: what it is, over the quieter fact that identifies it.
 * Emphasis here is colour and size, never weight. Both lines truncate to keep table rows the
 * same height. Record lists let their primary label wrap. A line only truncates when whatever holds
 * it is narrower than the line: on its own it is as wide as its longer line, so a table column
 * sized to its content shows all of it. A string line carries itself as its title, so a value
 * that was cut is one hover away.
 */
export function TwoLine({
  primary,
  secondary,
  mono = false,
  path = false,
  heading = false,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  /** The secondary line is an identifier — a key prefix, a slug, an id — not prose. */
  mono?: boolean;
  /**
   * The secondary line is a filesystem path: an identifier whose tail tells two records apart,
   * so it gives way from the start and keeps its end.
   */
  path?: boolean;
  /** Give a card a heading and let its identity wrap on a narrow screen. */
  heading?: boolean;
}) {
  const { Frame, Primary, overflow } = lineElements(heading);
  return (
    // In a filling cell the record also takes the row it sits in, beside a glyph or not, so its
    // secondary line has the whole column to give way in rather than the primary line's width.
    <Frame className="flex min-w-0 flex-col gap-0.5 in-data-[slot=fill-cell]:grow">
      <Primary
        className={cn(
          overflow,
          !heading && "text-sm",
          "in-data-[slot=record-row]:wrap-anywhere in-data-[slot=record-row]:whitespace-normal",
        )}
        title={titleOf(primary)}
      >
        {primary}
      </Primary>
      {secondary === undefined ? null : (
        <span
          className={cn(
            // In a filling table cell the primary line sets the record's width and the secondary
            // line takes whatever that leaves: a model under a name, a path under a daemon, a
            // connection under an event. Otherwise one long path would claim the width a
            // neighbouring column needs for the fact a reader is scanning for.
            overflow,
            "text-xs text-muted-foreground in-data-[slot=fill-cell]:w-0 in-data-[slot=fill-cell]:min-w-full",
            monoClass(mono, path),
            path && "text-left",
          )}
          title={titleOf(secondary)}
          // Right-to-left puts the overflow, and the ellipsis, at the start of the line; the
          // isolate inside keeps the path itself reading left to right.
          {...(path ? { dir: "rtl" } : {})}
        >
          {path ? <bdi dir="ltr">{secondary}</bdi> : secondary}
        </span>
      )}
    </Frame>
  );
}

function monoClass(mono: boolean, path: boolean) {
  return (mono || path) && "font-mono";
}

function lineElements(heading: boolean) {
  return {
    Frame: heading ? "div" : "span",
    Primary: heading ? "h2" : "span",
    overflow: heading ? "break-words" : "truncate",
  } as const;
}

function titleOf(line: ReactNode): string | undefined {
  return typeof line === "string" ? line : undefined;
}
