import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { z } from "zod";

import type { TranscriptItem as DisplayItem } from "../../components/app/transcript-types.js";
import {
  readInteractiveSession,
  readSessionHistory,
  type HistoryPage,
  type SessionSnapshot,
} from "../functions.js";
import type { AgentCursor } from "../service.js";
import { sessionEvents } from "./session-events.js";
import {
  appendAgentItem,
  initialAgentFeed,
  mergeHistoryPage,
  parseSessionCursor,
  sessionCursor,
  transcriptItems,
  type AgentFeed,
  type SessionMessage,
} from "./session-feed.js";

type Boundary = Extract<DisplayItem, { kind: "boundary" }>;
type HistoryStatus =
  | Extract<HistoryPage, { unavailable: string }>["unavailable"]
  | "loading"
  | "ready";
type Source = EventSource;
type StreamPosition = NonNullable<ReturnType<typeof parseSessionCursor>>;

interface LiveView {
  snapshot: SessionSnapshot | null;
  agent: AgentFeed;
  announcement: string;
  version: number;
  boundaries: readonly Boundary[];
  reconnecting: boolean;
  missedUpdates: boolean;
  history: HistoryStatus;
  loadingOlder: boolean;
}

export function useSessionStream(organizationSlug: string, initial: SessionSnapshot) {
  const [stream] = useState(() => new SessionStream(organizationSlug, initial));
  useEffect(() => stream.start(), [stream]);
  const view = useSyncExternalStore(stream.subscribe, stream.snapshot, stream.snapshot);
  const messages = view.snapshot?.messages;
  const items = useMemo(
    () => [...transcriptItems(view.agent, messages ?? []), ...view.boundaries],
    [messages, view.agent, view.boundaries],
  );
  return { view, items, refresh: stream.refresh, loadOlder: stream.loadOlder };
}

class SessionStream {
  private view: LiveView;
  private readonly listeners = new Set<() => void>();
  private readonly scope: { organizationSlug: string; sessionId: string };
  private readonly path: string;
  private source: Source | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private polling: ReturnType<typeof setInterval> | undefined;
  private lifecycle = 0;
  private active = false;
  private failures = 0;
  private historyRequest = 0;
  private presenceVersion = 0;

  constructor(organizationSlug: string, initial: SessionSnapshot) {
    this.scope = { organizationSlug, sessionId: initial.session.id };
    this.path = `/api/v1/interactive-sessions/${encodeURIComponent(initial.session.id)}/events`;
    this.view = {
      snapshot: initial,
      agent: initialAgentFeed(),
      announcement: "",
      version: 0,
      boundaries: [],
      reconnecting: false,
      missedUpdates: false,
      history: "loading",
      loadingOlder: false,
    };
  }

  readonly snapshot = () => this.view;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly start = () => {
    this.active = true;
    this.lifecycle += 1;
    this.open(true);
    void this.history();
    return () => this.stop();
  };

  private stop() {
    this.active = false;
    this.lifecycle += 1;
    this.source?.close();
    this.source = undefined;
    clearTimeout(this.reconnectTimer);
    this.stopPolling();
  }

  private unavailable() {
    this.stop();
    this.publish({ snapshot: null, agent: initialAgentFeed(), boundaries: [] });
  }

  private publish(update: Partial<LiveView>, feedChanged = false) {
    this.view = {
      ...this.view,
      ...update,
      version: this.view.version + Number(feedChanged),
    };
    for (const listener of this.listeners) listener();
  }

