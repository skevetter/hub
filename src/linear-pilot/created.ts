import type { QueryHandle } from "../db/runtime/index.js";
import { validMessage } from "../interactive-sessions/store.js";
import { LinearAgentError, type LinearAgentOperation } from "../providers/linear/agent.js";
import type { LinearPilotRegistration } from "../providers/linear/index.js";
import {
  createLinearPilotActivities,
  tracePilotActivities,
  type LinearPilotAcceptedEvent,
} from "./activities.js";
import {
  claimLinearPilotDelegation,
  hasLinearPilotReceipt,
  recordLinearPilotAdmission,
} from "./admission-receipt.js";
import type { LinearPilotConfig } from "./config.js";
import { proveDelegation, type DelegationRefusal } from "./delegation.js";
import { logPilotRefusal } from "./diagnostics.js";
import { resolveLinearPilotInstallation, type qualifyLinearPilotDelivery } from "./installation.js";

type Qualified = NonNullable<Awaited<ReturnType<typeof qualifyLinearPilotDelivery>>>;
type Provider = Parameters<LinearPilotRegistration["offer"]>[1];
type CreatedReceipt = Extract<Parameters<typeof hasLinearPilotReceipt>[1], { kind: "created" }>;

interface CreatedContext {
  qualified: Qualified;
  provider: Provider;
  config: LinearPilotConfig;
  database: QueryHandle;
  deadline: number;
  accepting(): boolean;
}

export function createdMetadata(nativeSessionId: string) {
  return { nativeSessionId, action: "created" } as const;
}

export function canAcknowledge(context: Pick<CreatedContext, "accepting" | "deadline">) {
  return context.accepting() && Date.now() < context.deadline;
}

export async function prepareCreated(
  context: CreatedContext,
  receivedAt: Date,
  activity: LinearPilotAcceptedEvent,
) {
  const {
    qualified: { event, installation },
    config,
    database,
  } = context;
  const metadata = createdMetadata(event.nativeSessionId);
  const receipt = {
    ...installation,
    profileId: config.profileId,
    kind: "created" as const,
    humanId: event.humanId,
    nativeSessionId: event.nativeSessionId,
    receivedAt,
  };
  if (event.pendingDelegation) return readDelegation(context, receipt, activity);
  const { message } = event;
  if (message === undefined) return undefined;
  if (!validMessage(message)) return logPilotRefusal("unqualified_content", metadata);
  if (!canAcknowledge(context)) return logPilotRefusal("ack_window_closed", metadata);
  if (!(await recordLinearPilotAdmission(database, receipt)))
    return logPilotRefusal("admission_not_claimed", metadata);
  return message;
}

function permitsDelegationOperation(
  operation: LinearAgentOperation,
  event: Qualified["event"],
  mayPostRefusal: boolean,
) {
  if (!("sessionId" in operation) || operation.sessionId !== event.nativeSessionId) return false;
  if (mayPostRefusal)
    return operation.kind === "createActivity" || operation.kind === "readActivity";
  return operation.kind === "readDelegationOrigin" && operation.issueId === event.issueId;
}

function sameInstallation(
  current: Awaited<ReturnType<typeof resolveLinearPilotInstallation>>,
  installation: Qualified["installation"],
) {
  return (
    current?.connectionId === installation.connectionId &&
    current.appUserId === installation.appUserId &&
    current.ownerUserId === installation.ownerUserId &&
    current.profileVersion === installation.profileVersion
  );
}

function delegationClient(
  context: CreatedContext,
  activity: LinearPilotAcceptedEvent,
  mayPostRefusal: boolean,
) {
  const {
    qualified: { event, installation },
    config,
    provider,
    database,
  } = context;
  const authorize = async (query: QueryHandle, operation: LinearAgentOperation) => {
    if (!canAcknowledge(context) || !permitsDelegationOperation(operation, event, mayPostRefusal))
      return false;
    const current = await resolveLinearPilotInstallation(query, config, provider.oauthClientId);
    return canAcknowledge(context) && sameInstallation(current, installation);
  };
  return provider.activityClient({
    binding: activity.binding,
    authorize: (_binding, operation) => authorize(database, operation),
    authorizeRefresh: (query, _binding, operation) => authorize(query, operation),
  });
}

function failedReadback(error: unknown) {
  return {
    reason: "origin_unproven" as const,
    stage: "readback_failed" as const,
    ...(error instanceof LinearAgentError ? { ...error.details, linearAgentCode: error.code } : {}),
  };
}

async function readDelegation(
  context: CreatedContext,
  receipt: CreatedReceipt,
  activity: LinearPilotAcceptedEvent,
): Promise<string | undefined> {
  const {
    qualified: { event },
    database,
    deadline,
  } = context;
  const metadata = createdMetadata(event.nativeSessionId);
  if (await hasLinearPilotReceipt(database, receipt)) return logPilotRefusal("duplicate", metadata);
  const client = delegationClient(context, activity, false);
  const scope = {
    sessionId: event.nativeSessionId,
    issueId: event.issueId,
    appUserId: event.appUserId,
    allowedHumanProviderUserId: event.humanId,
  };
  const proof = await proveDelegation(event, deadline, (signal) =>
    client.readDelegationOrigin(scope, signal),
  ).catch(failedReadback);
  if ("historyEntryId" in proof) return finishDelegation(context, receipt, activity, proof);
  logPilotRefusal(proof.reason, metadata, proof);
  return refuseDelegation(context, activity, { ...receipt, refusal: proof.reason });
}

async function finishDelegation(
  context: CreatedContext,
  receipt: CreatedReceipt,
  activity: LinearPilotAcceptedEvent,
  proof: Extract<Awaited<ReturnType<typeof proveDelegation>>, { historyEntryId: string }>,
): Promise<string | undefined> {
  const metadata = createdMetadata(activity.nativeSessionId);
  if (!canAcknowledge(context)) return logPilotRefusal("ack_window_closed", metadata);
  const matched = {
    ...receipt,
    historyEntryId: proof.historyEntryId,
    ...("reason" in proof ? { refusal: proof.reason } : {}),
  };
  const claim = await claimLinearPilotDelegation(context.database, matched);
  switch (claim) {
    case "claimed":
      if ("message" in proof) return proof.message;
      logPilotRefusal(proof.reason, metadata);
      return publishDelegationRefusal(context, activity);
    case "origin_reused":
      logPilotRefusal(claim, metadata);
      return refuseDelegation(context, activity, { ...matched, refusal: claim });
    case "not_claimed":
      return logPilotRefusal("admission_not_claimed", metadata);
  }
  return undefined;
}

async function refuseDelegation(
  context: CreatedContext,
  activity: LinearPilotAcceptedEvent,
  receipt: CreatedReceipt & { refusal: DelegationRefusal },
): Promise<undefined> {
  if (!context.accepting()) return undefined;
  if (await recordLinearPilotAdmission(context.database, receipt))
    await publishDelegationRefusal(context, activity);
  return undefined;
}

async function publishDelegationRefusal(
  context: CreatedContext,
  activity: LinearPilotAcceptedEvent,
): Promise<undefined> {
  if (!canAcknowledge(context)) return undefined;
  const metadata = createdMetadata(activity.nativeSessionId);
  const client = tracePilotActivities(
    delegationClient(context, activity, true),
    (operation, error) =>
      logPilotRefusal(
        operation,
        metadata,
        error instanceof LinearAgentError ? error.details : undefined,
      ),
  );
  await createLinearPilotActivities({ clientFor: () => client }).refuseDelegation(activity);
  return undefined;
}
