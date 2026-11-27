import type { ErrorObject } from "ajv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  deriveAgentExecutionCompletionToken,
  verifyAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import type { AgentSessionRecord } from "../agent-sessions/types.js";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import { registerResponseLifecycle } from "../http/response-lifecycle.js";
import { reportFailure, withReference } from "../failures/index.js";
import { compileJsonSchema, formatJsonSchemaErrors } from "../workflows/json-schema.js";
import type { FinishCallRegistry } from "./finish-calls.js";
import {
  executionToolDefinitions,
  finishExecutionToolName,
  type MaterializedOutputCapability,
  type OutputExecutorRegistry,
  type OutputToolSchema,
} from "./outputs.js";

type JsonSchema = OutputToolSchema;

export interface ExecutionCapabilityServer {
  handleSession(request: Request, sessionId: string): Promise<Response>;
  handle(request: Request, executionId: string): Promise<Response>;
}

interface ExecutionCapabilityOptions {
  completionTokenSecret?: string;
  database: Database;
  outputs: OutputExecutorRegistry;
  completeExecution(input: {
    executionId: string;
    token: string;
    output?: unknown;
  }): Promise<AgentExecutionRecord>;
  now?: () => Date;
  /** Told when a finish_execution call starts and ends, keyed by the execution that made it. */
  finishCalls?: FinishCallRegistry;
}

export function createExecutionCapabilityServer(
  options: ExecutionCapabilityOptions,
): ExecutionCapabilityServer {
  return {
    handleSession: createSessionHandler(options),
    handle: createExecutionHandler(options),
  };
}

