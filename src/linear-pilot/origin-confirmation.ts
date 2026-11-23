import type { QueryHandle } from "../db/runtime/index.js";
import { validMessage } from "../interactive-sessions/store.js";
import type { LinearAgentOperation } from "../providers/linear/agent.js";
import type { LinearPilotRegistration } from "../providers/linear/index.js";
import type { LinearPilotConfig } from "./config.js";
import { canAcknowledge } from "./created.js";
import { logPilotRefusal } from "./diagnostics.js";
import type { PilotHistoryScope } from "./history-read.js";
import { resolveLinearPilotInstallation, type qualifyLinearPilotDelivery } from "./installation.js";
import { MAX_PILOT_MESSAGE_CHARS } from "./intake.js";
import {
  createOriginActivities,
  originActivityId,
  originClient,
  readOriginWithin,
} from "./origin-activities.js";
import { claimConfirmation, waitingConfirmation } from "./origin-confirmation-receipt.js";

export const DELEGATION_CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_READ_MS = 4_000;

type Qualified = NonNullable<Awaited<ReturnType<typeof qualifyLinearPilotDelivery>>>;
type Event = Qualified["event"];
type Provider = Parameters<LinearPilotRegistration["offer"]>[1];
type Client = ReturnType<typeof originClient>;

interface Context {
  qualified: Qualified;
  provider: Provider;
  config: LinearPilotConfig;
  database: QueryHandle;
  deadline: number;
  receivedAt: Date;
  accepting(): boolean;
}

function receiptKey({ event, installation }: Qualified) {
  return {
    ...installation,
    nativeSessionId: event.nativeSessionId,
    issueId: event.issueId,
  };
}

function historyScope(event: Event): PilotHistoryScope {
  return {
    sessionId: event.nativeSessionId,
    issueId: event.issueId,
    appUserId: event.appUserId,
    allowedHumanProviderUserId: event.humanId,
  };
}

function allows(
  context: Context,
  operation: LinearAgentOperation,
  mode: "write" | "confirm" | "issue",
) {
  const { event } = context.qualified;
  if (
    !canAcknowledge(context) ||
    !("sessionId" in operation) ||
    operation.sessionId !== event.nativeSessionId
  )
    return false;
  if (mode === "write") return operation.kind === "createActivity";
  if (!("issueId" in operation) || operation.issueId !== event.issueId) return false;
  return mode === "confirm"
    ? operation.kind === "readDelegationConfirmation"
    : operation.kind === "readDelegationIssue";
}

function clientFor(context: Context, mode: "write" | "confirm" | "issue") {
  const {
    qualified: { installation },
    provider,
    database,
    config,
  } = context;
  const binding = {
    id: installation.connectionId,
    organizationId: installation.organizationId,
    linearOrganizationId: installation.workspaceId,
    providerApplicationId: installation.applicationId,
    appUserId: installation.appUserId,
  };
  const client = originClient({
    provider,
    database,
    binding,
    permits: (operation) => allows(context, operation, mode),
    current: async (query) => {
      const current = await resolveLinearPilotInstallation(query, config, provider.oauthClientId);
      return (
        current?.connectionId === installation.connectionId &&
        current.appUserId === installation.appUserId &&
        current.ownerUserId === installation.ownerUserId &&
        current.profileVersion === installation.profileVersion
      );
    },
  });
  return { client, binding };
}

function matchesIssue(
  issue: { id: string; team: { id: string; organization: { id: string } } },
  event: Event,
) {
  return (
    issue.id === event.issueId &&
    issue.team.id === event.teamId &&
    issue.team.organization.id === event.workspaceId
  );
}

type ConfirmedSession = NonNullable<Awaited<ReturnType<Client["readDelegationConfirmation"]>>>;

function matchesSession(result: ConfirmedSession, event: Event) {
  return (
    result.id === event.nativeSessionId &&
    result.appUser.id === event.appUserId &&
    result.creator?.id === event.humanId &&
    result.sourceComment === null
  );
}

function confirmedIssue(result: ConfirmedSession | null | undefined, event: Event) {
  if (!result || !matchesSession(result, event)) return undefined;
  const author = result.comment?.user;
  if (author && author.id !== event.humanId) return undefined;
  const { issue } = result;
  return issue?.delegate?.id === event.appUserId && matchesIssue(issue, event) ? issue : undefined;
}

function writer(context: Context) {
  const { client, binding } = clientFor(context, "write");
  return createOriginActivities(client, binding);
}

