import {
  DaemonAgentError,
  type AgentConnection,
  type AgentEvent,
  type AgentSnapshot,
} from "../daemons/agents/index.js";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import type { DaemonRecord, Database } from "../db/types.js";
import type { EntitlementsService } from "../entitlements/service.js";
import type { TimelineScrubber } from "../run-timeline/capture-types.js";
import type { SessionEventBus } from "./bus.js";
import {
  LiveSessionTranscript,
  SessionTranscriptNormalizer,
  type RelayedTranscript,
} from "./normalize.js";
import type { InteractiveSessionSettings } from "./settings.js";
import {
  maxDeliveryAttempts,
  type AcceptCommandResult,
  type ApplySessionStateInput,
  type SettleCommandInput,
  type StartSessionInput,
  type StartSessionResult,
} from "./store.js";
import type {
  CommandStatus,
  Delivery,
  RefusalCode,
  SessionCommandRecord,
  SessionPrincipal,
  SessionRecord,
  SessionState,
} from "./types.js";

export type StartCommand = Pick<
  StartSessionInput,
  "profileId" | "profileVersion" | "message" | "participants" | "idempotencyKey"
>;
export interface ControlCommand {
  sessionId: string;
  generation: number;
  idempotencyKey: string;
}
export interface SendCommand extends ControlCommand {
  message: string;
  delivery: Delivery;
}
export interface RetryCommand extends ControlCommand {
  commandId: string;
}
export type CommandOutcome =
  | {
      outcome: "accepted";
      sessionId: string;
      commandId: string;
      status: CommandStatus;
      replayed: boolean;
    }
  | { outcome: "refused"; code: RefusalCode };

interface CoordinatorOptions {
  database: Database;
  entitlements: Pick<EntitlementsService, "meterReservation">;
  connectionForDaemon(daemonId: string): DaemonConnection | undefined;
  bus: SessionEventBus;
  settings: InteractiveSessionSettings;
  scrub?: TimelineScrubber;
  scrubValues?: readonly string[];
  shutdownTimeoutMs?: number;
  instanceId: string;
  now?: () => Date;
  bodyCutoff?: (now: Date) => Date | null;
  reportFailure(error: unknown, operation: string, scope?: object): void;
}

const LEASE_MS = 60_000;
const OFFLINE_STOP_GRACE_MS = 15_000;
const OPEN_STATES: readonly SessionState[] = [
  "starting",
  "running",
  "idle",
  "waiting_permission",
  "stopping",
  "failed",
];
type Lane = "message" | "control" | "observation" | "events";
type DispatchLane = "message" | "control";
interface Scope {
  sessionId: string;
  organizationId: string;
}
type Settlement = Pick<SettleCommandInput, "status" | "failureCode">;

interface Watch {
  agents: AgentConnection;
  transcript: LiveSessionTranscript;
  session: SessionRecord;
  unsubscribe?: () => void;
  turnId?: string | undefined;
  identifiedTurn?: number;
  ready?: Promise<void>;
}

interface DispatchTimer {
  timeout: NodeJS.Timeout;
  backoff: boolean;
}

interface Worker {
  scope: Scope;
  daemonId: string;
  watched?: Watch | undefined;
  lanes: Partial<Record<Lane, Promise<void>>>;
  timers: Partial<Record<DispatchLane, DispatchTimer>>;
  cursor: number;
  heldStop?: SessionCommandRecord | undefined;
  closing?: boolean;
  offlineStop?: NodeJS.Timeout | undefined;
}

export class InteractiveSessionCoordinator {
  private readonly database: Database;
  private readonly now: () => Date;
  private readonly workers = new Map<string, Worker>();
  private readonly daemonOrganizations = new Map<string, string>();
  private readonly disconnected = new Set<string>();
  private readonly revoked = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private accepting = true;
  private expired = false;
  private shutdown?: Promise<void>;
  private readonly transcript: SessionTranscriptNormalizer;

