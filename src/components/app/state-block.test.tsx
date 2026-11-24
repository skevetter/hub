import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { StateBlock, type StateTone } from "./state-block.js";

describe("StateBlock", () => {
  it.each<[StateTone, string]>([
    ["attention", "bg-attention text-attention-foreground"],
    ["live", "bg-live text-live-foreground"],
    ["done", "bg-done text-done-foreground"],
    ["off", "bg-off text-off-foreground"],
  ])("draws the %s tone with its own label", (tone, classes) => {
    const html = renderToStaticMarkup(<StateBlock tone={tone}>Label</StateBlock>);
    assert.ok(html.includes(classes), html);
    assert.ok(html.includes(">Label<"), html);
    assert.ok(html.includes("h-7 min-w-24"), html);
  });
});
