import type { RunProgressSettings } from "../run-progress/settings.js";
import type { SessionEventBus, SessionNotification } from "./bus.js";
import { SessionReadError, type AgentCursor, type InteractiveSessionService } from "./service.js";
import {
  compareAgentPosition,
  type SessionEventRecord,
  type SessionPrincipal,
  type TranscriptItem,
} from "./types.js";

export type SessionStreamSource = Pick<
  InteractiveSessionService,
  "authorizeStream" | "streamEvents" | "streamEventData" | "streamCatchUp"
>;

export type SessionStreamSettings = Pick<
  RunProgressSettings,
  | "streamMaxPerKey"
  | "streamMaxPerOrg"
  | "streamMaxTotal"
  | "streamHeartbeatSeconds"
  | "streamMaxSeconds"
>;

export interface SessionStreamCursor {
  hubSeq: number;
  agent: AgentCursor | null;
}

interface SubscriberOptions {
  request: Request;
  organizationSlug: string;
  sessionId: string;
  principal: SessionPrincipal;
  cursor: SessionStreamCursor;
  resumeWithoutAgent: boolean;
  service: SessionStreamSource;
  bus: SessionEventBus;
  settings: SessionStreamSettings;
  release(): void;
  reportFailure(error: unknown): void;
}

type LiveEvent = Exclude<SessionNotification, { kind: "hub" | "access_changed" | "shutdown" }>;
type AgentEvent = Extract<LiveEvent, { kind: "agent" }>;
type CloseCode = "slow_consumer" | "reauth" | "max_age";
const encoder = new TextEncoder();
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_REPLAY = 500;
const REAUTHORIZE_MS = 60_000;
const ACCESS_CHECK_TIMEOUT_MS = 750;

export class SessionStreamSubscriber {
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private unsubscribe?: () => void;
  private readonly timers: NodeJS.Timeout[] = [];
  private closed = false;
  private wake: (() => void) | undefined;
  private ping = false;
  private opened = false;
  private principal: SessionPrincipal;
  private authorization: Promise<void> | undefined;
  private accessVersion = 0;
  private checkedVersion = 0;
  private hubSeq: number;
  private hubDirty = true;
  private hubRows: SessionEventRecord[] = [];
  private hubIndex = 0;
  private catchUp: AgentCursor | null;
  private agentReplay: (AgentEvent | Extract<LiveEvent, { kind: "gap" }>)[] = [];
  private readonly pendingHub = new Set<number>();
  private agent: AgentCursor | null;
  private readonly retiredEpochs = new Set<string>();
  private pendingAgent: AgentEvent | undefined;
  private readonly live: { event: LiveEvent; bytes: number }[] = [];
  private liveBytes = 0;
  private readonly onAbort = () => this.end();