  constructor(private readonly options: CoordinatorOptions) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.transcript = new SessionTranscriptNormalizer(options.scrubValues, options.scrub);
  }

  start(principal: SessionPrincipal, input: StartCommand): Promise<CommandOutcome> {
    return this.intake(this.acceptStart(principal, input));
  }

  private async acceptStart(
    principal: SessionPrincipal,
    input: StartCommand,
  ): Promise<CommandOutcome> {
    if (!this.available()) return { outcome: "refused", code: "not_found" };
    const profile = await this.database.findSessionProfile(
      principal.organizationId,
      input.profileId,
    );
    if (profile?.status !== "active") return { outcome: "refused", code: "profile_unavailable" };
    if (profile.version !== input.profileVersion)
      return { outcome: "refused", code: "profile_changed" };
    const daemon = await this.database.findDaemonForOrganization(
      principal.organizationId,
      profile.daemonId,
    );
    if (
      daemon?.status !== "active" ||
      !daemon.permissions.includes("hub.execute") ||
      !this.agents(daemon.id)
    )
      return { outcome: "refused", code: "daemon_unavailable" };

    const usage = await this.options.entitlements.meterReservation(
      principal.organizationId,
      "executions.monthly",
    );
    const now = this.now();
    if (!this.available()) return { outcome: "refused", code: "not_found" };
    const result = await this.database.startInteractiveSession({
      ...input,
      principal,
      usage,
      now,
      bodyCutoff: this.bodyCutoff(now),
      maxActivePerDaemon: this.options.settings.maxActivePerDaemon,
    });
    return this.outcome(result, "message");
  }

  send(principal: SessionPrincipal, input: SendCommand): Promise<CommandOutcome> {
    return this.intake(this.acceptMessage(principal, input));
  }

  private async acceptMessage(
    principal: SessionPrincipal,
    input: SendCommand,
  ): Promise<CommandOutcome> {
    if (!this.available()) return { outcome: "refused", code: "not_found" };
    const usage = await this.options.entitlements.meterReservation(
      principal.organizationId,
      "executions.monthly",
    );
    const now = this.now();
    if (!this.available()) return { outcome: "refused", code: "not_found" };
    const result = await this.database.acceptInteractiveSessionCommand({
      ...input,
      principal,
      usage,
      now,
      bodyCutoff: this.bodyCutoff(now),
      kind: "message",
      maxQueued: this.options.settings.maxQueued,
    });
    return this.outcome(result, "message");
  }

  retry(principal: SessionPrincipal, input: RetryCommand): Promise<CommandOutcome> {
    return this.intake(this.acceptRetry(principal, input));
  }

  private async acceptRetry(
    principal: SessionPrincipal,
    input: RetryCommand,
  ): Promise<CommandOutcome> {
    if (!this.available()) return { outcome: "refused", code: "not_found" };
    const now = this.now();
    return this.outcome(
      await this.database.acceptInteractiveSessionCommand({
        ...input,
        principal,
        now,
        bodyCutoff: this.bodyCutoff(now),
        kind: "retry",
        maxQueued: this.options.settings.maxQueued,
      }),
      "message",
    );
  }

  stop(principal: SessionPrincipal, input: ControlCommand): Promise<CommandOutcome> {
    return this.intake(this.control(principal, input, "stop"));
  }

  close(principal: SessionPrincipal, input: ControlCommand): Promise<CommandOutcome> {
    return this.intake(this.control(principal, input, "close"));
  }

  replaceAgent(principal: SessionPrincipal, input: ControlCommand): Promise<CommandOutcome> {
    return this.intake(this.control(principal, input, "replace"));
  }

  private async control(
    principal: SessionPrincipal,
    input: ControlCommand,
    kind: "stop" | "close" | "replace",
  ): Promise<CommandOutcome> {
    if (!this.available()) return { outcome: "refused", code: "not_found" };
    const now = this.now();
    const result = await this.database.acceptInteractiveSessionCommand({
      ...input,
      principal,
      kind,
      now,
      bodyCutoff: this.bodyCutoff(now),
    });
    if (result.status === "accepted" && (kind === "close" || kind === "replace")) {
      const worker = this.worker(result.session, Math.max(0, result.session.hubSeq - 1));
      this.clearTimers(worker);
      this.dropWatch(worker);
      this.options.bus.clearAgentItems(result.session.id);
      if (kind === "close") worker.closing = true;
      else this.options.bus.publish(result.session.id, { kind: "resync" });
    }
    return this.outcome(result, "control");
  }

  private outcome(
    result: StartSessionResult | AcceptCommandResult,
    lane: DispatchLane,
  ): CommandOutcome {
    if (result.status === "refused") return { outcome: "refused", code: result.code };
    if (result.status !== "replayed") {
      const worker = this.worker(result.session, Math.max(0, result.session.hubSeq - 1));
      void this.publishEvents(worker);
      void this.dispatch(worker, lane);
    }
    return {
      outcome: "accepted",
      sessionId: result.session.id,
      commandId: result.command.id,
      status: result.command.status,
      replayed: result.status === "replayed",
    };
  }

  async begin(): Promise<void> {
    if (!this.available()) return;
    for (const organization of await this.database.listOrganizationsForOperator()) {
      const daemons = await this.database.listDaemonsForOrganization(organization.id);
      await Promise.all(
        daemons.map((daemon) => {
          this.daemonOrganizations.set(daemon.id, organization.id);
          return daemon.status === "revoked"
            ? this.daemonRevoked(daemon)
            : this.recoverDaemon(daemon);
        }),
      );
    }
  }

  async recoverDaemon(daemon: DaemonRecord): Promise<void> {
    if (
      !this.available() ||
      daemon.status !== "active" ||
      !daemon.permissions.includes("hub.execute") ||
      this.revoked.has(daemon.id)
    )
      return;
    this.disconnected.delete(daemon.id);
    const agents = this.agents(daemon.id);
    const recover = agents ? this.recover(daemon.id, agents) : this.recoverOfflineStops(daemon.id);
    await this.track(recover, "recover", { daemonId: daemon.id });
  }

  private async recoverOfflineStops(daemonId: string): Promise<void> {
    for (const session of await this.daemonSessions(daemonId)) {
      if (session.state === "stopping" && !this.agents(daemonId))
        this.scheduleOfflineStop(this.worker(session, session.hubSeq));
    }
  }

  private async recover(daemonId: string, agents: AgentConnection): Promise<void> {
    for (const session of await this.daemonSessions(daemonId)) {
      if (this.agents(daemonId) !== agents) return;
      if (session.state === "failed") continue;
      const worker = this.worker(session, session.hubSeq);
      this.clearTimers(worker);
      if (session.daemonAgentId) {
        await this.enqueue(worker, "observation", async () => {
          const current = await this.session(worker);
          if (!current?.daemonAgentId || current.state === "closed" || current.state === "failed")
            return;
          await this.inspect(worker, current, agents);
          const observed = await this.session(worker);
          if (
            observed?.state !== "failed" &&
            observed?.state !== "closed" &&
            observed?.daemonAgentId
          )
            await this.watch(worker, observed, agents);
        });
      }
      if (this.agents(daemonId) !== agents) return;
      this.options.bus.publish(session.id, { kind: "connection", online: true });
      this.options.bus.publish(session.id, { kind: "resync" });
      await this.dispatch(worker, "control", true);
      await this.dispatch(worker, "message", true);
    }
    for (const worker of this.workers.values()) {
      if (worker.daemonId === daemonId && worker.closing)
        await this.dispatch(worker, "control", true);
    }
  }

  daemonDisconnected(daemon: DaemonRecord): void {
    if (!this.available()) return;
    this.disconnected.add(daemon.id);
    for (const worker of this.workers.values()) {
      if (worker.daemonId !== daemon.id) continue;
      this.dropWatch(worker);
      this.clearTimers(worker);
      this.scheduleOfflineStop(worker);
    }
    void this.track(this.publishOffline(daemon.id), "disconnect", { daemonId: daemon.id });
  }

  private async publishOffline(daemonId: string): Promise<void> {
    for (const session of await this.daemonSessions(daemonId)) {
      if (!this.disconnected.has(daemonId)) return;
      this.options.bus.publish(session.id, { kind: "connection", online: false });
      this.options.bus.publish(session.id, { kind: "gap", reason: "daemon_disconnected" });
    }
  }

  async daemonRevoked(daemon: DaemonRecord): Promise<void> {
    if (!this.available()) return;
    this.revoked.add(daemon.id);
    this.daemonDisconnected(daemon);
    await this.track(this.failRevoked(daemon.id), "revoke", { daemonId: daemon.id });
  }

  private async failRevoked(daemonId: string): Promise<void> {
    for (const session of await this.daemonSessions(daemonId)) {
      const worker = this.worker(session, session.hubSeq);
      await this.enqueue(worker, "observation", async () => {
        let current = await this.session(worker);
        while (current && current.state !== "closed") {
          if (await this.transition(worker, current, OPEN_STATES, "failed", "daemon_revoked"))
            break;
          current = await this.session(worker);
        }
      });
    }
  }

  stopAccepting(): Promise<void> {
    this.shutdown ??= this.drain();
    return this.shutdown;
  }

  private async drain(): Promise<void> {
    this.accepting = false;
    for (const worker of this.workers.values()) {
      this.clearTimers(worker);
      this.dropWatch(worker);
    }
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        this.expired = true;
        this.reportFailure(
          new Error("Session coordinator shutdown deadline expired"),
          "shutdown",
          {},
        );
        resolve();
      }, this.options.shutdownTimeoutMs ?? 30_000);
    });
    try {
      await Promise.race([this.joinTasks(), deadline]);
    } finally {
      clearTimeout(timeout);
      this.workers.clear();
    }
  }

  private async joinTasks(): Promise<void> {
    while (!this.expired && this.tasks.size > 0) await Promise.all(this.tasks);
  }

  private available(): boolean {
    return this.accepting && this.options.settings.enabled;
  }

  private agents(daemonId: string): AgentConnection | undefined {
    if (!this.available() || this.disconnected.has(daemonId) || this.revoked.has(daemonId))
      return undefined;
    return this.options.connectionForDaemon(daemonId)?.agents;
  }

  private worker(session: SessionRecord, cursor: number): Worker {
    const existing = this.workers.get(session.id);
    if (existing) return existing;
    const { id: sessionId, organizationId, daemonId } = session;
    const worker: Worker = {
      scope: { sessionId, organizationId },
      daemonId,
      lanes: {},
      timers: {},
      cursor,
    };
    this.workers.set(sessionId, worker);
    this.daemonOrganizations.set(daemonId, organizationId);
    return worker;
  }

  private async daemonSessions(daemonId: string): Promise<SessionRecord[]> {
    const known = this.daemonOrganizations.get(daemonId);
    if (known) return this.database.listRecoverableInteractiveSessions(known, daemonId);
    for (const organization of await this.database.listOrganizationsForOperator()) {
      if (await this.database.findDaemonForOrganization(organization.id, daemonId)) {
        this.daemonOrganizations.set(daemonId, organization.id);
        return this.database.listRecoverableInteractiveSessions(organization.id, daemonId);
      }
    }
    return [];
  }

  private async session(worker: Worker): Promise<SessionRecord | undefined> {
    const { organizationId, sessionId } = worker.scope;
    return (await this.database.findInteractiveSession(organizationId, sessionId))?.session;
  }

  private bodyCutoff(now: Date): Date | null {
    return this.options.bodyCutoff?.(now) ?? null;
  }

  private enqueue(worker: Worker, lane: Lane, run: () => Promise<void>): Promise<void> {
    const next = this.track(
      (worker.lanes[lane] ?? Promise.resolve()).then(run),
      lane,
      worker.scope,
    );
    worker.lanes[lane] = next;
    void next.then(() => {
      if (worker.lanes[lane] === next) delete worker.lanes[lane];
      return undefined;
    });
    return next;
  }

  private track(task: Promise<void>, operation: string, scope: object): Promise<void> {
    const observed = task.catch((error: unknown) => {
      if (error instanceof DaemonResponseLostError) return;
      this.reportFailure(error, operation, scope);
    });
    this.tasks.add(observed);
    void observed.then(() => this.tasks.delete(observed));
    return observed;
  }

  private intake<T>(result: Promise<T>): Promise<T> {
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.tasks.add(completion);
    void completion.then(() => this.tasks.delete(completion));
    return result;
  }

  private reportFailure(error: unknown, operation: string, scope: object): void {
    try {
      this.options.reportFailure(error, "interactive_session." + operation, scope);
    } catch {}
  }

  private publishEvents(worker: Worker): Promise<void> {
    return this.enqueue(worker, "events", async () => {
      const { organizationId, sessionId } = worker.scope;
      while (true) {
        const events = await this.database.listInteractiveSessionEvents(
          organizationId,
          sessionId,
          worker.cursor,
          100,
        );
        for (const event of events) {
          this.options.bus.publish(sessionId, { kind: "hub", event });
          worker.cursor = event.seq;
        }
        if (events.length < 100) return;
      }
    });
  }

  private dispatch(worker: Worker, lane: DispatchLane, recovering = false): Promise<void> {
    return this.enqueue(worker, lane, async () => {
      if (!recovering && worker.timers[lane]?.backoff) return;
      const agents = this.agents(worker.daemonId);
      if (!agents) {
        if (lane === "control") this.scheduleOfflineStop(worker);
        return;
      }
      if (lane === "message") await this.dispatchMessages(worker, agents, recovering);
      else await this.dispatchControls(worker, agents, recovering);
    });
  }

  private scheduleDispatch(
    worker: Worker,
    lane: DispatchLane,
    delay: number,
    backoff = true,
  ): void {
    if (!this.agents(worker.daemonId) || (worker.timers[lane] && !backoff)) return;
    this.clearTimer(worker, lane);
    const timeout = setTimeout(() => {
      delete worker.timers[lane];
      if (lane === "control" && !backoff) worker.heldStop = undefined;
      void this.dispatch(worker, lane);
    }, delay).unref();
    worker.timers[lane] = { timeout, backoff };
  }

  private clearTimer(worker: Worker, lane: DispatchLane): void {
    clearTimeout(worker.timers[lane]?.timeout);
    delete worker.timers[lane];
  }

  private clearTimers(worker: Worker): void {
    clearTimeout(worker.offlineStop);
    worker.offlineStop = undefined;
    this.clearTimer(worker, "message");
    this.clearTimer(worker, "control");
  }

  private scheduleOfflineStop(worker: Worker): void {
    if (!this.available() || this.revoked.has(worker.daemonId) || worker.offlineStop) return;
    worker.offlineStop = setTimeout(() => {
      worker.offlineStop = undefined;
      void this.enqueue(worker, "control", async () => {
        if (!this.available() || this.agents(worker.daemonId)) return;
        if ((await this.session(worker))?.state !== "stopping") return;
        const command = await this.claim(worker, "control");
        if (command?.kind === "stop")
          await this.settle(worker, command, {
            status: "unknown",
            failureCode: "delivery_unconfirmed",
          });
      });
    }, OFFLINE_STOP_GRACE_MS).unref();
  }

  private claim(worker: Worker, lane: "message" | "control", agentIdle = false) {
    const now = this.now();
    return this.database.claimInteractiveSessionCommand({
      ...worker.scope,
      lane,
      owner: this.options.instanceId,
      leaseMs: LEASE_MS,
      agentIdle,
      now,
      bodyCutoff: this.bodyCutoff(now),
    });
  }

  private async settle(
    worker: Worker,
    command: SessionCommandRecord,
    settlement: Settlement,
  ): Promise<boolean> {
    if (this.expired) return false;
    const settled = await this.database.settleInteractiveSessionCommand({
      ...worker.scope,
      ...settlement,
      commandId: command.id,
      generation: command.generation,
      claimOwner: this.options.instanceId,
      attempts: command.attempts,
      now: this.now(),
    });
    if (!settled) {
      this.reportFailure(new Error("Session claim no longer current"), "settle", {
        commandId: command.id,
      });
    }
    await this.publishEvents(worker);
    if (
      settled &&
      command.kind === "replace" &&
      command.attempts >= maxDeliveryAttempts &&
      settlement.status === "unknown"
    ) {
      this.dropWatch(worker);
      this.clearTimers(worker);
      this.workers.delete(worker.scope.sessionId);
    }
    return settled;
  }

  private async dispatchMessages(
    worker: Worker,
    agents: AgentConnection,
    recovering: boolean,
  ): Promise<void> {
    while (this.agents(worker.daemonId) === agents) {
      const current = await this.session(worker);
      if (!canDispatchMessage(current) || (!current.daemonAgentId && current.generation > 1))
        return;

      const command = await this.claim(worker, "message", current.state === "idle");
      await this.publishEvents(worker);
      if (!command) {
        if (recovering) this.scheduleDispatch(worker, "message", LEASE_MS, false);
        return;
      }
      if (!(await this.dispatchMessage(worker, agents, command))) return;
    }
  }

  private async dispatchMessage(
    worker: Worker,
    agents: AgentConnection,
    command: SessionCommandRecord,
  ): Promise<boolean> {
    const session = await this.session(worker);
    if (!session || session.generation !== command.generation) return false;
    if (!canDispatchMessage(session)) {
      await this.retryMessage(worker, command);
      return false;
    }
    let bound: SessionRecord | undefined;
    try {
      bound = await this.ensureAgent(worker, session, agents);
      if (!bound) {
        await this.retryMessage(worker, command);
        return false;
      }
    } catch (error) {
      if (uncertain(error)) await this.retryMessage(worker, command);
      else {
        await this.settle(worker, command, { status: "failed", failureCode: "launch_failed" });
        const latest = await this.session(worker);
        if (latest?.generation === command.generation)
          await this.transition(worker, latest, ["starting"], "failed", "launch_failed");
      }
      return false;
    }
    try {
      await this.watch(worker, bound, agents);
    } catch (error) {
      this.reportFailure(error, "watch", worker.scope);
      await this.retryMessage(worker, command, uncertain(error) ? undefined : "daemon_rejected");
      return false;
    }
    const ready = await this.session(worker);
    if (
      !canDispatchMessage(ready) ||
      !ready.daemonAgentId ||
      ready.generation !== command.generation ||
      this.agents(worker.daemonId) !== agents
    ) {
      await this.retryMessage(worker, command);
      return false;
    }
    const settlement = await this.deliver(agents, ready.daemonAgentId, command);
    if (settlement.status === "unknown") {
      await this.retryMessage(worker, command);
      return false;
    }

    const dispatchState = ready.state;
    if (
      settlement.status === "delivered" &&
      (dispatchState === "starting" || dispatchState === "idle")
    ) {
      // Hold the claim until the store records the new turn, so another worker cannot drain the queue.
      await this.enqueue(worker, "observation", async () => {
        await this.transition(worker, ready, [dispatchState], "running");
      });
    }
    await this.settle(worker, command, settlement);
    return true;
  }

  private async retryMessage(
    worker: Worker,
    command: SessionCommandRecord,
    failureCode?: "daemon_rejected",
  ): Promise<void> {
    const settlement: Settlement = {
      status:
        failureCode === "daemon_rejected" && command.attempts >= maxDeliveryAttempts
          ? "failed"
          : "unknown",
      ...(failureCode ? { failureCode } : {}),
    };
    if (await this.settle(worker, command, settlement)) {
      if (command.attempts < maxDeliveryAttempts)
        this.scheduleDispatch(worker, "message", retryDelay(command));
      else void this.dispatch(worker, "message");
    }
  }

  private async deliver(
    agents: AgentConnection,
    agentId: string,
    command: SessionCommandRecord,
  ): Promise<Settlement> {
    if (command.body === null) return { status: "superseded" };
    try {
      await agents.send(agentId, command.id, command.body);
      return { status: "delivered" };
    } catch (error) {
      if (uncertain(error)) return { status: "unknown" };
      return {
        status: "failed",
        failureCode:
          error instanceof DaemonAgentError && error.code === "agent_request_key_conflict"
            ? "key_conflict"
            : "daemon_rejected",
      };
    }
  }

  private async ensureAgent(
    worker: Worker,
    session: SessionRecord,
    agents: AgentConnection,
  ): Promise<SessionRecord | undefined> {
    if (!session.daemonAgentId) {
      const { launch } = session;
      const agent = await agents.create("isession:" + session.id + ":" + session.generation, {
        provider: launch.provider,
        cwd: launch.cwd,
        env: {},
        title: session.title,
        background: false,
        ...(launch.worktree === null ? {} : { worktree: launch.worktree }),
        ...(launch.model === null ? {} : { model: launch.model }),
        ...(launch.mode === null ? {} : { mode: launch.mode }),
        ...(launch.thinkingOptionId === null ? {} : { thinkingOptionId: launch.thinkingOptionId }),
        providerOptions: launch.providerOptions,
      });
      if (this.agents(worker.daemonId) !== agents) return undefined;
      if (
        !(await this.database.bindInteractiveSessionAgent({
          ...worker.scope,
          generation: session.generation,
          agentId: agent.id,
          workspaceId: agent.workspaceId,
          now: this.now(),
        }))
      )
        return undefined;
      await this.publishEvents(worker);
      const bound = await this.session(worker);
      if (!bound || bound.generation !== session.generation || bound.daemonAgentId !== agent.id)
        return undefined;
      session = bound;
    }
    return session;
  }

  private async dispatchControls(
    worker: Worker,
    agents: AgentConnection,
    recovering: boolean,
  ): Promise<void> {
    let session = await this.session(worker);
    if (!session || session.state === "failed") return;
    let command = worker.heldStop;
    if (command && (session.state === "closed" || command.generation !== session.generation)) {
      worker.heldStop = undefined;
      command = undefined;
    }
    if (!command) {
      command = await this.claim(worker, "control");
      await this.publishEvents(worker);
    }
    if (!command) {
      if (worker.closing) {
        this.clearTimers(worker);
        this.workers.delete(worker.scope.sessionId);
      } else if (recovering) this.scheduleDispatch(worker, "control", LEASE_MS, false);
      return;
    }
    session = await this.session(worker);
    if (
      !session ||
      session.generation !== command.generation ||
      this.agents(worker.daemonId) !== agents
    )
      return;

    switch (command.kind) {
      case "replace":
        await this.dispatchReplacement(worker, agents, session, command);
        break;
      case "close":
        await this.dispatchClose(worker, agents, session, command);
        break;
      case "stop":
        await this.dispatchStop(worker, agents, session, command, recovering);
        break;
    }
  }

  private async dispatchClose(
    worker: Worker,
    agents: AgentConnection,
    session: SessionRecord,
    command: SessionCommandRecord,
  ): Promise<void> {
    let settlement: Settlement = { status: "done" };
    try {
      if (session.daemonAgentId && session.daemonWorkspaceId) {
        const snapshot = await agents.get(session.daemonAgentId);
        if (snapshot.status === "running" && !isArchived(snapshot))
          await agents.control(session.daemonAgentId, session.daemonWorkspaceId, "interrupt");
      }
    } catch (error) {
      if (!isMissingAgent(error)) settlement = controlFailure(error);
    }
    await this.settle(worker, command, settlement);
    if (settlement.status === "unknown" && command.attempts < maxDeliveryAttempts)
      this.scheduleDispatch(worker, "control", 1_000);
    else {
      this.clearTimers(worker);
      this.workers.delete(session.id);
    }
  }

  private async dispatchStop(
    worker: Worker,
    agents: AgentConnection,
    session: SessionRecord,
    command: SessionCommandRecord,
    recovering: boolean,
  ): Promise<void> {
    if (session.state === "idle") {
      await this.finishStop(worker, command);
      return;
    }
    if (session.state !== "stopping" || !session.daemonAgentId || !session.daemonWorkspaceId)
      return;
    if (worker.heldStop && !recovering) return;
    worker.heldStop = command;
    try {
      if (command.attempts > 1) {
        await this.inspect(worker, session, agents);
        if ((await this.session(worker))?.state !== "stopping") return;
      }
      await agents.control(session.daemonAgentId, session.daemonWorkspaceId, "interrupt");
      await this.inspect(worker, session, agents);
    } catch (error) {
      const current = await this.session(worker);
      if (
        current?.generation === session.generation &&
        current.turn === session.turn &&
        current.state === "idle"
      ) {
        await this.finishStop(worker, command);
        return;
      }
      await this.deferStop(worker, command, controlFailure(error));
      return;
    }
    if ((await this.session(worker))?.state === "idle") await this.finishStop(worker, command);
    else await this.deferStop(worker, command, { status: "unknown" });
  }

  private async deferStop(
    worker: Worker,
    command: SessionCommandRecord,
    failure: Settlement,
  ): Promise<void> {
    worker.heldStop = undefined;
    const retry = command.attempts < maxDeliveryAttempts;
    const settlement = retry ? { ...failure, status: "unknown" as const } : failure;
    if (!(await this.settle(worker, command, settlement)) || !retry) return;
    if (this.agents(worker.daemonId)) this.scheduleDispatch(worker, "control", retryDelay(command));
    else this.scheduleOfflineStop(worker);
  }

  private async finishStop(worker: Worker, command: SessionCommandRecord): Promise<void> {
    worker.heldStop = undefined;
    this.clearTimer(worker, "control");
    if (!(await this.settle(worker, command, { status: "done" })))
      void this.dispatch(worker, "control");
    void this.dispatch(worker, "message");
  }

  private async dispatchReplacement(
    worker: Worker,
    agents: AgentConnection,
    session: SessionRecord,
    command: SessionCommandRecord,
  ): Promise<void> {
    try {
      const bound = await this.ensureAgent(worker, session, agents);
      if (!bound) throw new DaemonResponseLostError();
      try {
        await this.watch(worker, bound, agents);
      } catch (error) {
        this.reportFailure(error, "watch", worker.scope);
      }
      if (await this.settle(worker, command, { status: "done" })) {
        await this.transition(worker, bound, ["starting"], "idle");
        void this.dispatch(worker, "message");
      }
    } catch (error) {
      if (uncertain(error)) {
        if (
          (await this.settle(worker, command, { status: "unknown" })) &&
          command.attempts < maxDeliveryAttempts
        )
          this.scheduleDispatch(worker, "control", retryDelay(command));
      } else {
        await this.settle(worker, command, { status: "failed", failureCode: "launch_failed" });
        await this.transition(worker, session, ["starting"], "failed", "launch_failed");
      }
    }
  }

  private async watch(
    worker: Worker,
    session: SessionRecord,
    agents: AgentConnection,
  ): Promise<void> {
    if (!session.daemonAgentId || this.agents(worker.daemonId) !== agents) return;
    const current = worker.watched;
    if (
      current?.agents === agents &&
      current.session.generation === session.generation &&
      current.session.daemonAgentId === session.daemonAgentId
    )
      return current.ready;
    this.dropWatch(worker);
    const watch: Watch = {
      agents,
      session,
      transcript: new LiveSessionTranscript(this.transcript),
    };
    worker.watched = watch;
    watch.ready = agents
      .watch(session.daemonAgentId, (event) => {
        if (worker.watched !== watch || this.agents(worker.daemonId) !== agents) return;
        this.watchEvent(worker, watch, event);
      })
      .then((unsubscribe) => {
        if (worker.watched === watch && this.agents(worker.daemonId) === agents)
          watch.unsubscribe = unsubscribe;
        else unsubscribe();
        return undefined;
      })
      .catch((error: unknown) => {
        if (worker.watched === watch) this.dropWatch(worker);
        throw error;
      });
    await watch.ready;
  }

  private dropWatch(worker: Worker): void {
    worker.watched?.unsubscribe?.();
    worker.watched = undefined;
  }

  private watchEvent(worker: Worker, watch: Watch, event: AgentEvent): void {
    if (event.type === "agent_stream" && event.agentId !== watch.session.daemonAgentId) return;
    if (event.type === "agent_stream" && event.event.type === "timeline") {
      const items = watch.transcript.accept(event);
      if (items.length)
        void this.enqueue(worker, "observation", async () =>
          this.publishTranscript(worker, watch, items),
        );
      return;
    }
    const observed = watch.session;
    const items =
      event.type === "agent_stream" && endsTurn(event.event.type)
        ? watch.transcript.finish(agentTurnId(event))
        : [];
    void this.enqueue(worker, "observation", async () => {
      if (items.length) {
        const persisted = await this.session(worker);
        if (
          persisted?.generation === observed.generation &&
          persisted.daemonAgentId === observed.daemonAgentId &&
          persisted.state !== "closed" &&
          persisted.state !== "failed"
        )
          this.publishTranscript(worker, watch, items);
      }
      await this.observe(worker, watch, event, observed);
    });
  }

  private publishTranscript(worker: Worker, watch: Watch, items: RelayedTranscript[]): void {
    if (worker.watched !== watch || this.agents(worker.daemonId) !== watch.agents) return;
    for (const item of items) {
      this.options.bus.publish(
        worker.scope.sessionId,
        "gap" in item ? { kind: "gap", reason: item.gap } : { kind: "agent", ...item },
      );
    }
  }

  private async observe(
    worker: Worker,
    watch: Watch,
    event: AgentEvent,
    observed: SessionRecord,
  ): Promise<void> {
    if (worker.watched !== watch || this.agents(worker.daemonId) !== watch.agents) return;
    const agentId = event.type === "agent_stream" ? event.agentId : event.agent.id;
    if (agentId !== watch.session.daemonAgentId) return;
    if (event.type !== "agent_stream") {
      if (event.type === "agent_snapshot" || isMissingSnapshot(event.agent))
        await this.observeSnapshot(worker, observed, event.agent);
      return;
    }
    const stream = event.event;
    const turnId = agentTurnId(event);
    if (stream.type === "turn_started") {
      await this.observeTurnStart(worker, watch, turnId);
      return;
    }
    if (
      turnId !== undefined &&
      watch.turnId !== undefined &&
      (turnId !== watch.turnId || watch.identifiedTurn !== watch.session.turn)
    )
      return;

    const current = watch.session;
    switch (stream.type) {
      case "turn_completed":
      case "turn_failed":
        await this.observeTurnEnd(worker, current, watch.agents);
        break;
      case "turn_canceled":
        await this.observeIdle(worker, current, true);
        break;
      case "permission_requested":
        await this.transition(worker, current, ["running"], "waiting_permission");
        break;
      case "permission_resolved":
        await this.transition(worker, current, ["waiting_permission"], "running");
        break;
    }
  }

  private async observeTurnStart(
    worker: Worker,
    watch: Watch,
    turnId: string | undefined,
  ): Promise<void> {
    if (turnId !== undefined && turnId === watch.turnId) return;
    const previous = watch.session;
    const replacement =
      turnId !== undefined && watch.turnId !== undefined && watch.identifiedTurn === previous.turn;
    const changed = await this.transition(
      worker,
      previous,
      replacement ? ["starting", "idle", "running"] : ["starting", "idle"],
      "running",
      undefined,
      replacement,
    );
    if (!changed) {
      const current = await this.session(worker);
      if (
        current?.generation === previous.generation &&
        current.daemonAgentId === previous.daemonAgentId &&
        current.state === "running"
      )
        watch.session = current;
    }
    if (turnId !== undefined) {
      watch.turnId = turnId;
      watch.identifiedTurn = watch.session.turn;
    }
  }

  private async observeTurnEnd(
    worker: Worker,
    current: SessionRecord,
    agents: AgentConnection,
  ): Promise<void> {
    if (await this.transition(worker, current, ["running", "waiting_permission"], "idle")) return;
    const stopping = await this.session(worker);
    if (
      stopping?.state === "stopping" &&
      stopping.generation === current.generation &&
      stopping.turn === current.turn &&
      stopping.daemonAgentId === current.daemonAgentId
    )
      await this.inspect(worker, stopping, agents);
  }

  private async inspect(
    worker: Worker,
    session: SessionRecord,
    agents: AgentConnection,
  ): Promise<void> {
    if (!session.daemonAgentId) return;
    let snapshot: AgentSnapshot;
    try {
      snapshot = await agents.get(session.daemonAgentId);
    } catch (error) {
      if (!isMissingAgent(error)) throw error;
      if (this.agents(worker.daemonId) === agents)
        await this.transition(worker, session, OPEN_STATES, "failed", "agent_missing");
      return;
    }
    if (this.agents(worker.daemonId) === agents && snapshot.id === session.daemonAgentId)
      await this.observeSnapshot(worker, session, snapshot);
  }

  private async observeSnapshot(
    worker: Worker,
    session: SessionRecord,
    snapshot: AgentSnapshot,
  ): Promise<void> {
    if (isMissingSnapshot(snapshot)) {
      await this.transition(worker, session, OPEN_STATES, "failed", "agent_missing");
    } else if (snapshot.status === "idle") {
      await this.observeIdle(worker, session, true);
    } else if (snapshot.status === "running") {
      await this.transition(worker, session, ["starting", "idle"], "running");
    } else if (snapshot.status === "error") {
      await this.transition(worker, session, ["running", "waiting_permission"], "idle");
    }
  }

  private async observeIdle(
    worker: Worker,
    session: SessionRecord,
    stopEvidence: boolean,
  ): Promise<void> {
    if (stopEvidence) {
      const stopped = await this.transition(
        worker,
        session,
        ["stopping"],
        "idle",
        "stopped_by_person",
      );
      if (stopped) {
        this.clearTimer(worker, "control");
        void this.dispatch(worker, "control");
        return;
      }
    }
    await this.transition(worker, session, ["running", "waiting_permission"], "idle");
  }

  private async transition(
    worker: Worker,
    session: SessionRecord,
    from: readonly SessionState[],
    to: ApplySessionStateInput["to"],
    reason?: ApplySessionStateInput["reason"],
    beginsTurn = false,
  ): Promise<SessionRecord | undefined> {
    if (this.expired) return undefined;
    const next = await this.database.applyInteractiveSessionState({
      ...worker.scope,
      generation: session.generation,
      turn: session.turn,
      agentId: session.daemonAgentId,
      from,
      to,
      now: this.now(),
      ...(reason ? { reason } : {}),
      ...(beginsTurn ? { beginsTurn: true } : {}),
    });
    if (!next) return undefined;
    if (
      worker.watched?.session.generation === next.generation &&
      worker.watched.session.daemonAgentId === next.daemonAgentId
    )
      worker.watched.session = next;
    await this.publishEvents(worker);
    if (next.state === "failed") {
      this.dropWatch(worker);
      this.clearTimers(worker);
      this.workers.delete(next.id);
    }
    if (next.state === "idle" && reason !== "stopped_by_person")
      void this.dispatch(worker, "message");
    if (session.state === "waiting_permission" && next.state === "running") {
      void this.dispatch(worker, "message");
    }
    return next;
  }
}

