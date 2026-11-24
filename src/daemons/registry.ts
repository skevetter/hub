import { DaemonAgents, DaemonFrameNotSentError } from "./agents/index.js";
import { DaemonTerminals } from "./terminals/index.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { z } from "zod";
import type { Logger } from "pino";
import type { CompiledAgent } from "../config/compiler.js";
import type { Database, DaemonRecord } from "../db/types.js";
import { reportFailure, type FailureKind } from "../failures/index.js";
import { logger as defaultLogger } from "../logger.js";
import {
  HubExecutionAgentValidateRequestSchema,
  HubExecutionAgentValidateResponseSchema,
  GetProvidersSnapshotRequestSchema,
  GetProvidersSnapshotResponseSchema,
  RefreshProvidersSnapshotRequestSchema,
  RefreshProvidersSnapshotResponseSchema,
  HubExecutionOutboundSchema,
  HubDaemonHelloSchema,
  HubDaemonServerInfoEnvelopeSchema,
} from "../hub/protocol.js";
import { type DaemonConnection } from "./protocol.js";
import type { HubProviderSnapshot } from "../hub/protocol.js";

interface PendingAgentValidationRequest {
  kind: "agent-validation";
  generation: number;
  resolve(value: { valid: true } | { valid: false; issues: readonly AgentValidationIssue[] }): void;
  reject(error: Error): void;
}
interface PendingProviderSnapshotRequest {
  kind: "provider-snapshot";
  generation: number;
  resolve(value: HubProviderSnapshot): void;
  reject(error: Error): void;
}
interface PendingProviderRefreshRequest {
  kind: "provider-refresh";
  generation: number;
  resolve(): void;
  reject(error: Error): void;
}
interface AgentValidationIssue {
  path: readonly (string | number)[];
  message: string;
}
type PendingRequest =
  | PendingAgentValidationRequest
  | PendingProviderSnapshotRequest
  | PendingProviderRefreshRequest;
interface ActiveSocket {
  agents: DaemonAgents;
  terminals: DaemonTerminals;
  generation: number;
  socket: WebSocket;
  daemon: DaemonRecord;
  ready: boolean;
  presenceReady: Promise<void>;
  providerSnapshotSupported: boolean;
  acceptedAt: number;
  heartbeatExpired: boolean;
  stopHeartbeat: () => void;
}

export type DaemonSessionProtocol = "legacy" | "session-v1";

const DAEMON_SESSION_PROTOCOL_HEADER = "x-paseo-session-protocol";
const DAEMON_SESSION_PROTOCOL_VERSION = "1";
const PROVIDER_REQUEST_DEADLINE_MS = 20_000;
// Proxies such as Cloudflare drop a WebSocket that carries no frames for about 100 seconds, and
// daemons before 0.12.0 send no keepalive of their own. Protocol pings are answered by every
// daemon version without application support.
const DAEMON_PING_INTERVAL_MS = 30_000;
const DAEMON_PONG_TIMEOUT_MS = 90_000;
// Close reasons are peer-supplied text, so only reasons Hub itself sends are logged verbatim.
const LOGGED_CLOSE_REASONS: ReadonlySet<string> = new Set([
  "",
  "replaced",
  "revoked",
  "invalid daemon message",
  "daemon session permissions do not match enrollment",
  "server shutdown",
]);

type DaemonConnectedHandler = (daemon: DaemonRecord) => void | Promise<void>;
type DaemonDisconnectedHandler = (daemon: DaemonRecord) => void;
type DaemonRevokedHandler = (daemon: DaemonRecord) => void | Promise<void>;

export class ActiveDaemonRegistry {
  private readonly active = new Map<string, ActiveSocket>();
  private readonly pendingByDaemon = new Map<string, Map<string, PendingRequest>>();
  private readonly connectedHandlers = new Set<DaemonConnectedHandler>();
  private readonly disconnectedHandlers = new Set<DaemonDisconnectedHandler>();
  private readonly revokedHandlers = new Set<DaemonRevokedHandler>();
  private readonly presenceWrites = new Set<Promise<void>>();
  private generation = 0;

