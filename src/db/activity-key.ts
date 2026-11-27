const TIMESTAMP =
  /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/u;

function offsetMinutes(zone: string): number | undefined {
  if (zone === "Z") return 0;
  const digits = zone.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const rest = Number(digits.slice(2) || "0");
  if (hours > 15 || rest > 59) return undefined;
  return (zone.startsWith("-") ? -1 : 1) * (hours * 60 + rest);
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Microseconds since the epoch for a PostgreSQL or ISO timestamp, or undefined when the text is
 * not a real calendar time and offset. Run keys carry PostgreSQL's own text, so comparing them
 * through a JavaScript Date would drop the digits that tell close runs apart.
 */
export function activityTimestampMicros(text: string): bigint | undefined {
  const match = TIMESTAMP.exec(text);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction = "", zone = "Z"] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (!isCalendarDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return undefined;
  const offset = offsetMinutes(zone);
  if (offset === undefined) return undefined;
  const seconds = BigInt(Date.UTC(y, mo - 1, d, h, mi, s) / 1000) - BigInt(offset * 60);
  return seconds * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function compareRunsNewestFirst(
  left: { micros: bigint; id: string },
  right: { micros: bigint; id: string },
): number {
  if (left.micros !== right.micros) return left.micros > right.micros ? -1 : 1;
  const a = left.id.toLowerCase();
  const b = right.id.toLowerCase();
  if (a === b) return 0;
  return a > b ? -1 : 1;
}
