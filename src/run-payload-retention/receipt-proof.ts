import { z } from "zod";
import type { CompiledHubConfig } from "../config/compiler.js";
import { parseManualReceiptReplayBinding } from "../db/receipt-replay.js";
import type { ManualReceiptReplayBinding, ProviderEventReceiptRecord } from "../db/types.js";
import { classifyGitHubEvent } from "../triggers/github/classification.js";
import { matchesNotification } from "../triggers/github-notifications/match.js";
import {
  NotificationPayloadSchema,
  notificationDeliveryId,
} from "../triggers/github-notifications/notification.js";
import { hasLinearSourceTrigger } from "../triggers/linear/match.js";
import { eventProjectId } from "../triggers/linear/events.js";
import {
  ManualRunPayloadSchema,
  authorizeManualIdentity,
  manualInvocationPassesFilters,
  parseManualInvocation,
  type ManualRunPayload,
} from "../triggers/manual/provider.js";
import { bearerWebhookDeliveryId, signedWebhookDeliveryId } from "../webhooks/delivery-id.js";
import {
  matchPinnedProviderInvocations,
  parsePinnedRoutes,
  pinnedConfiguration,
  readPinnedProviderEvent,
  type AdmittedBranch,
  type FanoutRevision,
  type PinnedProviderEvent,
  type PinnedRoute,
} from "./fanout.js";

export type ReceiptDisposition =
  | "eligible"
  | "expiring"
  | "not_old_enough"
  | "pending_admission"
  | "fan_out_unresolved"
  | "match_evidence_missing"
  | "drop_unproven"
  | "unknown_shape"
  | "run_payload_pending"
  | "live_execution"
  | "reporter_pending"
  | "notification_pending"
  | "push_sync_unproven"
  | "lifecycle_pending";

export type ReceiptWorkBlocker = "live_execution" | "reporter_pending" | "notification_pending";

export interface ReceiptProofBranch extends AdmittedBranch {
  organizationId: string;
  outcome: "accepted" | "rejected";
  payloadExpiryState: string | null;
  payloadExpiredAt: Date | null;
  blocker: ReceiptWorkBlocker | null;
}

export type ReceiptProofEvidence = Omit<ProviderEventReceiptRecord, "acceptedRoutes"> & {
  acceptedRoutes: unknown;
  hasCapability: boolean;
  legacyBindingValid: boolean;
  hasLifecycleWork: boolean;
};

interface BlockedReceipt {
  disposition: Exclude<ReceiptDisposition, "eligible">;
}

type ReceiptProof =
  | { disposition: "eligible"; binding: ManualReceiptReplayBinding | null }
  | BlockedReceipt;

interface RoutedEvidence {
  expected: readonly ExpectedBranch[];
  binding: ManualReceiptReplayBinding | null;
}

type RevisionLookup = (id: string) => FanoutRevision | undefined;

interface ExpectedBranch extends AdmittedBranch {
  outcome: "accepted" | "rejected";
}

const TriggerEvidence = z.object({
  kind: z.literal("organization_trigger_adapter"),
  triggerId: z.uuid(),
});
const SchedulePayload = z.object({
  schedule: z.object({
    trigger_id: z.uuid(),
    scheduled_at: z.iso.datetime(),
    timezone: z.string().min(1),
  }),
});
const NotificationEvent = z.object({ github_notification: NotificationPayloadSchema });
const SIGNED_DELIVERY_KEY = /^github-sha256:([0-9a-f]{64})$/u;

export function isLifecycleReceipt(
  receipt: Pick<ReceiptProofEvidence, "provider" | "source" | "droppedReason">,
) {
  return (
    receipt.provider === "github" &&
    (receipt.source === "github.installation" ||
      receipt.source === "github.installation_repositories") &&
    receipt.droppedReason === "github_lifecycle"
  );
}

