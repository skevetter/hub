import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { summarizeTrigger } from "../projects/activity-summary.js";
import { TriggerActivityTable } from "./activity-table.js";

const row = {
  id: "run-1",
  triggerId: "trigger-1",
  triggerName: "build-finished",
  provider: "manual" as const,
  source: "webhook.received",
  repo: null,
  payloadExpiredAt: null,
  status: "running" as const,
  receivedAt: "2026-11-16T12:00:00.000Z",
};
const webhookActivity = [
  {
    ...row,
    webhookSummary: summarizeTrigger("webhook.received", {
      actor: "ci-partner",
      input: "Build 43 finished",
      trigger: "build-finished",
    }),
  },
];
const manualActivity = [{ ...row, source: "manual.run" }];

describe("webhook activity table", () => {
  it("renders the bound actor, prompt preview and source glyph on the real activity row", () => {
    const markup = renderToStaticMarkup(
      <TriggerActivityTable activity={webhookActivity} organizationSlug="acme" />,
    );
    assert.match(markup, /Webhook from ci-partner/u);
    assert.match(markup, /Build 43 finished/u);
    assert.match(markup, /lucide-webhook/u);
    assert.match(markup, /href="\/o\/acme\/activity\/run-1"/u);
    assert.match(markup, />manual</u);
  });

  it("keeps a legacy manual source distinct from webhook intake", () => {
    const markup = renderToStaticMarkup(
      <TriggerActivityTable activity={manualActivity} organizationSlug="acme" />,
    );
    assert.match(markup, /manual\.run/u);
    assert.match(markup, /lucide-terminal/u);
    assert.doesNotMatch(markup, /Webhook from/u);
  });
});