  private open(initial = false) {
    const snapshot = this.view.snapshot;
    if (!this.active || snapshot === null) return;
    const query = new URLSearchParams({
      organization: this.scope.organizationSlug,
      after: sessionCursor(snapshot.hubSeq, this.view.agent.cursor),
    });
    const source = new EventSource(`${this.path}?${query.toString()}`);
    this.source = source;
    let initialGap = initial && snapshot.hubSeq > 0 && this.view.agent.cursor === null;
    const live = () => this.active && this.source === source;

    source.addEventListener("open", () => {
      if (!live()) return;
      this.failures = 0;
      this.stopPolling();
      this.publish({ reconnecting: false });
      if (!initial) void this.refresh();
    });

    this.listen(source, "agent", sessionEvents.agent, (item, cursor) => {
      const current = this.view.snapshot;
      if (current === null || cursor.agent === null) return;
      const agent = appendAgentItem(
        this.view.agent,
        cursor.agent.epoch,
        item,
        current.session.turn,
      );
      if (agent !== this.view.agent) this.publish({ agent }, true);
    });
    this.listen(source, "message", sessionEvents.message, (message, cursor) => {
      this.applyMessage(cursor.hubSeq, message);
    });
    this.listen(
      source,
      "delivery",
      sessionEvents.delivery,
      ({ commandId, status, failureCode }, cursor) => {
        this.applyDelivery(cursor.hubSeq, commandId, status, failureCode);
      },
    );
    this.listen(source, "state", sessionEvents.state, (state, cursor) => {
      const current = this.view.snapshot;
      if (current === null || cursor.hubSeq <= current.hubSeq) return;
      this.applySnapshot({
        ...current,
        session: { ...current.session, ...state },
        hubSeq: cursor.hubSeq,
      });
    });
    this.listen(source, "participants", sessionEvents.participants, (access, cursor) => {
      const current = this.view.snapshot;
      if (current !== null && cursor.hubSeq > current.hubSeq)
        this.publish({ snapshot: { ...current, ...access, hubSeq: cursor.hubSeq } });
    });
    this.listen(source, "connection", sessionEvents.connection, ({ daemon }) => {
      const current = this.view.snapshot;
      if (current === null) return;
      this.presenceVersion += 1;
      const session = {
        ...current.session,
        daemon: { ...current.session.daemon, connection: daemon },
      };
      this.publish({ snapshot: { ...current, session } });
      if (daemon === "online") void this.history();
      else {
        this.historyRequest += 1;
        this.publish({ history: "daemon_offline", loadingOlder: false });
      }
    });
    this.listen(source, "gap", sessionEvents.gap, ({ reason }) => {
      const firstReplay = initialGap;
      initialGap = false;
      if (firstReplay && reason === "behind") return;
      this.publish({ missedUpdates: true });
      if (reason === "daemon_disconnected") return;
      if (reason === "epoch_changed") {
        this.historyRequest += 1;
        this.publish({ agent: { ...this.view.agent, cursor: null }, loadingOlder: false });
      }
      void this.history();
    });
    source.addEventListener("resync", () => {
      if (!live()) return;
      void this.resync();
    });
    this.listen(source, "shutdown", sessionEvents.shutdown, ({ reconnectMs }) => {
      this.disconnect();
      this.scheduleReconnect(Math.max(1000, Math.min(reconnectMs, 30_000)));
    });
    source.addEventListener("error", (event) => {
      if (!live()) return;
      if (
        event instanceof MessageEvent &&
        readEvent(sessionEvents.error, event)?.code === "reauth"
      ) {
        this.unavailable();
        return;
      }
      this.disconnect();
      this.failures += 1;
      if (this.failures >= 3) this.startPolling();
      this.scheduleReconnect(Math.min(1000 * 2 ** (this.failures - 1), 30_000));
    });
  }

  private async resync() {
    this.publish({ missedUpdates: true });
    this.disconnect();
    if (await this.refresh()) {
      if (this.source !== undefined) return;
      void this.history();
      this.scheduleReconnect(1000);
    }
  }

  private listen<T>(
    source: Source,
    event: string,
    schema: z.ZodType<T>,
    apply: (data: T, cursor: StreamPosition) => void,
  ) {
    source.addEventListener(event, (frame: MessageEvent<unknown>) => {
      if (!this.active || this.source !== source) return;
      const cursor = parseSessionCursor(frame.lastEventId);
      const data = readEvent(schema, frame);
      if (cursor !== undefined && data !== undefined) apply(data, cursor);
    });
  }

  private disconnect() {
    this.source?.close();
    this.source = undefined;
    this.publish({ reconnecting: true });
  }

