import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/utils.js";

export type PageAlertTone = "attention" | "neutral";

const MARK_CLASS: Record<PageAlertTone, string> = {
  attention: "bg-attention",
  neutral: "bg-off-text",
};

/**
 * What a page has to tell its reader before the content: one item per source, stacked at the top
 * of the page, each with at most one way out. A heavy rule opens it and a square mark carries the
 * state ink, so it reads as a line of the page and never as a box. `attention` means a person has
 * to act; `neutral` is something that ended or does not need anyone.
 *
 * Announce it with `role`: `alert` for something that arrived while the reader was here,
 * `status` for a calmer notice, and nothing for a warning derived from the page they just opened.
 * It owns the distance to whatever follows, because a page stack has no gap to inherit.
 */
export function PageAlert({
  tone = "attention",
  title,
  action,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  tone?: PageAlertTone;
  title?: ReactNode;
  /** The single control belonging to the alert, such as a link to the page that resolves it. */
  action?: ReactNode;
}) {
  return (
    <div
      data-slot="alert"
      data-tone={tone}
      className={cn(
        "mb-6 grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-3 border-t-2 border-foreground pt-3 text-sm md:grid-cols-[auto_1fr_auto]",
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0", MARK_CLASS[tone])} />
      <div className="grid min-w-0 gap-1">
        {title === undefined ? null : (
          <div data-slot="alert-title" className="min-w-0 font-strong">
            {title}
          </div>
        )}
        {children === undefined ? null : (
          <div
            data-slot="alert-description"
            className="grid min-w-0 justify-items-start gap-2 wrap-anywhere text-muted-foreground"
          >
            {children}
          </div>
        )}
      </div>
      {action === undefined ? null : (
        <div data-slot="alert-action" className="col-start-2 md:col-start-3 md:self-center">
          {action}
        </div>
      )}
    </div>
  );
}
