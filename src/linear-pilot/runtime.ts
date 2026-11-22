import type { Database } from "../db/types.js";
import type { DatabaseRuntime, QueryHandle } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import { validMessage } from "../interactive-sessions/store.js";
import type { InteractiveSessionCoordinator } from "../interactive-sessions/coordinator.js";
import type { SessionRecord } from "../interactive-sessions/types.js";
import type { LinearAgentOperation } from "../providers/linear/agent.js";
import type { LinearPilotRegistration } from "../providers/linear/index.js";
import type { SurfaceBinding } from "../surfaces/store.js";
import {
  createLinearPilotActivities,
  pilotActivityIds,
  type LinearPilotAcceptedEvent,
} from "./activities.js";
import { recordLinearPilotAdmission } from "./admission-receipt.js";
import { PilotBindings, type PilotAuthority, type PilotNativeOrigin } from "./binding.js";
import type { LinearPilotConfig } from "./config.js";
import { qualifyLinearPilotDelivery, resolveLinearPilotInstallation } from "./installation.js";
import { classifyLinearPilotCompanionComment } from "./intake.js";
import { adaptSignedPilotFollowUp } from "./follow-up-event.js";
import {
  createPilotFollowUp,
  pilotExceptionCode,
  type PilotConversation,
  type PilotFailure,
  type PilotTurn,
} from "./follow-up.js";
import type { PilotHistoryScope } from "./history-read.js";
import { createPilotSessionSerialization } from "./session-serialization.js";
import type { LinearPilotSessionHooks } from "./session.js";
import {
  authorizeBoundPilotTurn,
  authorizePilotTurnRefresh,
  type PilotTurnGrant,
} from "./turn-authority.js";

type Qualified = NonNullable<Awaited<ReturnType<typeof qualifyLinearPilotDelivery>>>;
type Provider = Parameters<LinearPilotRegistration["offer"]>[1];

interface Options {
  config: LinearPilotConfig;
  database: Database;
  runtime: DatabaseRuntime;
  locks: Locks;
  scrubValues?: readonly string[];
  reportFailure?(failure: PilotFailure): void;
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

export function createLinearPilotRuntime(options: Options) {
  const { config, database, runtime, locks } = options;
  const bindings = new PilotBindings(runtime, locks, database);
  const withSession = createPilotSessionSerialization();
  const pending = new Map<
    string,
    { installation: Qualified["installation"]; identityId: string }
  >();
  const active = new Map<string, Active>();
  const jobs = new Set<Promise<void>>();
  let coordinator: InteractiveSessionCoordinator | undefined;
  let accepting = true;

  function reportFailure(failure: PilotFailure): void {
    try {
      options.reportFailure?.(failure);
    } catch {}
  }

  function eventScope({ event, installation }: Qualified) {
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
    { event, installation }: Qualified,
    kind: LinearPilotAcceptedEvent["kind"],
    interactionId: string,
    receivedAt: Date,
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

  async function dispatchCreated(
    qualified: Qualified,
    provider: Provider,
    receivedAt: Date,
    sessions: InteractiveSessionCoordinator,
  ) {
    const { event, installation } = qualified;
    const { message, nativeSessionId } = event;
    if (!message || !validMessage(message)) return;
    const { authority, origin, principal } = eventScope(qualified);
    const report = (code: PilotFailure["code"]) =>
      reportFailure({ sessionId: nativeSessionId, code });
    await withSession(authority, origin, async () => {
      const now = new Date();
      if (!accepting || now.getTime() - receivedAt.getTime() >= 10_000) return;
      const prior = await bindings.find(authority, origin);
      if (prior.status === "refused") return report(prior.reason);
      if (prior.status !== "none") return;
      const admitted = await recordLinearPilotAdmission(runtime, {
        ...installation,
        profileId: config.profileId,
        kind: "created",
        humanId: event.humanId,
        nativeSessionId,
        receivedAt,
      });
      if (!admitted) return;
      const identity = await bindings.mapIdentity(authority, "Linear pilot owner", now);
      if (identity.status === "refused") return report(identity.reason);
      pending.set(nativeSessionId, { installation, identityId: identity.identity.id });
      try {
        const start = await sessions.startLinearPilot(principal, {
          profileId: config.profileId,
          profileVersion: installation.profileVersion,
          idempotencyKey: nativeSessionId,
          message,
          nativeRequester: {
            identityId: identity.identity.id,
            workspaceId: installation.workspaceId,
          },
        });
        if (start.outcome === "refused") return report(start.code);
        if (start.replayed) return;
        const binding = await bindings.admit(authority, {
          ...origin,
          sessionId: start.sessionId,
          now,
        });
        if (binding.status === "refused") return report(binding.reason);
        if (binding.status !== "created") return;
        const activity = acceptedActivity(qualified, "created", nativeSessionId, receivedAt);
        const grant: Active = {
          authority,
          origin,
          activity,
          provider,
          sessionId: start.sessionId,
          commandId: start.commandId,
          bindingGeneration: binding.binding.generation,
          profileVersion: installation.profileVersion,
        };
        active.set(grant.sessionId, grant);
        const writer = writerFor(grant);
        const ack = await writer.acknowledge(activity, "first-attempt");
        if (ack.disposition !== "confirmed" || !accepting) {
          active.delete(grant.sessionId);
          return;
        }
        await sessions.dispatchLinearPilotStart({
          organizationId: installation.organizationId,
          sessionId: grant.sessionId,
          commandId: grant.commandId,
        });
      } finally {
        pending.delete(nativeSessionId);
      }
    });
  }

  function clientFor(grant: Active, activity = grant.activity) {
    const permitsOperation = (operation: Readonly<LinearAgentOperation>) =>
      accepting &&
      "sessionId" in operation &&
      operation.sessionId === activity.nativeSessionId &&
      (!("issueId" in operation) || operation.issueId === grant.origin.issueId) &&
      operation.kind !== "addHubUrl";
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
        accepting,
    });
  }

