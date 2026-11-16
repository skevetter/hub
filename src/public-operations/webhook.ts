import { createHash } from "node:crypto";
import type { CompiledTrigger } from "../config/compiler.js";
import type { ProviderEventReceiptRecord } from "../db/types.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import { parseManualInvocation, type ManualRunPayload } from "../triggers/manual/provider.js";
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
  actor: string;
}

async function resolveTarget(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  authorization: PublicAuthorization,
  name: string,
): Promise<
  WebhookTarget | { status: "trigger_not_found" | "actor_forbidden" | "key_actor_required" }
> {
  if (authorization.kind !== "apiKey" || authorization.actor == null)
    return { status: "key_actor_required" };
  if (authorization.allowedTriggers != null && !authorization.allowedTriggers.includes(name))
    return { status: "trigger_not_found" };
  const project = await repository.resolveWebhookProject(authorization.organizationId, name);
  if (project === undefined) return { status: "trigger_not_found" };
  const stored = await capabilities.configurationForProject(project.id).getActive();
  const trigger = stored?.configuration.triggers.find(
    (candidate) => candidate.name === name && candidate.on === "manual.run",
  );
  if (trigger === undefined) return { status: "trigger_not_found" };
  const users = trigger.filters?.from_users;
  if (!users?.includes("*") && !users?.includes(authorization.actor))
    return { status: "actor_forbidden" };
  return { status: "resolved", projectId: project.id, trigger, actor: authorization.actor };
}

async function receiptResult(
  repository: PublicOperationRepository,
  receipt: ProviderEventReceiptRecord,
  input: ReceiveWebhookInput,
  duplicate: boolean,
): Promise<ReceiveWebhookResult> {
  const run = await repository.findManualRun(receipt.id, input.trigger);
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
  const target = await resolveTarget(repository, capabilities, authorization, input.trigger);
  if (target.status !== "resolved") return target;
  const deliveryId = `public-manual-${createHash("sha256")
    .update(
      JSON.stringify([
        authorization.organizationId,
        target.projectId,
        input.trigger,
        input.deliveryKey,
      ]),
    )
    .digest("base64url")}`;
  const existing = await repository.findWebhookReceipt(authorization.organizationId, deliveryId);
  if (existing !== undefined) {
    const replay = await receiptResult(repository, existing, input, true);
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
    organizationId: authorization.organizationId,
    projectId: target.projectId,
    source: "webhook.received",
    deliveryId,
    receivedAt: new Date(),
    payload: {
      ...payload,
      authenticatedBy: { kind: "api-key", credentialId: authorization.credentialId },
    },
  });
  if (outcome === undefined) return { status: "dispatch_conflict" };
  const receipt = await repository.findWebhookReceipt(authorization.organizationId, deliveryId);
  if (receipt === undefined) return { status: "dispatch_conflict" };
  return receiptResult(repository, receipt, input, outcome.replayed === true);
}