export function proveReceipt(
  receipt: ReceiptProofEvidence,
  branches: readonly ReceiptProofBranch[],
  revisionById: RevisionLookup,
  cutoff: Date,
): ReceiptProof {
  if (isLifecycleReceipt(receipt) || receipt.hasLifecycleWork)
    return { disposition: "lifecycle_pending" };
  if (receipt.payloadExpiryState !== "expiring" && receipt.receivedAt >= cutoff)
    return { disposition: "not_old_enough" };
  if (receipt.provider === "github" && receipt.source === "github.push")
    return { disposition: "push_sync_unproven" };
  if (receipt.provider === "slack" || receipt.provider === "discord")
    return { disposition: "match_evidence_missing" };
  if (!knownSource(receipt)) return { disposition: "unknown_shape" };
  if (receipt.hasCapability) return { disposition: "live_execution" };
  const blocker = finalRunBlocker(receipt.organizationId, branches);
  if (blocker !== undefined) return blocker;
  if (receipt.payloadExpiryState === "expiring")
    return { disposition: validStagedReceipt(receipt) ? "expiring" : "drop_unproven" };
  if (receipt.acceptedRoutes === null) return proveUnrouted(receipt, branches);
  const routes = parsePinnedRoutes(receipt.acceptedRoutes);
  if (
    routes === undefined ||
    new Set(routes.map((route) => route.projectId)).size !== routes.length
  )
    return { disposition: "fan_out_unresolved" };
  if (
    receipt.droppedReason === "configuration_unavailable" ||
    receipt.droppedReason === "no_project_route"
  )
    return { disposition: "drop_unproven" };
  try {
    return proveRouted(receipt, branches, routes, revisionById);
  } catch {
    return { disposition: "fan_out_unresolved" };
  }
}

function finalRunBlocker(
  organizationId: string,
  branches: readonly ReceiptProofBranch[],
): BlockedReceipt | undefined {
  if (branches.some((branch) => branch.organizationId !== organizationId))
    return { disposition: "fan_out_unresolved" };
  if (
    branches.some(
      (branch) => branch.payloadExpiryState !== "expired" || branch.payloadExpiredAt === null,
    )
  )
    return { disposition: "run_payload_pending" };
  const blocker = branches.find((branch) => branch.blocker !== null)?.blocker;
  if (blocker != null) return { disposition: blocker };

  return undefined;
}

function knownSource(receipt: ReceiptProofEvidence) {
  switch (receipt.provider) {
    case "github":
      return receipt.source.startsWith("github.");
    case "linear":
      return receipt.source === "linear.issue" || receipt.source === "linear.comment";
    case "manual":
      return receipt.source === "manual.run" || receipt.source === "webhook.received";
    case "schedule":
      return receipt.source === "schedule.tick";
    case "github_notification":
      return receipt.source === "github.notification";
    default:
      return false;
  }
}

function proveUnrouted(
  receipt: ReceiptProofEvidence,
  branches: readonly ReceiptProofBranch[],
): ReceiptProof {
  if (branches.length !== 0) return { disposition: "fan_out_unresolved" };
  if (receipt.provider !== "github" && receipt.provider !== "linear")
    return { disposition: "pending_admission" };
  if (
    receipt.connectionId !== null &&
    ((receipt.preRoutingDrop != null && receipt.droppedReason === receipt.preRoutingDrop) ||
      (receipt.droppedReason === "no_project_route" && receipt.legacyBindingValid))
  )
    return { disposition: "eligible", binding: null };
  return { disposition: receipt.droppedReason === null ? "pending_admission" : "drop_unproven" };
}

function proveRouted(
  receipt: ReceiptProofEvidence,
  branches: readonly ReceiptProofBranch[],
  routes: readonly PinnedRoute[],
  revisionById: RevisionLookup,
): ReceiptProof {
  const evidence = readRoutedEvidence(receipt, routes, revisionById);
  if ("disposition" in evidence) return evidence;
  const { expected, binding } = evidence;
  if (!exactBranches(expected, branches)) {
    return {
      disposition:
        receipt.provider === "manual" && branches.length === 0
          ? "pending_admission"
          : "fan_out_unresolved",
    };
  }
  if (
    expected.length === 0 &&
    receipt.droppedReason !== "trigger_filters_rejected" &&
    (receipt.provider === "manual" || receipt.droppedReason !== "no_trigger_for_source")
  ) {
    return { disposition: receipt.droppedReason === null ? "pending_admission" : "drop_unproven" };
  }
  return { disposition: "eligible", binding };
}

function readRoutedEvidence(
  receipt: ReceiptProofEvidence,
  routes: readonly PinnedRoute[],
  revisionById: RevisionLookup,
): RoutedEvidence | BlockedReceipt {
  switch (receipt.provider) {
    case "github":
    case "linear":
      return providerEvidence(receipt, routes, revisionById);
    case "manual":
      return routes.length === 1
        ? manualEvidence(receipt, routes[0]!, revisionById(routes[0]!.configurationRevisionId))
        : { disposition: "fan_out_unresolved" };
    case "schedule":
    case "github_notification":
      return transactionalEvidence(receipt, routes, revisionById);
    default:
      return { disposition: "unknown_shape" };
  }
}