function createSessionHandler(
  options: ExecutionCapabilityOptions,
): ExecutionCapabilityServer["handleSession"] {
  return async function handleSession(request, sessionId) {
    const token = readBearerToken(request.headers.get("authorization") ?? undefined);
    const session = z.uuid().safeParse(sessionId).success
      ? await options.database.findAgentSession(sessionId)
      : undefined;
    if (
      !session ||
      !token ||
      !options.completionTokenSecret ||
      !verifyAgentExecutionCompletionToken(token, session.capabilityTokenHash)
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const server = createCapabilityMcpServer("paseo-hub-session");
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: session.tools.map((tool) => ({
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            executionId: {
              type: "string",
              description: "Execution ID supplied with the request prompt.",
            },
          },
          required: [...(tool.inputSchema.required ?? []), "executionId"],
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (call) =>
      callSessionTool(options, session, call),
    );
    return serveMcp(request, sessionId, server);
  };
}

async function callSessionTool(
  options: ExecutionCapabilityOptions,
  session: AgentSessionRecord,
  call: CallToolRequest,
) {
  const { executionId, ...args } = call.params.arguments ?? {};
  if (typeof executionId !== "string" || !z.uuid().safeParse(executionId).success)
    return toolFailure("A valid executionId is required");
  const execution = await options.database.findAgentExecutionById(executionId);
  if (
    !execution ||
    execution.agentSessionId !== session.id ||
    (execution.status !== "spawning" && execution.status !== "running")
  ) {
    return toolFailure("Execution is not live in this agent session");
  }
  const outputs = options.outputs.materialize(
    execution.launchIntent?.allowOutputs ?? [],
    execution.outputContext,
  );
  return callExecutionTool({
    options,
    execution,
    token: sessionCompletionToken(options.completionTokenSecret, execution.id),
    materializedOutputs: outputs,
    toolName: call.params.name,
    args,
  });
}

function sessionCompletionToken(secret: string | undefined, executionId: string): string {
  if (secret === undefined) {
    // Preserve the HMAC error if the secret disappears after session authentication.
    throw Object.assign(
      new TypeError(
        'The "key" argument must be of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey. Received undefined',
      ),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
  return deriveAgentExecutionCompletionToken(secret, executionId);
}

function createExecutionHandler(
  options: ExecutionCapabilityOptions,
): ExecutionCapabilityServer["handle"] {
  return async function handle(request, executionId) {
    const token = readBearerToken(request.headers.get("authorization") ?? undefined);
    const execution = await authenticateExecution(options.database, executionId, token);
    if (execution === undefined || token === undefined) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (execution.status !== "spawning" && execution.status !== "running") {
      return Response.json({ error: "execution_not_live" }, { status: 409 });
    }
    let materializedOutputs: readonly MaterializedOutputCapability[];
    try {
      materializedOutputs = options.outputs.materialize(
        execution.launchIntent?.allowOutputs ?? [],
        execution.outputContext,
      );
    } catch (error) {
      const failure = reportFailure(error, {
        operation: "execution_capability.materialize_outputs",
        component: "execution_capabilities",
        executionId,
      });
      return Response.json(
        {
          error: "required_output_capability_unavailable",
          message: withReference(outputCapabilityMessage(error), failure.requestId),
        },
        { status: 409 },
      );
    }

    const server = createMcpServer(options, execution, token, materializedOutputs);
    return serveMcp(request, executionId, server);
  };
}

async function serveMcp(
  request: Request,
  executionId: string,
  server: McpServer["server"],
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Omitting sessionIdGenerator is the SDK's stateless-mode setting.
    enableJsonResponse: true,
    enableDnsRebindingProtection: false,
  });
  let responseLifecycleRegistered = false;
  const closeMcp = async (): Promise<void> => {
    await closeCapabilityResource("mcp_server", executionId, () => server.close());
    await closeCapabilityResource("mcp_transport", executionId, () => transport.close());
  };
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    responseLifecycleRegistered = true;
    return registerResponseLifecycle(response, {
      // HTTP finish only proves that Node flushed the MCP response. The
      // provider still has to acknowledge its subsequent turn before a
      // deferred Hub archive action can be reconciled.
      onFinish: closeMcp,
      onAbort: closeMcp,
    });
  } finally {
    if (!responseLifecycleRegistered) await closeMcp();
  }
}

function outputCapabilityMessage(error: unknown): string {
  if (error instanceof Error && error.name === "OutputCapabilityValidationError") {
    return error.message;
  }
  return "A required output capability is unavailable. Check the workflow output configuration.";
}

async function authenticateExecution(
  database: Database,
  executionId: string,
  token: string | undefined,
): Promise<AgentExecutionRecord | undefined> {
  if (!z.uuid().safeParse(executionId).success || token === undefined) return undefined;
  const execution = await database.findAgentExecutionById(executionId);
  if (
    execution === undefined ||
    execution.completionTokenHash === null ||
    !verifyAgentExecutionCompletionToken(token, execution.completionTokenHash)
  ) {
    return undefined;
  }
  return execution;
}

function createCapabilityMcpServer(name: string): McpServer["server"] {
  // The raw handlers expose the original JSON Schemas without SDK conversion.
  return new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } }).server;
}

function createMcpServer(
  options: ExecutionCapabilityOptions,
  execution: AgentExecutionRecord,
  token: string,
  materializedOutputs: readonly MaterializedOutputCapability[],
): McpServer["server"] {
  const server = createCapabilityMcpServer("paseo-hub-execution");
  const tools = executionToolDefinitions(execution.launchIntent?.outputSchema, materializedOutputs);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callExecutionTool({
      options,
      execution,
      token,
      materializedOutputs,
      toolName: request.params.name,
      args: request.params.arguments ?? {},
    }),
  );
  return server;
}

interface FinishExecutionCallOptions {
  options: ExecutionCapabilityOptions;
  execution: AgentExecutionRecord;
  token: string;
  args: Record<string, unknown>;
  materializedOutputs: readonly MaterializedOutputCapability[];
}

interface ExecutionToolCallOptions extends FinishExecutionCallOptions {
  toolName: string;
}

async function callExecutionTool({
  options,
  execution,
  token,
  materializedOutputs,
  toolName,
  args,
}: ExecutionToolCallOptions) {
  const tool = executionToolDefinitions(
    execution.launchIntent?.outputSchema,
    materializedOutputs,
  ).find((candidate) => candidate.name === toolName);
  if (!tool) return toolFailure(`Tool ${toolName} not found`);
  const contract =
    toolName === finishExecutionToolName
      ? finishExecutionContract(tool.inputSchema)
      : jsonSchemaContract(tool.inputSchema);
  const validation = contract.validate(args);
  if (!validation.valid) return toolFailure(validation.message);
  if (toolName === finishExecutionToolName)
    return finishExecutionCall({ options, execution, token, args, materializedOutputs });
  const output = materializedOutputs.find((item) => item.capability.tool.name === toolName);
  return output === undefined
    ? toolFailure(`Tool ${toolName} not found`)
    : executeOutputCall({ options, execution, toolName, output, args });
}

