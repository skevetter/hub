import { createHash } from "node:crypto";
import type { CompiledTrigger } from "../config/compiler.js";
import { DaemonDispatchFailure } from "../daemons/index.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import type { ProviderEventReplayMetadata } from "../db/types.js";
import { hasPostgresText, isPostgresJson } from "../http/json-storage.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import {
  authorizeManualIdentity,
  ManualRunRejected,
  parseManualInvocation,
  type ManualRunPayload,
} from "../triggers/manual/provider.js";
import { authorizeMarkedManualReplay, type ManualDispatchIdentity } from "./manual-replay.js";
import type {
  DispatchManualRunInput,
  DispatchManualRunResult,
  PublicOperationCapabilities,
  PublicOperationRepository,
} from "./types.js";

interface ManualRunDispatch {
  identity: ManualDispatchIdentity;
  projectId: string;
  input: Pick<DispatchManualRunInput, "trigger" | "deliveryKey" | "expectedVersionId" | "input">;
}

export type DispatchResolvedManualRun = (
  request: ManualRunDispatch,
) => Promise<DispatchManualRunResult>;

interface ManualRunServices {
  repository: PublicOperationRepository;
  capabilities: PublicOperationCapabilities;
}

interface ManualRunTarget {
  projectId: string;
  source: "manual.run";
  publicTriggerName: string;
}

export function createManualRunDispatcher(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
): DispatchResolvedManualRun {
  return async (request) => {
    try {
      return await dispatchManualRun({ repository, capabilities }, request);
    } catch (error) {
      if (error instanceof ManualRunRejected) return { status: error.code };
      if (error instanceof DaemonDispatchFailure && error.reason === "daemon_unreachable") {
        return { status: "daemon_offline" };
      }
      if (isDatabaseUnavailableError(error)) return { status: "infrastructure_unavailable" };
      throw error;
    }
  };
}

async function prepareManualRun(
  capabilities: PublicOperationCapabilities,
  { identity, projectId, input }: ManualRunDispatch,
) {
  const stored = await capabilities.configurationForProject(projectId).getActive();
  if (stored === undefined) throw new ManualRunRejected("configuration_not_found");
  if (input.expectedVersionId !== undefined && input.expectedVersionId !== stored.revision.id) {
    throw new ManualRunRejected("expected_configuration_not_current");
  }
  const trigger = stored.configuration.triggers.find(
    (candidate) => candidate.name === input.trigger && candidate.on === "manual.run",
  );
  if (trigger === undefined) throw new ManualRunRejected("trigger_not_found");
  authorizeManualIdentity(trigger, identity);
  const payload: ManualRunPayload = {
    ...(input.expectedVersionId === undefined
      ? {}
      : { expectedVersionId: input.expectedVersionId }),
    trigger: input.trigger,
    actor: identity.actor,
    authenticatedBy: identity.authenticatedBy,
    input: input.input,
    publicDeliveryKey: input.deliveryKey,
  };
  return { payload, trigger };
}

async function dispatchManualRun(
  services: ManualRunServices,
  request: ManualRunDispatch,
): Promise<DispatchManualRunResult> {
  const { identity, projectId, input } = request;
  const { payload, trigger } = await prepareManualRun(services.capabilities, request);
  const deliveryId = internalDeliveryId(request);
  const target: ManualRunTarget = {
    projectId,
    source: "manual.run",
    publicTriggerName: input.trigger,
  };
  const receipt = await services.repository.findManualReceipt(identity.organizationId, deliveryId);
  if (receipt === undefined) {
    const issue = validateNewManualInvocation(payload, trigger);
    if (issue !== undefined) return { status: "invalid_input", issues: [issue] };
  }
  const settled = await settleManualReceipt(
    services,
    { identity, target, deliveryId, payload },
    receipt,
  );
  if (settled.receiptId === undefined) return { status: "dispatch_conflict" };
  return readDispatchedRun(
    services,
    { identity, target, deliveryKey: input.deliveryKey },
    {
      receiptId: settled.receiptId,
      receipt: settled.receipt,
    },
  );
}

