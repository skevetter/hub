import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePageSize, readPageSizePreference, rememberPageSize } from "./page-size.js";

afterEach(() => vi.unstubAllGlobals());

describe("page size", () => {
  it.each([15, 25, 50, 100])("accepts %i from the URL", (size) => {
    expect(parsePageSize(size)).toBe(size);
    expect(parsePageSize(String(size))).toBe(size);
  });

  it.each([0, 20, 101, "", "025", "25.0", "all", null, [25]].map((value) => ({ value })))(
    "uses 15 for invalid size %j",
    ({ value }) => {
      expect(parsePageSize(value)).toBe(15);
    },
  );

  it("distinguishes an absent URL value from an explicit invalid value", () => {
    expect(parsePageSize(undefined)).toBeUndefined();
    expect(parsePageSize(false)).toBe(15);
  });

  it("remembers the choice only for the account that made it", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });

    rememberPageSize("alice", 50);

    expect(readPageSizePreference("alice")).toBe(50);
    expect(readPageSizePreference("bob")).toBe(15);
  });

  it("defaults when storage is unavailable or throws", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readPageSizePreference("alice")).toBe(15);
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("storage unavailable");
      },
      setItem() {
        throw new Error("storage unavailable");
      },
    });
    expect(readPageSizePreference("alice")).toBe(15);
    expect(() => rememberPageSize("alice", 50)).not.toThrow();
  });
});
