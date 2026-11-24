import type { Database } from "../db/types.js";
import type { DatabaseRuntime, QueryHandle } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import type { InteractiveSessionCoordinator } from "../interactive-sessions/coordinator.js";
import type { SessionRecord } from "../interactive-sessions/types.js";
import { logger } from "../logger.js";
import type { LinearAgentOperation } from "../providers/linear/agent.js";
import type { LinearPilotRegistration } from "../providers/linear/index.js";
import type { SurfaceBinding } from "../surfaces/store.js";
import {
  createLinearPilotActivities,
  PILOT_ACK_MS,
  pilotActivityIds,
  tracePilotActivities,
  type LinearPilotAcceptedEvent,
} from "./activities.js";
import { recordLinearPilotAdmission } from "./admission-receipt.js";
import { PilotBindings, type PilotAuthority, type PilotNativeOrigin } from "./binding.js";
import type { LinearPilotConfig } from "./config.js";
import { canAcknowledge, createdMetadata, prepareCreated } from "./created.js";
import { logPilotRefusal, pilotDeliveryMetadata } from "./diagnostics.js";
import { qualifyLinearPilotDelivery, resolveLinearPilotInstallation } from "./installation.js";
import { classifyLinearPilotCompanionComment } from "./intake.js";
import { adaptSignedPilotFollowUp } from "./follow-up-event.js";
import {
  createPilotFollowUp,
  pilotExceptionFields,
  type PilotConversation,
  type PilotFailure,
  type PilotFollowUpOptions,
  type PilotTurn,
} from "./follow-up.js";
import type { PilotHistoryScope } from "./history-read.js";
import { awaitDelegationOwner, confirmDelegationOwner } from "./origin-confirmation.js";
import { createNonOwnerOrigin } from "./origin-non-owner.js";
import { createPilotSessionSerialization } from "./session-serialization.js";
import { createLinearPilotToolStepHook, type ToolStepHook } from "./tool-steps.js";
import type { LinearPilotSessionHooks } from "./session.js";
import {
  authorizeBoundPilotTurn,
  authorizePilotTurnRefresh,
  type PilotTurnGrant,
} from "./turn-authority.js";

type Qualified = NonNullable<Awaited<ReturnType<typeof qualifyLinearPilotDelivery>>>;
type Provider = Parameters<LinearPilotRegistration["offer"]>[1];
function followUpScope({ event, installation }: Qualified, ownerId: string): PilotConversation {
  const { organizationId, workspaceId, applicationId, appUserId, connectionId } = installation;
  const { nativeSessionId, issueId, teamId } = event;
  return {
    organizationId,
    workspaceId,
    applicationId,
    appUserId,
    connectionId,
    nativeSessionId,
    issueId,
    teamId,
    ownerId,
  };
}

function reportFollowUpOutcome(fields: {
  nativeSessionId: string;
  operation: "prompted" | "stop";
  outcome: string;
  reason: string;
}) {
  logger.info(fields, "Linear pilot follow-up did not start");
}

interface Options {
  config: LinearPilotConfig;
  database: Database;
  runtime: DatabaseRuntime;
  locks: Locks;
  scrubValues?: readonly string[];
  reportFailure?(failure: PilotFailure): void;
}

async function appendFollowUpRefusal(
  { config, runtime }: Options,
  { installation }: Pick<Qualified, "installation">,
  provider: Provider,
  activity: LinearPilotAcceptedEvent,
) {
  const authorize = async (query: QueryHandle, operation: LinearAgentOperation) => {
    if (operation.kind !== "createActivity" && operation.kind !== "readActivity") return false;
    if (operation.sessionId !== activity.nativeSessionId) return false;
    const current = await resolveLinearPilotInstallation(query, config, provider.oauthClientId);
    return (
      current?.connectionId === installation.connectionId &&
      current.appUserId === installation.appUserId &&
      current.ownerUserId === installation.ownerUserId &&
      current.profileVersion === installation.profileVersion
    );
  };
  const client = provider.activityClient({
    binding: activity.binding,
    authorize: (_binding, operation) => authorize(runtime, operation),
    authorizeRefresh: (query, _binding, operation) => authorize(query, operation),
  });
  const writer = createLinearPilotActivities({ clientFor: () => client });
  const written = await writer.error(activity, "first-attempt", undefined, "continuation");
  if (written.disposition !== "confirmed") {
    reportFollowUpOutcome({
      nativeSessionId: activity.nativeSessionId,
      operation: "prompted",
      outcome: written.disposition,
      reason: "refusal_not_confirmed",
    });
  }
}

