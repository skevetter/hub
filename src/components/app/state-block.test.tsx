import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { StateBlock } from "./state-block.js";
import type { StateTone } from "./state-label.js";

function render(tone: StateTone, label: string, unseen = false) {
  return renderToStaticMarkup(createElement(StateBlock, { state: { tone, label }, unseen }));
}

describe("StateBlock", () => {
  it.each<[StateTone, string]>([
    ["attention", "bg-attention text-attention-foreground"],
    ["live", "bg-live text-live-foreground"],
    ["done", "bg-done text-done-foreground"],
    ["off", "bg-off text-off-foreground"],
  ])("draws the %s tone with its own label", (tone, classes) => {
    const html = render(tone, "Label");
    assert.ok(html.includes(classes), html);
    assert.ok(html.includes(">Label<"), html);
    assert.ok(html.includes("h-7 min-w-24"), html);
    assert.ok(!html.includes("Not opened yet"), html);
  });

  it("keeps the state and adds that nobody has opened it", () => {
    const html = render("attention", "Failed", true);
    assert.ok(html.includes("bg-attention text-attention-foreground"), html);
    assert.ok(html.includes(">Failed<"), html);
    assert.ok(html.includes(">Not opened yet<"), html);
  });
});