/**
 * Both MCP entry points reach finish_execution here with the owning execution known, so the
 * registry hears about the call before it runs and how it ended.
 */
async function finishExecutionCall(input: FinishExecutionCallOptions) {
  const { options, execution } = input;
  options.finishCalls?.start(execution.id);
  let outcome: "completed" | "failed" = "failed";
  try {
    const result = await attemptFinishExecution(input);
    if (!("isError" in result)) outcome = "completed";
    return result;
  } finally {
    options.finishCalls?.resolve(execution.id, outcome);
    await releaseIfTerminal(options, execution.id);
  }
}

/**
 * The handler checks that an execution is live before it reads the request, so a delayed call can
 * start after the execution ended and was released, which would recreate its entry. Nothing else
 * releases it then, so the call's end does, based on the execution's stored state.
 */
async function releaseIfTerminal(
  options: Pick<ExecutionCapabilityOptions, "database" | "finishCalls">,
  executionId: string,
): Promise<void> {
  if (options.finishCalls === undefined) return;
  try {
    const current = await options.database.findAgentExecutionById(executionId);
    if (current === undefined || current.status === "succeeded" || current.status === "failed") {
      options.finishCalls.release(executionId);
    }
  } catch {
    // A failed read must not replace the tool result; the entry is freed when the process ends.
  }
}

async function attemptFinishExecution({
  options,
  execution,
  token,
  args,
  materializedOutputs,
}: FinishExecutionCallOptions) {
  try {
    const missingOutputs = missingRequiredOutputs(execution, materializedOutputs);
    if (missingOutputs.length > 0) return finishMissingOutputs(execution, missingOutputs);
    const output = Object.hasOwn(args, "output") ? args["output"] : undefined;
    const completed = await options.completeExecution({
      executionId: execution.id,
      token,
      ...(output === undefined ? {} : { output }),
    });
    if (completed.status !== "succeeded") {
      reportFailure(
        new Error(`execution completion ended with status ${completed.status}`),
        {
          operation: "execution_capability.finish.transition",
          component: "execution_capabilities",
          executionId: execution.id,
        },
        { kind: "conflict" },
      );
      return toolFailure(
        "Execution could not be finished because its state changed. Reload its current status before finishing again.",
      );
    }
    await options.database.recordAgentExecutionHubAcknowledgement(execution.id, {
      kind: "finish_execution",
      status: "completed",
      observedAt: options.now?.() ?? new Date(),
    });
    return toolSuccess("Execution finished");
  } catch (error) {
    const failure = reportFailure(error, {
      operation: "execution_capability.finish",
      component: "execution_capabilities",
      executionId: execution.id,
    });
    return toolFailure(
      withReference(
        "Execution could not be finished. Check its current status and required outputs.",
        failure.requestId,
      ),
    );
  }
}

function finishMissingOutputs(
  execution: AgentExecutionRecord,
  missingOutputs: ReturnType<typeof missingRequiredOutputs>,
) {
  reportFailure(
    new Error("required execution outputs are missing"),
    {
      operation: "execution_capability.finish.required_outputs",
      component: "execution_capabilities",
      executionId: execution.id,
    },
    { kind: "validation" },
  );
  return toolFailure(requiredOutputsGuidance(missingOutputs));
}

interface OutputCallOptions {
  options: ExecutionCapabilityOptions;
  execution: AgentExecutionRecord;
  toolName: string;
  output: MaterializedOutputCapability;
  args: Record<string, unknown>;
}

