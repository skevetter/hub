import {
  compareAgentPosition,
  type AgentPosition,
  type SessionEventRecord,
  type TranscriptItem,
} from "./types.js";

export type SessionNotification =
  | { kind: "hub"; event: SessionEventRecord }
  | { kind: "agent"; epoch: string; item: TranscriptItem }
  | { kind: "access_changed" }
  | { kind: "connection"; online: boolean }
  | { kind: "gap"; reason: "daemon_disconnected" | "epoch_changed" | "behind" }
  | { kind: "resync" }
  | { kind: "shutdown"; reconnectMs: number };

type Listener = (notification: SessionNotification) => void;

interface AgentBuffer {
  epoch: string;
  items: { item: TranscriptItem; bytes: number }[];
  bytes: number;
  evictedThrough: AgentPosition;
  eviction: NodeJS.Timeout | undefined;
}

const MAX_AGENT_ITEMS = 256;
const MAX_AGENT_BYTES = 512 * 1024;
const NO_VIEWER_MS = 5 * 60_000;

export class SessionEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly agentBuffers = new Map<string, AgentBuffer>();

  constructor(private readonly reportFailure?: (error: unknown) => void) {}

  subscribe(sessionId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<Listener>();
    const buffer = this.agentBuffers.get(sessionId);
    clearTimeout(buffer?.eviction);
    const subscription: Listener = (notification) => listener(notification);
    listeners.add(subscription);
    this.listeners.set(sessionId, listeners);
    return () => {
      if (!listeners.delete(subscription) || listeners.size !== 0) return;
      this.listeners.delete(sessionId);
      const current = this.agentBuffers.get(sessionId);
      if (current)
        current.eviction = setTimeout(() => this.clearAgentItems(sessionId), NO_VIEWER_MS).unref();
    };
  }

  publish(sessionId: string, notification: SessionNotification): void {
    if (notification.kind === "agent")
      this.rememberAgentItem(sessionId, notification.epoch, notification.item);
    if (
      notification.kind === "hub" &&
      notification.event.kind === "state" &&
      notification.event.data.state === "closed"
    ) {
      this.clearAgentItems(sessionId);
    }
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of Array.from(listeners)) {
      if (!listeners.has(listener)) continue;
      this.notify(listener, notification);
    }
  }

  private notify(listener: Listener, notification: SessionNotification): void {
    try {
      listener(notification);
    } catch (error) {
      try {
        this.reportFailure?.(error);
      } catch {}
    }
  }

  readAgentItems(
    sessionId: string,
    epoch: string,
    after: AgentPosition,
  ):
    | { status: "available"; items: TranscriptItem[] }
    | { status: "unavailable"; reason: "epoch_changed" | "behind" } {
    const buffer = this.agentBuffers.get(sessionId);
    if (!buffer) return { status: "unavailable", reason: "behind" };
    if (buffer.epoch !== epoch) return { status: "unavailable", reason: "epoch_changed" };
    if (compareAgentPosition(after, buffer.evictedThrough) < 0)
      return { status: "unavailable", reason: "behind" };
    return {
      status: "available",
      items: buffer.items
        .filter(({ item }) => compareAgentPosition(item, after) > 0)
        .map(({ item }) => structuredClone(item)),
    };
  }

  clearAgentItems(sessionId: string): void {
    clearTimeout(this.agentBuffers.get(sessionId)?.eviction);
    this.agentBuffers.delete(sessionId);
  }

  private rememberAgentItem(sessionId: string, epoch: string, item: TranscriptItem): void {
    let buffer = this.agentBuffers.get(sessionId);
    if (!buffer && !this.listeners.has(sessionId)) return;
    if (buffer?.epoch !== epoch) {
      buffer = {
        epoch,
        items: [],
        bytes: 0,
        evictedThrough: positionBefore(item),
        eviction: buffer?.eviction,
      };
      this.agentBuffers.set(sessionId, buffer);
    }
    const last = buffer.items.at(-1);
    if (compareAgentPosition(item, last?.item ?? buffer.evictedThrough) <= 0) return;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    buffer.items.push({ item: structuredClone(item), bytes });
    buffer.bytes += bytes;
    trimAgentBuffer(buffer);
  }
}

function positionBefore(item: TranscriptItem): AgentPosition {
  return item.kind === "assistant" && item.chunkStart !== undefined
    ? { seq: item.seq, chunkOffset: item.chunkStart }
    : { seq: item.seq - 1 };
}

function trimAgentBuffer(buffer: AgentBuffer): void {
  while (buffer.items.length > MAX_AGENT_ITEMS || buffer.bytes > MAX_AGENT_BYTES) {
    const removed = buffer.items.shift();
    if (removed === undefined)
      throw new TypeError("Cannot read properties of undefined (reading 'bytes')");
    buffer.bytes -= removed.bytes;
    const offset = removed.item.kind === "assistant" ? removed.item.chunkOffset : undefined;
    buffer.evictedThrough = {
      seq: removed.item.seq,
      ...(offset === undefined ? {} : { chunkOffset: offset }),
    };
  }
}