interface Active extends PilotTurnGrant {
  activity: LinearPilotAcceptedEvent;
  provider: Provider;
  stopping?: boolean;
}

interface BoundLiveSession {
  binding: SurfaceBinding;
  session: SessionRecord;
  grant: Active;
}

function followUpTurnState(session: SessionRecord, live: Active | undefined): PilotTurn["state"] {
  if (live && !live.stopping && ["running", "waiting_permission", "idle"].includes(session.state))
    return "busy";
  if (!live && session.state === "idle" && session.daemonAgentId !== null) return "complete";
  return "fenced";
}

async function projectFollowUpTurn(
  scope: PilotConversation,
  { binding, session, grant }: BoundLiveSession,
  live: Active | undefined,
  sessions: InteractiveSessionCoordinator,
): Promise<PilotTurn> {
  const target =
    live &&
    (await sessions.activeLinearPilotTurn({
      organizationId: session.organizationId,
      sessionId: session.id,
      commandId: grant.commandId,
    }));
  const state = followUpTurnState(session, live);
  return {
    ...scope,
    generation: binding.generation,
    policyRevision: binding.policyRevision,
    hubSessionId: session.id,
    profileId: session.profileId,
    profileVersion: session.profileVersion,
    state,
    preceding:
      state === "complete"
        ? {
            activityId: session.startIdempotencyKey,
            kind: session.stateReason === "stopped_by_person" ? "stop" : "answer",
          }
        : null,
    agentId: target?.agentId ?? session.daemonAgentId,
    daemonTurnId: target?.daemonTurnId ?? null,
    ...(target?.startedAt ? { startedAt: target.startedAt } : {}),
  };
}

function connectionBinding(
  installation: Qualified["installation"],
): LinearPilotAcceptedEvent["binding"] {
  return {
    id: installation.connectionId,
    organizationId: installation.organizationId,
    linearOrganizationId: installation.workspaceId,
    providerApplicationId: installation.applicationId,
    appUserId: installation.appUserId,
  };
}

type PendingStarts = Map<string, { installation: Qualified["installation"]; identityId: string }>;
interface CreatedScope {
  authority: PilotAuthority;
  origin: PilotNativeOrigin;
  principal: { organizationId: string; userId: string; role: "owner" };
}
interface CreatedDependencies {
  bindings: Pick<PilotBindings, "mapIdentity" | "admit">;
  pending: PendingStarts;
  active: Map<string, Active>;
  writerFor: (grant: Active) => ReturnType<typeof createLinearPilotActivities>;
  reportFailure: (failure: PilotFailure) => void;
  accepting: () => boolean;
}

interface FollowUpActions {
  scope: CreatedScope;
  installation: Qualified["installation"];
  provider: Provider;
  sessions: InteractiveSessionCoordinator;
  bindings: Pick<PilotBindings, "advance">;
  active: Map<string, Active>;
  pending: PendingStarts;
  accepting(): boolean;
  activity(kind: "prompted" | "stop", interactionId: string): LinearPilotAcceptedEvent;
  closeToolSteps(activity: LinearPilotAcceptedEvent): void;
  writerFor: CreatedDependencies["writerFor"];
  report: (failureCode: PilotFailure["failureCode"]) => void;
}

async function retireFollowUp(
  actions: FollowUpActions,
  { binding, session, grant }: BoundLiveSession,
  agentId: string,
) {
  const { active, sessions, scope } = actions;
  active.set(session.id, grant);
  try {
    return await sessions.retireLinearPilotTurn(scope.principal, {
      organizationId: session.organizationId,
      sessionId: session.id,
      commandId: grant.commandId,
      profileId: session.profileId,
      workspaceId: scope.authority.workspaceId,
      generation: session.generation,
      hubTurn: session.turn,
      agentId,
      expectedBindingGeneration: binding.generation,
    });
  } finally {
    active.delete(session.id);
  }
}

async function reserveFollowUp(
  actions: FollowUpActions,
  prior: BoundLiveSession | undefined,
  activityId: string,
) {
  if (!prior || !actions.accepting()) return undefined;
  const { daemonAgentId, requesterIdentityId } = prior.session;
  const { pending, report, installation } = actions;
  if (!daemonAgentId || !requesterIdentityId || pending.has(activityId)) return undefined;
  if (!(await retireFollowUp(actions, prior, daemonAgentId))) {
    report("retirement_refused");
    return undefined;
  }
  pending.set(activityId, { installation, identityId: requesterIdentityId });
  try {
    return await reserveFreshFollowUp(actions, prior, activityId, {
      daemonAgentId,
      requesterIdentityId,
    });
  } finally {
    pending.delete(activityId);
  }
}

