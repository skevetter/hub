import type {
  AgentConnection,
  AgentEvent,
  AgentHistory,
  AgentSnapshot,
} from "../../daemons/agents/index.js";
import type { DaemonConnection, DaemonCreateAgentOptions } from "../../daemons/protocol.js";

export class FakeAgents implements AgentConnection, AgentHistory {
  readonly creations: { key: string; options: DaemonCreateAgentOptions }[] = [];
  readonly sends: { agentId: string; messageId: string; text: string }[] = [];
  readonly interrupts: string[] = [];
  readonly archives: string[] = [];
  readonly watches: string[] = [];
  readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly receipts = new Map<string, AgentSnapshot>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  afterCreate?: (() => Promise<void>) | undefined;
  afterSend?: (() => Promise<void>) | undefined;
  afterInterrupt?: (() => Promise<void>) | undefined;

  readonly connection: DaemonConnection = {
    agents: this,
    history: this,
    async getProviderSnapshot() {
      throw new Error("Unexpected provider snapshot");
    },
    async refreshProviderSnapshot() {
      throw new Error("Unexpected provider refresh");
    },
    async validateAgentConfiguration() {
      return { valid: true };
    },
  };

  async create(key: string, options: DaemonCreateAgentOptions) {
    this.creations.push({ key, options });
    let agent = this.receipts.get(key);
    if (!agent) {
      const id = "agent-" + (this.receipts.size + 1);
      agent = { id, workspaceId: id + "-workspace", status: "idle" };
      this.snapshots.set(id, agent);
      this.receipts.set(key, agent);
    }
    await this.afterCreate?.();
    return structuredClone(agent);
  }

  async get(agentId: string) {
    const agent = this.snapshots.get(agentId);
    if (!agent) throw new Error("Missing fixture snapshot");
    return structuredClone(agent);
  }

  async send(agentId: string, messageId: string, text: string) {
    this.sends.push({ agentId, messageId, text });
    const agent = this.snapshots.get(agentId);
    if (agent === undefined) throw new Error("fake agents invariant: expected a send snapshot");
    agent.status = "running";
    await this.afterSend?.();
  }

  async control(agentId: string, _workspaceId: string, action: "interrupt" | "archive") {
    if (action === "archive") throw new Error("Unexpected workspace archive");
    this.interrupts.push(agentId);
    await this.afterInterrupt?.();
  }

  async archiveAgent(agentId: string) {
    this.archives.push(agentId);
  }

  async restore(): Promise<boolean> {
    throw new Error("Unexpected restore");
  }

  async timeline(): ReturnType<AgentHistory["timeline"]> {
    throw new Error("Unexpected history request");
  }

  async watch(agentId: string, listener: (event: AgentEvent) => void) {
    this.watches.push(agentId);
    const listeners = this.listeners.get(agentId) ?? new Set();
    this.listeners.set(agentId, listeners);
    listeners.add(listener);
    listener({
      type: "agent_snapshot",
      agent: await this.get(agentId),
      timestamp: new Date().toISOString(),
    });
    return () => listeners.delete(listener);
  }

  emit(
    agentId: string,
    event: Extract<AgentEvent, { type: "agent_stream" }>["event"],
    cursor?: { seq: number; epoch: string },
  ) {
    const agent = this.snapshots.get(agentId);
    const finished =
      event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed";
    if (finished || event.type === "turn_started") {
      if (agent === undefined) throw new Error("fake agents invariant: expected a turn snapshot");
      agent.status = finished ? "idle" : "running";
    }
    for (const listener of this.listeners.get(agentId) ?? []) {
      listener({
        type: "agent_stream",
        agentId,
        event,
        timestamp: new Date().toISOString(),
        ...cursor,
      });
    }
  }
}