function providerEvidence(
  receipt: ReceiptProofEvidence,
  routes: readonly PinnedRoute[],
  revisionById: RevisionLookup,
): RoutedEvidence | BlockedReceipt {
  const parsed = readPinnedProviderEvent(receipt);
  if (parsed === undefined)
    return {
      disposition: receipt.provider === "linear" ? "match_evidence_missing" : "drop_unproven",
    };
  const invalid = providerEventBlocker(receipt, parsed);
  if (invalid !== undefined) return invalid;
  const expected: ExpectedBranch[] = [];
  for (const route of routes) {
    const config = pinnedConfiguration(
      revisionById(route.configurationRevisionId),
      receipt.organizationId,
      route,
    );
    if (
      config === undefined ||
      receipt.connectionId === null ||
      route.connectionId !== receipt.connectionId ||
      (route.resourceId !== null && route.resourceId !== receipt.resourceId)
    )
      return { disposition: "fan_out_unresolved" };
    if (
      parsed.provider === "linear" &&
      parsed.event.issue === null &&
      hasLinearSourceTrigger(config.triggers, receipt.source)
    )
      return { disposition: "match_evidence_missing" };
    const matches = matchPinnedProviderInvocations(config, parsed, receipt.source, route);
    if (matches === undefined) return { disposition: "match_evidence_missing" };
    expected.push(
      ...matches.map(({ triggerName, invocation }) =>
        expectedBranch(route, triggerName, invocation.status),
      ),
    );
  }
  return { expected, binding: null };
}

function providerEventBlocker(
  receipt: ReceiptProofEvidence,
  parsed: PinnedProviderEvent,
): BlockedReceipt | undefined {
  const { provider, event } = parsed;
  if (provider === "linear") {
    return receipt.resourceId === (eventProjectId(event) ?? null)
      ? undefined
      : { disposition: "match_evidence_missing" };
  }
  const classified = classifyGitHubEvent(event);
  if (
    event.id !== receipt.deliveryId ||
    String(event.repositoryId) !== receipt.resourceId ||
    event.repo !== receipt.repo ||
    classified.semanticEvent === undefined ||
    classified.item?.number == null ||
    classified.item.number < 1
  )
    return { disposition: "drop_unproven" };
  return undefined;
}

function manualEvidence(
  receipt: ReceiptProofEvidence,
  route: PinnedRoute,
  revision: FanoutRevision | undefined,
): RoutedEvidence | BlockedReceipt {
  const config = pinnedConfiguration(revision, receipt.organizationId, route);
  if (config === undefined) return { disposition: "fan_out_unresolved" };
  const payload = ManualRunPayloadSchema.safeParse(receipt.payload);
  if (!payload.success) return { disposition: "drop_unproven" };
  const binding = manualBinding(receipt, route, revision?.sourceEvidence, payload.data);
  if (binding === null) return { disposition: "drop_unproven" };
  const target = config.triggers.find(
    (trigger) => trigger.name === binding.triggerName && trigger.on === "manual.run",
  );
  if (target === undefined) return { disposition: "fan_out_unresolved" };
  try {
    authorizeManualIdentity(target, payload.data);
  } catch {
    return { disposition: "drop_unproven" };
  }
  const invocation = parseManualInvocation(payload.data, target.inputs);
  const expected = manualInvocationPassesFilters(target, invocation)
    ? [expectedBranch(route, target.name, invocation.status)]
    : [];
  return { expected, binding };
}

function transactionalEvidence(
  receipt: ReceiptProofEvidence,
  routes: readonly PinnedRoute[],
  revisionById: RevisionLookup,
): RoutedEvidence | BlockedReceipt {
  if (receipt.provider === "schedule" && routes.length !== 1)
    return { disposition: "fan_out_unresolved" };
  const expected: ExpectedBranch[] = [];
  for (const route of routes) {
    const revision = revisionById(route.configurationRevisionId);
    const config = pinnedConfiguration(revision, receipt.organizationId, route);
    if (config === undefined) return { disposition: "fan_out_unresolved" };
    const name = transactionalTrigger(receipt, config, revision?.sourceEvidence, route);
    if (name === undefined) return { disposition: "fan_out_unresolved" };
    expected.push(expectedBranch(route, name, "accepted"));
  }
  return { expected, binding: null };
}

