export interface PostgresJsonLimits {
  maxDepth?: number;
  maxKeysPerObject?: number;
}

export function hasPostgresText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isPostgresJson(value: unknown, limits: PostgresJsonLimits = {}): boolean {
  return validJsonValue(
    value,
    1,
    limits.maxDepth ?? Number.POSITIVE_INFINITY,
    limits.maxKeysPerObject ?? Number.POSITIVE_INFINITY,
  );
}

function validJsonValue(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxKeysPerObject: number,
): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return hasPostgresText(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > maxDepth) return false;
  if (Array.isArray(value)) {
    return value.every((item) => validJsonValue(item, depth + 1, maxDepth, maxKeysPerObject));
  }
  const keys = Object.keys(value);
  if (keys.length > maxKeysPerObject) return false;
  return keys.every(
    (key) =>
      hasPostgresText(key) &&
      validJsonValue(Reflect.get(value, key), depth + 1, maxDepth, maxKeysPerObject),
  );
}
