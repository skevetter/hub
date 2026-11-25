import { useId, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * A labelled group of related content. The heading is set apart by the gap above it, not by
 * being bigger or heavier than the rows below. Owns its own bottom margin so callers never
 * add spacing between sections — the section decides how far apart sections sit.
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  /** A single trailing link or button, e.g. "View all". */
  action?: ReactNode;
  children: ReactNode;
  /** Placement in a parent grid only. Never used to change how the section looks. */
  className?: string;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={title === undefined ? undefined : titleId}
      className={cn("mb-8 grid min-w-0 gap-3 last:mb-0", className)}
    >
      {title === undefined ? null : (
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            <h2 id={titleId} className="text-sm text-foreground">
              {title}
            </h2>
            {description === undefined ? null : (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action === undefined ? null : (
            <div className="shrink-0 [&>a]:inline-flex [&>a]:min-h-6 [&>a]:items-center max-md:[&>a]:min-h-11">
              {action}
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
