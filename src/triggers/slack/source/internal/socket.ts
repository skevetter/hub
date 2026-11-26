import { createHash } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import type { z } from "zod";
import { reportFailure } from "../../../../failures/index.js";
import { logger } from "../../../../logger.js";
import type { TriggerHandler, TriggerSource } from "../../../index.js";
import {
  intakeSlackEvent,
  SlackEventIntakeValidationError,
  type SlackEventIntakeOptions,
} from "./intake.js";
import {
  openSlackSocket,
  SlackSocketConnectionError,
  type OpenSlackSocketResult,
} from "./connection.js";
import {
  parseSlackSocketFrame,
  slackSocketFrame,
  slackSocketAck,
  SlackSocketDisconnectSchema,
  SlackSocketEnvelopeSchema,
} from "./socket-protocol.js";

const MAX_FRAME_BYTES = 1_048_576;

export type SlackDeliveryStatus =
  | { state: "connecting" | "reconnecting" | "connected" }
  | {
      state: "actionNeeded";
      reason: "appTokenRejected" | "socketModeOff" | "appIdentityMismatch";
    }
  | { state: "stopped" };

export interface SlackSocketSource extends TriggerSource {
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
}

export interface SlackSocketSourceOptions extends SlackEventIntakeOptions {
  appToken: string;
  apiUrl?: string;
  random?: () => number;
  timeoutMs?: number;
}

export function createSlackSocketSource(options: SlackSocketSourceOptions): SlackSocketSource {
  const supervisor = new SlackSocketSupervisor(options);
  return {
    start: supervisor.start.bind(supervisor),
    stop: supervisor.stop.bind(supervisor),
    status: () => supervisor.status(),
    retry: supervisor.retry.bind(supervisor),
  };
}

type SocketFrame =
  | { kind: "invalid"; envelopeId: string }
  | { kind: "envelope"; envelope: z.infer<typeof SlackSocketEnvelopeSchema>; bytes: number };

class SlackSocketSupervisor {
  private readonly handlers = new Set<TriggerHandler>();
  private readonly random: () => number;
  private deliveryStatus: SlackDeliveryStatus = { state: "stopped" };
  private stopped = true;
  private attempt = 0;
  private controller: AbortController | undefined;
  private current: OpenSlackSocketResult | undefined;
  private supervisor: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private frames = Promise.resolve();
  private failureOwned = false;
  private expectedClose = false;
  private terminalDisconnect: "socketModeOff" | undefined;
  private transientReported = false;
  private minimumDelay = 0;

  constructor(private readonly options: SlackSocketSourceOptions) {
    this.random = options.random ?? Math.random;
  }

  status(): SlackDeliveryStatus {
    return this.deliveryStatus;
  }

  async start(handler: TriggerHandler): Promise<void> {
    this.handlers.add(handler);
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.startSupervisor();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    const wake = this.wake;
    wake?.();
    const connection = this.current;
    if (connection !== undefined) await connection.close(250, "shutdown");
    await this.supervisor;
    await this.frames;
    this.handlers.clear();
    this.deliveryStatus = { state: "stopped" };
  }

  async retry(): Promise<void> {
    if (!this.stopped && this.deliveryStatus.state !== "actionNeeded") {
      const wake = this.wake;
      wake?.();
      return;
    }
    if (this.stopped) return;
    this.attempt = 0;
    this.transientReported = false;
    this.startSupervisor();
  }

