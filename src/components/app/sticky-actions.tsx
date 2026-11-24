import type { ReactNode } from "react";

/**
 * A detail page's primary action on a phone, held above the bottom bar. Place it after the
 * page's content: a sticky bottom edge only holds while its natural position is still below
 * the visible area. From `md` the shell has no bottom bar and the page header carries the
 * action, so this renders nothing visible there.
 */
export function StickyActions({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="sticky-actions"
      className="sticky bottom-[var(--shell-bottom-bar)] z-10 -mx-4 grid gap-2 border-t bg-background px-4 py-3 md:hidden"
    >
      {children}
    </div>
  );
}
