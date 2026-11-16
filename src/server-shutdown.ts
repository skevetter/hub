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
  const graceMs = readBudget(environment, "PASEO_HUB_SHUTDOWN_GRACE_MS", 10_000, 1_000, 40_000);
  const hardExitMs = readBudget(
    environment,
    "PASEO_HUB_SHUTDOWN_HARD_EXIT_MS",
    15_000,
    1_001,
    44_000,
  );
  if (hardExitMs <= graceMs) {
    throw new Error("PASEO_HUB_SHUTDOWN_HARD_EXIT_MS must exceed PASEO_HUB_SHUTDOWN_GRACE_MS");
  }
  return { graceMs, hardExitMs };
}

export function createServerShutdown(
  server: Server,
  stopRuntime: () => Promise<void>,
  options: ShutdownBudgets & {
    logger?: Pick<Logger, "info" | "warn" | "error">;
    exit: (code: number) => void;
  },
): () => Promise<boolean> {
  const logger = options.logger ?? defaultLogger;
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
  let shutdown: Promise<boolean> | undefined;
  return () => {
    shutdown ??= stop();
    return shutdown;
  };

  async function stop(): Promise<boolean> {
    const started = performance.now();
    const pending = new Set<string>();
    const requests = beginHttpShutdown(server);
    let expired = false;
    let hardExited = false;
    const destroySockets = (flushing: ReadonlySet<Socket> = new Set()) => {
      if (flushing.size === 0) server.closeAllConnections();
      for (const socket of sockets) {
        if (!flushing.has(socket)) socket.destroy();
      }
    };
    const grace = setTimeout(() => {
      expired = true;
      logger.warn(
        { pendingStages: [...pending], elapsedMs: performance.now() - started },
        "shutdown grace deadline reached; destroying remaining connections",
      );
      destroySockets(requests.expire());
    }, options.graceMs);
    const watchdog = setTimeout(() => {
      hardExited = true;
      logger.error(
        { pendingStages: [...pending], elapsedMs: performance.now() - started },
        "shutdown hard deadline reached; exiting",
      );
      destroySockets();
      options.exit(1);
    }, options.hardExitMs);
    watchdog.unref();
    try {
      const httpClose = stage("http.close", () => {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
        for (const socket of upgrades) socket.destroy();
        return promise;
      });
      const runtimeStop = (async () => {
        await stage("http.requests", () => requests.drained);
        server.closeIdleConnections();
        await stage("runtime.stop", stopRuntime);
      })();
      const outcomes = await Promise.allSettled([httpClose, runtimeStop]);
      const clean = !expired && outcomes.every((outcome) => outcome.status === "fulfilled");
      if (!hardExited) options.exit(clean ? 0 : 1);
      return clean;
    } finally {
      clearTimeout(grace);
      clearTimeout(watchdog);
      server.off("connection", trackSocket);
      server.off("upgrade", trackUpgrade);
    }

    async function stage(name: string, action: () => Promise<void>): Promise<void> {
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
    }
  }
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
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}