  private startSupervisor(): void {
    this.supervisor = this.run().catch((error: unknown) =>
      this.report(error, "slack.socket.loop", "internal"),
    );
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.deliveryStatus = { state: this.attempt === 0 ? "connecting" : "reconnecting" };
      this.controller = new AbortController();
      try {
        const connection = await openSlackSocket(this.connectionOptions(this.controller));
        this.onConnected(connection);
        const closed = await connection.closed;
        this.current = undefined;
        if (!this.shouldReconnect(closed)) return;
      } catch (error) {
        if (this.stopped || this.controller.signal.aborted) return;
        if (!this.shouldRetry(error)) return;
      }
      await this.waitForRetry(this.nextDelay());
    }
  }

  private connectionOptions(controller: AbortController): Parameters<typeof openSlackSocket>[0] {
    const { options } = this;
    return {
      appToken: options.appToken,
      appId: options.appId,
      signal: controller.signal,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
  }

  private onConnected(connection: OpenSlackSocketResult): void {
    this.current = connection;
    this.failureOwned = false;
    this.expectedClose = false;
    this.terminalDisconnect = undefined;
    this.transientReported = false;
    this.attempt = 0;
    this.deliveryStatus = { state: "connected" };
    logger.info(
      { provider: "slack", operation: "slack.socket.connect", appId: this.options.appId },
      "Slack Socket Mode connected",
    );
    connection.socket.on("message", (data, binary) => {
      this.frames = this.frames
        .then(() => this.handleFrame(connection, data, binary))
        .catch((error: unknown) => this.onFrameFailure(connection, error));
    });
  }

  private onFrameFailure(connection: OpenSlackSocketResult, error: unknown): void {
    if (!this.failureOwned) {
      this.failureOwned = true;
      this.report(error, "slack.socket.handoff", "internal");
    }
    connection.socket.close();
  }

  private shouldReconnect(closed: number): boolean {
    if (this.stopped) return false;
    if (this.terminalDisconnect !== undefined) {
      this.deliveryStatus = { state: "actionNeeded", reason: this.terminalDisconnect };
      if (!this.failureOwned)
        this.report(new Error("Slack Socket Mode is off"), "slack.socket.disconnect", "validation");
      return false;
    }
    if (!this.expectedClose && !this.failureOwned) {
      this.report(
        Object.assign(new Error("Slack Socket Mode connection closed"), { closeCode: closed }),
        "slack.socket.connect",
        "network",
      );
      this.transientReported = true;
    }
    return true;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof SlackSocketConnectionError && error.reason !== "transient") {
      this.deliveryStatus = { state: "actionNeeded", reason: error.reason };
      this.report(error, "slack.socket.authenticate", "authentication");
      return false;
    }
    if (!this.transientReported) {
      this.transientReported = true;
      this.report(error, "slack.socket.connect", "network");
    }
    this.minimumDelay = error instanceof SlackSocketConnectionError ? error.retryAfterMs : 0;
    return true;
  }

  private nextDelay(): number {
    this.attempt += 1;
    const random = this.random;
    const delayMs = Math.max(
      this.minimumDelay,
      Math.floor(random() * Math.min(30_000, 1_000 * 2 ** (this.attempt - 1))),
    );
    this.minimumDelay = 0;
    return delayMs;
  }

  private async handleFrame(
    connection: OpenSlackSocketResult,
    data: RawData,
    binary: boolean,
  ): Promise<void> {
    const frame = this.readFrame(connection, data, binary);
    if (frame === undefined) return;
    if (frame.kind === "invalid") {
      await this.sendAck(connection.socket, frame.envelopeId);
      return;
    }

    const envelope = frame.envelope;
    if (envelope.type === "events_api") {
      if (objectString(envelope.payload, "type") === "app_rate_limited") {
        reportRateLimit(envelope.payload);
      } else {
        const signatureHash = createHash("sha256").update(envelope.envelope_id).digest("hex");
        try {
          await intakeSlackEvent(envelope.payload, signatureHash, this.handlers, this.options);
        } catch (error) {
          this.handleIntakeError(error, frame.bytes);
        }
      }
    }
    if (!this.stopped) await this.sendAck(connection.socket, envelope.envelope_id);
  }

  private readFrame(
    connection: OpenSlackSocketResult,
    data: RawData,
    binary: boolean,
  ): SocketFrame | undefined {
    const frame = slackSocketFrame(data);
    const bytes = frame.byteLength;
    if (binary || bytes > MAX_FRAME_BYTES) {
      this.reportInvalidFrame(bytes);
      return undefined;
    }
    const value = parseSlackSocketFrame(frame);
    const disconnect = SlackSocketDisconnectSchema.safeParse(value);
    if (disconnect.success) {
      this.expectedClose = disconnect.data.reason !== "link_disabled";
      if (!this.expectedClose) this.terminalDisconnect = "socketModeOff";
      connection.socket.close(1000, disconnect.data.reason);
      return undefined;
    }
    const envelope = SlackSocketEnvelopeSchema.safeParse(value);
    return envelope.success
      ? { kind: "envelope", envelope: envelope.data, bytes }
      : this.invalidEnvelope(value, bytes);
  }

  private invalidEnvelope(value: unknown, bytes: number): SocketFrame | undefined {
    this.reportInvalidFrame(bytes);
    const envelopeId = boundedEnvelopeId(value);
    return envelopeId === undefined ? undefined : { kind: "invalid", envelopeId };
  }

  private handleIntakeError(error: unknown, bytes: number): void {
    if (!(error instanceof SlackEventIntakeValidationError)) throw error;
    this.reportInvalidFrame(bytes);
  }

  private async sendAck(socket: WebSocket, envelopeId: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        socket.send(slackSocketAck(envelopeId), (error) => {
          if (error != null) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } catch (error) {
      this.failureOwned = true;
      this.report(error, "slack.socket.ack", "network");
      socket.close();
    }
  }

  private waitForRetry(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.wake = undefined;
    });
  }

  private report(
    error: unknown,
    operation: string,
    kind: "authentication" | "network" | "validation" | "internal",
  ): void {
    const { options } = this;
    reportFailure(
      error,
      { operation, component: "triggers", provider: "slack" },
      {
        kind,
        scrubValues: [options.appToken, ...(options.apiUrl === undefined ? [] : [options.apiUrl])],
      },
    );
  }

  private reportInvalidFrame(byteCount: number): void {
    this.report(
      Object.assign(new Error("Slack sent an invalid event"), { frameBytes: byteCount }),
      "slack.socket.envelope.parse",
      "validation",
    );
  }
}

function reportRateLimit(payload: unknown): void {
  logger.warn(
    {
      provider: "slack",
      operation: "slack.socket.rate_limited",
      teamId: objectString(payload, "team_id"),
    },
    "Slack is delaying events for a workspace",
  );
}

function boundedEnvelopeId(value: unknown): string | undefined {
  const id = objectString(value, "envelope_id");
  return id !== undefined && id.length <= 255 ? id : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate: unknown = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}
