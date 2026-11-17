import { TIMELINE_KINDS } from "../run-timeline/store.js";
import {
  mergeRunEvents,
  runEventSchema,
  runEventStatusSchema,
  timelineRead,
  type RunConnection,
  type RunEventPage,
} from "./run-events.js";

export interface RunEventSource {
  addEventListener(kind: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
export interface RunEventState extends RunEventPage {
  connection: RunConnection;
  lastSeq: number;
}
export interface RunEventSubscriptionOptions {
  url: string;
  initial: RunEventPage;
  after: number;
  source: (url: string) => RunEventSource;
  probe: (url: string, signal: AbortSignal) => Promise<number>;
  onSeal: () => void;
}

interface TimelineMetadata {
  status: string;
  sealedSeq: number | null;
  stepRowsOmitted: number;
  origin?: RunEventPage["origin"] | undefined;
  events?: RunEventPage["events"];
  timelineUnavailable?: boolean;
}

function hasTimeline(metadata: TimelineMetadata) {
  return (
    metadata.timelineUnavailable === false ||
    (metadata.events?.length ?? 0) > 0 ||
    metadata.origin != null ||
    metadata.sealedSeq != null
  );
}

export class RunEventSubscription {
  private state: RunEventState;
  private readonly listeners = new Set<() => void>();
  private source: RunEventSource | undefined;
  private failures = 0;
  private stopped = true;
  private probe: AbortController | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sealNotified = false;
  private persistedTerminal: boolean;
  private timelineKnown: boolean;

  constructor(private readonly options: RunEventSubscriptionOptions) {
    const events = options.initial.expired ? [] : mergeRunEvents([], options.initial.events);
    const lastSeq = Math.max(options.after, events.at(-1)?.seq ?? 0);
    this.persistedTerminal = options.initial.status !== "running";
    this.timelineKnown = hasTimeline(options.initial);
    const unavailable = options.initial.timelineUnavailable && !this.timelineKnown;
    const sealedOrExpired =
      options.initial.expired || timelineRead(lastSeq, options.initial.sealedSeq);
    const complete = sealedOrExpired || (unavailable && this.persistedTerminal);
    const connection = options.initial.streamEnabled ? "Reconnecting" : "Polling";
    this.sealNotified = sealedOrExpired;
    this.state = {
      ...options.initial,
      events,
      lastSeq,
      timelineUnavailable: unavailable,
      connection: complete ? null : connection,
    };
  }

  readonly snapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start() {
    this.stopped = false;
    if (!this.finishIfRead() && this.state.streamEnabled) this.open();
    return () => this.stop();
  }

  stop() {
    this.stopped = true;
    this.source?.close();
    this.source = undefined;
    this.probe?.abort();
    this.probe = undefined;
    clearTimeout(this.reconnectTimer);
  }

  acceptSnapshot(page: RunEventPage) {
    this.persistedTerminal ||= page.status !== "running";
    this.acceptPage(page);
  }

  acceptPage(page: RunEventPage) {
    if (this.stopped) return;
    const expired = this.state.expired || page.expired;
    const events = expired ? [] : mergeRunEvents(this.state.events, page.events);
    const lastSeq = Math.max(this.state.lastSeq, events.at(-1)?.seq ?? 0);
    const state = this.mergeMetadata(page);
    state.events = events;
    state.lastSeq = lastSeq;
    state.expired = expired;
    state.droppedCount = Math.max(this.state.droppedCount, page.droppedCount);
    this.update(state);
    if (this.finishIfRead()) return;
    if (
      this.state.connection === null ||
      (!page.streamEnabled && this.state.connection !== "Polling")
    )
      this.poll();
  }

  private update(state: RunEventState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private mergeMetadata(incoming: TimelineMetadata) {
    this.timelineKnown ||= hasTimeline(incoming);
    const seal = Math.max(this.state.sealedSeq ?? -1, incoming.sealedSeq ?? -1);
    const state: RunEventState = {
      ...this.state,
      ...incoming,
      origin: this.state.origin ?? incoming.origin ?? null,
      sealedSeq: seal < 0 ? null : seal,
      stepRowsOmitted: Math.max(this.state.stepRowsOmitted, incoming.stepRowsOmitted),
      status: this.state.status === "running" ? incoming.status : this.state.status,
      timelineUnavailable:
        !this.timelineKnown &&
        (this.state.timelineUnavailable || incoming.timelineUnavailable === true),
    };
    return state;
  }

  private acceptStatus(status: TimelineMetadata, connection = this.state.connection) {
    const state = this.mergeMetadata(status);
    state.connection = connection;
    this.update(state);
  }

  private finishIfRead() {
    const unavailable =
      !this.timelineKnown &&
      this.state.timelineUnavailable &&
      this.persistedTerminal &&
      this.state.status !== "running";
    if (
      !this.state.expired &&
      !timelineRead(this.state.lastSeq, this.state.sealedSeq) &&
      !unavailable
    )
      return false;
    this.source?.close();
    this.source = undefined;
    this.probe?.abort();
    clearTimeout(this.reconnectTimer);
    if (this.state.connection !== null) this.update({ ...this.state, connection: null });
    if (!this.sealNotified && !unavailable) {
      this.sealNotified = true;
      this.options.onSeal();
    }
    return true;
  }

  private poll() {
    this.source?.close();
    this.source = undefined;
    clearTimeout(this.reconnectTimer);
    this.update({ ...this.state, connection: "Polling" });
  }

  private open() {
    if (this.stopped || this.finishIfRead()) return;
    const source = this.options.source(`${this.options.url}&after=${String(this.state.lastSeq)}`);
    this.source = source;
    const listen = (kind: string, listener: (event: MessageEvent<string>) => void) =>
      source.addEventListener(kind, (event) => {
        if (!this.stopped && this.source === source) listener(event);
      });
    listen("open", () => {
      this.failures = 0;
      this.update({ ...this.state, connection: "Live" });
    });
    for (const kind of TIMELINE_KINDS)
      listen(kind, (event) => {
        const row = this.parse(event.data, runEventSchema);
        if (row === undefined) return;
        this.timelineKnown = true;
        const events = mergeRunEvents(this.state.events, [row]);
        this.update({
          ...this.state,
          events,
          lastSeq: Math.max(this.state.lastSeq, row.seq),
          timelineUnavailable: false,
          status:
            this.state.status === "running" &&
            row.kind === "run_finished" &&
            typeof row.data["status"] === "string"
              ? row.data["status"]
              : this.state.status,
        });
        this.finishIfRead();
      });
    listen("status", (event) => {
      const status = this.parse(event.data, runEventStatusSchema);
      if (status === undefined) return;
      this.failures = 0;
      this.acceptStatus(status, "Live");
      this.finishIfRead();
    });
    listen("end", (event) => {
      const status = this.parse(event.data, runEventStatusSchema);
      if (status === undefined) return;
      this.acceptStatus(status);
      if (!this.finishIfRead()) this.poll();
    });
    const reconnect = () => {
      source.close();
      this.source = undefined;
      this.update({ ...this.state, connection: "Reconnecting" });
      this.reconnectTimer = setTimeout(() => this.open(), 5000);
    };
    listen("shutdown", reconnect);
    listen("reconnect", reconnect);
    listen("error", () => {
      this.failures += 1;
      if (this.failures >= 3) this.poll();
      else this.update({ ...this.state, connection: "Reconnecting" });
      if (this.probe !== undefined) return;
      const probe = new AbortController();
      this.probe = probe;
      void this.options
        .probe(`${this.options.url}&after=${String(this.state.lastSeq)}`, probe.signal)
        .then((status) => {
          if (this.stopped || probe.signal.aborted) return undefined;
          if (status === 404) this.poll();
          if (status === 410) {
            this.update({ ...this.state, expired: true, events: [] });
            this.finishIfRead();
          }
          return undefined;
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.probe === probe) this.probe = undefined;
        });
    });
  }

  private parse<T>(
    text: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): T | undefined {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}

export function pollRunDetail(refresh: () => void) {
  const timer = setInterval(refresh, 5_000);
  return () => clearInterval(timer);
}