async function reserveFreshFollowUp(
  actions: FollowUpActions,
  { binding, session, grant }: BoundLiveSession,
  activityId: string,
  { daemonAgentId, requesterIdentityId }: { daemonAgentId: string; requesterIdentityId: string },
) {
  const {
    scope: { authority, origin, principal },
    active,
    sessions,
    report,
  } = actions;
  const start = await sessions.reserveLinearPilotFreshStart(principal, {
    profileId: session.profileId,
    profileVersion: session.profileVersion,
    idempotencyKey: activityId,
    nativeRequester: { identityId: requesterIdentityId, workspaceId: authority.workspaceId },
  });
  if (start.outcome === "refused") {
    report(start.code);
    return undefined;
  }
  if (start.replayed) return undefined;
  const switched = await actions.bindings.advance(authority, {
    ...origin,
    nextSessionId: start.sessionId,
    now: new Date(),
    expected: {
      bindingId: binding.id,
      generation: binding.generation,
      sessionId: binding.sessionId,
      sessionGeneration: session.generation,
      turn: session.turn,
      agentId: daemonAgentId,
      firstCommandId: grant.commandId,
    },
  });
  if (switched.status === "refused") report(switched.reason);
  if (switched.status !== "advanced") return undefined;
  active.set(start.sessionId, {
    authority,
    origin,
    provider: actions.provider,
    activity: actions.activity("prompted", activityId),
    sessionId: start.sessionId,
    commandId: start.commandId,
    bindingGeneration: switched.binding.generation,
    profileVersion: session.profileVersion,
  });
  return {
    hubSessionId: start.sessionId,
    generation: switched.binding.generation,
    dispatchInitial: (message: string) =>
      dispatchReservedFollowUp(actions, start.sessionId, () => start.dispatch(message)),
  };
}

async function dispatchReservedFollowUp(
  { active, report }: FollowUpActions,
  sessionId: string,
  dispatch: () => Promise<"started" | "unconfirmed">,
) {
  const outcome = await dispatch();
  if (outcome !== "started") {
    active.delete(sessionId);
    report(outcome);
  }
  return outcome;
}

async function stopFollowUpTurn(
  actions: FollowUpActions,
  prior: BoundLiveSession | undefined,
  { turn, requestedAt }: Parameters<PilotFollowUpOptions["stopCurrent"]>[0],
) {
  if (!prior || !turn.agentId || !turn.daemonTurnId || !actions.accepting()) return "ignored";
  const { session, grant } = prior;
  grant.stopping = true;
  actions.closeToolSteps(grant.activity);
  try {
    const stopped = await actions.sessions.stopLinearPilot({
      organizationId: session.organizationId,
      sessionId: session.id,
      commandId: grant.commandId,
      expectedAgentId: turn.agentId,
      expectedDaemonTurnId: turn.daemonTurnId,
      expectedBindingGeneration: turn.generation,
      requestedAt,
    });
    const activity = actions.activity("stop", session.startIdempotencyKey);
    const confirmed = stopped.status === "stopped";
    await actions
      .writerFor(grant)
      .stop(activity, "first-attempt", confirmed ? "confirmed" : "unconfirmed");
    return confirmed ? "stopped" : "unconfirmed";
  } finally {
    actions.active.delete(session.id);
  }
}

function logRuntimeFailure(failure: PilotFailure) {
  const { sessionId, failureCode, operation } = failure;
  const action = operation === "stop" ? "prompted" : operation;
  logPilotRefusal(
    failureCode,
    {
      nativeSessionId: sessionId,
      ...(action === "created" || action === "prompted" ? { action } : {}),
    },
    failure,
  );
}

