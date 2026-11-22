import { useCallback, type MouseEvent } from "react";

export const CONTENT_ID = "content";

/**
 * The first stop for a keyboard: past the sidebar, straight to the page. Invisible until it has
 * focus. It moves focus itself rather than following a fragment, because a fragment is a
 * navigation to the router and the page would be read again from its title.
 */
export function SkipLink() {
  const skip = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById(CONTENT_ID)?.focus();
  }, []);
  return (
    <a
      href={`#${CONTENT_ID}`}
      onClick={skip}
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-popover focus-visible:px-3 focus-visible:py-2 focus-visible:text-sm focus-visible:text-foreground focus-visible:shadow-floating"
    >
      Skip to content
    </a>
  );
}
