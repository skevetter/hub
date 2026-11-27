import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { cn } from "../../lib/utils.js";
import { buttonVariants } from "./button.js";

const SIZES = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;
const classes = (options: Parameters<typeof buttonVariants>[0]) => cn(buttonVariants(options));

describe("button phone size", () => {
  it("lifts every size to a 44 px target and leaves the desktop box alone", () => {
    for (const size of SIZES) {
      const merged = classes({ size });
      assert.match(merged, /(^| )max-md:min-h-11( |$)/u, size);
      assert.match(merged, /(^| )max-md:min-w-11( |$)/u, size);
      assert.doesNotMatch(merged, /(^| )(md|lg):/u, size);
    }
    assert.match(classes({ size: "sm" }), /(^| )h-7( |$)/u);
    assert.match(classes({ size: "icon-sm" }), /(^| )size-7( |$)/u);
  });

  it("keeps a link button inline on a phone", () => {
    const merged = classes({ variant: "link", size: "sm" });
    assert.match(merged, /(^| )max-md:min-h-0( |$)/u);
    assert.match(merged, /(^| )max-md:min-w-0( |$)/u);
    assert.doesNotMatch(merged, /max-md:min-[hw]-11/u);
  });
});