async function startCreated(
  input: {
    message: string;
    qualified: Qualified;
    scope: CreatedScope;
    activity: LinearPilotAcceptedEvent;
    provider: Provider;
    sessions: InteractiveSessionCoordinator;
  },
  deps: CreatedDependencies,
) {
  const { bindings, pending, reportFailure } = deps;
  const { message, qualified, scope, activity, provider, sessions } = input;
  const { installation } = qualified;
  const { nativeSessionId } = activity;
  const refuseDuplicate = () => logPilotRefusal("duplicate", createdMetadata(nativeSessionId));
  const report = (failureCode: PilotFailure["failureCode"]) =>
    reportFailure({ sessionId: nativeSessionId, failureCode, operation: "created" });
  const now = new Date();
  const identity = await bindings.mapIdentity(scope.authority, "Linear pilot owner", now);
  if (identity.status === "refused") return report(identity.reason);
  pending.set(nativeSessionId, { installation, identityId: identity.identity.id });
  try {
    const start = await sessions.startLinearPilot(scope.principal, {
      profileId: scope.authority.profileId,
      profileVersion: installation.profileVersion,
      idempotencyKey: nativeSessionId,
      message,
      nativeRequester: {
        identityId: identity.identity.id,
        workspaceId: installation.workspaceId,
      },
    });
    if (start.outcome === "refused") return report(start.code);
    if (start.replayed) return refuseDuplicate();
    const binding = await bindings.admit(scope.authority, {
      ...scope.origin,
      sessionId: start.sessionId,
      now,
    });
    if (binding.status === "refused") return report(binding.reason);
    if (binding.status !== "created") return refuseDuplicate();
    await acknowledgeCreated(
      sessions,
      {
        authority: scope.authority,
        origin: scope.origin,
        activity,
        provider,
        sessionId: start.sessionId,
        commandId: start.commandId,
        bindingGeneration: binding.binding.generation,
        profileVersion: installation.profileVersion,
      },
      deps,
    );
  } finally {
    pending.delete(nativeSessionId);
  }
}

async function acknowledgeCreated(
  sessions: InteractiveSessionCoordinator,
  grant: Active,
  { active, writerFor, accepting }: CreatedDependencies,
) {
  const { activity } = grant;
  active.set(grant.sessionId, grant);
  const ack = await writerFor(grant).acknowledge(activity, "first-attempt");
  if (ack.disposition !== "confirmed" || !accepting()) {
    active.delete(grant.sessionId);
    logPilotRefusal(
      ack.disposition === "confirmed" ? "not_accepting" : ack.disposition,
      createdMetadata(activity.nativeSessionId),
    );
    return;
  }
  await sessions.dispatchLinearPilotStart({
    organizationId: grant.authority.organizationId,
    sessionId: grant.sessionId,
    commandId: grant.commandId,
  });
}

interface RuntimeState {
  options: Options;
  bindings: PilotBindings;
  withSession: ReturnType<typeof createPilotSessionSerialization>;
  pending: PendingStarts;
  active: Map<string, Active>;
  jobs: Set<Promise<void>>;
  accepting: boolean;
  coordinator?: InteractiveSessionCoordinator;
  toolSteps?: ReturnType<typeof createLinearPilotToolStepHook>;
}

interface RuntimeDelivery {
  qualified: Qualified;
  provider: Provider;
  receivedAt: Date;
  sessions: InteractiveSessionCoordinator;
}

function reportRuntimeFailure(state: RuntimeState, failure: PilotFailure): void {
  logRuntimeFailure(failure);
  try {
    state.options.reportFailure?.(failure);
  } catch {}
}

function eventScope(config: LinearPilotConfig, { event, installation }: Qualified) {
  const authority: PilotAuthority = {
    ...installation,
    profileId: config.profileId,
    humanProviderUserId: config.allowedHumanId,
    teamIds: [event.teamId],
  };
  const origin: PilotNativeOrigin = {
    nativeSessionId: event.nativeSessionId,
    issueId: event.issueId,
    teamId: event.teamId,
    actorProviderUserId: event.humanId,
  };
  const principal = {
    organizationId: installation.organizationId,
    userId: installation.ownerUserId,
    role: "owner" as const,
  };
  return { authority, origin, principal };
}

function acceptedActivity(
  config: LinearPilotConfig,
  { event, installation }: Qualified,
  {
    kind,
    interactionId,
    receivedAt,
  }: { kind: LinearPilotAcceptedEvent["kind"]; interactionId: string; receivedAt: Date },
): LinearPilotAcceptedEvent {
  return {
    kind,
    decision: "accepted",
    binding: connectionBinding(installation),
    nativeSessionId: event.nativeSessionId,
    interactionId,
    receivedAt: receivedAt.getTime(),
    actorProviderUserId: event.humanId,
    allowedHumanProviderUserId: config.allowedHumanId,
    publishAnswer: true,
  };
}

function originContext(state: RuntimeState, { qualified, provider, receivedAt }: RuntimeDelivery) {
  const { config, runtime } = state.options;
  return {
    qualified,
    provider,
    config,
    database: runtime,
    receivedAt,
    deadline: receivedAt.getTime() + PILOT_ACK_MS,
    accepting: () => state.accepting,
  };
}