  constructor(
    private readonly database: Pick<Database, "setDaemonPresence" | "touchDaemon">,
    private readonly clock: DaemonClock = systemDaemonClock,
    private readonly failureLogger: Pick<Logger, "info" | "warn" | "error"> = defaultLogger,
  ) {}

  accept(
    daemon: DaemonRecord,
    socket: WebSocket,
    sessionProtocol: DaemonSessionProtocol = "session-v1",
  ): void {
    const previous = this.active.get(daemon.id);
    if (previous) this.rejectGeneration(daemon.id, previous.generation);
    const active = this.createActiveSocket(daemon, socket);
    this.active.set(daemon.id, active);
    previous?.agents.close();
    previous?.terminals.close();
    previous?.socket.close(4001, "replaced");
    socket.on("message", (data) => this.receive(active, readText(data)));
    socket.on("error", (error) => {
      // A peer that sends a malformed control frame (e.g. an invalid close
      // status code) makes the `ws` receiver emit `error` on this socket.
      // Node's EventEmitter rethrows unlistened `error` events as an
      // uncaught exception, which without this listener kills the whole
      // Hub process over one bad daemon connection. Report and let the
      // subsequent `close` event drive the normal offline-presence cleanup.
      this.report(error, "daemon.socket.error", daemon.id, "network");
    });
    socket.on("close", (code: number, reason: Buffer) => this.closed(active, code, reason));
    if (sessionProtocol === "legacy") this.markReady(active);
    else sendHello(daemon, socket);
  }

  private createActiveSocket(daemon: DaemonRecord, socket: WebSocket): ActiveSocket {
    const active: ActiveSocket = {
      agents: new DaemonAgents(
        (frame) => {
          if (socket.readyState !== WebSocket.OPEN) throw new DaemonFrameNotSentError();
          socket.send(frame);
        },
        () => this.clock.nowDate(),
        (error, operation) => this.report(error, operation, daemon.id),
      ),
      terminals: new DaemonTerminals((frame) => socket.send(frame)),
      generation: ++this.generation,
      socket,
      daemon,
      ready: false,
      presenceReady: Promise.resolve(),
      providerSnapshotSupported: false,
      acceptedAt: performance.now(),
      heartbeatExpired: false,
      stopHeartbeat: () => undefined,
    };
    active.stopHeartbeat = startHeartbeat(socket, () => {
      active.heartbeatExpired = true;
    });
    return active;
  }

  private closed(active: ActiveSocket, code: number, reason: Buffer): void {
    const daemonId = active.daemon.id;
    active.stopHeartbeat();
    this.logClose(active, code, reason);
    active.agents.close();
    active.terminals.close();
    if (this.active.get(daemonId)?.generation !== active.generation) return;
    this.active.delete(daemonId);
    this.rejectGeneration(daemonId, active.generation);
    const write = active.presenceReady.then(() =>
      this.database.setDaemonPresence(daemonId, "offline"),
    );
    this.presenceWrites.add(write);
    void write.then(
      () => this.presenceWrites.delete(write),
      (error: unknown) => {
        this.report(error, "daemon.presence.offline", daemonId);
      },
    );
    for (const handler of this.disconnectedHandlers) {
      this.observeHandler(() => handler(active.daemon), "daemon.disconnected.handler", daemonId);
    }
  }

  onConnected(handler: DaemonConnectedHandler): () => void {
    this.connectedHandlers.add(handler);
    return () => this.connectedHandlers.delete(handler);
  }

  onDisconnected(handler: DaemonDisconnectedHandler): () => void {
    this.disconnectedHandlers.add(handler);
    return () => this.disconnectedHandlers.delete(handler);
  }

  onRevoked(handler: DaemonRevokedHandler): () => void {
    this.revokedHandlers.add(handler);
    return () => this.revokedHandlers.delete(handler);
  }

