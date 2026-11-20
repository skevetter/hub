import { randomUUID } from "node:crypto";
import {
  AgentStreamMessageSchema,
  AgentTimelineCursorSchema,
  AgentTimelineEntryPayloadSchema,
  FetchAgentTimelineResponseMessageSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  HubExecutionAgentStreamEventSchema,
  HubExecutionAgentSnapshotSchema,
} from "../../hub/protocol.js";
import type { DaemonCreateAgentOptions } from "../protocol.js";
import { DaemonResponseLostError } from "../protocol.js";

const SnapshotSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: HubExecutionAgentSnapshotSchema.shape.status,
  archivedAt: z.unknown().optional(),
});
const StreamSchema = AgentStreamMessageSchema.shape.payload
  .pick({ agentId: true, timestamp: true, seq: true, epoch: true })
  .extend({ event: HubExecutionAgentStreamEventSchema });
const TimelinePageSchema = FetchAgentTimelineResponseMessageSchema.shape.payload
  .pick({
    epoch: true,
    reset: true,
    staleCursor: true,
    gap: true,
    startCursor: true,
    endCursor: true,
    hasOlder: true,
    hasNewer: true,
  })
  .extend({
    entries: z.array(
      AgentTimelineEntryPayloadSchema.pick({
        item: true,
        turnId: true,
        timestamp: true,
        seqStart: true,
        seqEnd: true,
      }),
    ),
  });
export type AgentSnapshot = z.infer<typeof SnapshotSchema>;
export type AgentEvent =
  | { type: "agent_update" | "agent_snapshot"; agent: AgentSnapshot; timestamp: string }
  | ({ type: "agent_stream" } & z.infer<typeof StreamSchema>);
type AgentTimelineCursor = z.infer<typeof AgentTimelineCursorSchema>;
interface AgentTimelineQuery {
  direction: "tail" | "before" | "after";
  cursor?: AgentTimelineCursor;
  limit: number;
}
export type AgentTimelinePage = z.infer<typeof TimelinePageSchema>;
export interface AgentHistory {
  timeline(agentId: string, query: AgentTimelineQuery): Promise<AgentTimelinePage>;
}
export interface AgentConnection {
  create(
    key: string,
    options: DaemonCreateAgentOptions,
    timeoutMs?: number,
  ): Promise<AgentSnapshot>;
  get(agentId: string): Promise<AgentSnapshot>;
  send(agentId: string, messageId: string, text: string, timeoutMs?: number): Promise<void>;
  restore(workspaceId: string, timeoutMs?: number): Promise<boolean>;
  control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive",
    onWritten?: () => void,
  ): Promise<void>;
  archiveAgent?(agentId: string, timeoutMs?: number): Promise<void>;
  watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void>;
}

const EnvelopeSchema = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
});
const ResultSchema = z
  .object({ error: z.string().nullable().optional(), accepted: z.boolean().optional() })
  .passthrough();

export class DaemonAgentError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
export class DaemonAgentMissingError extends DaemonAgentError {}
export class DaemonFrameNotSentError extends DaemonResponseLostError {}

/** The ordinary daemon protocol. This channel knows nothing about Hub executions or triggers. */
export class DaemonAgents implements AgentConnection, AgentHistory {
  private supported = false;
  private closed = false;
  private readonly pending = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private observing = false;
  constructor(
    private readonly sendFrame: (frame: string) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly reportFailure: (error: unknown, operation: string) => void = () => {},
  ) {}

  receive(value: unknown): boolean {
    if (this.closed) return false;
    const envelope = EnvelopeSchema.safeParse(value);
    if (!envelope.success) return false;
    const { type, payload } = envelope.data.message;
    if (type === "server_info" || (type === "status" && payload["status"] === "server_info")) {
      const features = z
        .object({ hubAgentRpc: z.literal(true), agentRequestReceipts: z.literal(true) })
        .safeParse(payload["features"]);
      this.supported = features.success;
      return false;
    }
    const requestId = payload["requestId"];
    const pending = typeof requestId === "string" ? this.pending.get(requestId) : undefined;
    if (pending) {
      if (type === "rpc_error" || payload["status"] === "agent_create_failed") {
        pending.reject(
          new DaemonAgentError(
            z.string().catch("Daemon request rejected").parse(payload["error"]),
            type === "rpc_error" && typeof payload["code"] === "string"
              ? payload["code"]
              : undefined,
          ),
        );
      } else pending.resolve(payload);
      return true;
    }
    if (type === "agent_update" && payload["kind"] === "upsert") {
      const agent = SnapshotSchema.safeParse(payload["agent"]);
      if (agent.success)
        this.emit(agent.data.id, { type, agent: agent.data, timestamp: this.now().toISOString() });
      return true;
    }
    if (type === "agent_stream") {
      const stream = StreamSchema.safeParse(payload);
      if (stream.success)
        this.emit(stream.data.agentId, {
          type,
          ...stream.data,
          timestamp: this.now().toISOString(),
        });
      return true;
    }
    return false;
  }

  close(): void {
    this.closed = true;
    this.supported = false;
    this.observing = false;
    for (const pending of this.pending.values()) pending.reject(new DaemonResponseLostError());
    this.pending.clear();
    this.listeners.clear();
  }

