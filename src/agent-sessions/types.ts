import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { OutputToolDefinition } from "../execution-capabilities/outputs.js";

export type AgentSessionAction = "created" | "continued" | "restored";

interface AgentSessionIdentity {
  id: string;
  organizationId: string;
  projectId: string;
  continuationKey: string | null;
  daemonId: string;
  compatibility: string;
  capabilityTokenHash: string;
  tools: readonly OutputToolDefinition[];
}

export interface ReducedAgentSessionOptions {
  provider: string | null;
  model: string | null;
  toolPolicy?: DaemonCreateAgentOptions["toolPolicy"];
}

export type AgentSessionRecord = AgentSessionIdentity &
  (
    | {
        optionsReducedAt?: null;
        agentId: string | null;
        workspaceId: string | null;
        creationOptions: DaemonCreateAgentOptions;
      }
    | {
        optionsReducedAt: Date;
        agentId: string;
        workspaceId: string;
        creationOptions: ReducedAgentSessionOptions;
      }
  );
