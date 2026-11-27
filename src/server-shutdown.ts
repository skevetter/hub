import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { logger as defaultLogger } from "./logger.js";
import { reportFailure } from "./failures/index.js";
import { beginHttpShutdown } from "./http/node-server.js";

export interface ShutdownBudgets {
  graceMs: number;
  hardExitMs: number;
}

export function readShutdownBudgets(
  environment: Readonly<Record<string, string | undefined>>,
): ShutdownBudgets {
  const graceMs = readBudget(environment, {
    name: "PASEO_HUB_SHUTDOWN_GRACE_MS",
    fallback: 10_000,
    minimum: 1_000,
    maximum: 40_000,
  });
  const hardExitMs = readBudget(environment, {
    name: "PASEO_HUB_SHUTDOWN_HARD_EXIT_MS",
    fallback: 15_000,
    minimum: 1_001,
    maximum: 44_000,
  });
  if (hardExitMs <= graceMs) {
    throw new Error("PASEO_HUB_SHUTDOWN_HARD_EXIT_MS must exceed PASEO_HUB_SHUTDOWN_GRACE_MS");
  }
  return { graceMs, hardExitMs };
}

type ShutdownLogger = Pick<Logger, "info" | "warn" | "error">;
type Stage = (name: string, action: () => Promise<void>) => Promise<void>;

interface ShutdownOptions extends ShutdownBudgets {
  logger?: ShutdownLogger;
  beginShutdown?: () => Promise<void>;
  exit: (code: number) => void;
}

interface Connections {
  sockets: Set<Socket>;
  upgrades: Set<Duplex>;
  release: () => void;
}

interface ShutdownContext {
  server: Server;
  stopRuntime: () => Promise<void>;
  options: ShutdownOptions;
  connections: Connections;
}

interface Deadlines {
  state: { expired: boolean; hardExited: boolean };
  clear: () => void;
}

export function createServerShutdown(
  server: Server,
  stopRuntime: () => Promise<void>,
  options: ShutdownOptions,
): () => Promise<boolean> {
  const connections = trackConnections(server);
  let shutdown: Promise<boolean> | undefined;
  return () => {
    shutdown ??= runShutdown({ server, stopRuntime, options, connections });
    return shutdown;
  };
}

function trackConnections(server: Server): Connections {
  const sockets = new Set<Socket>();
  const upgrades = new Set<Duplex>();
  const trackUpgrade = (_request: IncomingMessage, socket: Duplex) => {
    upgrades.add(socket);
    socket.once("close", () => upgrades.delete(socket));
  };
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", trackSocket);
  server.on("upgrade", trackUpgrade);
  return {
    sockets,
    upgrades,
    release: () => {
      server.off("connection", trackSocket);
      server.off("upgrade", trackUpgrade);
    },
  };
}

async function runShutdown(context: ShutdownContext): Promise<boolean> {
  const { server, stopRuntime, options, connections } = context;
  const logger = options.logger ?? defaultLogger;
  const started = performance.now();
  const pending = new Set<string>();
  const stage = createStage(logger, pending);
  const requests = beginHttpShutdown(server);
  const deadlines = startDeadlines({
    context,
    requests,
    logger,
    report: () => ({ pendingStages: [...pending], elapsedMs: performance.now() - started }),
  });
  try {
    const streamOutcomes =
      options.beginShutdown === undefined
        ? []
        : await Promise.allSettled([stage("streams.close", options.beginShutdown)]);
    const httpClose = stage("http.close", () => closeHttp(server, connections.upgrades));
    const runtimeStop = drainThenStopRuntime({ stage, requests, server, stopRuntime });
    const outcomes = [...streamOutcomes, ...(await Promise.allSettled([httpClose, runtimeStop]))];
    const clean =
      !deadlines.state.expired && outcomes.every((outcome) => outcome.status === "fulfilled");
    if (!deadlines.state.hardExited) options.exit(clean ? 0 : 1);
    return clean;
  } finally {
    deadlines.clear();
    connections.release();
  }
}

function destroySockets(
  server: Server,
  sockets: ReadonlySet<Socket>,
  flushing: ReadonlySet<Socket> = new Set(),
): void {
  if (flushing.size === 0) server.closeAllConnections();
  for (const socket of sockets) {
    if (!flushing.has(socket)) socket.destroy();
  }
}

function startDeadlines(input: {
  context: ShutdownContext;
  requests: ReturnType<typeof beginHttpShutdown>;
  logger: ShutdownLogger;
  report: () => { pendingStages: string[]; elapsedMs: number };
}): Deadlines {
  const { context, requests, logger, report } = input;
  const { server, options, connections } = context;
  const state = { expired: false, hardExited: false };
  const grace = setTimeout(() => {
    state.expired = true;
    logger.warn(report(), "shutdown grace deadline reached; destroying remaining connections");
    destroySockets(server, connections.sockets, requests.expire());
  }, options.graceMs);
  const watchdog = setTimeout(() => {
    state.hardExited = true;
    logger.error(report(), "shutdown hard deadline reached; exiting");
    destroySockets(server, connections.sockets);
    options.exit(1);
  }, options.hardExitMs);
  watchdog.unref();
  return {
    state,
    clear: () => {
      clearTimeout(grace);
      clearTimeout(watchdog);
    },
  };
}

function createStage(logger: ShutdownLogger, pending: Set<string>): Stage {
  return async (name, action) => {
    const stageStarted = performance.now();
    pending.add(name);
    logger.info({ stage: name, phase: "start", elapsedMs: 0 }, "shutdown stage started");
    try {
      await action();
    } catch (error) {
      reportFailure(error, { operation: "server.shutdown", component: "server" }, { logger });
      throw error;
    } finally {
      pending.delete(name);
      logger.info(
        { stage: name, phase: "end", elapsedMs: performance.now() - stageStarted },
        "shutdown stage ended",
      );
    }
  };
}

function closeHttp(server: Server, upgrades: ReadonlySet<Duplex>): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => {
    if (error !== undefined) reject(error);
    else resolve();
  });
  server.closeIdleConnections();
  for (const socket of upgrades) socket.destroy();
  return promise;
}

async function drainThenStopRuntime(input: {
  stage: Stage;
  requests: ReturnType<typeof beginHttpShutdown>;
  server: Server;
  stopRuntime: () => Promise<void>;
}): Promise<void> {
  const { stage, requests, server, stopRuntime } = input;
  await stage("http.requests", () => requests.drained);
  server.closeIdleConnections();
  await stage("runtime.stop", stopRuntime);
}

export interface ShutdownSignals {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export function installShutdownSignals(
  signals: ShutdownSignals,
  stop: () => Promise<boolean>,
  finished: () => void = () => {},
): () => void {
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    void stop().finally(finished);
  };
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);
  return () => {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
  };
}

function readBudget(
  environment: Readonly<Record<string, string | undefined>>,
  spec: { name: string; fallback: number; minimum: number; maximum: number },
): number {
  const { name, fallback, minimum, maximum } = spec;
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}
