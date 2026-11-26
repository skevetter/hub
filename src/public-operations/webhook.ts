import { bearerWebhookDeliveryId, signedWebhookDeliveryId } from "../webhooks/delivery-id.js";
import type { CompiledTrigger } from "../config/compiler.js";
import type { ManualReceiptReplayTarget, ProviderEventReplayMetadata } from "../db/types.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import { parseManualInvocation, type ManualRunPayload } from "../triggers/manual/provider.js";
import {
  authorizeMarkedManualReplay,
  publicManualIdentity,
  type ManualDispatchIdentity,
} from "./manual-replay.js";
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

interface WebhookRequest {
  repository: PublicOperationRepository;
  capabilities: PublicOperationCapabilities;
  authorization: PublicAuthorization;
  input: ReceiveWebhookInput;
  maxActiveRuns: number;
}

async function resolveTarget({
  repository,
  capabilities,
  authorization,
  input,
}: WebhookRequest): Promise<
  WebhookTarget | { status: "trigger_not_found" | "actor_forbidden" | "key_actor_required" }
> {
  const { actor, allowedTriggers, organizationId } = authorization;
  const { trigger: name, githubSignature } = input;
  const targetTriggerId = githubSignature?.targetTriggerId;
  if (authorization.kind !== "apiKey" || actor == null) return { status: "key_actor_required" };
  if (allowedTriggers != null && !allowedTriggers.includes(name))
    return { status: "trigger_not_found" };
  const project = await repository.resolveWebhookProject(organizationId, name);
  if (
    project === undefined ||
    (targetTriggerId !== undefined && project.triggerId !== targetTriggerId)
  )
    return { status: "trigger_not_found" };
  return resolveActiveTarget(capabilities, project.id, name, actor);
}

async function resolveActiveTarget(
  capabilities: PublicOperationCapabilities,
  projectId: string,
  name: string,
  actor: string,
): Promise<WebhookTarget | { status: "trigger_not_found" }> {
  const stored = await capabilities.configurationForProject(projectId).getActive();
  if (stored === undefined) return { status: "trigger_not_found" };
  const trigger = stored.configuration.triggers.find(
    (candidate) => candidate.name === name && candidate.on === "manual.run",
  );
  if (trigger === undefined) return { status: "trigger_not_found" };
  const users = trigger.filters?.from_users;
  if (!users?.includes("*") && !users?.includes(actor)) return { status: "trigger_not_found" };
  return {
    status: "resolved",
    projectId,
    trigger,
    actor,
    configurationRevisionId: stored.revision.id,
  };
}

async function receiptResult(
  { repository, authorization, input }: WebhookRequest,
  receipt: ProviderEventReplayMetadata,
  projectId: string,
  duplicate: boolean,
): Promise<ReceiveWebhookResult> {
  const { organizationId } = authorization;
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

export async function receiveWebhook(request: WebhookRequest): Promise<ReceiveWebhookResult> {
  const { repository, authorization, input } = request;
  const target = await resolveTarget(request);
  if (target.status !== "resolved") return target;
  const replayTarget = webhookReplayTarget(input, target);
  const deliveryId = webhookDeliveryId(authorization, input, target.projectId);
  const existing = await repository.findManualReceipt(authorization.organizationId, deliveryId);
  const identity = publicManualIdentity(authorization, target.actor);
  const delivery = { identity, replayTarget, deliveryId };
  if (existing !== undefined) {
    const replay = await replayWebhook(request, delivery, existing);
    if (replay !== undefined) return replay;
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
    const rejected = await validateNewDelivery(request, target, payload);
    if (rejected !== undefined) return rejected;
  }
  return dispatchWebhookDelivery(request, delivery, payload);
}

interface WebhookDelivery {
  identity: ManualDispatchIdentity;
  replayTarget: WebhookReplayTarget;
  deliveryId: string;
}

type WebhookReplayTarget = ManualReceiptReplayTarget & { source: "webhook.received" };

function webhookReplayTarget(
  input: ReceiveWebhookInput,
  target: WebhookTarget,
): WebhookReplayTarget {
  const signature = input.githubSignature;
  return {
    projectId: target.projectId,
    publicTriggerName: input.trigger,
    source: "webhook.received",
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
}

function webhookDeliveryId(
  authorization: PublicAuthorization,
  input: ReceiveWebhookInput,
  projectId: string,
): string {
  const signature = input.githubSignature;
  return signature === undefined
    ? bearerWebhookDeliveryId(
        authorization.organizationId,
        projectId,
        input.trigger,
        input.deliveryKey,
      )
    : signedWebhookDeliveryId(
        authorization.organizationId,
        authorization.credentialId,
        signature.bodyDigest,
      );
}

async function replayWebhook(
  request: WebhookRequest,
  { identity, replayTarget }: WebhookDelivery,
  receipt: ProviderEventReplayMetadata,
): Promise<ReceiveWebhookResult | undefined> {
  if (receipt.payloadExpiryState != null) {
    await authorizeMarkedManualReplay(request.repository, request.capabilities, {
      identity,
      receipt,
      target: replayTarget,
    });
    return receiptResult(request, receipt, replayTarget.projectId, true);
  }
  const replay = await receiptResult(request, receipt, replayTarget.projectId, true);
  return replay.status === "dispatch_conflict" ? undefined : replay;
}

async function validateNewDelivery(
  { repository, authorization, input, maxActiveRuns }: WebhookRequest,
  target: WebhookTarget,
  payload: ManualRunPayload,
): Promise<ReceiveWebhookResult | undefined> {
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
  return active >= maxActiveRuns ? { status: "trigger_busy" } : undefined;
}

async function dispatchWebhookDelivery(
  request: WebhookRequest,
  { identity, replayTarget, deliveryId }: WebhookDelivery,
  payload: ManualRunPayload,
): Promise<ReceiveWebhookResult> {
  const { repository, capabilities, authorization } = request;
  const outcome = await capabilities.dispatchManualEvent({
    ...replayTarget,
    organizationId: authorization.organizationId,
    deliveryId,
    receivedAt: new Date(),
    payload: {
      ...payload,
      authenticatedBy: identity.authenticatedBy,
    },
  });
  if (outcome === undefined) return { status: "dispatch_conflict" };
  const receipt = await repository.findManualReceipt(authorization.organizationId, deliveryId);
  if (receipt === undefined) return { status: "dispatch_conflict" };
  if (receipt.payloadExpiryState != null)
    await authorizeMarkedManualReplay(repository, capabilities, {
      identity,
      receipt,
      target: replayTarget,
    });
  return receiptResult(
    request,
    receipt,
    replayTarget.projectId,
    outcome.replayed === true || receipt.payloadExpiryState != null,
  );
}