  constructor(private readonly options: SubscriberOptions) {
    this.principal = options.principal;
    this.hubSeq = options.cursor.hubSeq;
    this.catchUp = options.cursor.agent;
    this.agent = options.cursor.agent;
    if (options.resumeWithoutAgent) this.setCatchUpGap("behind");
    this.body = new ReadableStream(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => this.pull(),
        cancel: () => this.end(),
      },
      // Authorization changes must be able to discard every frame the consumer has not read.
      { highWaterMark: 0 },
    );
  }

  start(): void {
    const { bus, request, sessionId, settings } = this.options;
    this.unsubscribe = bus.subscribe(sessionId, (notification) => this.receive(notification));
    request.signal.addEventListener("abort", this.onAbort, { once: true });
    if (request.signal.aborted) {
      this.end();
      return;
    }
    this.timers.push(
      setInterval(() => {
        this.ping = true;
        this.wake?.();
      }, settings.streamHeartbeatSeconds * 1000).unref(),
      setTimeout(() => this.fail("max_age"), settings.streamMaxSeconds * 1000).unref(),
      setInterval(() => this.recheck(), REAUTHORIZE_MS).unref(),
    );
    // A removal could have committed between the route's first access check and subscription.
    this.recheck();
  }

  shutdown(reconnectMs = 5000): void {
    this.end(this.frameAtCursor("shutdown", { reconnectMs }));
  }

  end(terminal?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.options.request.signal.removeEventListener("abort", this.onAbort);
    for (const timer of this.timers) clearTimeout(timer);
    this.live.length = 0;
    this.liveBytes = 0;
    this.hubRows.length = 0;
    this.agentReplay.length = 0;
    this.pendingHub.clear();
    this.pendingAgent = undefined;
    this.wake?.();
    try {
      if (terminal !== undefined) this.controller.enqueue(encoder.encode(terminal));
      this.controller.close();
    } catch {
      // The client may have canceled the body already.
    } finally {
      this.options.release();
    }
  }

  private fail(code: CloseCode): void {
    this.end(this.frameAtCursor("error", { code }));
  }

  private receive(notification: SessionNotification): void {
    if (this.closed) return;
    if (notification.kind === "access_changed" || notification.kind === "hub") {
      if (notification.kind === "hub" && notification.event.seq > this.hubSeq) {
        this.pendingHub.add(notification.event.seq);
        if (this.queueOverLimit()) {
          this.fail("slow_consumer");
          return;
        }
      }
      this.hubDirty = true;
      if (notification.kind === "access_changed" || notification.event.kind === "participants")
        this.recheck();
    } else if (notification.kind === "shutdown") {
      this.shutdown(notification.reconnectMs);
    } else if (notification.kind !== "agent" || validAgentEpoch(notification.epoch)) {
      this.enqueueLive(notification);
    }
    this.wake?.();
  }

  private enqueueLive(event: LiveEvent): void {
    if (this.closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.live.push({ event, bytes });
    this.liveBytes += bytes;
    if (this.queueOverLimit()) this.fail("slow_consumer");
  }

  private queueOverLimit(): boolean {
    return (
      this.live.length + this.pendingHub.size > MAX_PENDING_EVENTS ||
      this.liveBytes > MAX_PENDING_BYTES
    );
  }

  private recheck(): void {
    if (this.closed) return;
    this.accessVersion += 1;
    this.ensureAuthorization();
  }

  private ensureAuthorization(): void {
    if (this.closed || this.authorization || this.checkedVersion === this.accessVersion) return;
    this.authorization = this.refreshAccess().finally(() => {
      this.authorization = undefined;
      this.ensureAuthorization();
    });
  }

  private async refreshAccess(): Promise<void> {
    const deadline = Promise.withResolvers<"not_found">();
    const timeout = setTimeout(
      () => deadline.resolve("not_found"),
      ACCESS_CHECK_TIMEOUT_MS,
    ).unref();
    try {
      while (!this.closed && this.checkedVersion !== this.accessVersion) {
        const version = this.accessVersion;
        const { service, request, organizationSlug, sessionId } = this.options;
        const principal = await Promise.race([
          service.authorizeStream(request, organizationSlug, sessionId),
          deadline.promise,
        ]);
        if (
          typeof principal === "string" ||
          principal.organizationId !== this.principal.organizationId ||
          principal.userId !== this.principal.userId
        ) {
          this.fail("reauth");
          return;
        }
        this.principal = principal;
        this.checkedVersion = version;
      }
    } catch (error) {
      if (!this.closed) this.options.reportFailure(error);
      this.fail("reauth");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async pull(): Promise<void> {
    try {
      while (!this.closed) {
        if (this.authorization) {
          await this.authorization;
          continue;
        }
        if (!this.opened) {
          this.opened = true;
          this.send(": stream open\n\n");
          return;
        }
        const hub = this.hubRows[this.hubIndex];
        if (hub !== undefined) {
          this.hubIndex += 1;
          if (await this.sendHub(hub)) return;
          continue;
        }
        if (this.hubDirty) {
          await this.fetchHub();
          continue;
        }
        if (this.catchUp !== null) {
          const cursor = this.catchUp;
          this.catchUp = null;
          await this.fetchAgentCatchUp(cursor);
          continue;
        }
        if (this.pendingAgent) {
          const event = this.pendingAgent;
          this.pendingAgent = undefined;
          if (this.sendAgent(event)) return;
          continue;
        }
        const replayed = this.agentReplay.shift();
        if (replayed !== undefined) {
          if (this.sendLive(replayed)) return;
          continue;
        }
        const queued = this.live.shift();
        if (queued !== undefined) {
          this.liveBytes -= queued.bytes;
          if (this.sendLive(queued.event)) return;
          continue;
        }
        if (this.ping) {
          this.ping = false;
          this.send(": ping\n\n");
          return;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    } catch (error) {
      if (this.closed) return;
      if (error instanceof SessionReadError && error.code === "not_found") {
        this.fail("reauth");
        return;
      }
      this.options.reportFailure(error);
      this.end(this.frameAtCursor("resync", {}));
    }
  }

  private async fetchHub(): Promise<void> {
    this.hubDirty = false;
    const { service, sessionId } = this.options;
    const rows = await service.streamEvents(this.principal, sessionId, this.hubSeq, MAX_REPLAY + 1);
    if (this.closed) return;
    if (rows.length > MAX_REPLAY) {
      this.end(this.frameAtCursor("resync", {}));
      return;
    }
    this.hubRows = rows;
    this.hubIndex = 0;
  }

  private async sendHub(event: SessionEventRecord): Promise<boolean> {
    this.pendingHub.delete(event.seq);
    if (event.seq <= this.hubSeq) return false;
    while (!this.closed) {
      if (this.authorization) {
        await this.authorization;
        continue;
      }
      const version = this.checkedVersion;
      const data = await this.options.service.streamEventData(this.principal, event);
      if (this.closed) return false;
      if (version !== this.accessVersion) continue;
      this.hubSeq = event.seq;
      return (
        data !== undefined && this.send(frame(event.kind, data, cursorId(event.seq, this.agent)))
      );
    }
    return false;
  }

  private async fetchAgentCatchUp(cursor: AgentCursor): Promise<void> {
    this.recheck();
    while (this.authorization) await this.authorization;
    if (this.closed) return;
    const { bus, sessionId, service } = this.options;
    const buffered = bus.readAgentItems(sessionId, cursor.epoch, cursor);
    if (buffered.status === "available") {
      this.setCatchUp(cursor.epoch, buffered.items);
      return;
    }
    if (buffered.reason === "epoch_changed") {
      this.setCatchUpGap("epoch_changed");
      return;
    }
    const page = await service.streamCatchUp(this.principal, sessionId, cursor);
    if (this.closed) return;
    if ("gap" in page) {
      this.setCatchUpGap(page.gap);
    } else if (page.epoch !== cursor.epoch) {
      this.setCatchUpGap("epoch_changed");
    } else if (page.hasNewer) {
      this.setCatchUpGap("behind");
    } else {
      this.setCatchUp(page.epoch, page.items);
    }
  }

  private setCatchUpGap(reason: Extract<LiveEvent, { kind: "gap" }>["reason"]): void {
    this.agentReplay = [{ kind: "gap", reason }];
  }

  private setCatchUp(epoch: string, items: TranscriptItem[]): void {
    this.agentReplay = items.map((item) => ({ kind: "agent", epoch, item }));
  }

  private sendLive(event: LiveEvent): boolean {
    switch (event.kind) {
      case "agent":
        return this.sendAgent(event);
      case "connection":
        return this.send(
          this.frameAtCursor("connection", { daemon: event.online ? "online" : "offline" }),
        );
      case "gap":
        if (event.reason === "epoch_changed" && this.agent !== null) {
          this.retiredEpochs.add(this.agent.epoch);
          this.agent = null;
        }
        return this.send(this.frameAtCursor("gap", { reason: event.reason }));
      default:
        this.end(this.frameAtCursor("resync", {}));
        return true;
    }
  }

  private sendAgent(event: AgentEvent): boolean {
    const { epoch, item } = event;
    if (!Number.isSafeInteger(item.seq) || item.seq < 0 || this.retiredEpochs.has(epoch))
      return false;
    if (this.agent !== null) {
      if (epoch !== this.agent.epoch) {
        this.retiredEpochs.add(this.agent.epoch);
        this.agent = null;
        this.pendingAgent = event;
        return this.send(this.frameAtCursor("gap", { reason: "epoch_changed" }));
      }
      if (compareAgentPosition(item, this.agent) <= 0) return false;
    }
    const chunkOffset = item.kind === "assistant" ? item.chunkOffset : undefined;
    const cursor = { seq: item.seq, epoch, ...(chunkOffset === undefined ? {} : { chunkOffset }) };
    if (!this.send(frame("agent", item, cursorId(this.hubSeq, cursor)))) return false;
    this.agent = cursor;
    return true;
  }

  private frameAtCursor(event: string, data: unknown): string {
    return frame(event, data, cursorId(this.hubSeq, this.agent));
  }

  private send(value: string): boolean {
    if (this.closed) return false;
    const bytes = encoder.encode(value);
    if (bytes.byteLength > MAX_FRAME_BYTES) {
      this.fail("slow_consumer");
      return false;
    }
    this.controller.enqueue(bytes);
    return true;
  }
}

function frame(event: string, data: unknown, id?: string): string {
  return (
    (id === undefined ? "" : `id: ${id}\n`) + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

export function validAgentEpoch(epoch: string): boolean {
  return epoch.length > 0 && epoch.length <= 200 && !/\p{Cc}/u.test(epoch);
}

function cursorId(hubSeq: number, agent: AgentCursor | null): string {
  if (!agent) return String(hubSeq);
  const offset = agent.chunkOffset === undefined ? "" : `.${agent.chunkOffset}`;
  return `${hubSeq}:${agent.seq}${offset}:${agent.epoch}`;
}
