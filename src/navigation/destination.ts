import { trimPathRight } from "@tanstack/react-router";

export interface NavigationDestination {
  to: string;
  /** The destination owns pages beneath it, so it matches while any of them is presented. */
  subtree?: boolean;
}

/**
 * The one destination the presented pages belong to. A destination can sit under another one
 * (Profiles under Sessions), and both match there: only the deepest is where the reader is.
 * `pathnames` run from the outermost presented route to the page itself.
 */
export function deepestDestination(
  destinations: readonly NavigationDestination[],
  pathnames: readonly string[],
): string | undefined {
  const presented = pathnames.map(trimPathRight);
  let deepest: string | undefined;
  for (const { to, subtree = false } of destinations) {
    const reached = (subtree ? presented : presented.slice(-1)).includes(trimPathRight(to));
    if (reached && (deepest === undefined || to.length > deepest.length)) deepest = to;
  }
  return deepest;
}
