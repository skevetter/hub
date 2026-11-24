import { describe, expect, it } from "vitest";
import { savedToast } from "./saved-toast.js";

describe("savedToast", () => {
  it("gives each organization its own id and scope", () => {
    const acme = savedToast("acme", "t1");
    const globex = savedToast("globex", "t1");
    expect(acme.id).not.toBe(globex.id);
    expect([acme.scope, globex.scope]).toEqual(["acme", "globex"]);
  });

  it("offers View only for an existing trigger", () => {
    expect(savedToast("acme", undefined).action).toBeUndefined();
    expect(savedToast("acme", "t1").action).toBeDefined();
  });
});
