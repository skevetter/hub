type Labels = ReadonlyMap<string, string>;

/** A route and its index route report the same page, one with a trailing slash. */
export function crumbKey(to: string): string {
  return to.length > 1 && to.endsWith("/") ? to.slice(0, -1) : to;
}

export function applyCrumbLabels<T extends { label: string; to: string }>(
  crumbs: readonly T[],
  labels: Labels,
): T[] {
  return crumbs.map((crumb) => ({
    ...crumb,
    label: labels.get(crumbKey(crumb.to)) ?? crumb.label,
  }));
}
