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