  connection(daemonId: string): DaemonConnection | undefined {
    const active = this.active.get(daemonId);
    if (!active?.ready || !active.daemon.permissions.includes("hub.execute")) return undefined;
    return {
      agents: active.agents,
      history: active.agents,
      terminals: active.terminals,
      getProviderSnapshot: (options) => this.getProviderSnapshot(daemonId, options),
      refreshProviderSnapshot: (options) => this.refreshProviderSnapshot(daemonId, options),
      validateAgentConfiguration: (agent) => this.validateAgentConfiguration(daemonId, agent),
    };
  }

  validateAgentConfiguration(
    daemonId: string,
    agent: CompiledAgent,
  ): Promise<{ valid: true } | { valid: false; issues: readonly AgentValidationIssue[] }> {
    const active = this.active.get(daemonId);
    if (!active?.ready) return Promise.reject(new Error("daemon_not_connected"));
    if (!active.daemon.permissions.includes("hub.execute")) {
      return Promise.reject(new Error("daemon_execution_not_allowed"));
    }
    const requestId = randomUUID();
    const request = HubExecutionAgentValidateRequestSchema.parse({
      type: "hub.execution.agent.validate.request",
      requestId,
      provider: agent.provider,
      model: agent.model,
      modeId: agent.mode,
      thinkingOptionId: agent.thinkingOptionId,
      providerOptions: agent.options,
    });
    return new Promise((resolve, reject) => {
      this.pendingFor(daemonId).set(requestId, {
        kind: "agent-validation",
        generation: active.generation,
        resolve,
        reject,
      });
      active.socket.send(JSON.stringify({ type: "session", message: request }));
    });
  }

  updatePermissions(daemon: DaemonRecord): void {
    const active = this.active.get(daemon.id);
    if (active) active.daemon = daemon;
  }

  async revoke(daemon: DaemonRecord, persistRevocation: () => Promise<boolean>): Promise<void> {
    const previous = this.active.get(daemon.id);
    this.closeRevokedConnection(daemon.id);
    await persistRevocation();
    // A reconnect could have been admitted while the revocation was being persisted.
    if (this.active.get(daemon.id) !== previous) this.closeRevokedConnection(daemon.id);
    await Promise.all(Array.from(this.revokedHandlers, async (handler) => handler(daemon)));
  }

  private closeRevokedConnection(daemonId: string): void {
    const active = this.active.get(daemonId);
    if (active === undefined) return;
    active.ready = false;
    active.agents.close();
    active.terminals.close();
    active.socket.close(4403, "revoked");
  }

  async stop(): Promise<void> {
    const activeDaemons = Array.from(this.active.values());
    const sockets = activeDaemons.map((active) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      if (active.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return promise;
      }
      const cleanup = () => {
        clearTimeout(timer);
        active.socket.off("close", finish);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      let timer = setTimeout(() => {
        this.report(
          new Error("daemon socket close exceeded the shutdown deadline"),
          "daemon.socket.close",
          active.daemon.id,
          "network",
        );
        timer = setTimeout(() => {
          fail(new Error("daemon socket did not close after termination"));
        }, 1000);
        try {
          active.socket.terminate();
        } catch (error) {
          fail(error);
        }
      }, 1000);
      active.socket.once("close", finish);
      try {
        active.socket.close(1001, "server shutdown");
      } catch (error) {
        fail(error);
      }
      return promise;
    });
    await Promise.all(sockets);
    await Promise.all(this.presenceWrites);
    for (const [daemonId, pending] of this.pendingByDaemon) {
      for (const request of pending.values()) request.reject(new Error("daemon disconnected"));
      this.pendingByDaemon.delete(daemonId);
    }
  }

  private getProviderSnapshot(
    daemonId: string,
    options: { cwd?: string },
  ): Promise<HubProviderSnapshot> {
    const active = this.requireProviderSnapshotConnection(daemonId);
    const requestId = randomUUID();
    const request = GetProvidersSnapshotRequestSchema.parse({
      type: "get_providers_snapshot_request",
      requestId,
      cwd: options.cwd,
    });
    return this.sendProviderRequest<HubProviderSnapshot>(active, request, (settle) => ({
      kind: "provider-snapshot",
      ...settle,
    }));
  }

