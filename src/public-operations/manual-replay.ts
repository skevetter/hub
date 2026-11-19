import { requireManualReceiptReplayBinding } from "../db/receipt-replay.js";
import type { ManualReceiptReplayTarget, ProviderEventReplayMetadata } from "../db/types.js";
import {
  authorizeManualIdentity,
  ManualRunRejected,
  type ManualRunIdentity,
} from "../triggers/manual/provider.js";
import type {
  PublicAuthorization,
  PublicOperationCapabilities,
  PublicOperationRepository,
} from "./types.js";

export function publicManualIdentity(
  authorization: PublicAuthorization,
  actor: string,
): ManualRunIdentity {
  return {
    actor,
    authenticatedBy: {
      kind: authorization.kind === "apiKey" ? "api-key" : "cli-credential",
      credentialId: authorization.credentialId,
      boundActor: authorization.kind === "apiKey" ? (authorization.actor ?? null) : null,
    },
  };
}

export async function authorizeMarkedManualReplay(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  authorization: PublicAuthorization,
  receipt: ProviderEventReplayMetadata,
  target: ManualReceiptReplayTarget,
  actor: string,
): Promise<void> {
  const binding = requireManualReceiptReplayBinding(receipt, target);
  if (target.boundWebhookTrigger !== undefined) {
    await repository.authorizeSignedReceiptReplay({
      ...target,
      organizationId: authorization.organizationId,
      receiptId: receipt.id,
    });
  }
  const pinned = await capabilities
    .configurationForProject(binding.projectId)
    .getRevision?.(binding.configurationRevisionId);
  if (
    pinned?.revision.organizationId !== authorization.organizationId ||
    pinned.revision.projectId !== binding.projectId
  ) {
    throw new ManualRunRejected("configuration_not_found");
  }
  const trigger = pinned.configuration.triggers.find(
    (candidate) => candidate.name === binding.triggerName && candidate.on === "manual.run",
  );
  if (trigger === undefined) throw new ManualRunRejected("trigger_not_found");
  authorizeManualIdentity(trigger, publicManualIdentity(authorization, actor));
}
