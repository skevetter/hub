import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { assertRealTimersRestored } from "./real-timers.js";

it("rejects a leaked fake timer before another worker file can wait forever", () => {
  vi.useFakeTimers();
  try {
    assert.throws(
      assertRealTimersRestored,
      /Leaked fake timer at worker file boundary: setTimeout/,
    );
  } finally {
    vi.useRealTimers();
  }
  assertRealTimersRestored();
});
