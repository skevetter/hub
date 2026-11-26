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

  it("draws Linear with the published logomark", () => {
    const markup = renderToStaticMarkup(<ProviderGlyph provider="linear" />);
    assert.match(markup, /viewBox="0 0 100 100"/u);
    assert.ok(markup.includes("M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3"));
    assert.ok(markup.includes("99 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z"));
  });
});
