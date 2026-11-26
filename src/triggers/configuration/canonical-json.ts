/** A string that is equal for equal values whatever the key order of their objects. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    const body = entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${body.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const MAX_JSON_NODES = 10_000;
const MAX_JSON_DEPTH = 64;

/**
 * Whether a parsed value is a finite tree: no object contains itself, aliases do not expand to
 * more than a fixed number of nodes, and nesting stays shallow. YAML aliases can build all three,
 * and walking them recurses, so a deep chain would overflow the stack before the node count trips.
 */
export function isBoundedJson(value: unknown): boolean {
  let remaining = MAX_JSON_NODES;
  const walk = (node: unknown, ancestors: readonly object[]): boolean => {
    if (typeof node !== "object" || node === null) return true;
    remaining -= 1;
    if (remaining < 0 || ancestors.length >= MAX_JSON_DEPTH || ancestors.includes(node))
      return false;
    const next = [...ancestors, node];
    return Object.values(node).every((child) => walk(child, next));
  };
  return walk(value, []);
}