  function writerFor(grant: Active) {
    return createLinearPilotActivities({
      clientFor(activity) {
        const client = clientFor(grant, activity);
        const trace = <T>(request: Promise<T>) =>
          request.catch((error: unknown) => {
            reportFailure({ sessionId: activity.nativeSessionId, code: pilotExceptionCode(error) });
            throw error;
          });
        return {
          createActivity: (input, signal) => trace(client.createActivity(input, signal)),
          isActivityConfirmed: (input, signal) => trace(client.isActivityConfirmed(input, signal)),
        };
      },
    });
  }

  async function boundLiveSession(
    qualified: Qualified,
    provider: Provider,
    receivedAt: Date,
    authority: PilotAuthority,
    origin: PilotNativeOrigin,
  ): Promise<BoundLiveSession | undefined> {
    const found = await bindings.find(authority, origin);
    if (found.status === "refused") {
      reportFailure({ sessionId: origin.nativeSessionId, code: found.reason });
    }
    if (found.status !== "bound") return undefined;
    const { binding } = found;
    const stored = await database.findInteractiveSession(
      authority.organizationId,
      binding.sessionId,
    );
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
      activity: acceptedActivity(qualified, kind, session.startIdempotencyKey, receivedAt),
      sessionId: session.id,
      commandId: first.id,
      bindingGeneration: binding.generation,
      profileVersion: session.profileVersion,
    };
    if (
      !(await authorizeBoundPilotTurn(bindings.find, grant, session, first.id, binding.generation))
    )
      return undefined;
    return { binding, session, grant };
  }

  async function dispatchFollowUp(
    qualified: Qualified,
    provider: Provider,
    receivedAt: Date,
    sessions: InteractiveSessionCoordinator,
  ) {
    const { event, installation } = qualified;
    const { kind } = event;
    if (kind === "created") return;
    const signed = adaptSignedPilotFollowUp(event, installation);
    if (!signed) return;
    const { authority, origin, principal } = eventScope(qualified);
    const scope: PilotConversation = {
      organizationId: authority.organizationId,
      workspaceId: authority.workspaceId,
      applicationId: authority.applicationId,
      appUserId: authority.appUserId,
      nativeSessionId: origin.nativeSessionId,
      connectionId: authority.connectionId,
      issueId: origin.issueId,
      teamId: origin.teamId,
      ownerId: config.allowedHumanId,
    };
    const history: PilotHistoryScope = {
      sessionId: origin.nativeSessionId,
      issueId: origin.issueId,
      appUserId: authority.appUserId,
      allowedHumanProviderUserId: config.allowedHumanId,
    };
    let current: BoundLiveSession | undefined;
    const report = (code: PilotFailure["code"]) =>
      reportFailure({ sessionId: origin.nativeSessionId, code });
    const run = createPilotFollowUp({
      withSession: (_scope, operation) => withSession(authority, origin, operation),
      activityIds: pilotActivityIds,
      reportFailure,
      current: async (): Promise<PilotTurn | undefined> => {
        if (!accepting) return undefined;
        current = await boundLiveSession(qualified, provider, receivedAt, authority, origin);
        if (!current) return undefined;
        const { binding, session, grant } = current;
        const live = active.get(session.id);
        const target =
          live &&
          (await sessions.activeLinearPilotTurn({
            organizationId: session.organizationId,
            sessionId: session.id,
            commandId: grant.commandId,
          }));
        const busy =
          live &&
          !live.stopping &&
          (session.state === "running" ||
            session.state === "waiting_permission" ||
            session.state === "idle");
        const done = !live && session.state === "idle" && session.daemonAgentId !== null;
        let state: PilotTurn["state"] = "fenced";
        if (busy) state = "busy";
        else if (done) state = "complete";
        return {
          ...scope,
          generation: binding.generation,
          policyRevision: binding.policyRevision,
          hubSessionId: session.id,
          profileId: session.profileId,
          profileVersion: session.profileVersion,
          state,
          preceding: done
            ? {
                activityId: session.startIdempotencyKey,
                kind: session.stateReason === "stopped_by_person" ? "stop" : "answer",
              }
            : null,
          agentId: target?.agentId ?? session.daemonAgentId,
          daemonTurnId: target?.daemonTurnId ?? null,
          ...(target?.startedAt ? { startedAt: target.startedAt } : {}),
        };
      },
      claim: async ({ activityId }) => {
        const admitted = await recordLinearPilotAdmission(runtime, {
          ...installation,
          profileId: config.profileId,
          kind,
          humanId: event.humanId,
          nativeSessionId: origin.nativeSessionId,
          activityId,
          receivedAt,
        });
        return admitted ? "claimed" : "duplicate";
      },
      appendBusy: async ({ activityId }) => {
        if (!current) return false;
        const activity = acceptedActivity(qualified, "prompted", activityId, receivedAt);
        return (
          (await writerFor(current.grant).busy(activity, "first-attempt")).disposition ===
          "confirmed"
        );
      },
      readPrompt: async (_scope, expected) =>
        current && clientFor(current.grant).readPilotPrompt(history, expected),
      readHistory: async (_scope, anchor) =>
        current && clientFor(current.grant).readPilotHistory(history, anchor.createdAt),
      secrets: async () => options.scrubValues ?? [],
      reserve: async ({ activityId }) => {
        const prior = current;
        if (!prior || !accepting) return undefined;
        const { binding, session, grant } = prior;
        const { daemonAgentId, requesterIdentityId } = session;
        if (!daemonAgentId || !requesterIdentityId || pending.has(activityId)) return undefined;
        active.set(session.id, grant);
        try {
          const retired = await sessions.retireLinearPilotTurn(principal, {
            organizationId: session.organizationId,
            sessionId: session.id,
            commandId: grant.commandId,
            profileId: session.profileId,
            workspaceId: scope.workspaceId,
            generation: session.generation,
            hubTurn: session.turn,
            agentId: daemonAgentId,
            expectedBindingGeneration: binding.generation,
          });
          if (!retired) {
            report("retirement_refused");
            return undefined;
          }
        } finally {
          active.delete(session.id);
        }
        pending.set(activityId, { installation, identityId: requesterIdentityId });
        try {
          const start = await sessions.reserveLinearPilotFreshStart(principal, {
            profileId: session.profileId,
            profileVersion: session.profileVersion,
            idempotencyKey: activityId,
            nativeRequester: { identityId: requesterIdentityId, workspaceId: scope.workspaceId },
          });
          if (start.outcome === "refused") {
            report(start.code);
            return undefined;
          }
          if (start.replayed) return undefined;
          const switched = await bindings.advance(authority, {
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
            provider,
            activity: acceptedActivity(qualified, "prompted", activityId, receivedAt),
            sessionId: start.sessionId,
            commandId: start.commandId,
            bindingGeneration: switched.binding.generation,
            profileVersion: session.profileVersion,
          });
          return {
            hubSessionId: start.sessionId,
            generation: switched.binding.generation,
            dispatchInitial: async (message) => {
              const outcome = await start.dispatch(message);
              if (outcome !== "started") {
                active.delete(start.sessionId);
                report(outcome);
              }
              return outcome;
            },
          };
        } finally {
          pending.delete(activityId);
        }
      },
      stopCurrent: async ({ turn, requestedAt }) => {
        const prior = current;
        if (!prior || !turn.agentId || !turn.daemonTurnId || !accepting) return "ignored";
        const { session, grant } = prior;
        grant.stopping = true;
        try {
          const stopped = await sessions.stopLinearPilot({
            organizationId: session.organizationId,
            sessionId: session.id,
            commandId: grant.commandId,
            expectedAgentId: turn.agentId,
            expectedDaemonTurnId: turn.daemonTurnId,
            expectedBindingGeneration: turn.generation,
            requestedAt,
          });
          const activity = acceptedActivity(
            qualified,
            "stop",
            session.startIdempotencyKey,
            receivedAt,
          );
          const confirmed = stopped.status === "stopped";
          await writerFor(grant).stop(
            activity,
            "first-attempt",
            confirmed ? "confirmed" : "unconfirmed",
          );
          return confirmed ? "stopped" : "unconfirmed";
        } finally {
          active.delete(session.id);
        }
      },
    });
    await run(scope, signed);
  }

  const sessionHooks: LinearPilotSessionHooks = {
    async authorizeStart(principal, input) {
      const grant = pending.get(input.idempotencyKey);
      if (
        !accepting ||
        !grant ||
        principal.organizationId !== config.hubOrganizationId ||
        principal.userId !== grant.installation.ownerUserId ||
        principal.role !== "owner" ||
        input.profileId !== config.profileId ||
        input.profileVersion !== grant.installation.profileVersion ||
        input.nativeRequester.identityId !== grant.identityId ||
        input.nativeRequester.workspaceId !== config.linearOrganizationId
      )
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
    },
    authorize(session, commandId, expectedBindingGeneration?: number) {
      return accepting
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
        if (!accepting || grant.stopping || active.get(grant.sessionId) !== grant) return;
        try {
          const writer = writerFor(grant);
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
  };

  const registration: LinearPilotRegistration = {
    async offer(input, provider) {
      const sessions = coordinator;
      if (!accepting || !sessions) return false;
      const qualified = await qualifyLinearPilotDelivery(
        runtime,
        config,
        provider.oauthClientId,
        input.payload,
      );
      if (!accepting || !qualified) return false;
      const dispatch = qualified.event.kind === "created" ? dispatchCreated : dispatchFollowUp;
      const job = dispatch(qualified, provider, input.receivedAt, sessions)
        .catch((error: unknown) =>
          reportFailure({
            sessionId: qualified.event.nativeSessionId,
            code: pilotExceptionCode(error),
          }),
        )
        .finally(() => jobs.delete(job));
      jobs.add(job);
      return true;
    },
    async suppressComment(event, provider) {
      if (!accepting || !coordinator) return false;
      const decision = await classifyLinearPilotCompanionComment({
        config,
        workspaceId: event.organizationId,
        authorId: event.actor?.id,
        body: event.comment.body,
        resolveHandle: async () => {
          const installation = await resolveLinearPilotInstallation(
            runtime,
            config,
            provider.oauthClientId,
          );
          if (!installation) return undefined;
          const authorizeViewer = async (query: QueryHandle, operation: LinearAgentOperation) => {
            if (!accepting || operation.kind !== "viewer") return false;
            const current = await resolveLinearPilotInstallation(
              query,
              config,
              provider.oauthClientId,
            );
            return (
              accepting &&
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
        },
      });
      return decision.suppress || ("ambiguous" in decision && decision.ambiguous);
    },
  };

  return {
    sessionHooks,
    registration,
    attachCoordinator(sessions: InteractiveSessionCoordinator) {
      coordinator = sessions;
    },
    async stop() {
      accepting = false;
      await Promise.allSettled(jobs);
    },
  };
}