  private refreshProviderSnapshot(
    daemonId: string,
    options: { cwd?: string; providers?: string[] },
  ): Promise<void> {
    const active = this.requireProviderSnapshotConnection(daemonId);
    const requestId = randomUUID();
    const request = RefreshProvidersSnapshotRequestSchema.parse({
      type: "refresh_providers_snapshot_request",
      requestId,
      cwd: options.cwd,
      providers: options.providers,
    });
    return this.sendProviderRequest<void>(active, request, (settle) => ({
      kind: "provider-refresh",
      ...settle,
    }));
  }

  private sendProviderRequest<T>(
    active: ActiveSocket,
    request:
      | z.infer<typeof GetProvidersSnapshotRequestSchema>
      | z.infer<typeof RefreshProvidersSnapshotRequestSchema>,
    createPending: (settle: {
      generation: number;
      resolve: (value: T) => void;
      reject: (error: Error) => void;
    }) => PendingProviderSnapshotRequest | PendingProviderRefreshRequest,
  ): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const { requestId } = request;
    const requests = this.pendingFor(active.daemon.id);
    const timer = setTimeout(
      () => fail(Object.assign(new Error("daemon_provider_timeout"), { code: "timeout" })),
      PROVIDER_REQUEST_DEADLINE_MS,
    );
    timer.unref?.();
    function cleanup() {
      clearTimeout(timer);
      requests.delete(requestId);
    }
    function fail(error: unknown) {
      cleanup();
      reject(error);
    }
    requests.set(
      requestId,
      createPending({
        generation: active.generation,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: fail,
      }),
    );
    try {
      active.socket.send(JSON.stringify({ type: "session", message: request }));
    } catch (error) {
      fail(error);
    }
    return promise;
  }

  private requireProviderSnapshotConnection(daemonId: string): ActiveSocket {
    const active = this.active.get(daemonId);
    if (!active?.ready) throw new Error("daemon_not_connected");
    if (!active.providerSnapshotSupported) throw new Error("daemon_provider_snapshot_unsupported");
    return active;
  }

  private receive(active: ActiveSocket, raw: string): void {
    if (this.active.get(active.daemon.id)?.generation !== active.generation) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      this.report(error, "daemon.websocket.message.parse", active.daemon.id, "validation");
      active.socket.close(4400, "invalid daemon message");
      return;
    }
    if (active.agents.receive(value) || active.terminals.receive(value)) return;
    const serverInfo = HubDaemonServerInfoEnvelopeSchema.safeParse(value);
    if (serverInfo.success) {
      this.acceptServerInfo(
        active,
        serverInfo.data.message.payload.permissions,
        serverInfo.data.message.payload.features?.providersSnapshot === true,
      );
      return;
    }
    this.receiveExecutionMessage(active, value);
  }

  private receiveExecutionMessage(active: ActiveSocket, value: unknown): void {
    const envelope = HubExecutionOutboundSchema.safeParse(value);
    if (!envelope.success) return;
    const message = envelope.data.message;
    if (message.type === "rpc_error") return this.receiveRpcError(active, message.payload);
    const validated = HubExecutionAgentValidateResponseSchema.safeParse(message);
    if (validated.success) return this.receiveAgentValidation(active, validated.data);
    const providerSnapshot = GetProvidersSnapshotResponseSchema.safeParse(message);
    if (providerSnapshot.success)
      return this.receiveProviderSnapshot(active, providerSnapshot.data);
    const providerRefresh = RefreshProvidersSnapshotResponseSchema.safeParse(message);
    if (providerRefresh.success) return this.receiveProviderRefresh(active, providerRefresh.data);
  }

  private acceptServerInfo(
    active: ActiveSocket,
    permissions: readonly string[],
    providerSnapshotSupported = false,
  ): void {
    if (!samePermissions(permissions, active.daemon.permissions)) {
      active.socket.close(4403, "daemon session permissions do not match enrollment");
      return;
    }
    active.providerSnapshotSupported = providerSnapshotSupported;
    this.markReady(active);
  }

  private markReady(active: ActiveSocket): void {
    if (active.ready) return;
    active.ready = true;
    const write = Promise.all([
      this.database.touchDaemon(active.daemon.id),
      this.database.setDaemonPresence(active.daemon.id, "connected"),
    ]).then(
      () => undefined,
      (error: unknown) => this.report(error, "daemon.presence.connected", active.daemon.id),
    );
    active.presenceReady = write;
    this.presenceWrites.add(write);
    void write.then(() => {
      this.presenceWrites.delete(write);
      for (const handler of this.connectedHandlers) {
        this.observeHandler(
          () => handler(active.daemon),
          "daemon.connected.handler",
          active.daemon.id,
        );
      }
      return undefined;
    });
  }

  private logClose(active: ActiveSocket, code: number, reason: Buffer): void {
    const fields = {
      operation: "daemon.socket.closed",
      component: "daemons",
      daemonId: active.daemon.id,
      generation: active.generation,
      closeCode: code,
      closeReason: loggedCloseReason(reason),
      connectedMs: Math.round(performance.now() - active.acceptedAt),
    };
    if (active.heartbeatExpired) {
      this.failureLogger.warn(fields, "daemon socket closed after missed heartbeat");
    } else {
      this.failureLogger.info(fields, "daemon socket closed");
    }
  }

  private observeHandler(
    handler: () => void | Promise<void>,
    operation: string,
    daemonId: string,
    kind?: FailureKind,
  ): void {
    void Promise.resolve()
      .then(handler)
      .catch((error: unknown) => this.report(error, operation, daemonId, kind));
  }

  private report(error: unknown, operation: string, daemonId: string, kind?: FailureKind): void {
    reportFailure(
      error,
      { operation, component: "daemons", daemonId },
      { logger: this.failureLogger, ...(kind === undefined ? {} : { kind }) },
    );
  }

  private receiveAgentValidation(
    active: ActiveSocket,
    response: z.infer<typeof HubExecutionAgentValidateResponseSchema>,
  ): void {
    const requests = this.pendingFor(active.daemon.id);
    const pending = requests.get(response.payload.requestId);
    if (
      !pending ||
      pending.kind !== "agent-validation" ||
      pending.generation !== active.generation
    ) {
      return;
    }
    requests.delete(response.payload.requestId);
    if (response.payload.error !== null) {
      pending.reject(new Error(response.payload.error));
      return;
    }
    pending.resolve(
      response.payload.valid ? { valid: true } : { valid: false, issues: response.payload.issues },
    );
  }

  private receiveProviderSnapshot(
    active: ActiveSocket,
    response: z.infer<typeof GetProvidersSnapshotResponseSchema>,
  ): void {
    const requests = this.pendingFor(active.daemon.id);
    const pending = requests.get(response.payload.requestId);
    if (
      !pending ||
      pending.kind !== "provider-snapshot" ||
      pending.generation !== active.generation
    ) {
      return;
    }
    pending.resolve(response.payload);
  }

  private receiveProviderRefresh(
    active: ActiveSocket,
    response: z.infer<typeof RefreshProvidersSnapshotResponseSchema>,
  ): void {
    const requests = this.pendingFor(active.daemon.id);
    const pending = requests.get(response.payload.requestId);
    if (
      !pending ||
      pending.kind !== "provider-refresh" ||
      pending.generation !== active.generation
    ) {
      return;
    }
    if (!response.payload.acknowledged) {
      pending.reject(new Error("daemon provider refresh was not acknowledged"));
      return;
    }
    pending.resolve();
  }

  private receiveRpcError(
    active: ActiveSocket,
    payload: { requestId: string; error: string },
  ): void {
    const requests = this.pendingFor(active.daemon.id);
    const pending = requests.get(payload.requestId);
    if (pending?.generation !== active.generation) return;
    requests.delete(payload.requestId);
    pending.reject(new Error(payload.error));
  }

  private pendingFor(daemonId: string): Map<string, PendingRequest> {
    const existing = this.pendingByDaemon.get(daemonId);
    if (existing) return existing;
    const pending = new Map<string, PendingRequest>();
    this.pendingByDaemon.set(daemonId, pending);
    return pending;
  }

  private rejectGeneration(daemonId: string, generation: number): void {
    const pending = this.pendingFor(daemonId);
    for (const [requestId, request] of pending) {
      if (request.generation !== generation) continue;
      pending.delete(requestId);
      request.reject(new Error("daemon disconnected"));
    }
  }
}

