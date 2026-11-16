import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { WebhookCard } from "./webhook-card.js";

const render = (enabled: boolean) =>
  renderToStaticMarkup(
    <WebhookCard
      baseUrl="https://hub.example.test"
      triggerName="build-finished"
      enabled={enabled}
    />,
  );

function text(markup: string) {
  return markup.replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
}

describe("webhook card", () => {
  it("renders the full configured URL and copy controls for an enabled manual trigger", () => {
    const markup = render(true);
    assert.match(markup, />Webhook</u);
    assert.match(markup, /https:\/\/hub\.example\.test\/api\/v1\/hooks\/build-finished/u);
    assert.match(markup, /Copy Webhook URL/u);
    assert.match(markup, /lucide-webhook/u);
    assert.doesNotMatch(markup, /Calls return 404/u);
  });

  it("keeps the URL and sample available while explaining disabled responses", () => {
    const markup = render(false);
    assert.match(markup, /Trigger is disabled/u);
    assert.match(markup, /Calls return 404 until this trigger is enabled and saved/u);
    assert.match(markup, /https:\/\/hub\.example\.test\/api\/v1\/hooks\/build-finished/u);
    assert.match(text(markup), /Authorization: Bearer \$HUB_KEY/u);
  });

  it("uses only a key placeholder and explains required input fields and key authority", () => {
    const markup = text(render(true));
    assert.match(
      markup,
      /curl -sS -X POST 'https:\/\/hub\.example\.test\/api\/v1\/hooks\/build-finished'/u,
    );
    assert.match(markup, /Authorization: Bearer \$HUB_KEY/u);
    assert.match(markup, /Content-Type: application\/json/u);
    assert.match(markup, /Idempotency-Key: example-delivery/u);
    assert.match(markup, /'\{"message":"Event received"\}'/u);
    assert.match(markup, /events:send/u);
    assert.match(markup, /bound actor allowed by this trigger/u);
    assert.match(markup, /required declared inputs as top-level JSON fields/u);
    assert.match(markup, /declared types and choices/u);
    assert.match(markup, /Do not include secrets/u);
    assert.doesNotMatch(markup, /paseo_pk_/u);
  });
});