function startInitialDelivery(
  state: RuntimeState,
  { qualified, provider, receivedAt, sessions }: RuntimeDelivery,
  scope: CreatedScope,
  message: string,
) {
  const activity = acceptedActivity(state.options.config, qualified, {
    kind: "created",
    interactionId: qualified.event.nativeSessionId,
    receivedAt,
  });
  return startCreated(
    { message, qualified, scope, activity, provider, sessions },
    {
      bindings: state.bindings,
      pending: state.pending,
      active: state.active,
      writerFor: (grant) => runtimeWriter(state, grant),
      reportFailure: (failure) => reportRuntimeFailure(state, failure),
      accepting: () => state.accepting,
    },
  );
}

async function dispatchCreated(state: RuntimeState, delivery: RuntimeDelivery) {
  const { bindings, withSession } = state;
  const { qualified, receivedAt } = delivery;
  const { event } = qualified;
  const { nativeSessionId } = event;
  const scope = eventScope(state.options.config, qualified);
  const refusal = (reason: string) => logPilotRefusal(reason, createdMetadata(nativeSessionId));
  const context = originContext(state, delivery);

  await withSession(scope.authority, scope.origin, async () => {
    if (!canAcknowledge(context)) return refusal("ack_window_closed");
    const prior = await bindings.find(scope.authority, scope.origin);
    if (prior.status === "refused")
      return reportRuntimeFailure(state, {
        sessionId: nativeSessionId,
        failureCode: prior.reason,
        operation: "created",
      });
    if (prior.status !== "none") return refusal("duplicate");
    if (event.pendingDelegation) return awaitDelegationOwner(context);
    const message = await prepareCreated(context, receivedAt);
    if (message !== undefined) await startInitialDelivery(state, delivery, scope, message);
  });
}

async function dispatchDelegationConfirmation(state: RuntimeState, delivery: RuntimeDelivery) {
  const scope = eventScope(state.options.config, delivery.qualified);
  const { authority, origin } = scope;
  const context = originContext(state, delivery);
  return state.withSession(authority, origin, async () => {
    const decision = await confirmDelegationOwner(context, async () => {
      const prior = await state.bindings.find(authority, origin);
      return prior.status !== "none";
    });
    if (decision.handled && decision.message !== undefined && canAcknowledge(context))
      await startInitialDelivery(state, delivery, scope, decision.message);
    return decision.handled;
  });
}

function clientFor(state: RuntimeState, grant: Active, activity = grant.activity) {
  const {
    bindings,
    options: { database },
  } = state;
  const permitsOperation = (operation: Readonly<LinearAgentOperation>) =>
    state.accepting &&
    "sessionId" in operation &&
    operation.sessionId === activity.nativeSessionId &&
    (!("issueId" in operation) || operation.issueId === grant.origin.issueId) &&
    operation.kind !== "addHubUrl" &&
    operation.kind !== "readNonOwnerOrigin" &&
    operation.kind !== "readDelegationConfirmation" &&
    operation.kind !== "readDelegationIssue";
  return grant.provider.activityClient({
    binding: activity.binding,
    authorize: async (_binding, operation) => {
      if (!permitsOperation(operation)) return false;
      const found = await database.findInteractiveSession(
        grant.authority.organizationId,
        grant.sessionId,
      );
      return (
        found !== undefined &&
        (await authorizeBoundPilotTurn(bindings.find, grant, found.session, grant.commandId))
      );
    },
    authorizeRefresh: async (query, _binding, operation) =>
      permitsOperation(operation) &&
      (await authorizePilotTurnRefresh(query, bindings.find, grant)) &&
      state.accepting,
  });
}

function runtimeWriter(state: RuntimeState, grant: Active) {
  return createLinearPilotActivities({
    clientFor(activity) {
      const client = clientFor(state, grant, activity);
      return tracePilotActivities(client, (operation, error) =>
        reportRuntimeFailure(state, {
          sessionId: activity.nativeSessionId,
          ...pilotExceptionFields(error),
          operation,
        }),
      );
    },
  });
}

