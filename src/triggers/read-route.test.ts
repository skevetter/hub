import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { legacyTriggerEditorHref } from "./read-route.js";
import { triggerSearchSchema } from "./trigger-query.js";

const pathname = "/o/example/triggers/trigger-1";

describe("legacy editor links", () => {
  it.each(Object.keys(triggerSearchSchema.shape))(
    "preserves %s exactly when redirecting",
    (key) => {
      const searchStr = `?${key}=Some%20value&extra=1`;
      assert.equal(
        legacyTriggerEditorHref({ pathname, searchStr }, "trigger-1"),
        `${pathname}/edit${searchStr}`,
      );
    },
  );

  it.each(["", "?extra=1"])("keeps the read view for %j", (searchStr) => {
    assert.equal(legacyTriggerEditorHref({ pathname, searchStr }, "trigger-1"), undefined);
  });

  it("keeps the old create URL working", () => {
    assert.equal(
      legacyTriggerEditorHref({ pathname: "/o/example/triggers/new", searchStr: "" }, "new"),
      "/o/example/triggers/new/edit",
    );
  });
});
