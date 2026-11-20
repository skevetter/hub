import { createHash } from "node:crypto";
import { isCanceledExecution } from "../triggers/run-stop.js";
import { temporaryCredentialFact } from "./credentials.js";
import type { Database, AgentExecutionRecord } from "../db/types.js";
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  type LaunchMachineIntent,
} from "../dispatcher/launch-machine-intent.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";
import type { AgentConnection, AgentEvent } from "../daemons/agents/index.js";
import {
  executionToolDefinitions,
  type OutputExecutorRegistry,
} from "../execution-capabilities/outputs.js";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import type { AgentSessionRecord } from "./types.js";
export type { AgentSessionRecord, AgentSessionAction } from "./types.js";

export class AgentSessionError extends Error {}

/** Owns session selection, delivery, and cleanup under the same existing database lock. */
export class AgentSessions {
  constructor(
    private readonly database: Database,
    private readonly secret: string,
    private readonly publicBaseUrl: string,
    private readonly outputs: OutputExecutorRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  async dispatch(input: {
    executionId: string;
    intent: LaunchMachineIntent;
    connection: AgentConnection;
    createOptions: () => Promise<DaemonCreateAgentOptions>;
    onEvent: (event: AgentEvent) => void;
    /** Called just before the prompt is sent to the daemon, the one step that is not repeatable. */
    beforePromptSend?: () => void;
  }): Promise<{
    agentId: string;
    unsubscribe: () => void;
    action: "created" | "continued" | "restored";
  }> {
    await this.requireActiveExecution(input.executionId);
    const policy = input.intent.continuation;
    const startupTimeoutMs = input.intent.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const continuationKey = policy?.key ?? null;
    const projectId = input.intent.projectId;
    const lockId = deriveSessionId(projectId, continuationKey ?? `execution:${input.executionId}`);
    const findSession = async () => {
      const execution = await this.database.findAgentExecutionById(input.executionId);
      if (execution?.agentSessionId)
        return this.database.findAgentSession(execution.agentSessionId);
      return continuationKey === null
        ? this.database.findAgentSession(
            deriveSessionId(projectId, `execution:${input.executionId}`),
          )
        : this.database.findAgentSessionByKey(projectId, continuationKey);
    };
    const shouldRotateFinishedSession = async (session: AgentSessionRecord) => {
      const executions = await this.database.listAgentSessionExecutions(session.id);
      if (executions.some(isActive)) return false;
      let rotate = false;
      for (const { usedTemporaryCredentials, launchIntent } of executions) {
        const fact = usedTemporaryCredentials ?? temporaryCredentialFact(launchIntent);
        if (fact !== false) rotate = true;
      }
      return rotate;
    };
    // External credential minting must not hold a database connection open during shutdown.
    const storedSession = await findSession();
    const options =
      !storedSession || (await shouldRotateFinishedSession(storedSession))
        ? await input.createOptions()
        : undefined;
    const dispatched = await this.database.withAdvisoryLock(`agent-session:${lockId}`, async () => {
      await this.requireActiveExecution(input.executionId);
      const tools = executionToolDefinitions(
        input.intent.outputSchema,
        this.outputs.materialize(input.intent.allowOutputs, input.intent.outputContext),
      );
      const compatibility = fingerprint({ settings: policy?.compatibility, tools });
      let session = await findSession();
      if (session && (await shouldRotateFinishedSession(session))) {
        // Completion may have raced credential preparation. Retry outside the lock.
        if (!options) return undefined;
        await this.database.saveAgentSession({ ...session, continuationKey: null });
        session = undefined;
      }
      const id = session?.id ?? deriveSessionId(projectId, `execution:${input.executionId}`);
      if (session && session.compatibility !== compatibility) {
        throw new AgentSessionError(
          "Continuation settings differ from the existing agent; use a different key or choose a new agent",
        );
      }
      if (!session) {
        if (!options) return undefined;
        const token = deriveAgentExecutionCompletionToken(this.secret, `session:${id}`);
        session = {
          id,
          projectId: input.intent.projectId,
          organizationId: input.intent.organizationId,
          continuationKey,
          daemonId: input.intent.environment.daemonId,
          agentId: null,
          workspaceId: null,
          compatibility,
          tools,
          capabilityTokenHash: hashAgentExecutionCompletionToken(token),
          creationOptions: {
            ...options,
            ...(policy === undefined
              ? {}
              : {
                  mcpServers: {
                    hub: {
                      type: "http",
                      url: new URL(`/agent-sessions/${id}/mcp`, this.publicBaseUrl).toString(),
                      headers: { Authorization: `Bearer ${token}` },
                    },
                  },
                }),
          },
        };
        await this.database.saveAgentSession(session);
      }
      const activeExecutions = (await this.database.listAgentSessionExecutions(id)).filter(
        (execution) => execution.status === "spawning" || execution.status === "running",
      );
      const deadline = activeExecutions.reduce<number>(
        (earliest, execution) =>
          Math.min(earliest, execution.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(deadline))
        await this.database.limitAgentExecutionDeadline(input.executionId, new Date(deadline));
      await this.database.attachExecutionToSession(input.executionId, id);
      let action: "created" | "continued" | "restored" = "continued";
      if (session.agentId === null) {
        const agent = await input.connection.create(
          id,
          bootstrapOptions(session),
          startupTimeoutMs,
        );
        session = { ...session, agentId: agent.id, workspaceId: agent.workspaceId };
        await this.database.saveAgentSession(session);
        action = "created";
      }
      if (session.agentId === null || session.workspaceId === null)
        throw new Error("Session agent is missing");
      await this.database.attachAgentToExecution(
        input.executionId,
        session.daemonId,
        session.agentId,
      );
      const agent = await input.connection.get(session.agentId);
      if (!agent.archivedAt && (agent.status === "closed" || agent.status === "error")) {
        throw new AgentSessionError("agent_interrupted");
      }
      if (agent.archivedAt) {
        await input.connection.restore(session.workspaceId, startupTimeoutMs);
        action = "restored";
      }
      await this.database.attachExecutionToSession(input.executionId, id, action);
      const unsubscribe = await this.deliver(input, session.agentId, startupTimeoutMs);
      return { agentId: session.agentId, unsubscribe, action };
    });
    return dispatched ?? this.dispatch(input);
  }

  private async requireActiveExecution(executionId: string) {
    const execution = await this.database.findAgentExecutionById(executionId);
    if (execution === undefined || !isActive(execution))
      throw new AgentSessionError("execution_terminal");
    return execution;
  }

  private async deliver(
    input: {
      executionId: string;
      intent: LaunchMachineIntent;
      connection: AgentConnection;
      onEvent: (event: AgentEvent) => void;
      beforePromptSend?: () => void;
    },
    agentId: string,
    startupTimeoutMs: number,
  ): Promise<() => void> {
    const unsubscribe = await input.connection.watch(agentId, input.onEvent);
    try {
      const execution = await this.requireActiveExecution(input.executionId);
      if (execution.deadlineAt !== null && execution.deadlineAt.getTime() <= this.now()) {
        throw new AgentSessionError("execution_deadline_exceeded");
      }
      input.beforePromptSend?.();
      await input.connection.send(
        agentId,
        input.executionId,
        input.intent.continuation === undefined
          ? input.intent.prompt
          : `Hub execution: ${input.executionId}\nUse this executionId for Hub tool calls for this request.\n\n${input.intent.prompt}`,
        startupTimeoutMs,
      );
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async control(
    execution: AgentExecutionRecord,
    connection: AgentConnection,
    action: "interrupt" | "archive",
  ): Promise<readonly string[] | undefined> {
    const canceled = isCanceledExecution(execution);
    if (!execution.agentSessionId) {
      if (action === "interrupt" && canceled && execution.daemonAgentId !== null) {
        const agent = await connection.get(execution.daemonAgentId);
        await connection.control(agent.id, agent.workspaceId, action);
      }
      return [];
    }
    const id = execution.agentSessionId;
    const session = await this.database.findAgentSession(id);
    if (session === undefined) return canceled ? [] : undefined;
    if (!canceled && (!session.agentId || !session.workspaceId)) return undefined;
    return this.database.withAdvisoryLock(sessionLock(session), async () => {
      // Agent creation holds the same lock. If it never finished, it could not send a prompt.
      const target = canceled ? await this.database.findAgentSession(id) : session;
      if (!target?.agentId || !target.workspaceId) return canceled ? [] : undefined;
      const executions = await this.database.listAgentSessionExecutions(id);
      const active = executions.filter(isActive);
      // Automatic terminal actions cannot interrupt a newer arrival. An explicit Stop can.
      if (!canceled && active.length > 0) return [];
      await connection.control(target.agentId, target.workspaceId, action);
      return active.map((arrival) => arrival.id);
    });
  }

  async releaseAuthority(
    execution: AgentExecutionRecord,
    release: (executionId: string) => Promise<void>,
  ): Promise<void> {
    const sessionId = execution.agentSessionId;
    const session =
      sessionId === null ? undefined : await this.database.findAgentSession(sessionId);
    const owners =
      sessionId === null || !session
        ? [execution.id]
        : await this.database.withAdvisoryLock(sessionLock(session), async () => {
            const executions = await this.database.listAgentSessionExecutions(sessionId);
            if (executions.some((item) => item.status === "spawning" || item.status === "running"))
              return [];
            return executions.map((item) => item.id);
          });
    // Revocation can call upstream services; do not keep a database lock while it runs.
    await Promise.all(owners.map(release));
  }

  async canResumeAuthority(
    execution: AgentExecutionRecord,
    available: (executionId: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (execution.agentSessionId === null) return available(execution.id);
    const owners = await this.database.listAgentSessionExecutions(execution.agentSessionId);
    for (const owner of owners) {
      if (await available(owner.id)) return true;
    }
    return false;
  }
}

function bootstrapOptions(session: AgentSessionRecord): DaemonCreateAgentOptions {
  if (session.optionsReducedAt != null) throw new Error("Reduced session is missing its agent");
  return session.creationOptions;
}

function deriveSessionId(projectId: string, key: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["agent-session", projectId, key]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}

function isActive(execution: AgentExecutionRecord): boolean {
  return execution.status === "spawning" || execution.status === "running";
}
export function sessionLock(
  session: Pick<AgentSessionRecord, "id" | "projectId" | "continuationKey">,
): string {
  return `agent-session:${session.continuationKey === null ? session.id : deriveSessionId(session.projectId, session.continuationKey)}`;
}