async function settleManualReceipt(
  { repository, capabilities }: ManualRunServices,
  request: {
    identity: ManualDispatchIdentity;
    target: ManualRunTarget;
    deliveryId: string;
    payload: ManualRunPayload;
  },
  receipt: ProviderEventReplayMetadata | undefined,
) {
  if (receipt?.payloadExpiryState != null) return { receipt, receiptId: receipt.id };
  const { identity, target, deliveryId, payload } = request;
  const { organizationId, startedByUserId } = identity;
  const outcome = await capabilities.dispatchManualEvent({
    ...target,
    organizationId,
    ...(startedByUserId === undefined ? {} : { startedByUserId }),
    deliveryId,
    receivedAt: new Date(),
    payload,
  });
  return {
    receipt:
      outcome?.replayed === true
        ? await repository.findManualReceipt(organizationId, deliveryId)
        : receipt,
    receiptId: outcome?.providerEventReceiptId,
  };
}

async function readDispatchedRun(
  { repository, capabilities }: ManualRunServices,
  request: { identity: ManualDispatchIdentity; target: ManualRunTarget; deliveryKey: string },
  { receipt, receiptId }: { receipt: ProviderEventReplayMetadata | undefined; receiptId: string },
): Promise<DispatchManualRunResult> {
  const { identity, target, deliveryKey } = request;
  if (receipt?.payloadExpiryState != null) {
    await authorizeMarkedManualReplay(repository, capabilities, { identity, receipt, target });
  }
  const run = await repository.findManualRun(
    identity.organizationId,
    target.projectId,
    receiptId,
    target.publicTriggerName,
  );
  if (run === undefined) return { status: "dispatch_conflict" };
  if (
    receipt?.payloadExpiryState != null &&
    run.configurationRevisionId !== receipt.manualReplayBinding?.configurationRevisionId
  )
    return { status: "dispatch_conflict" };
  if (run.outcome === "rejected") {
    return {
      status: "invalid_input",
      providerEventReceiptId: receiptId,
      triggerRunId: run.id,
      configuredTriggerName: run.configuredTriggerName,
      issues: [{ path: ["input"], message: formatInvocationRejection(run.rejection) }],
    };
  }
  return {
    status: "dispatched",
    deliveryKey,
    providerEventReceiptId: receiptId,
    triggerRunId: run.id,
    configuredTriggerName: run.configuredTriggerName,
    workflowStatus: run.status,
  };
}

function validateNewManualInvocation(payload: ManualRunPayload, trigger: CompiledTrigger) {
  const issue = validateManualInput(payload.input);
  if (issue !== undefined) return issue;
  const invocation = parseManualInvocation(payload, trigger.inputs);
  if (invocation.status !== "rejected") return undefined;
  return {
    path: ["input", invocation.rejection.inputName],
    message: formatInvocationRejection(invocation.rejection),
  };
}

function internalDeliveryId({ identity, projectId, input }: ManualRunDispatch): string {
  const parts = [identity.organizationId, projectId, input.deliveryKey];
  const browser = identity.authenticatedBy.kind === "browser-session";
  if (browser) parts.push(identity.authenticatedBy.credentialId);
  if (
    identity.authenticatedBy.kind === "cli-credential" &&
    identity.startedByUserId !== undefined
  ) {
    parts.push(identity.startedByUserId);
  }
  const hash = createHash("sha256")
    .update(parts.map((part) => JSON.stringify(part)).join(":"))
    .digest("base64url");
  return browser ? `browser-manual-${hash}` : `public-manual-${hash}`;
}

function validateManualInput(input: unknown) {
  const storable = typeof input === "string" ? hasPostgresText(input) : isPostgresJson(input);
  if (!storable) {
    return { path: ["input"], message: "Input contains unsupported JSON or Unicode text." };
  }
  const message = manualInputMessage(input);
  if (typeof message !== "string") {
    return {
      path: ["input", "message"],
      message: "Input must be text or an object with a string message.",
    };
  }
  if (Buffer.byteLength(message, "utf8") > 65_536) {
    return { path: ["input", "message"], message: "Message exceeds 65536 UTF-8 bytes." };
  }
  return undefined;
}

function manualInputMessage(input: unknown): unknown {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return Object.hasOwn(input, "message") && "message" in input ? input.message : "";
}
