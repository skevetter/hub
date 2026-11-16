import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { ProviderGlyph } from "./provider-glyph.js";

describe("provider glyph", () => {
  it("uses the webhook source rather than the stored manual provider", () => {
    const markup = renderToStaticMarkup(
      <ProviderGlyph provider="manual" source="webhook.received" />,
    );
    assert.match(markup, /lucide-webhook/u);
    assert.doesNotMatch(markup, /lucide-terminal/u);
    assert.match(markup, /aria-hidden="true"/u);
  });

  it("preserves the manual glyph without a webhook source", () => {
    const legacy = renderToStaticMarkup(<ProviderGlyph provider="manual" />);
    const manual = renderToStaticMarkup(<ProviderGlyph provider="manual" source="manual.run" />);
    assert.equal(manual, legacy);
    assert.match(manual, /lucide-terminal/u);
    assert.doesNotMatch(manual, /lucide-webhook/u);
  });

  it("leaves the other provider glyphs unchanged when their source is passed", () => {
    for (const provider of [
      "github",
      "slack",
      "discord",
      "linear",
      "schedule",
      "github_notification",
    ] as const) {
      assert.equal(
        renderToStaticMarkup(<ProviderGlyph provider={provider} source={`${provider}.event`} />),
        renderToStaticMarkup(<ProviderGlyph provider={provider} />),
      );
    }
  });
});