function sendHello(daemon: DaemonRecord, socket: WebSocket): void {
  socket.send(
    JSON.stringify(
      HubDaemonHelloSchema.parse({
        type: "hello",
        clientId: `hub:${daemon.id}`,
        clientType: "hub",
        capabilities: { all_providers: true, selective_agent_timeline: true },
        protocolVersion: 1,
      }),
    ),
  );
}

function startHeartbeat(socket: WebSocket, onExpired: () => void): () => void {
  if (socket.readyState !== WebSocket.OPEN) return () => undefined;
  const pings = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, DAEMON_PING_INTERVAL_MS);
  const deadline = setTimeout(() => {
    clearInterval(pings);
    if (socket.readyState !== WebSocket.OPEN) return;
    onExpired();
    socket.terminate();
  }, DAEMON_PONG_TIMEOUT_MS);
  pings.unref?.();
  deadline.unref?.();
  const pong = () => deadline.refresh();
  socket.on("pong", pong);
  return () => {
    clearInterval(pings);
    clearTimeout(deadline);
    socket.off("pong", pong);
  };
}

function loggedCloseReason(reason: Buffer): string {
  const text = reason.toString("utf8");
  return LOGGED_CLOSE_REASONS.has(text) ? text : "unrecognized";
}

function samePermissions(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && expected.every((permission) => actual.includes(permission))
  );
}

