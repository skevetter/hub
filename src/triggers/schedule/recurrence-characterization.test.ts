import { expect, it } from "vitest";
import { nextOccurrence, RecurrenceSchema } from "./recurrence.js";

it.each([
  {
    timezone: "America/New_York",
    start: "2026-03-07T02:30:00",
    rule: "FREQ=DAILY;COUNT=3",
    after: "2026-03-07T07:30:00Z",
    expected: "2026-03-09T06:30:00.000Z",
  },
  {
    timezone: "America/New_York",
    start: "2026-01-01T01:30:00",
    rule: "FREQ=DAILY",
    after: "2026-11-01T05:30:00Z",
    expected: "2026-11-02T06:30:00.000Z",
  },
  {
    timezone: "Australia/Lord_Howe",
    start: "2026-01-01T01:45:00",
    rule: "FREQ=DAILY",
    after: "2026-04-04T14:45:00Z",
    expected: "2026-04-05T15:15:00.000Z",
  },
  {
    timezone: "Pacific/Apia",
    start: "2011-12-29T00:00:00",
    rule: "FREQ=DAILY;COUNT=2",
    after: "2011-12-29T10:00:00Z",
    expected: "2011-12-30T10:00:00.000Z",
  },
  {
    timezone: "Asia/Kathmandu",
    start: "2024-01-31T09:00:00",
    rule: "FREQ=MONTHLY",
    after: "2024-01-31T03:15:00Z",
    expected: "2024-03-31T03:15:00.000Z",
  },
  {
    timezone: "America/St_Johns",
    start: "2024-02-29T09:00:00",
    rule: "FREQ=YEARLY",
    after: "2024-02-29T12:30:00Z",
    expected: "2028-02-29T12:30:00.000Z",
  },
  {
    timezone: "Asia/Kolkata",
    start: "2024-01-31T00:00:00",
    rule: "FREQ=MONTHLY;BYMONTHDAY=-1",
    after: "2024-01-31T18:30:00Z",
    expected: "2024-02-28T18:30:00.000Z",
  },
  {
    timezone: "Europe/Berlin",
    start: "2026-03-28T02:30:00",
    rule: "FREQ=DAILY;UNTIL=20260330T003000Z",
    after: "2026-03-30T00:29:59.999Z",
    expected: "2026-03-30T00:30:00.000Z",
  },
  {
    timezone: "Europe/Berlin",
    start: "2026-03-28T02:30:00",
    rule: "FREQ=DAILY;UNTIL=20260330T002959Z",
    after: "2026-03-29T01:00:00Z",
    expected: null,
  },
  {
    timezone: "UTC",
    start: "2026-01-01T09:00:00",
    rule: "FREQ=DAILY;COUNT=1",
    after: "2026-01-01T09:00:00Z",
    expected: null,
  },
])("evaluates $rule in $timezone strictly after $after", ({ after, expected, ...value }) => {
  const recurrence = RecurrenceSchema.parse(value);
  expect(nextOccurrence(recurrence, new Date(after))?.toISOString() ?? null).toBe(expected);
});

const base = { timezone: "UTC", start: "2026-01-01T09:00:00", rule: "FREQ=DAILY" };
const invalidPart = "Use one RRULE with distinct, supported RFC 5545 fields.";
it.each([
  ["FREQ=DAILY;", invalidPart],
  ["FREQ=DAILY;FREQ=HOURLY", invalidPart],
  ["FREQ=DAILY;X=1", invalidPart],
  ["FREQ=DAILY;BYDAY=\u00e9", invalidPart],
  ["FREQ=DAILY;COUNT=0;UNTIL=20261231", "Use COUNT or UNTIL, not both."],
  ["FREQ=DAILY;COUNT=0", "COUNT must be between 1 and 10000."],
  ["FREQ=DAILY;COUNT=10001", "COUNT must be between 1 and 10000."],
  ["FREQ=DAILY;UNTIL=20261231", "UNTIL must be a UTC date-time, such as 20261231T235959Z."],
  ["FREQ=MONTHLY;BYDAY=-54FR", "BYDAY ordinals must be between -53 and 53."],
  ["FREQ=DAILY;INTERVAL=10001", "Invalid INTERVAL value."],
])("reports the first rule error for %s", (rule, message) => {
  const value = { ...base, rule };
  const parsed = RecurrenceSchema.safeParse(value);
  expect(parsed.error?.issues).toMatchObject([{ path: ["rule"], message }]);
  expect(() => nextOccurrence(value, new Date(base.start))).toThrow(new Error(message));
});

it.each([
  { ...base, start: "2025-02-29T09:00:00" },
  { ...base, timezone: "+01:00" },
  { ...base, timezone: "Mars/Olympus" },
  { ...base, rule: "A".repeat(2049) },
  { ...base, rule: "" },
  { ...base, rule: undefined },
  null,
  undefined,
])("rejects invalid recurrence input %#", (value) => {
  expect(RecurrenceSchema.safeParse(value).success).toBe(false);
});

it("throws on an invalid cursor instead of treating it as exhaustion", () => {
  expect(() => nextOccurrence(base, new Date(Number.NaN))).toThrow(RangeError);
});