async function boundLiveSession(
  state: RuntimeState,
  { qualified, provider, receivedAt }: Omit<RuntimeDelivery, "sessions">,
  { authority, origin }: CreatedScope,
): Promise<BoundLiveSession | undefined> {
  const {
    bindings,
    active,
    options: { config, runtime, database },
  } = state;
  const found = await bindings.find(authority, origin);
  if (found.status === "refused") {
    reportRuntimeFailure(state, {
      sessionId: origin.nativeSessionId,
      failureCode: found.reason,
      operation: qualified.event.kind,
    });
  }
  if (found.status !== "bound") return undefined;
  const { binding } = found;
  const stored = await database.findInteractiveSession(authority.organizationId, binding.sessionId);
  if (stored === undefined) return undefined;
  const { session } = stored;
  const {
    rows: [first],
  } = await runtime.query<{ id: string }>(
    `select id from interactive_session_commands
        where organization_id = $1 and session_id = $2 and ordinal = 1
          and generation = $3 and kind = 'message' and status = 'delivered'
          and author_user_id = $4`,
    [session.organizationId, session.id, session.generation, authority.ownerUserId],
  );
  if (!first) return undefined;
  const live = active.get(session.id);
  const kind = session.startIdempotencyKey === origin.nativeSessionId ? "created" : "prompted";
  const grant = live ?? {
    authority,
    origin,
    provider,
    activity: acceptedActivity(config, qualified, {
      kind,
      interactionId: session.startIdempotencyKey,
      receivedAt,
    }),
    sessionId: session.id,
    commandId: first.id,
    bindingGeneration: binding.generation,
    profileVersion: session.profileVersion,
  };
  if (!(await authorizeBoundPilotTurn(bindings.find, grant, session, first.id, binding.generation)))
    return undefined;
  return { binding, session, grant };
}

async function dispatchFollowUp(state: RuntimeState, delivery: RuntimeDelivery) {
  const { qualified } = delivery;
  const { event, installation } = qualified;
  const { kind } = event;
  if (kind === "created") return;
  if (kind === "prompted" && (await dispatchDelegationConfirmation(state, delivery))) return;
  const signed = adaptSignedPilotFollowUp(event, installation);
  if (!signed)
    return reportFollowUpOutcome({
      nativeSessionId: event.nativeSessionId,
      operation: kind,
      outcome: "ignored",
      reason: "invalid_event",
    });
  const actions = followUpActions(state, delivery, kind);
  const scope = followUpScope(qualified, state.options.config.allowedHumanId);
  const run = createPilotFollowUp(followUpOptions(state, delivery, actions));
  await run(scope, signed);
}

function followUpActions(
  state: RuntimeState,
  { qualified, provider, receivedAt, sessions }: RuntimeDelivery,
  kind: "prompted" | "stop",
): FollowUpActions {
  const {
    options: { config },
    active,
    pending,
    bindings,
  } = state;
  const { installation } = qualified;
  const eventContext = eventScope(config, qualified);
  const { origin } = eventContext;
  const report = (failureCode: PilotFailure["failureCode"]) =>
    reportRuntimeFailure(state, {
      sessionId: origin.nativeSessionId,
      failureCode,
      operation: kind,
    });
  return {
    scope: eventContext,
    installation,
    provider,
    sessions,
    bindings,
    active,
    pending,
    accepting: () => state.accepting,
    activity: (activityKind, id) =>
      acceptedActivity(config, qualified, { kind: activityKind, interactionId: id, receivedAt }),
    closeToolSteps: (activity) => state.toolSteps?.close(activity),
    writerFor: (grant) => runtimeWriter(state, grant),
    report,
  };
}

function followUpOptions(
  state: RuntimeState,
  { qualified, provider, receivedAt, sessions }: RuntimeDelivery,
  actions: FollowUpActions,
): PilotFollowUpOptions {
  const {
    options: { config, runtime },
    active,
    withSession,
  } = state;
  const { event, installation } = qualified;
  const { scope: eventContext } = actions;
  const { authority, origin } = eventContext;
  const scope = followUpScope(qualified, config.allowedHumanId);
  const history: PilotHistoryScope = {
    sessionId: origin.nativeSessionId,
    issueId: origin.issueId,
    appUserId: authority.appUserId,
    allowedHumanProviderUserId: config.allowedHumanId,
  };
  let current: BoundLiveSession | undefined;
  return {
    withSession: (_scope, operation) => withSession(authority, origin, operation),
    activityIds: pilotActivityIds,
    reportFailure: (failure) => reportRuntimeFailure(state, failure),
    reportOutcome: reportFollowUpOutcome,
    current: async (): Promise<PilotTurn | undefined> => {
      if (!state.accepting) return undefined;
      current = await boundLiveSession(state, { qualified, provider, receivedAt }, eventContext);
      return (
        current && projectFollowUpTurn(scope, current, active.get(current.session.id), sessions)
      );
    },
    claim: async ({ activityId }) => {
      const admitted = await recordLinearPilotAdmission(runtime, {
        ...installation,
        profileId: config.profileId,
        kind: event.kind === "stop" ? "stop" : "prompted",
        humanId: event.humanId,
        nativeSessionId: origin.nativeSessionId,
        activityId,
        receivedAt,
      });
      return admitted ? "claimed" : "duplicate";
    },
    ...followUpResponses(state, actions, () => current, history),
  };
}