export function createDaemonUpgradeHandler(
  database: Pick<Database, "findDaemonById">,
  registry: ActiveDaemonRegistry,
) {
  const server = new WebSocketServer({ noServer: true });
  server.on("headers", (headers, request) => {
    if (request.headers[DAEMON_SESSION_PROTOCOL_HEADER] === DAEMON_SESSION_PROTOCOL_VERSION) {
      headers.push(`${DAEMON_SESSION_PROTOCOL_HEADER}: ${DAEMON_SESSION_PROTOCOL_VERSION}`);
    }
  });
  return async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/daemons/socket") {
      socket.destroy();
      return;
    }
    const daemonId = request.headers["x-paseo-daemon-id"];
    const credential = bearer(request.headers.authorization);
    if (typeof daemonId !== "string" || !credential) return rejectUpgrade(socket, 401);
    const daemon = await database.findDaemonById(daemonId);
    if (
      !daemon ||
      daemon.status !== "active" ||
      !matchesVerifier(credential, daemon.credentialVerifier)
    )
      return rejectUpgrade(socket, 403);
    const sessionProtocol =
      request.headers[DAEMON_SESSION_PROTOCOL_HEADER] === DAEMON_SESSION_PROTOCOL_VERSION
        ? "session-v1"
        : "legacy";
    server.handleUpgrade(request, socket, head, (webSocket) =>
      registry.accept(daemon, webSocket, sessionProtocol),
    );
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
function matchesVerifier(value: string, verifier: string): boolean {
  const actual = Buffer.from(hash(value));
  const expected = Buffer.from(verifier);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function bearer(value: string | undefined): string | undefined {
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function readText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}

export interface DaemonClock {
  nowDate(): Date;
}

const systemDaemonClock: DaemonClock = {
  nowDate: () => new Date(),
};
