import type { SessionEventRecord, TranscriptItem } from "./types.js";

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
  evictedThrough: number;
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
      try {
        listener(notification);
      } catch (error) {
        try {
          this.reportFailure?.(error);
        } catch {}
      }
    }
  }

  readAgentItems(
    sessionId: string,
    epoch: string,
    afterSeq: number,
  ):
    | { status: "available"; items: TranscriptItem[] }
    | { status: "unavailable"; reason: "epoch_changed" | "behind" } {
    const buffer = this.agentBuffers.get(sessionId);
    if (!buffer) return { status: "unavailable", reason: "behind" };
    if (buffer.epoch !== epoch) return { status: "unavailable", reason: "epoch_changed" };
    if (afterSeq < buffer.evictedThrough) return { status: "unavailable", reason: "behind" };
    return {
      status: "available",
      items: buffer.items
        .filter(({ item }) => item.seq > afterSeq)
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
        evictedThrough: item.seq - 1,
        eviction: buffer?.eviction,
      };
      this.agentBuffers.set(sessionId, buffer);
    }
    const last = buffer.items.at(-1);
    if (item.seq <= (last?.item.seq ?? buffer.evictedThrough)) return;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    buffer.items.push({ item: structuredClone(item), bytes });
    buffer.bytes += bytes;
    while (buffer.items.length > MAX_AGENT_ITEMS || buffer.bytes > MAX_AGENT_BYTES) {
      const removed = buffer.items.shift()!;
      buffer.bytes -= removed.bytes;
      buffer.evictedThrough = removed.item.seq;
    }
  }
}