function followUpResponses(
  state: RuntimeState,
  actions: FollowUpActions,
  getCurrent: () => BoundLiveSession | undefined,
  history: PilotHistoryScope,
): Pick<
  PilotFollowUpOptions,
  | "appendBusy"
  | "appendRefusal"
  | "confirmStop"
  | "readPrompt"
  | "readHistory"
  | "secrets"
  | "reserve"
  | "stopCurrent"
> {
  const { options } = state;
  return {
    appendBusy: async ({ activityId }) => {
      const current = getCurrent();
      if (!current) return false;
      const activity = actions.activity("prompted", activityId);
      return (
        (await runtimeWriter(state, current.grant).busy(activity, "first-attempt")).disposition ===
        "confirmed"
      );
    },
    appendRefusal: ({ activityId }) =>
      appendFollowUpRefusal(
        options,
        { installation: actions.installation },
        actions.provider,
        actions.activity("prompted", activityId),
      ),
    confirmStop: async (_scope, activityId) => {
      const current = getCurrent();
      return (
        current !== undefined &&
        clientFor(state, current.grant).isActivityConfirmed({
          sessionId: history.sessionId,
          activityId,
          kind: "response",
        })
      );
    },
    readPrompt: async (_scope, expected) => {
      const current = getCurrent();
      return current && clientFor(state, current.grant).readPilotPrompt(history, expected);
    },
    readHistory: async (_scope, anchor) => {
      const current = getCurrent();
      return current && clientFor(state, current.grant).readPilotHistory(history, anchor.createdAt);
    },
    secrets: async () => options.scrubValues ?? [],
    reserve: ({ activityId }) => reserveFollowUp(actions, getCurrent(), activityId),
    stopCurrent: (request) => stopFollowUpTurn(actions, getCurrent(), request),
  };
}

type StartArguments = Parameters<LinearPilotSessionHooks["authorizeStart"]>;

function matchesStartGrant(
  config: LinearPilotConfig,
  grant: NonNullable<ReturnType<PendingStarts["get"]>>,
  [principal, input]: StartArguments,
) {
  return (
    principal.organizationId === config.hubOrganizationId &&
    principal.userId === grant.installation.ownerUserId &&
    principal.role === "owner" &&
    input.profileId === config.profileId &&
    input.profileVersion === grant.installation.profileVersion &&
    input.nativeRequester.identityId === grant.identityId &&
    input.nativeRequester.workspaceId === config.linearOrganizationId
  );
}

async function authorizePilotStart(state: RuntimeState, ...[principal, input]: StartArguments) {
  const {
    pending,
    options: { config, runtime },
  } = state;
  const grant = pending.get(input.idempotencyKey);
  if (!state.accepting || !grant || !matchesStartGrant(config, grant, [principal, input]))
    return false;
  const current = await resolveLinearPilotInstallation(
    runtime,
    config,
    grant.installation.oauthClientId,
  );
  return (
    current?.connectionId === grant.installation.connectionId &&
    current.appUserId === grant.installation.appUserId &&
    current.ownerUserId === principal.userId &&
    current.profileVersion === input.profileVersion
  );
}

function configureSessionHooks(state: RuntimeState): LinearPilotSessionHooks {
  const { bindings, active, withSession, options } = state;
  return {
    authorizeStart: (...args) => authorizePilotStart(state, ...args),
    authorize(session, commandId, expectedBindingGeneration?: number) {
      return state.accepting
        ? authorizeBoundPilotTurn(
            bindings.find,
            active.get(session.id),
            session,
            commandId,
            expectedBindingGeneration,
          )
        : Promise.resolve(false);
    },
    async onTerminal(terminal) {
      const grant = active.get(terminal.sessionId);
      if (!grant || grant.commandId !== terminal.commandId) return;
      await withSession(grant.authority, grant.origin, async () => {
        if (!state.accepting || grant.stopping || active.get(grant.sessionId) !== grant) return;
        try {
          const writer = runtimeWriter(state, grant);
          if (terminal.status === "completed") {
            await writer.respond(
              grant.activity,
              "first-attempt",
              terminal.answer,
              options.scrubValues ?? [],
            );
          } else {
            await writer.error(grant.activity, "first-attempt");
          }
        } finally {
          active.delete(grant.sessionId);
        }
      });
    },
    ...(state.toolSteps === undefined ? {} : { toolSteps: state.toolSteps }),
  };
}