function expectedBranch(
  route: PinnedRoute,
  configuredTriggerName: string,
  outcome: ExpectedBranch["outcome"],
): ExpectedBranch {
  return {
    projectId: route.projectId,
    configurationRevisionId: route.configurationRevisionId,
    configuredTriggerName,
    outcome,
  };
}

function exactBranches(expected: readonly ExpectedBranch[], admitted: readonly ExpectedBranch[]) {
  const key = (branch: ExpectedBranch) =>
    JSON.stringify([
      branch.projectId,
      branch.configurationRevisionId,
      branch.configuredTriggerName,
      branch.outcome,
    ]);
  const keys = new Set(expected.map(key));
  return (
    keys.size === expected.length &&
    admitted.length === expected.length &&
    admitted.every((branch) => keys.delete(key(branch)))
  );
}

function manualBinding(
  receipt: ReceiptProofEvidence,
  route: PinnedRoute,
  sourceEvidence: unknown,
  payload: ManualRunPayload,
): ManualReceiptReplayBinding | null {
  if (
    (payload.source !== undefined && payload.source !== receipt.source) ||
    (payload.expectedVersionId !== undefined &&
      payload.expectedVersionId !== route.configurationRevisionId)
  )
    return null;
  const binding = {
    projectId: route.projectId,
    configurationRevisionId: route.configurationRevisionId,
    triggerName: payload.trigger,
    triggerId: null,
  };
  if (receipt.source === "manual.run") return binding;
  if (
    payload.publicDeliveryKey === undefined ||
    payload.authenticatedBy?.kind !== "api-key" ||
    payload.authenticatedBy.boundActor !== payload.actor
  )
    return null;
  if (
    receipt.deliveryId ===
    bearerWebhookDeliveryId(
      receipt.organizationId,
      route.projectId,
      payload.trigger,
      payload.publicDeliveryKey,
    )
  )
    return binding;
  const digest = SIGNED_DELIVERY_KEY.exec(payload.publicDeliveryKey)?.[1];
  const signer = TriggerEvidence.safeParse(sourceEvidence);
  if (
    digest === undefined ||
    !signer.success ||
    receipt.deliveryId !==
      signedWebhookDeliveryId(receipt.organizationId, payload.authenticatedBy.credentialId, digest)
  )
    return null;
  return { ...binding, triggerId: signer.data.triggerId };
}

function transactionalTrigger(
  receipt: ReceiptProofEvidence,
  config: CompiledHubConfig,
  sourceEvidence: unknown,
  route: PinnedRoute,
) {
  if (
    receipt.connectionId !== null ||
    receipt.resourceId !== null ||
    route.connectionId !== null ||
    route.resourceId !== null
  )
    return undefined;
  const trigger = config.triggers.find((candidate) => candidate.on === receipt.source);
  if (trigger === undefined) return undefined;
  if (receipt.provider === "schedule") {
    const event = SchedulePayload.safeParse(receipt.payload);
    const evidence = TriggerEvidence.safeParse(sourceEvidence);
    if (!event.success || !evidence.success) return undefined;
    const { trigger_id, scheduled_at } = event.data.schedule;
    return trigger_id === evidence.data.triggerId &&
      receipt.deliveryId === `schedule:${trigger_id}:${new Date(scheduled_at).toISOString()}`
      ? trigger.name
      : undefined;
  }
  const event = NotificationEvent.safeParse(receipt.payload);
  if (!event.success) return undefined;
  const payload = event.data.github_notification;
  return receipt.deliveryId === notificationDeliveryId(payload) &&
    receipt.repo === payload.repo &&
    matchesNotification(payload, trigger.filters)
    ? trigger.name
    : undefined;
}

function validStagedReceipt(receipt: ReceiptProofEvidence): boolean {
  const { payload } = receipt;
  return (
    receipt.payloadExpiredAt != null &&
    receipt.acceptedRoutes === null &&
    receipt.preRoutingDrop == null &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 0 &&
    (receipt.provider !== "manual" ||
      parseManualReceiptReplayBinding(receipt.manualReplayBinding) !== null)
  );
}