  async create(
    key: string,
    options: DaemonCreateAgentOptions,
    timeoutMs?: number,
  ): Promise<AgentSnapshot> {
    const response = await this.request(
      {
        type: "create_agent_request",
        idempotencyKey: key,
        config: {
          provider: options.provider,
          title: options.title,
          cwd: options.cwd,
          model: options.model,
          modeId: options.mode,
          thinkingOptionId: options.thinkingOptionId,
          providerOptions: options.providerOptions,
          mcpServers: options.mcpServers,
          toolPolicy: options.toolPolicy,
        },
        env: options.env,
        worktree: options.worktree,
        background: options.background,
      },
      timeoutMs,
    );
    const agent = SnapshotSchema.parse(response["agent"]);
    if (options.workspaceTitle !== undefined)
      await this.titleWorkspace(agent.workspaceId, options.workspaceTitle);
    return agent;
  }
  /**
   * The daemon takes no workspace title on create and never auto-names a workspace whose agent
   * starts without a prompt, so the workspace is titled after the agent exists. The agent is
   * already created and titled, so a failure here is reported and the dispatch continues.
   */
  private async titleWorkspace(workspaceId: string, title: string): Promise<void> {
    try {
      await this.request({ type: "workspace.title.set.request", workspaceId, title });
    } catch (error) {
      if (this.closed || error instanceof DaemonResponseLostError) throw error;
      this.reportFailure(error, "daemon.workspace.title.set");
    }
  }
  async get(agentId: string): Promise<AgentSnapshot> {
    const response = await this.request({ type: "fetch_agent_request", agentId });
    if (response["agent"] === null)
      throw new DaemonAgentMissingError(
        "Continuation agent was deleted; use a new key or choose a new agent",
      );
    return SnapshotSchema.parse(response["agent"]);
  }
  async timeline(agentId: string, query: AgentTimelineQuery): Promise<AgentTimelinePage> {
    const response = await this.request({
      ...query,
      type: "fetch_agent_timeline_request",
      agentId,
      projection: "projected",
    });
    return TimelinePageSchema.parse(response);
  }
  async send(agentId: string, messageId: string, text: string, timeoutMs?: number): Promise<void> {
    await this.request(
      {
        type: "send_agent_message_request",
        agentId,
        messageId,
        text,
        activeTurnBehavior: "steer",
      },
      timeoutMs,
    );
  }
  async restore(workspaceId: string, timeoutMs?: number): Promise<boolean> {
    const result = await this.request({ type: "workspace.recovery.inspect.request", workspaceId });
    const state = z
      .object({ kind: z.string(), reason: z.string().optional() })
      .parse(result["state"]);
    if (state.kind === "unavailable" && state.reason === "workspace_not_archived") return false;
    if (state.kind !== "recoverable")
      throw new DaemonAgentError(
        "Workspace cannot be restored; inspect its recovery state in Paseo",
      );
    await this.request({ type: "workspace.recovery.restore.request", workspaceId }, timeoutMs);
    return true;
  }
  async control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive",
    onWritten?: () => void,
  ): Promise<void> {
    await this.request(
      action === "archive"
        ? { type: "archive_workspace_request", workspaceId }
        : { type: "cancel_agent_request", agentId },
      undefined,
      onWritten,
    );
  }
  async archiveAgent(agentId: string, timeoutMs?: number): Promise<void> {
    await this.request({ type: "archive_agent_request", agentId }, timeoutMs);
  }
  async watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void> {
    this.assertOpen();
    const listeners = this.listeners.get(agentId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(agentId, listeners);
    try {
      if (!this.observing) {
        await this.request({
          type: "fetch_agents_request",
          includeBackground: true,
          subscribe: { subscriptionId: "hub-continuation" },
        });
        this.assertOpen();
        this.observing = true;
      }
      await this.request({
        type: "agent.timeline.set_subscription.request",
        agentIds: [...this.listeners.keys()],
      });
      // Subscribe before reading so a state change after the snapshot is still observed.
      // Fetch individually: the directory is paginated and later watches share its subscription.
      try {
        const response = await this.request({ type: "fetch_agent_request", agentId });
        this.assertOpen();
        const agent = SnapshotSchema.safeParse(response["agent"]);
        if (agent.success && agent.data.id === agentId)
          listener({
            type: "agent_snapshot",
            agent: agent.data,
            timestamp: this.now().toISOString(),
          });
      } catch (error) {
        if (this.closed || error instanceof DaemonResponseLostError) throw error;
        // Snapshot reads are best effort; older daemons keep their live subscription usable.
        this.reportFailure(error, "daemon.agent.watch.snapshot");
      }
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(agentId);
      throw error;
    }
    this.assertOpen();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(agentId);
    };
  }
  private emit(agentId: string, event: AgentEvent): void {
    for (const listener of this.listeners.get(agentId) ?? []) listener(event);
  }
  private assertOpen(): void {
    if (this.closed) throw new DaemonFrameNotSentError();
  }
  private async request(
    message: Record<string, unknown>,
    timeoutMs = 30_000,
    onWritten?: () => void,
  ): Promise<Record<string, unknown>> {
    this.assertOpen();
    if (!this.supported) throw new DaemonAgentError("Update the Paseo daemon to run Hub agents");
    const requestId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        timeout = setTimeout(() => reject(new DaemonResponseLostError()), timeoutMs);
        this.sendFrame(JSON.stringify({ type: "session", message: { ...message, requestId } }));
        onWritten?.();
      });
      const parsed = ResultSchema.parse(result);
      if (parsed.error || parsed.accepted === false)
        throw new DaemonAgentError(parsed.error ?? "Daemon request rejected");
      return result;
    } finally {
      clearTimeout(timeout);
      this.pending.delete(requestId);
    }
  }
}