function canDispatchMessage(session: SessionRecord | undefined): session is SessionRecord {
  return (
    session !== undefined &&
    session.state !== "closed" &&
    session.state !== "failed" &&
    session.state !== "stopping" &&
    session.state !== "waiting_permission"
  );
}

function controlFailure(error: unknown): Settlement {
  return uncertain(error)
    ? { status: "unknown" }
    : { status: "failed", failureCode: "daemon_rejected" };
}

function isArchived(agent: AgentSnapshot): boolean {
  return agent.archivedAt !== undefined && agent.archivedAt !== null;
}

function isMissingSnapshot(agent: AgentSnapshot): boolean {
  return isArchived(agent) || agent.status === "closed";
}

function isMissingAgent(error: unknown): boolean {
  return (
    error instanceof DaemonAgentError &&
    (error.code === "agent_not_found" ||
      error.message.startsWith("Continuation agent was deleted;"))
  );
}

function uncertain(error: unknown): boolean {
  return (
    error instanceof DaemonResponseLostError ||
    (error instanceof DaemonAgentError && error.code === "agent_request_outcome_unknown")
  );
}

function retryDelay(command: SessionCommandRecord): number {
  return 1_000 * 2 ** (command.attempts - 1);
}

function endsTurn(type: string): boolean {
  return type === "turn_completed" || type === "turn_canceled" || type === "turn_failed";
}

function agentTurnId(event: Extract<AgentEvent, { type: "agent_stream" }>): string | undefined {
  const turnId = event.event["turnId"];
  return typeof turnId === "string" ? turnId : undefined;
}
