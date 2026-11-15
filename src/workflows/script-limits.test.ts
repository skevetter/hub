import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DEFAULT_SCRIPT_LIMITS, readScriptLimits } from "./script-limits.js";

describe("script concurrency settings", () => {
  it("defaults to 5 per daemon and 3 per trigger", () => {
    assert.deepEqual(readScriptLimits({}), { maxPerDaemon: 5, maxPerTrigger: 3 });
    assert.deepEqual(DEFAULT_SCRIPT_LIMITS, { maxPerDaemon: 5, maxPerTrigger: 3 });
    assert.deepEqual(
      readScriptLimits({
        PASEO_HUB_SCRIPT_MAX_PER_DAEMON: " ",
        PASEO_HUB_SCRIPT_MAX_PER_TRIGGER: "",
      }),
      DEFAULT_SCRIPT_LIMITS,
    );
  });

  it("reads each cap from its variable", () => {
    assert.deepEqual(
      readScriptLimits({
        PASEO_HUB_SCRIPT_MAX_PER_DAEMON: "10",
        PASEO_HUB_SCRIPT_MAX_PER_TRIGGER: "1",
      }),
      { maxPerDaemon: 10, maxPerTrigger: 1 },
    );
  });

  it("accepts the bounds 1 and 50", () => {
    assert.deepEqual(
      readScriptLimits({
        PASEO_HUB_SCRIPT_MAX_PER_DAEMON: "50",
        PASEO_HUB_SCRIPT_MAX_PER_TRIGGER: "1",
      }),
      { maxPerDaemon: 50, maxPerTrigger: 1 },
    );
  });

  it.each(["0", "51", "-1", "3.5", "five", "1e1", "0x10", "10 daemons"])(
    "refuses %j with the variable's name so startup fails",
    (value) => {
      assert.throws(
        () => readScriptLimits({ PASEO_HUB_SCRIPT_MAX_PER_DAEMON: value }),
        /PASEO_HUB_SCRIPT_MAX_PER_DAEMON must be a whole number from 1 to 50/u,
      );
      assert.throws(
        () => readScriptLimits({ PASEO_HUB_SCRIPT_MAX_PER_TRIGGER: value }),
        /PASEO_HUB_SCRIPT_MAX_PER_TRIGGER must be a whole number from 1 to 50/u,
      );
    },
  );
});
