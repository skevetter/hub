import { expect, it } from "vitest";
import { requireManualReceiptReplayBinding } from "./receipt-replay.js";
import type { ManualReceiptReplayTarget, ProviderEventReplayMetadata } from "./types.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const triggerId = "33333333-3333-4333-8333-333333333333";
const binding = {
  projectId,
  configurationRevisionId: revisionId,
  triggerName: "public",
  triggerId,
};
const receipt = {
  id: "receipt",
  provider: "manual",
  source: "webhook.received",
  payloadExpiryState: "expired",
  droppedReason: null,
  manualReplayBinding: binding,
} satisfies ProviderEventReplayMetadata;
const target = {
  source: "webhook.received",
  projectId,
  publicTriggerName: "public",
  boundWebhookTrigger: { id: triggerId, name: "bound", configurationRevisionId: revisionId },
} satisfies ManualReceiptReplayTarget;

it("honors public-name precedence and retains parsed binding key order", () => {
  const found = requireManualReceiptReplayBinding(receipt, target);
  expect(found).toEqual(binding);
  expect(Object.keys(found)).toEqual([
    "projectId",
    "configurationRevisionId",
    "triggerName",
    "triggerId",
  ]);
});

it("rejects wrong provider, source, project, name, id, and malformed binding", () => {
  for (const change of [
    { provider: "github" as const },
    { source: "other" },
    { manualReplayBinding: null },
  ]) {
    expect(() => requireManualReceiptReplayBinding({ ...receipt, ...change }, target)).toThrow(
      "manual run rejected: configuration_not_found",
    );
  }
  for (const change of [
    { projectId: "other" },
    { publicTriggerName: "other" },
    { boundWebhookTrigger: { id: "other", name: "bound", configurationRevisionId: revisionId } },
  ]) {
    expect(() =>
      requireManualReceiptReplayBinding(receipt, {
        ...target,
        ...change,
      }),
    ).toThrow("manual run rejected: configuration_not_found");
  }
});
