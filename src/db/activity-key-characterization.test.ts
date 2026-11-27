import { expect, it } from "vitest";
import { activityTimestampMicros } from "./activity-key.js";

it("retains PostgreSQL microseconds and offsets", () => {
  expect(activityTimestampMicros("1970-01-01 00:00:00.000001+00")).toBe(1n);
  expect(activityTimestampMicros("1969-12-31T23:59:59.9Z")).toBe(-100000n);
  expect(activityTimestampMicros("1970-01-01T15:59:00+1559")).toBe(0n);
  expect(activityTimestampMicros("1969-12-31 08:01:00-15:59")).toBe(0n);
  expect(activityTimestampMicros("2000-02-29T00:00:00Z")).toBe(951782400000000n);
});

it("rejects malformed timestamps, calendar rollovers, and out-of-range offsets", () => {
  for (const text of [
    "",
    "1970-01-01T00:00:00",
    "1970-01-01T00:00:00.0000000Z",
    "0099-01-01T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "1970-13-01T00:00:00Z",
    "1970-01-01T24:00:00Z",
    "1970-01-01T00:60:00Z",
    "1970-01-01T00:00:60Z",
    "1970-01-01T00:00:00+16",
    "1970-01-01T00:00:00-00:60",
  ]) {
    expect(activityTimestampMicros(text)).toBe(undefined);
  }
});
