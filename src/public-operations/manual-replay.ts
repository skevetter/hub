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

export type ManualDispatchIdentity = ManualRunIdentity & {
  authenticatedBy: NonNullable<ManualRunIdentity["authenticatedBy"]>;
  organizationId: string;
  startedByUserId?: string;
};

export function publicManualIdentity(
  authorization: PublicAuthorization,
  actor: string,
): ManualDispatchIdentity {
  const starter = authorization.kind === "cliCredential" ? authorization.user?.id : undefined;
  return {
    actor,
    organizationId: authorization.organizationId,
    ...(starter === undefined ? {} : { startedByUserId: starter }),
    authenticatedBy: {
      kind: authorization.kind === "apiKey" ? "api-key" : "cli-credential",
      credentialId: authorization.credentialId,
      boundActor:
        authorization.kind === "apiKey"
          ? (authorization.actor ?? null)
          : (authorization.user?.email?.toLowerCase() ?? null),
    },
  };
}

export async function authorizeMarkedManualReplay(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  {
    identity,
    receipt,
    target,
  }: {
    identity: ManualDispatchIdentity;
    receipt: ProviderEventReplayMetadata;
    target: ManualReceiptReplayTarget;
  },
): Promise<void> {
  const binding = requireManualReceiptReplayBinding(receipt, target);
  if (target.boundWebhookTrigger !== undefined) {
    await repository.authorizeSignedReceiptReplay({
      ...target,
      organizationId: identity.organizationId,
      receiptId: receipt.id,
    });
  }
  const pinned = await capabilities
    .configurationForProject(binding.projectId)
    .getRevision?.(binding.configurationRevisionId);
  if (
    pinned?.revision.organizationId !== identity.organizationId ||
    pinned.revision.projectId !== binding.projectId
  ) {
    throw new ManualRunRejected("configuration_not_found");
  }
  const trigger = pinned.configuration.triggers.find(
    (candidate) => candidate.name === binding.triggerName && candidate.on === "manual.run",
  );
  if (trigger === undefined) throw new ManualRunRejected("trigger_not_found");
  authorizeManualIdentity(trigger, identity);
}