function resolveToolStepTurn(state: RuntimeState, scope: Parameters<ToolStepHook>[0]) {
  const grant = state.active.get(scope.sessionId);
  if (!state.accepting || !grant || grant.stopping) return undefined;
  if (grant.commandId !== scope.commandId) return undefined;
  if (grant.authority.organizationId !== scope.organizationId) return undefined;
  return { event: grant.activity, clientFor: () => clientFor(state, grant) };
}

async function readCompanionHandle(state: RuntimeState, provider: Provider) {
  const { config, runtime } = state.options;
  const installation = await resolveLinearPilotInstallation(
    runtime,
    config,
    provider.oauthClientId,
  );
  if (!installation) return undefined;
  const authorizeViewer = async (query: QueryHandle, operation: LinearAgentOperation) => {
    if (!state.accepting || operation.kind !== "viewer") return false;
    const current = await resolveLinearPilotInstallation(query, config, provider.oauthClientId);
    return (
      state.accepting &&
      current?.connectionId === installation.connectionId &&
      current.appUserId === installation.appUserId &&
      current.ownerUserId === installation.ownerUserId &&
      current.profileVersion === installation.profileVersion
    );
  };
  const client = provider.activityClient({
    binding: connectionBinding(installation),
    authorize: (_binding, operation) => authorizeViewer(runtime, operation),
    authorizeRefresh: (query, _binding, operation) => authorizeViewer(query, operation),
  });
  try {
    return (await client.readAppViewer(AbortSignal.timeout(2_000))).handle;
  } catch {
    return undefined;
  }
}

function trackJob(
  state: RuntimeState,
  work: Promise<void>,
  metadata: Pick<PilotFailure, "sessionId" | "operation">,
) {
  const job = work
    .catch((error: unknown) =>
      reportRuntimeFailure(state, {
        ...metadata,
        ...pilotExceptionFields(error),
      }),
    )
    .finally(() => state.jobs.delete(job));
  state.jobs.add(job);
}

function configureRegistration(state: RuntimeState): LinearPilotRegistration {
  const {
    options: { config, runtime },
  } = state;
  const nonOwner = createNonOwnerOrigin({
    config,
    database: runtime,
    locks: state.options.locks,
    accepting: () => state.accepting,
  });
  return {
    async offer(input, provider) {
      const sessions = state.coordinator;
      if (!state.accepting || !sessions) {
        logPilotRefusal("not_accepting", pilotDeliveryMetadata(input.payload));
        return false;
      }
      const refusal = await nonOwner.qualify(input, provider);
      if (state.accepting && refusal) {
        trackJob(state, nonOwner.reply(refusal), {
          sessionId: refusal.mention.nativeSessionId,
          operation: "created",
        });
        return true;
      }
      const qualified = await qualifyLinearPilotDelivery(
        runtime,
        config,
        provider.oauthClientId,
        input.payload,
      );
      if (!state.accepting || !qualified) return false;
      const dispatch = qualified.event.kind === "created" ? dispatchCreated : dispatchFollowUp;
      trackJob(
        state,
        dispatch(state, { qualified, provider, receivedAt: input.receivedAt, sessions }),
        {
          sessionId: qualified.event.nativeSessionId,
          operation: qualified.event.kind,
        },
      );
      return true;
    },
    async suppressComment(event, provider) {
      if (!state.accepting || !state.coordinator) return false;
      const decision = await classifyLinearPilotCompanionComment({
        config,
        workspaceId: event.organizationId,
        authorId: event.actor?.id,
        body: event.comment.body,
        resolveHandle: () => readCompanionHandle(state, provider),
      });
      return decision.suppress || ("ambiguous" in decision && decision.ambiguous);
    },
  };
}

export function createLinearPilotRuntime(options: Options) {
  const { database, runtime, locks } = options;
  const bindings = new PilotBindings(runtime, locks, database);
  const withSession = createPilotSessionSerialization();
  const pending: PendingStarts = new Map();
  const active = new Map<string, Active>();
  const jobs = new Set<Promise<void>>();
  const state: RuntimeState = {
    options,
    bindings,
    withSession,
    pending,
    active,
    jobs,
    accepting: true,
  };
  if (options.config.toolSteps === true) {
    state.toolSteps = createLinearPilotToolStepHook({
      resolve: (scope) => resolveToolStepTurn(state, scope),
      scrubValues: options.scrubValues,
    });
  }
  return {
    sessionHooks: configureSessionHooks(state),
    registration: configureRegistration(state),
    attachCoordinator(sessions: InteractiveSessionCoordinator) {
      state.coordinator = sessions;
    },
    async stop() {
      state.accepting = false;
      state.toolSteps?.closeAll();
      await Promise.allSettled(jobs);
    },
  };
}
