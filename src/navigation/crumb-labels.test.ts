import { describe, expect, it } from "vitest";
import { applyCrumbLabels, crumbKey } from "./crumb-labels.js";

const trail = [
  { label: "Triggers", to: "/o/acme/triggers" },
  { label: "Trigger", to: "/o/acme/triggers/t1/" },
];

describe("crumb labels", () => {
  it("replaces only the crumb that has a label, matching an index route with a trailing slash", () => {
    const labels = new Map([[crumbKey("/o/acme/triggers/t1"), "Nightly review"]]);
    expect(applyCrumbLabels(trail, labels)).toEqual([
      { label: "Triggers", to: "/o/acme/triggers" },
      { label: "Nightly review", to: "/o/acme/triggers/t1/" },
    ]);
  });

  it("keeps the route label until the page names itself", () => {
    expect(applyCrumbLabels(trail, new Map())).toEqual(trail);
  });

  it("keeps the root path as it is", () => {
    expect(crumbKey("/")).toBe("/");
  });
});