function logConfirmation(
  event: Event,
  reason: string,
  stage?: "readback_failed" | "signed_origin" | "issue_readback" | "session_mismatch",
) {
  const action = event.kind === "created" ? "created" : "prompted";
  return logPilotRefusal(
    reason,
    { nativeSessionId: event.nativeSessionId, action },
    stage === undefined ? undefined : { stage },
  );
}

async function refuseConfirmation(
  context: Context,
  stage: "readback_failed" | "signed_origin" | "session_mismatch",
) {
  const { database, qualified, receivedAt } = context;
  logConfirmation(qualified.event, "origin_unproven", stage);
  if (
    canAcknowledge(context) &&
    (await claimConfirmation(database, receiptKey(qualified), "refused", receivedAt))
  )
    await writer(context).delegationRefused(qualified.event.nativeSessionId);
}

export async function awaitDelegationOwner(context: Context) {
  const { qualified, database, receivedAt } = context;
  const { event } = qualified;
  const key = receiptKey(qualified);
  if (await waitingConfirmation(database, key)) return;
  if (!event.confirmationCandidate) return refuseConfirmation(context, "signed_origin");
  const { client } = clientFor(context, "confirm");
  const result = await readOriginWithin(CONFIRMATION_READ_MS, (signal) =>
    client.readDelegationConfirmation(historyScope(event), signal),
  );
  const issue = confirmedIssue(result, event);
  if (issue === undefined)
    return refuseConfirmation(context, result == null ? "readback_failed" : "session_mismatch");
  if (!canAcknowledge(context) || !(await claimConfirmation(database, key, "awaiting", receivedAt)))
    return;
  await writer(context).awaitingOwner(event.nativeSessionId, issue);
}

function eligiblePrompt(
  event: Event,
  allowedHumanId: string,
): event is Event & { message: string } {
  return (
    event.kind === "prompted" &&
    event.humanId === allowedHumanId &&
    event.humanId !== event.appUserId &&
    event.activityId !== undefined &&
    event.activityId !== originActivityId(event.nativeSessionId, "awaiting_owner") &&
    typeof event.message === "string"
  );
}

async function delegationPrompt(context: Context, reply: string) {
  const {
    qualified: { event },
  } = context;
  const { client } = clientFor(context, "issue");
  const issue = await readOriginWithin(CONFIRMATION_READ_MS, (signal) =>
    client.readDelegationIssue(historyScope(event), signal),
  );
  if (!issue || issue.delegate?.id !== event.appUserId || !matchesIssue(issue, event)) {
    logConfirmation(event, "origin_unproven", "issue_readback");
    return undefined;
  }
  const message = `Work on ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}\n\n${reply}`;
  return message.length <= MAX_PILOT_MESSAGE_CHARS && validMessage(message)
    ? message
    : logConfirmation(event, "unqualified_content");
}

type OwnerDecision = { handled: false } | { handled: true; message?: string };

type Waiting = NonNullable<Awaited<ReturnType<typeof waitingConfirmation>>>;
type Key = ReturnType<typeof receiptKey>;

function belongsToClaim(waiting: Waiting, key: Key) {
  return waiting.issueId === key.issueId && waiting.applicationId === key.applicationId;
}

async function startConfirmed(
  context: Context,
  key: Key,
  { age, reply }: { age: number; reply: string },
) {
  const {
    database,
    receivedAt,
    qualified: { event },
  } = context;
  if (age < 0) return undefined;
  if (age > DELEGATION_CONFIRM_TTL_MS) {
    if (await claimConfirmation(database, key, "expired", receivedAt))
      await writer(context).expired(event.nativeSessionId);
    return undefined;
  }
  if (!(await claimConfirmation(database, key, "started", receivedAt))) {
    return logConfirmation(event, "origin_reused");
  }
  const message = await delegationPrompt(context, reply);
  if (message === undefined) await writer(context).delegationRefused(event.nativeSessionId);
  return message;
}

export async function confirmDelegationOwner(
  context: Context,
  sessionExists: () => Promise<boolean>,
): Promise<OwnerDecision> {
  const { database, qualified, receivedAt, config } = context;
  const { event } = qualified;
  const key = receiptKey(qualified);
  const waiting = await waitingConfirmation(database, key);
  if (!waiting) return { handled: false };
  if (
    !canAcknowledge(context) ||
    !eligiblePrompt(event, config.allowedHumanId) ||
    !belongsToClaim(waiting, key)
  )
    return { handled: true };
  if (await sessionExists()) {
    logConfirmation(event, "origin_reused");
    return { handled: true };
  }
  const age = receivedAt.getTime() - waiting.receivedAt.getTime();
  const message = await startConfirmed(context, key, { age, reply: event.message });
  return message === undefined ? { handled: true } : { handled: true, message };
}