  private scheduleReconnect(delay: number) {
    if (!this.active) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startPolling() {
    if (this.polling !== undefined) return;
    void this.refresh();
    this.polling = setInterval(() => void this.refresh(), 5000);
  }

  private stopPolling() {
    clearInterval(this.polling);
    this.polling = undefined;
  }

  readonly refresh = async () => {
    const generation = this.lifecycle;
    const presenceVersion = this.presenceVersion;
    try {
      const result = await readInteractiveSession({ data: this.scope });
      if (!this.active || generation !== this.lifecycle) return false;
      if (result.status === "ok" && "outcome" in result.data && result.data.code === "not_found") {
        this.unavailable();
        return false;
      }
      if (result.status === "ok" && !("outcome" in result.data)) {
        const current = this.view.snapshot;
        const next = result.data;
        // Connection frames have no durable sequence, so an older response must not revert one.
        if (current !== null && presenceVersion !== this.presenceVersion) {
          this.applySnapshot({
            ...next,
            session: { ...next.session, daemon: current.session.daemon },
          });
        } else {
          this.applySnapshot(next);
        }
      }
    } catch {
      // Retain the last view until the service can be reached again.
    }
    return this.active && generation === this.lifecycle;
  };

  private applySnapshot(next: SessionSnapshot) {
    const prior = this.view.snapshot;
    if (prior === null || next.hubSeq < prior.hubSeq) return;
    const replaced = next.session.generation !== prior.session.generation;
    const daemonBack =
      next.session.daemon.connection === "online" && prior.session.daemon.connection === "offline";
    const agentReady = prior.session.state === "starting" && next.session.state !== "starting";
    const ended = next.session.state === "idle" && prior.session.state !== "idle";
    let messages = prior.messages;
    let announcement = ended ? "The agent's turn ended." : undefined;
    if (next.messages !== prior.messages) {
      const merged = new Map(prior.messages.map((message) => [message.commandId, message]));
      for (const message of next.messages) {
        if (message.status !== merged.get(message.commandId)?.status) {
          announcement = deliveryAnnouncement(message.status) ?? announcement;
        }
        merged.set(message.commandId, message);
      }
      messages = [...merged.values()];
    }
    this.publish(
      {
        snapshot: { ...next, messages },
        ...(announcement === undefined ? {} : { announcement }),
        ...(next.session.daemon.connection === "offline"
          ? { history: "daemon_offline" as const }
          : {}),
      },
      messages !== prior.messages || next.session.state !== prior.session.state,
    );
    if (replaced) {
      this.historyRequest += 1;
      this.publish(
        {
          agent: initialAgentFeed(),
          boundaries: [
            {
              kind: "boundary",
              id: `generation:${next.session.generation}`,
              seq: -1,
              label: "New agent started.",
            },
          ],
          history: "loading",
          loadingOlder: false,
        },
        true,
      );
      this.disconnect();
      this.scheduleReconnect(0);
    }
    if (daemonBack || agentReady || replaced) void this.history();
  }

  private applyMessage(seq: number, message: SessionMessage) {
    const current = this.view.snapshot;
    if (current === null || seq <= current.hubSeq) return;
    this.publish(
      {
        snapshot: {
          ...current,
          hubSeq: seq,
          messages: [
            ...current.messages.filter(({ commandId }) => commandId !== message.commandId),
            message,
          ],
        },
      },
      true,
    );
  }

  private applyDelivery(
    seq: number,
    id: string,
    status: SessionMessage["status"],
    failureCode: string | null,
  ) {
    const current = this.view.snapshot;
    if (current === null || seq <= current.hubSeq) return;
    const known = current.messages.some(({ commandId }) => commandId === id);
    const messages = current.messages.map((message) =>
      message.commandId === id
        ? { ...message, status, retryable: status === "unknown" && message.retryable }
        : message,
    );
    const announcement = known ? deliveryAnnouncement(status) : undefined;
    this.publish(
      {
        snapshot: { ...current, hubSeq: seq, messages },
        ...(announcement === undefined ? {} : { announcement }),
      },
      known,
    );
    if (known && status === "unknown" && failureCode === "delivery_unconfirmed")
      void this.refresh();
  }

  readonly loadOlder = () => {
    const before = this.view.agent.before;
    if (before === null || this.view.loadingOlder) return;
    this.publish({ loadingOlder: true });
    void this.history(before);
  };

  private async history(before: AgentCursor | null = null) {
    const request = ++this.historyRequest;
    const lifecycle = this.lifecycle;
    const epoch = this.view.agent.epoch;
    const eligible = () =>
      this.active && lifecycle === this.lifecycle && request === this.historyRequest;
    if (before === null && this.view.loadingOlder) this.publish({ loadingOlder: false });
    try {
      const result = await readSessionHistory({ data: { ...this.scope, before, limit: 50 } });
      if (!eligible()) return;
      this.applyHistory(result, before, epoch);
    } catch {
      if (eligible()) this.publish({ history: "history_unavailable" });
    } finally {
      if (eligible() && this.view.loadingOlder) this.publish({ loadingOlder: false });
    }
  }
  private applyHistory(
    result: Awaited<ReturnType<typeof readSessionHistory>>,
    before: AgentCursor | null,
    requestedEpoch: string | null,
  ) {
    if (result.status === "error") {
      this.publish({ history: "history_unavailable" });
      return;
    }
    const page = result.data;
    if ("outcome" in page) {
      if (page.code === "not_found") this.unavailable();
      else this.publish({ history: "history_unavailable" });
      return;
    }
    if ("unavailable" in page) {
      this.publish({ history: page.unavailable });
      return;
    }
    const current = this.view.agent;
    if (current.epoch !== requestedEpoch && current.epoch !== page.epoch) return;
    if (before !== null && before.epoch !== page.epoch) {
      this.publish({ missedUpdates: true });
      void this.history();
      return;
    }
    const agent = mergeHistoryPage(current, page, before !== null);
    const boundaries = this.view.missedUpdates
      ? [
          ...this.view.boundaries,
          {
            kind: "boundary" as const,
            id: `gap:${this.view.version}`,
            seq: agent.cursor?.seq ?? -1,
            label: "Some live updates were missed. Reloaded.",
          },
        ]
      : this.view.boundaries;
    this.publish({ history: "ready", agent, boundaries, missedUpdates: false }, true);
  }
}

function readEvent<T>(schema: z.ZodType<T>, event: MessageEvent<unknown>): T | undefined {
  if (typeof event.data !== "string") return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(event.data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function deliveryAnnouncement(status: SessionMessage["status"]) {
  switch (status) {
    case "delivered":
      return "Message delivered.";
    case "queued":
      return "Message queued.";
    case "unknown":
      return "Message delivery is unknown.";
    case "failed":
      return "Message delivery failed.";
    case "superseded":
      return "Message was not sent.";
    default:
      return undefined;
  }
}
