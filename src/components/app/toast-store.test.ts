import { afterEach, describe, expect, it } from "vitest";
import { clearToasts, dismissToast, MAX_TOASTS, toast, toastSnapshot } from "./toast-store.js";

function titles(): string[] {
  return toastSnapshot().map(({ title }) => title);
}

describe("toast store", () => {
  afterEach(clearToasts);

  it("keeps toasts in the order they arrived", () => {
    toast({ title: "One" });
    toast({ title: "Two" });
    expect(titles()).toEqual(["One", "Two"]);
  });

  it("replaces a toast that reuses an id and moves it last", () => {
    toast({ id: "save", title: "Saving" });
    toast({ title: "Other" });
    toast({ id: "save", title: "Saved" });
    expect(titles()).toEqual(["Other", "Saved"]);
  });

  it("drops the oldest toast past the cap", () => {
    for (let n = 0; n <= MAX_TOASTS; n += 1) toast({ title: `T${n}` });
    expect(titles()).toEqual(["T1", "T2", "T3"]);
  });

  it("dismisses one toast and ignores an unknown id", () => {
    toast({ title: "Keep" });
    const gone = toast({ title: "Gone" });
    dismissToast(gone);
    dismissToast("missing");
    expect(titles()).toEqual(["Keep"]);
  });

  it("notifies the snapshot reader with a new array only when something changed", () => {
    const before = toastSnapshot();
    clearToasts();
    expect(toastSnapshot()).toBe(before);
    toast({ title: "One" });
    expect(toastSnapshot()).not.toBe(before);
  });
});
