import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import { memberFlagKey, readMemberFlag, rememberMemberFlag } from "./member-preference.js";

function installStorage(storage: Pick<Storage, "getItem" | "setItem">) {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("a member's remembered choice", () => {
  it("is kept apart per organization and per member", () => {
    assert.notEqual(
      memberFlagKey("getting-started-open", "org-1", "user-1"),
      memberFlagKey("getting-started-open", "org-1", "user-2"),
    );
    assert.notEqual(
      memberFlagKey("getting-started-open", "org-1", "user-1"),
      memberFlagKey("getting-started-open", "org-2", "user-1"),
    );
  });

  it("reads back what was remembered and nothing when nothing was", () => {
    const values = new Map<string, string>();
    installStorage({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    });

    assert.equal(readMemberFlag("k"), undefined);
    rememberMemberFlag("k", false);
    assert.equal(readMemberFlag("k"), false);
    rememberMemberFlag("k", true);
    assert.equal(readMemberFlag("k"), true);
  });

  it("forgets quietly when the browser refuses storage", () => {
    installStorage({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });

    assert.equal(readMemberFlag("k"), undefined);
    assert.doesNotThrow(() => rememberMemberFlag("k", true));
  });
});
