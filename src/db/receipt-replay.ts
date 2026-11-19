import { z } from "zod";
import { ManualRunRejected } from "../triggers/manual/provider.js";
import type {
  ManualReceiptReplayBinding,
  ManualReceiptReplayTarget,
  ProviderEventAcceptance,
  ProviderEventReplayMetadata,
  ReceiptPreRoutingDrop,
} from "./types.js";

const ManualReceiptReplayBindingSchema = z.object({
  projectId: z.uuid(),
  configurationRevisionId: z.uuid(),
  triggerName: z.string().min(1),
  triggerId: z.uuid().nullable(),
});

export function parseManualReceiptReplayBinding(value: unknown): ManualReceiptReplayBinding | null {
  const parsed = ManualReceiptReplayBindingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function preRoutingDropEvidence(reason: string | undefined): ReceiptPreRoutingDrop | null {
  return reason === "no_trigger_for_source" || reason === "configuration_unavailable"
    ? reason
    : null;
}

export function requireManualReceiptReplayBinding(
  receipt: ProviderEventReplayMetadata,
  target: ManualReceiptReplayTarget,
): ManualReceiptReplayBinding {
  const binding = parseManualReceiptReplayBinding(receipt.manualReplayBinding);
  if (
    receipt.provider !== "manual" ||
    receipt.source !== target.source ||
    binding === null ||
    binding.projectId !== target.projectId ||
    binding.triggerName !== (target.publicTriggerName ?? target.boundWebhookTrigger?.name) ||
    binding.triggerId !== (target.boundWebhookTrigger?.id ?? null)
  ) {
    throw new ManualRunRejected("configuration_not_found");
  }
  return binding;
}

export function markedProviderReplay(
  receipt: ProviderEventReplayMetadata,
): ProviderEventAcceptance | undefined {
  const { payloadExpiryState, droppedReason } = receipt;
  if (payloadExpiryState == null) return undefined;
  return droppedReason === null
    ? { status: "duplicate", receiptId: receipt.id, payloadExpiryState }
    : { status: "dropped", receiptId: receipt.id, reason: droppedReason, payloadExpiryState };
}
