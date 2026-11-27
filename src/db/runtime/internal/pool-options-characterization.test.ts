import { expect, it } from "vitest";
import { readDatabasePoolOptions } from "./pool-options.js";
import { DEFAULT_ACQUIRE_TIMEOUT_MS, DEFAULT_POOL_MAX } from "./pool.js";

const max = "PASEO_HUB_DATABASE_POOL_MAX";
const timeout = "PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS";

it("returns ordered defaults for absent and blank environment values", () => {
  for (const environment of [{}, { [max]: " ", [timeout]: "" }]) {
    const options = readDatabasePoolOptions(environment);
    expect(options).toEqual({
      max: DEFAULT_POOL_MAX,
      acquireTimeoutMs: DEFAULT_ACQUIRE_TIMEOUT_MS,
    });
    expect(Object.keys(options)).toEqual(["max", "acquireTimeoutMs"]);
  }
});

it("accepts inclusive bounds and validates the pool size before the timeout", () => {
  expect(readDatabasePoolOptions({ [max]: " 001 ", [timeout]: "60000" })).toEqual({
    max: 1,
    acquireTimeoutMs: 60000,
  });
  expect(readDatabasePoolOptions({ [max]: "100", [timeout]: "1000" })).toEqual({
    max: 100,
    acquireTimeoutMs: 1000,
  });
  for (const raw of ["0", "101", "1.5", "+2", "9007199254740992"]) {
    expect(() => readDatabasePoolOptions({ [max]: raw, [timeout]: "bad" })).toThrow(
      max + ' must be a whole number from 1 to 100, got "' + raw + '".',
    );
  }
  expect(() => readDatabasePoolOptions({ [timeout]: " 999 " })).toThrow(
    timeout + ' must be a whole number from 1000 to 60000, got "999".',
  );
});