async function executeOutputCall({
  options,
  execution,
  toolName,
  output,
  args,
}: OutputCallOptions) {
  const attempt = await options.database.beginAgentExecutionOutput(
    execution.id,
    output.declaration.type,
    output.declaration.max,
    capabilityTime(options),
  );
  if (attempt === undefined) return outputLimitFailure(execution, output);
  try {
    await options.outputs.execute({
      agentExecutionId: execution.id,
      attemptId: attempt.id,
      toolType: output.declaration.type,
      args,
      outputContext: execution.outputContext,
    });
    const recorded = await options.database.completeAgentExecutionOutput(
      execution.id,
      attempt.id,
      capabilityTime(options),
    );
    if (recorded === undefined) throw new Error("output emission could not be recorded");
    return toolSuccess("Output sent");
  } catch (error) {
    const failure = reportFailure(error, {
      operation: "execution_capability.output.deliver",
      component: "execution_capabilities",
      executionId: execution.id,
    });
    try {
      await options.database.failAgentExecutionOutput(
        execution.id,
        attempt.id,
        capabilityTime(options),
      );
    } catch (recordError) {
      reportFailure(recordError, {
        operation: "execution_capability.output.record_failure",
        component: "execution_capabilities",
        executionId: execution.id,
      });
    }
    return toolFailure(
      withReference(
        `Output delivery failed. Check the provider connection and output configuration before calling \`${toolName}\` again.`,
        failure.requestId,
      ),
    );
  }
}

function outputLimitFailure(execution: AgentExecutionRecord, output: MaterializedOutputCapability) {
  reportFailure(
    new Error("execution output limit reached"),
    {
      operation: "execution_capability.output.limit",
      component: "execution_capabilities",
      executionId: execution.id,
    },
    { kind: "conflict" },
  );
  return toolFailure(`Output limit reached for ${output.declaration.type}`);
}

function capabilityTime(options: ExecutionCapabilityOptions): Date {
  return options.now?.() ?? new Date();
}

async function closeCapabilityResource(
  resource: string,
  executionId: string,
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    reportFailure(error, {
      operation: `execution_capability.${resource}.close`,
      component: "execution_capabilities",
      executionId,
    });
  }
}

interface JsonSchemaContract {
  schema: JsonSchema;
  validate(args: Record<string, unknown>): { valid: true } | { valid: false; message: string };
}

function finishExecutionContract(schema: JsonSchema): JsonSchemaContract {
  const compiled = compileJsonSchema(schema);
  return {
    schema,
    validate(args) {
      return compiled.validate(args)
        ? { valid: true }
        : {
            valid: false,
            message: validationMessage(compiled.validate.errors),
          };
    },
  };
}

function jsonSchemaContract(schema: JsonSchema): JsonSchemaContract {
  const compiled = compileJsonSchema(schema);
  return {
    schema,
    validate(args) {
      return compiled.validate(args)
        ? { valid: true }
        : {
            valid: false,
            message: validationMessage(compiled.validate.errors),
          };
    },
  };
}

function validationMessage(errors: readonly ErrorObject[] | null | undefined): string {
  const messages = formatJsonSchemaErrors(errors, "arguments");
  return messages.length === 0
    ? "Invalid arguments for tool"
    : `Invalid arguments for tool: ${messages.join("; ")}`;
}

function missingRequiredOutputs(
  execution: AgentExecutionRecord,
  materializedOutputs: readonly MaterializedOutputCapability[],
): readonly { type: string; toolName: string }[] {
  const toolsByType = new Map(
    materializedOutputs.map((output) => [output.declaration.type, output.capability.tool.name]),
  );
  return (execution.launchIntent?.allowOutputs ?? [])
    .filter((output) => output.required === true)
    .filter((output) => (execution.outputEmissions[output.type] ?? 0) < 1)
    .map((output) => ({
      type: output.type,
      toolName: toolsByType.get(output.type) ?? "unavailable",
    }));
}

function requiredOutputsGuidance(
  missingOutputs: readonly { type: string; toolName: string }[],
): string {
  const missing = missingOutputs
    .map((output) => `${output.type} (call \`${output.toolName}\`)`)
    .join(", ");
  return `Required output missing: ${missing}. Call the named Hub tool, then retry \`finish_execution\`.`;
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/u.exec(header ?? "");
  return match?.[1];
}

function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function toolFailure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
