import { useRouter } from "@tanstack/react-router";
import { useCallback, type MouseEvent, type ReactNode } from "react";

/**
 * A link to a path the router already resolved. A crumb names a matched route by its pathname,
 * which has no literal route type to hand `Link`, so this is a real anchor that the router
 * navigates on a plain click and the browser handles for new-tab, download and modified clicks.
 */
export function CrumbLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const open = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (event.button !== 0 || modified || event.defaultPrevented) return;
      event.preventDefault();
      router.history.push(to);
    },
    [router, to],
  );
  return (
    <a href={to} onClick={open} className={className}>
      {children}
    </a>
  );
}
