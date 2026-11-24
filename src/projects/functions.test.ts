import assert from "node:assert/strict";
import { it } from "vitest";
import { TenantRouteNotFoundError } from "./access.js";
import { readUnavailableMessage } from "./functions.js";

/**
 * `createServerFn` handlers bundle into a chunk separate from the composition root that throws
 * these errors, so a real cross-chunk error keeps its `name` but loses its class identity by the
 * time it reaches a catch block here. A plain `Error` with only the `name` set reproduces
 * exactly that: it is provably not an instance of the real class, matching what survives
 * bundling.
 */
function crossChunkError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

it("maps a cross-chunk TenantRouteNotFoundError to the friendly project message", () => {
  const error = crossChunkError("TenantRouteNotFoundError");
  assert.equal(error instanceof TenantRouteNotFoundError, false);
  assert.equal(readUnavailableMessage(error, true), "Project unavailable.");
  assert.equal(readUnavailableMessage(error, false), "Organization unavailable.");
});

it("describes project and organization read failures as load failures", () => {
  const error = new Error("storage unavailable");
  assert.equal(
    readUnavailableMessage(error, true),
    "Hub couldn't load this project's configuration. Reload the page to try again.",
  );
  assert.equal(
    readUnavailableMessage(error, false),
    "Hub couldn't load this organization. Reload the page to try again.",
  );
});
