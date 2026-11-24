import { afterEach, describe, expect, it } from "vitest";
import {
  clearToasts,
  dismissToast,
  MAX_TOASTS,
  toast,
  toastSnapshot,
  visibleToasts,
} from "./toast-store.js";

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

  it("caps each organization on its own", () => {
    toast({ title: "Acme first", scope: "acme" });
    for (let n = 0; n <= MAX_TOASTS; n += 1) toast({ title: `Globex ${n}`, scope: "globex" });
    expect(titles()).toEqual(["Acme first", "Globex 1", "Globex 2", "Globex 3"]);
    const all = toastSnapshot();
    expect(visibleToasts(all, "acme").map(({ title }) => title)).toEqual(["Acme first"]);
  });

  it("caps toasts without an organization separately from scoped ones", () => {
    for (let n = 0; n <= MAX_TOASTS; n += 1) toast({ title: `Any ${n}` });
    toast({ title: "Acme", scope: "acme" });
    expect(titles()).toEqual(["Any 1", "Any 2", "Any 3", "Acme"]);
  });

  it("shows at most the cap when unscoped and scoped toasts share an organization", () => {
    for (let n = 0; n < MAX_TOASTS; n += 1) toast({ title: `Any ${n}` });
    toast({ title: "Acme", scope: "acme" });
    expect(visibleToasts(toastSnapshot(), "acme").map(({ title }) => title)).toEqual([
      "Any 1",
      "Any 2",
      "Acme",
    ]);
  });

  it("moves a reused id into its new organization and displaces only that organization's oldest", () => {
    toast({ id: "move", title: "Moved", scope: "acme" });
    for (let n = 1; n <= MAX_TOASTS; n += 1) toast({ title: `Globex ${n}`, scope: "globex" });
    toast({ id: "move", title: "Moved", scope: "globex" });
    expect(titles()).toEqual(["Globex 2", "Globex 3", "Moved"]);
    expect(visibleToasts(toastSnapshot(), "acme")).toEqual([]);
  });

  it("dismisses one toast and ignores an unknown id", () => {
    toast({ title: "Keep" });
    const gone = toast({ title: "Gone" });
    dismissToast(gone);
    dismissToast("missing");
    expect(titles()).toEqual(["Keep"]);
  });

  it("shows an organization's toast only while that organization is open", () => {
    toast({ title: "Anywhere" });
    toast({ title: "Acme only", scope: "acme" });
    const all = toastSnapshot();
    expect(visibleToasts(all, "acme").map(({ title }) => title)).toEqual(["Anywhere", "Acme only"]);
    expect(visibleToasts(all, "globex").map(({ title }) => title)).toEqual(["Anywhere"]);
  });

  it("notifies the snapshot reader with a new array only when something changed", () => {
    const before = toastSnapshot();
    clearToasts();
    expect(toastSnapshot()).toBe(before);
    toast({ title: "One" });
    expect(toastSnapshot()).not.toBe(before);
  });
});
