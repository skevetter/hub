import { randomUUID } from "node:crypto";
import type { AgentConnection, AgentSnapshot } from "../daemons/agents/index.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";

export class TestAgents implements AgentConnection {
  readonly agents = new Map<string, AgentSnapshot>();
  readonly deliveries: { agentId: string; text: string }[] = [];
  readonly creates: DaemonCreateAgentOptions[] = [];
  readonly messages = new Set<string>();
  archives = 0;
  restorations = 0;
  async create(_key: string, options: DaemonCreateAgentOptions) {
    this.creates.push(options);
    const agent = { id: randomUUID(), workspaceId: randomUUID(), status: "idle" as const };
    this.agents.set(agent.id, agent);
    return agent;
  }
  async get(id: string) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("missing");
    return agent;
  }
  async send(agentId: string, messageId: string, text: string) {
    if (this.messages.has(messageId)) return;
    this.messages.add(messageId);
    this.deliveries.push({ agentId, text });
  }
  async watch() {
    return () => {};
  }
  async restore(workspaceId: string) {
    this.restorations++;
    for (const [id, agent] of this.agents)
      if (agent.workspaceId === workspaceId) this.agents.set(id, { ...agent, archivedAt: null });
    return true;
  }
  async control(agentId: string, _workspaceId: string, action: "interrupt" | "archive") {
    if (action === "archive") {
      this.archives++;
      this.agents.set(agentId, {
        ...(await this.get(agentId)),
        archivedAt: new Date().toISOString(),
      });
    }
  }
}
