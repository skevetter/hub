import { createHash } from "node:crypto";
import type { CompiledTrigger } from "../config/compiler.js";
import type { ProviderEventReplayMetadata } from "../db/types.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import { parseManualInvocation, type ManualRunPayload } from "../triggers/manual/provider.js";
import { authorizeMarkedManualReplay, publicManualIdentity } from "./manual-replay.js";
import type {
  PublicAuthorization,
  PublicOperationCapabilities,
  PublicOperationRepository,
  ReceiveWebhookInput,
  ReceiveWebhookResult,
} from "./types.js";

interface WebhookTarget {
  status: "resolved";
  projectId: string;
  trigger: CompiledTrigger;
  configurationRevisionId: string;
  actor: string;
}

async function resolveTarget(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  authorization: PublicAuthorization,
  name: string,
  targetTriggerId: string | undefined,
): Promise<
  WebhookTarget | { status: "trigger_not_found" | "actor_forbidden" | "key_actor_required" }
> {
  if (authorization.kind !== "apiKey" || authorization.actor == null)
    return { status: "key_actor_required" };
  if (authorization.allowedTriggers != null && !authorization.allowedTriggers.includes(name))
    return { status: "trigger_not_found" };
  const project = await repository.resolveWebhookProject(authorization.organizationId, name);
  if (
    project === undefined ||
    (targetTriggerId !== undefined && project.triggerId !== targetTriggerId)
  )
    return { status: "trigger_not_found" };
  const stored = await capabilities.configurationForProject(project.id).getActive();
  const trigger = stored?.configuration.triggers.find(
    (candidate) => candidate.name === name && candidate.on === "manual.run",
  );
  if (stored === undefined || trigger === undefined) return { status: "trigger_not_found" };
  const users = trigger.filters?.from_users;
  if (!users?.includes("*") && !users?.includes(authorization.actor))
    return { status: "actor_forbidden" };
  return {
    status: "resolved",
    projectId: project.id,
    trigger,
    actor: authorization.actor,
    configurationRevisionId: stored.revision.id,
  };
}

async function receiptResult(
  repository: PublicOperationRepository,
  receipt: ProviderEventReplayMetadata,
  organizationId: string,
  projectId: string,
  input: ReceiveWebhookInput,
  duplicate: boolean,
): Promise<ReceiveWebhookResult> {
  const run = await repository.findManualRun(organizationId, projectId, receipt.id, input.trigger);
  if (
    run !== undefined &&
    receipt.payloadExpiryState != null &&
    run.configurationRevisionId !== receipt.manualReplayBinding?.configurationRevisionId
  ) {
    return { status: "dispatch_conflict" };
  }
  if (run === undefined) {
    return receipt.droppedReason === "trigger_filters_rejected"
      ? { status: "filtered", duplicate }
      : { status: "dispatch_conflict" };
  }
  if (run.outcome === "rejected")
    return {
      status: "invalid_input",
      providerEventReceiptId: receipt.id,
      triggerRunId: run.id,
      configuredTriggerName: run.configuredTriggerName,
      issues: [
        {
          path: ["input", run.rejection.inputName],
          message: formatInvocationRejection(run.rejection),
        },
      ],
    };
  return {
    status: "dispatched",
    deliveryKey: input.deliveryKey,
    providerEventReceiptId: receipt.id,
    triggerRunId: run.id,
    configuredTriggerName: run.configuredTriggerName,
    workflowStatus: run.status,
    duplicate,
  };
}

export async function receiveWebhook(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  authorization: PublicAuthorization,
  input: ReceiveWebhookInput,
  maxActiveRuns: number,
): Promise<ReceiveWebhookResult> {
  const signature = input.githubSignature;
  const target = await resolveTarget(
    repository,
    capabilities,
    authorization,
    input.trigger,
    signature?.targetTriggerId,
  );
  if (target.status !== "resolved") return target;
  const replayTarget = {
    projectId: target.projectId,
    publicTriggerName: input.trigger,
    source: "webhook.received" as const,
    ...(signature === undefined
      ? {}
      : {
          boundWebhookTrigger: {
            id: signature.targetTriggerId,
            name: input.trigger,
            configurationRevisionId: target.configurationRevisionId,
          },
        }),
  };

  const deliveryId =
    signature === undefined
      ? `public-manual-${createHash("sha256")
          .update(
            JSON.stringify([
              authorization.organizationId,
              target.projectId,
              input.trigger,
              input.deliveryKey,
            ]),
          )
          .digest("base64url")}`
      : `public-signature-${createHash("sha256")
          .update(
            JSON.stringify([
              authorization.organizationId,
              authorization.credentialId,
              signature.bodyDigest,
            ]),
          )
          .digest("hex")}`;
  const existing = await repository.findManualReceipt(authorization.organizationId, deliveryId);
  if (existing !== undefined) {
    if (existing.payloadExpiryState != null) {
      await authorizeMarkedManualReplay(
        repository,
        capabilities,
        authorization,
        existing,
        replayTarget,
        target.actor,
      );
      return receiptResult(
        repository,
        existing,
        authorization.organizationId,
        target.projectId,
        input,
        true,
      );
    }
    const replay = await receiptResult(
      repository,
      existing,
      authorization.organizationId,
      target.projectId,
      input,
      true,
    );
    if (replay.status !== "dispatch_conflict") return replay;
  }
  const payload: ManualRunPayload = {
    trigger: input.trigger,
    actor: target.actor,
    input: input.input,
    ...(input.data === undefined ? {} : { data: input.data }),
    source: "webhook.received",
    publicDeliveryKey: input.deliveryKey,
  };
  if (existing === undefined) {
    if (Buffer.byteLength(input.input) > 65_536)
      return {
        status: "invalid_input",
        issues: [{ path: ["message"], message: "Message exceeds 65536 UTF-8 bytes." }],
      };
    const invocation = parseManualInvocation(payload, target.trigger.inputs);
    if (invocation.status === "rejected")
      return {
        status: "invalid_input",
        issues: [
          {
            path: ["input", invocation.rejection.inputName],
            message: formatInvocationRejection(invocation.rejection),
          },
        ],
      };
    const active = await repository.countActiveTriggerRuns(
      authorization.organizationId,
      target.projectId,
      input.trigger,
    );
    if (active >= maxActiveRuns) return { status: "trigger_busy" };
  }
  const outcome = await capabilities.dispatchManualEvent({
    ...replayTarget,
    organizationId: authorization.organizationId,
    deliveryId,
    receivedAt: new Date(),
    payload: {
      ...payload,
      ...publicManualIdentity(authorization, target.actor),
    },
  });
  if (outcome === undefined) return { status: "dispatch_conflict" };
  const receipt = await repository.findManualReceipt(authorization.organizationId, deliveryId);
  if (receipt === undefined) return { status: "dispatch_conflict" };
  if (receipt.payloadExpiryState != null)
    await authorizeMarkedManualReplay(
      repository,
      capabilities,
      authorization,
      receipt,
      replayTarget,
      target.actor,
    );
  return receiptResult(
    repository,
    receipt,
    authorization.organizationId,
    target.projectId,
    input,
    outcome.replayed === true || receipt.payloadExpiryState != null,
  );
}
