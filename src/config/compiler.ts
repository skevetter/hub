import {
  eventDefinition,
  isEditorEvent,
  NOTIFICATION_FROM_USERS_MESSAGE,
  replyMessageError,
  SCRIPT_NOTIFICATION_REASONS,
} from "../triggers/configuration/events.js";
import { ContinuationSchema, type Continuation } from "../triggers/continuation.js";
import {
  hasProgressDestination,
  PROGRESS_DESTINATION_REQUIRED,
} from "../triggers/progress-events.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  expressionPaths,
  parseExpression,
  expressionPathsInTemplate,
  validateExecutionTemplate,
  type Expression,
  type ExpressionPath,
} from "../workflows/expression.js";
import { compileJsonSchema, finiteSchemaChoices } from "../workflows/json-schema.js";
import {
  hashPromptPartialContent,
  validatePromptPartialPath,
  validateResolvedPromptPartialPath,
  type ResolvedPromptPartials,
} from "./prompt-partials.js";
import {
  AuthoredGitHubAuthoritySchema,
  CompiledGitHubAuthoritySchema,
  compileGitHubAuthority,
  isGitHubAuthorityEnvironmentKey,
  validateGitHubAuthority,
  type CompiledGitHubAuthority,
} from "./github-authority.js";
import { validateConnectionTemplate } from "./connection-template.js";

const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
const DURATION = /^([1-9][0-9]*)(ms|s|m|h)$/u;
export const MAX_DURATION_MS = 24 * 60 * 60_000;
const INPUT_NAME = /^[a-z][a-z0-9_-]*$/u;
const DYNAMIC_INPUT_REFERENCE = /^\$\{\{\s*paseo\.inputs\.([a-z][a-z0-9_-]*)\s*\}\}$/u;
const MAX_SCRIPT_BYTES = 64 * 1024;
const EXPRESSION_START = "${{";
const EXPRESSION_END = "}}";

const InputValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const AuthoredInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

const AgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    options: z.record(z.string(), z.custom<JsonValue>(isJsonValue)).optional(),
  })
  .strict();

const PromptBlockSchema = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ include: z.string().min(1) }).strict(),
]);
const JsonSchemaSchema = z.record(z.string(), z.unknown());

const AllowOutputSchema = z
  .object({
    type: z.string().regex(EVENT_NAME),
    max: z.number().int().nonnegative().optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.max === 0) {
      context.addIssue({
        code: "custom",
        path: ["max"],
        message:
          output.required === true
            ? "required outputs must have max at least 1"
            : "output max must be greater than 0",
      });
    }
  });

const AuthoredTriggerFilterSchema = z
  .object({
    pattern: z.string().optional(),
    contains: z.string().optional(),
    /** GitHub text which makes an event ineligible, such as a command another trigger owns. */
    exclude_contains: z.string().optional(),
    label: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).min(1).optional(),
    repo: z.string().min(1).optional(),
    /** GitHub notification reason, such as `mention` or `review_requested`. */
    reason: z.string().min(1).optional(),
    guild: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    /** A Linear project UUID. It is deliberately a string so imported Linear IDs work verbatim. */
    project: z.string().min(1).optional(),
    /** Linear workflow-state IDs which are eligible for this trigger. */
    states: z.array(z.string().min(1)).min(1).optional(),
    /** Linear label IDs which make an issue ineligible. */
    exclude_labels: z.array(z.string().min(1)).min(1).optional(),
    /** Linear user IDs which may be assigned to the issue. */
    assignees: z.array(z.string().min(1)).min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    from_users: z.array(z.string().min(1)).optional(),
    inputs: z.record(z.string(), InputValueSchema).optional(),
    connection: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .optional(),
  })
  .strict();

const CompiledTriggerFilterSchema = AuthoredTriggerFilterSchema.extend({
  connectionId: z.uuid().optional(),
  resourceId: z.string().min(1).optional(),
}).superRefine((filter, context) => {
  if (filter.resourceId !== undefined && filter.connectionId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["resourceId"],
      message: "resourceId requires connectionId",
    });
  }
});

export const WorktreeTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("branch-off"),
    newBranch: z.string().min(1),
    base: z.string().min(1).optional(),
  }),
  z.object({ mode: z.literal("checkout-branch"), branch: z.string().min(1) }),
  z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
]);

const EnvironmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("daemon"),
      daemon: z.string().min(1),
      cwd: z.string().min(1),
      worktree: WorktreeTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("fly"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      kind: z.literal("docker"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
]);

const AuthoredAgentSelectionSchema = z.union([AgentSchema, z.string().min(1)]);

const AgentStepSchema = z
  .object({
    id: z.string().min(1),
    environment: z.string().min(1),
    max_runtime: z.string().min(1),
    idle_timeout: z.string().min(1),
    startup_timeout: z.string().min(1).optional(),
    agent: AuthoredAgentSelectionSchema,
    title: z.string().min(1).optional(),
    prompt: z.array(PromptBlockSchema).min(1),
    env: z.record(z.string().min(1), z.string()).optional(),
    github: AuthoredGitHubAuthoritySchema.optional(),
    if: z.string().min(1).optional(),
    output: z.object({ schema: JsonSchemaSchema }).strict().optional(),
    allow_outputs: z.array(AllowOutputSchema).optional(),
    auto_archive: z.boolean().optional(),
    background: z.boolean().optional(),
    complete_on_turn_end: z.boolean().optional(),
  })
  .strict();

/** A shell script the daemon runs in a terminal, in place of an agent. */
const ScriptStepSchema = z
  .object({
    id: z.string().min(1),
    environment: z.string().min(1),
    max_runtime: z.string().min(1),
    script: z.string().refine((script) => script.trim().length > 0, "script must not be blank"),
    if: z.string().min(1).optional(),
  })
  .strict();

/** Picks the step kind by its `script` key so each kind reports its own field errors. */
const StepSchema = z.unknown().transform((value, context) => {
  const kind = isRecord(value) && "script" in value ? ScriptStepSchema : AgentStepSchema;
  const parsed = kind.safeParse(value);
  if (parsed.success) return parsed.data;
  forwardIssues(parsed.error.issues, [], context);
  return z.NEVER;
});

/** Re-reports a step's issues here, descending into a union's first branch for its detail. */
function forwardIssues(
  issues: readonly z.core.$ZodIssue[],
  base: readonly PropertyKey[],
  context: z.RefinementCtx,
): void {
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    const branch = issue.code === "invalid_union" ? issue.errors[0] : undefined;
    if (branch !== undefined && branch.length > 0) {
      forwardIssues(branch, path, context);
      continue;
    }
    context.addIssue({
      code: "custom",
      message: issue.message,
      path: path.map((segment) =>
        typeof segment === "symbol" ? (segment.description ?? String(segment)) : segment,
      ),
    });
  }
}

const AuthoredTriggerSchema = z
  .object({
    name: z.string().min(1),
    on: z.string().min(1),
    max_runtime: z.string().min(1),
    progress_message: z.boolean().optional(),
    reply_message: z.boolean().optional(),
    steps: z.array(StepSchema).min(1),
    inputs: z.record(z.string(), AuthoredInputSchema).optional(),
    values: z.record(z.string(), z.string().min(1)).optional(),
    filters: AuthoredTriggerFilterSchema.optional(),
  })
  .strict();

const AuthoredSchema = z
  .object({
    environments: z.array(EnvironmentSchema).min(1),
    triggers: z.array(AuthoredTriggerSchema),
  })
  .strict();

export const HubConfigSchema = AuthoredSchema;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export type AuthoredEnvironment = z.infer<typeof EnvironmentSchema>;
export type AuthoredAgentStep = z.infer<typeof AgentStepSchema>;
export type AuthoredScriptStep = z.infer<typeof ScriptStepSchema>;
export type AuthoredStep = AuthoredAgentStep | AuthoredScriptStep;
export type AuthoredTrigger = z.infer<typeof AuthoredTriggerSchema>;
export type AuthoredTriggerFilter = z.infer<typeof AuthoredTriggerFilterSchema>;
export type AuthoredHubConfig = z.infer<typeof AuthoredSchema>;

export type AuthoredInput = z.infer<typeof AuthoredInputSchema>;

export type CompiledPromptBlock =
  | { kind: "text"; value: string }
  | { kind: "partial"; path: string; content: string; contentHash: string };

export interface CompiledAgent {
  provider: string;
  model?: string | undefined;
  mode?: string | undefined;
  thinkingOptionId?: string | undefined;
  options?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface CompiledNamedAgentSelection {
  selector: string;
  choices: Readonly<Record<string, CompiledAgent>>;
}

export type CompiledAgentSelection = CompiledAgent | CompiledNamedAgentSelection;

export interface CompiledInput {
  type: AuthoredInput["type"];
  required: boolean;
  default?: JsonPrimitive | undefined;
  choices?: readonly JsonPrimitive[] | undefined;
}

export interface CompiledAgentStep {
  kind?: "agent" | undefined;
  continuation?: Continuation | undefined;
  id: string;
  environment: string;
  maxRuntimeMs: number;
  idleTimeoutMs: number;
  startupTimeoutMs?: number | undefined;
  agent: CompiledAgentSelection;
  /** Execution template for the workspace title; absent means Hub's default workspace title. */
  title?: string | undefined;
  prompt: readonly CompiledPromptBlock[];
  env?: Readonly<Record<string, string>> | undefined;
  github?: CompiledGitHubAuthority | undefined;
  condition?: Expression | undefined;
  output?: { schema: JsonValue } | undefined;
  allowOutputs: readonly { type: string; max?: number | undefined; required: boolean }[];
  autoArchive: boolean;
  background: boolean;
  /** Absent means off. A finished agent turn then completes the step without finish_execution. */
  completeOnTurnEnd?: boolean | undefined;
}

/** A step that runs a shell script in a daemon terminal. It has no agent, prompt, or output. */
export interface CompiledScriptStep {
  kind: "script";
  id: string;
  environment: string;
  maxRuntimeMs: number;
  /** The literal script text. It is never rendered from event data. */
  script: string;
  condition?: Expression | undefined;
  output?: undefined;
}

export type CompiledStep = CompiledAgentStep | CompiledScriptStep;

export function isScriptStep(step: CompiledStep): step is CompiledScriptStep {
  return step.kind === "script";
}

/** The step as an agent step, for code that is only ever given one. */
export function agentStep(step: CompiledStep | undefined): CompiledAgentStep {
  if (step === undefined || isScriptStep(step)) throw new Error("expected an agent step");
  return step;
}

export type CompiledSteps = readonly CompiledStep[];

export type CompiledTriggerFilter = Readonly<
  Omit<
    AuthoredTriggerFilter,
    "channels" | "from_users" | "states" | "labels" | "exclude_labels" | "assignees"
  > & {
    channels?: readonly string[] | undefined;
    from_users?: readonly string[] | undefined;
    states?: readonly string[] | undefined;
    labels?: readonly string[] | undefined;
    exclude_labels?: readonly string[] | undefined;
    assignees?: readonly string[] | undefined;
    inputs?: Readonly<Record<string, JsonPrimitive>> | undefined;
    connectionId?: string | undefined;
    resourceId?: string | undefined;
  }
>;

export type CompiledEnvironment =
  | (Extract<AuthoredEnvironment, { kind: "daemon" }> & { daemonId?: string | undefined })
  | Exclude<AuthoredEnvironment, { kind: "daemon" }>;

export interface CompiledTrigger {
  name: string;
  sourceFile?: string | undefined;
  on: string;
  maxRuntimeMs: number;
  progressMessage?: true | undefined;
  replyMessage?: true | undefined;
  steps: CompiledSteps;
  inputs: Readonly<Record<string, CompiledInput>>;
  values: Readonly<Record<string, Expression>>;
  filters?: CompiledTriggerFilter | undefined;
}

export interface CompiledHubConfig {
  environments: readonly CompiledEnvironment[];
  triggers: readonly CompiledTrigger[];
}

export interface CompileHubConfigOptions {
  resolvedPromptPartials?: ResolvedPromptPartials;
  namedAgents?: Readonly<Record<string, CompiledAgent>>;
  sourceFiles?: Readonly<Record<string, string>>;
}

/** A compiler failure located in the conceptual authored configuration tree. */
export class HubConfigurationCompilationError extends Error {
  constructor(
    readonly path: readonly (string | number)[],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HubConfigurationCompilationError";
  }
}

const CompiledPromptBlockSchema: z.ZodType<CompiledPromptBlock> = z.union([
  z.object({ kind: z.literal("text"), value: z.string() }).strict(),
  z
    .object({
      kind: z.literal("partial"),
      path: z.string().min(1),
      content: z.string(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .strict(),
]);

const CompiledAgentSchema: z.ZodType<CompiledAgent> = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    options: z.record(z.string(), z.custom<JsonValue>(isJsonValue)).optional(),
  })
  .strict();

const CompiledAgentSelectionSchema: z.ZodType<CompiledAgentSelection> = z.union([
  CompiledAgentSchema,
  z
    .object({
      selector: z.string().min(1),
      choices: z.record(z.string(), CompiledAgentSchema),
    })
    .strict(),
]);

const CompiledInputSchema: z.ZodType<CompiledInput> = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

const CompiledEnvironmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("daemon"),
      daemon: z.string().min(1),
      daemonId: z.string().min(1).optional(),
      cwd: z.string().min(1),
      worktree: WorktreeTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("fly"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().regex(IDENTIFIER),
      kind: z.literal("docker"),
      image: z.string().min(1),
      cwd: z.string().min(1).optional(),
    })
    .strict(),
]);

const CompiledJsonSchemaSchema = z.custom<JsonValue>(
  (value) => isJsonValue(value) && isRecord(value),
);

const CompiledAgentStepSchema = z
  .object({
    kind: z.literal("agent").optional(),
    continuation: ContinuationSchema.optional(),
    id: z.string().regex(IDENTIFIER),
    environment: z.string().min(1),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    idleTimeoutMs: z.number().int().positive().max(MAX_DURATION_MS),
    startupTimeoutMs: z.number().int().positive().max(MAX_DURATION_MS).optional(),
    agent: CompiledAgentSelectionSchema,
    title: z.string().min(1).optional(),
    prompt: z.array(CompiledPromptBlockSchema).min(1),
    env: z.record(z.string(), z.string()).optional(),
    github: CompiledGitHubAuthoritySchema.optional(),
    condition: z.custom<Expression>(isExpression).optional(),
    output: z.object({ schema: CompiledJsonSchemaSchema }).strict().optional(),
    allowOutputs: z.array(
      z
        .object({
          type: z.string().regex(EVENT_NAME),
          max: z.number().int().positive().optional(),
          required: z.boolean().default(false),
        })
        .strict(),
    ),
    autoArchive: z.boolean(),
    background: z.boolean().default(false),
    completeOnTurnEnd: z.boolean().optional(),
  })
  .strict();

const CompiledScriptStepSchema = z
  .object({
    kind: z.literal("script"),
    id: z.string().regex(IDENTIFIER),
    environment: z.string().min(1),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    script: z.string().min(1),
    condition: z.custom<Expression>(isExpression).optional(),
  })
  .strict();

const CompiledStepSchema: z.ZodType<CompiledStep> = z.union([
  CompiledScriptStepSchema,
  CompiledAgentStepSchema,
]);

const CompiledTriggerSchema: z.ZodType<CompiledTrigger> = z
  .object({
    name: z.string().regex(IDENTIFIER),
    sourceFile: z.string().min(1).optional(),
    on: z.string().regex(EVENT_NAME),
    maxRuntimeMs: z.number().int().positive().max(MAX_DURATION_MS),
    progressMessage: z.literal(true).optional(),
    replyMessage: z.literal(true).optional(),
    steps: z.array(CompiledStepSchema),
    inputs: z.record(z.string(), CompiledInputSchema),
    values: z.record(z.string(), z.custom<Expression>(isExpression)),
    filters: CompiledTriggerFilterSchema.optional(),
  })
  .strict();

const CompiledHubConfigSchema: z.ZodType<CompiledHubConfig> = z
  .object({
    environments: z.array(CompiledEnvironmentSchema).min(1),
    triggers: z.array(CompiledTriggerSchema),
  })
  .strict();

export function compileHubConfig(
  raw: unknown,
  options: CompileHubConfigOptions = {},
): CompiledHubConfig {
  rejectRemovedFields(raw);
  const authored = AuthoredSchema.parse(raw);
  validateAuthoredIds(authored);
  const environmentNames = new Set(authored.environments.map((environment) => environment.name));
  const environments = new Map(
    authored.environments.map((environment) => [environment.name, environment]),
  );
  validateEnvironmentTemplates(authored.environments);
  const triggers = authored.triggers.map((trigger) =>
    compileTrigger(trigger, {
      environmentNames,
      environments,
      resolvedPromptPartials: options.resolvedPromptPartials,
      namedAgents: options.namedAgents ?? {},
      sourceFile: options.sourceFiles?.[trigger.name],
    }),
  );
  const compiled = { environments: authored.environments, triggers } satisfies CompiledHubConfig;
  validateCompiledContract(compiled);
  return deepFreeze(compiled);
}

export function parseCompiledHubConfig(value: unknown): CompiledHubConfig {
  let cloned: unknown;
  try {
    cloned = structuredClone(value);
  } catch {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  const parsed = CompiledHubConfigSchema.safeParse(cloned);
  if (!parsed.success) {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  try {
    validateCompiledContract(parsed.data);
  } catch {
    throw new Error("active configuration contains an invalid compiled workflow contract");
  }
  return deepFreeze(parsed.data);
}

export function compiledConfigurationHash(configuration: CompiledHubConfig): string {
  return hashConfiguration(parseCompiledHubConfig(configuration));
}

export function rawConfigurationHash(configuration: unknown): string {
  return hashConfiguration(configuration);
}

export function parseDurationMs(value: string, field: string): number {
  const match = DURATION.exec(value);
  if (match === null) {
    throw new Error(`${field} must be a positive duration such as 30s or 2h`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  let multiplier: number;
  if (unit === "ms") multiplier = 1;
  else if (unit === "s") multiplier = 1_000;
  else if (unit === "m") multiplier = 60_000;
  else multiplier = 3_600_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration > MAX_DURATION_MS) {
    throw new Error(`${field} must not exceed 24h`);
  }
  return duration;
}

interface StepCompilationOptions {
  environmentNames: ReadonlySet<string>;
  environments: ReadonlyMap<string, AuthoredEnvironment>;
  resolvedPromptPartials: ResolvedPromptPartials | undefined;
  namedAgents: Readonly<Record<string, CompiledAgent>>;
}

interface TriggerCompilationOptions extends StepCompilationOptions {
  sourceFile: string | undefined;
}

function compileTrigger(
  trigger: AuthoredTrigger,
  options: TriggerCompilationOptions,
): CompiledTrigger {
  const { environmentNames, environments, sourceFile } = options;
  const triggerPath = ["triggers", trigger.name] as const;
  compileAt([...triggerPath, "on"], () => {
    if (!EVENT_NAME.test(trigger.on)) throw new Error(`invalid trigger event: ${trigger.on}`);
  });
  if (trigger.progress_message === true && !hasProgressDestination(trigger.on)) {
    throw new HubConfigurationCompilationError(
      [...triggerPath, "progress_message"],
      PROGRESS_DESTINATION_REQUIRED,
    );
  }
  if (trigger.reply_message === true) {
    const error = replyMessageError(trigger.on, trigger.filters?.from_users);
    if (error !== undefined)
      throw new HubConfigurationCompilationError([...triggerPath, "reply_message"], error);
  }
  const inputs = compileAt([...triggerPath, "inputs"], () => compileInputs(trigger));
  compileAt([...triggerPath, "filters"], () => validateInputFilters(trigger, inputs));
  compileAt([...triggerPath, "steps"], () =>
    validateEnvironmentInputChoices(trigger, inputs, environmentNames, environments),
  );
  const steps = trigger.steps.map((step) => compileStep(trigger, step, options));
  const values = compileValues(trigger);
  const compiled = {
    name: trigger.name,
    ...(sourceFile === undefined ? {} : { sourceFile }),
    on: trigger.on,
    maxRuntimeMs: compileAt([...triggerPath, "max_runtime"], () =>
      parseDurationMs(trigger.max_runtime, `trigger ${trigger.name} max_runtime`),
    ),
    ...(trigger.progress_message === true ? { progressMessage: true as const } : {}),
    ...(trigger.reply_message === true ? { replyMessage: true as const } : {}),
    steps,
    inputs,
    values,
    ...(trigger.filters === undefined ? {} : { filters: trigger.filters }),
  };
  validateExpressionContract(trigger.name, compiled, environments);
  return compiled;
}

function compileStep(
  trigger: AuthoredTrigger,
  step: AuthoredStep,
  options: StepCompilationOptions,
): CompiledStep {
  const { environmentNames, environments, resolvedPromptPartials, namedAgents } = options;
  checkStepEnvironment(trigger, step, environmentNames, environments);
  if ("script" in step) return compileScriptStep(trigger, step);
  return compileAgentStep(trigger, step, resolvedPromptPartials, namedAgents);
}

function checkStepEnvironment(
  trigger: AuthoredTrigger,
  step: AuthoredStep,
  environmentNames: ReadonlySet<string>,
  environments: ReadonlyMap<string, AuthoredEnvironment>,
): void {
  const stepPath = ["triggers", trigger.name, "steps", step.id] as const;
  compileAt([...stepPath, "environment"], () => {
    if (!environmentNames.has(step.environment) && !step.environment.includes(EXPRESSION_START)) {
      throw new Error(`step ${step.id} references unknown environment ${step.environment}`);
    }
    const staticEnvironment = environments.get(step.environment);
    if (staticEnvironment !== undefined && staticEnvironment.kind !== "daemon") {
      throw new Error(
        `trigger ${trigger.name} step ${step.id} environment ${step.environment} must be a daemon environment`,
      );
    }
  });
}

function compileScriptStep(trigger: AuthoredTrigger, step: AuthoredScriptStep): CompiledScriptStep {
  const stepPath = ["triggers", trigger.name, "steps", step.id] as const;
  const maxRuntimeMs = compileAt([...stepPath, "max_runtime"], () =>
    parseDurationMs(step.max_runtime, `trigger ${trigger.name} step ${step.id} max_runtime`),
  );
  const condition = compileStepCondition(step.if, stepPath);
  compileAt([...stepPath, "script"], () => validateScriptText(step.script));
  return {
    kind: "script",
    id: step.id,
    environment: step.environment,
    maxRuntimeMs,
    script: step.script,
    ...(condition === undefined ? {} : { condition }),
  };
}

function compileStepCondition(
  condition: string | undefined,
  stepPath: readonly string[],
): Expression | undefined {
  return condition === undefined
    ? undefined
    : compileAt([...stepPath, "if"], () => parseExpression(condition));
}

/**
 * Event data reaches a script only through HUB_EVENT_JSON. A `${{ }}` in the text is never
 * rendered, so it is refused instead of running as a bad shell substitution.
 */
function validateScriptText(script: string): void {
  if (script.includes(EXPRESSION_START)) {
    throw new Error(
      "script text is not templated. Remove the ${{ }} expression and read event data from the HUB_EVENT_JSON environment variable.",
    );
  }
  // An argument with a NUL byte cannot reach the host, and a very large one is refused by exec.
  if (script.includes("\u0000")) throw new Error("script text must not contain NUL bytes.");
  if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) {
    throw new Error(`script text must be at most ${String(MAX_SCRIPT_BYTES / 1024)} KiB.`);
  }
}

function compileAgentStep(
  trigger: AuthoredTrigger,
  step: AuthoredAgentStep,
  resolvedPromptPartials: ResolvedPromptPartials | undefined,
  namedAgents: Readonly<Record<string, CompiledAgent>>,
): CompiledAgentStep {
  const stepPath = ["triggers", trigger.name, "steps", step.id] as const;
  const { maxRuntimeMs, idleTimeoutMs } = compileAgentRuntimes(trigger, step, stepPath);
  const condition = compileStepCondition(step.if, stepPath);
  const outputDeclaration =
    step.output === undefined ? undefined : { schema: cloneJsonValue(step.output.schema) };
  if (outputDeclaration !== undefined)
    validateOutputSchema(outputDeclaration.schema, `step ${step.id} output.schema`);
  assertTurnEndCompletionAllowed(step.id, {
    enabled: step.complete_on_turn_end === true,
    structuredOutput: outputDeclaration !== undefined,
    requiredOutputs: (step.allow_outputs ?? []).some((output) => output.required === true),
  });
  const { env, github } = compileAgentEnvironment(trigger, step);
  const agent = compileAt([...stepPath, "agent"], () =>
    compileAgentSelection(trigger.name, step.id, step.agent, namedAgents),
  );
  const startupTimeout = step.startup_timeout;
  return {
    id: step.id,
    environment: step.environment,
    maxRuntimeMs,
    idleTimeoutMs,
    ...(startupTimeout === undefined
      ? {}
      : {
          startupTimeoutMs: compileAt([...stepPath, "startup_timeout"], () =>
            parseDurationMs(
              startupTimeout,
              `trigger ${trigger.name} step ${step.id} startup_timeout`,
            ),
          ),
        }),
    agent,
    ...(step.title === undefined ? {} : { title: step.title }),
    prompt: compilePromptBlocks(trigger.name, step.id, step.prompt, resolvedPromptPartials),
    ...(env === undefined ? {} : { env }),
    ...(github === undefined ? {} : { github }),
    ...(condition === undefined ? {} : { condition }),
    ...(outputDeclaration === undefined ? {} : { output: outputDeclaration }),
    ...compileAgentOutputOptions(step),
  };
}

function compileAgentRuntimes(
  trigger: AuthoredTrigger,
  step: AuthoredAgentStep,
  stepPath: readonly string[],
) {
  const maxRuntimeMs = compileAt([...stepPath, "max_runtime"], () =>
    parseDurationMs(step.max_runtime, `trigger ${trigger.name} step ${step.id} max_runtime`),
  );
  const idleTimeoutMs = compileAt([...stepPath, "idle_timeout"], () =>
    parseDurationMs(step.idle_timeout, `trigger ${trigger.name} step ${step.id} idle_timeout`),
  );
  if (idleTimeoutMs > maxRuntimeMs) {
    throw new Error(`step ${step.id} idle_timeout must not exceed max_runtime`);
  }
  return { maxRuntimeMs, idleTimeoutMs };
}

function compileAgentEnvironment(trigger: AuthoredTrigger, step: AuthoredAgentStep) {
  const env = step.env === undefined ? undefined : { ...step.env };
  const github =
    step.github === undefined
      ? undefined
      : compileGitHubAuthority(step.github, `trigger ${trigger.name} step ${step.id} github`);
  validateStepEnvironmentContract(trigger, step.id, { env, github });
  return { env, github };
}

function compileAgentOutputOptions(step: AuthoredAgentStep) {
  return {
    allowOutputs: (step.allow_outputs ?? []).map((allowOutput) => ({
      type: allowOutput.type,
      max: allowOutput.max ?? 1,
      required: allowOutput.required ?? false,
    })),
    autoArchive: step.auto_archive ?? false,
    background: step.background ?? false,
    ...(step.complete_on_turn_end === true ? { completeOnTurnEnd: true } : {}),
  };
}

/** A finished turn carries free text, so it cannot satisfy a declared output contract. */
function assertTurnEndCompletionAllowed(
  stepId: string,
  step: { enabled: boolean; structuredOutput: boolean; requiredOutputs: boolean },
): void {
  if (!step.enabled) return;
  if (step.structuredOutput) {
    throw new Error(
      `step ${stepId} complete_on_turn_end cannot be combined with output.schema: a finished turn has no structured output`,
    );
  }
  if (step.requiredOutputs) {
    throw new Error(
      `step ${stepId} complete_on_turn_end cannot be combined with a required output: the agent must emit it before it finishes`,
    );
  }
}

function compileAgentSelection(
  triggerName: string,
  stepId: string,
  authored: AuthoredAgentStep["agent"],
  namedAgents: Readonly<Record<string, CompiledAgent>>,
): CompiledAgentSelection {
  if (typeof authored === "string") {
    if (!authored.includes(EXPRESSION_START)) {
      const selected = namedAgents[authored];
      if (selected === undefined) {
        throw new Error(
          `trigger ${triggerName} step ${stepId} references unknown named agent ${authored}`,
        );
      }
      return cloneAgent(selected);
    }
    return {
      selector: authored,
      choices: Object.fromEntries(
        Object.entries(namedAgents)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, agent]) => [name, cloneAgent(agent)]),
      ),
    };
  }
  for (const value of [
    authored.provider,
    authored.model,
    authored.mode,
    authored.thinkingOptionId,
  ]) {
    if (value?.includes(EXPRESSION_START) === true) {
      throw new Error(
        `trigger ${triggerName} step ${stepId}: dynamic inline agent configurations are not allowed; select a complete named agent instead`,
      );
    }
  }
  return cloneAgent(authored);
}

function cloneAgent(agent: CompiledAgent): CompiledAgent {
  return {
    ...agent,
    ...(agent.options === undefined ? {} : { options: cloneJsonObject(agent.options) }),
  };
}

function compilePromptBlocks(
  triggerName: string,
  stepId: string,
  blocks: AuthoredAgentStep["prompt"],
  resolvedPromptPartials: ResolvedPromptPartials | undefined,
): readonly CompiledPromptBlock[] {
  return blocks.map((block, index) => {
    if ("text" in block) return { kind: "text" as const, value: block.text };
    if (resolvedPromptPartials === undefined) {
      throw new Error(
        `trigger ${triggerName} step ${stepId} prompt[${index}].include: this configuration was compiled without a prompt partial bundle, so no include can be resolved`,
      );
    }
    const path = validatePromptPartialPathForCompilation(block.include);
    const partial = resolvedPromptPartials.get(path);
    if (partial === undefined) {
      throw new Error(
        `trigger ${triggerName} step ${stepId} prompt[${index}].include: partial ${path} was not resolved at the exact configuration commit`,
      );
    }
    if (
      partial.path !== path ||
      partial.contentHash !== hashPromptPartialContent(partial.content)
    ) {
      throw new Error(`prompt partial ${path} has invalid resolved content evidence`);
    }
    return {
      kind: "partial" as const,
      path,
      content: partial.content,
      contentHash: partial.contentHash,
    };
  });
}

function validatePromptPartialPathForCompilation(value: string): string {
  try {
    return validatePromptPartialPath(value);
  } catch (error) {
    throw new Error(
      `prompt include path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function compileValues(trigger: AuthoredTrigger): Readonly<Record<string, Expression>> {
  const values: Record<string, Expression> = {};
  for (const [name, source] of Object.entries(trigger.values ?? {})) {
    assertIdentifier(name, `value name on trigger ${trigger.name}`);
    values[name] = compileAt(["triggers", trigger.name, "values", name], () =>
      parseExpression(source),
    );
  }
  return values;
}

function compileInputs(trigger: AuthoredTrigger): Readonly<Record<string, CompiledInput>> {
  const compiled: Record<string, CompiledInput> = {};
  for (const [name, input] of Object.entries(trigger.inputs ?? {})) {
    assertIdentifier(name, `input name on trigger ${trigger.name}`);
    if (input.required === true && input.default !== undefined) {
      throw new Error(
        `trigger ${trigger.name} input ${name} cannot be both required and defaulted`,
      );
    }
    if (!matchesInputType(input.default, input.type)) {
      throw new Error(`trigger ${trigger.name} input ${name} default does not match type`);
    }
    validateInputChoices(input, `trigger ${trigger.name} input ${name}`);
    compiled[name] = {
      type: input.type,
      required: input.required ?? false,
      ...(input.default === undefined ? {} : { default: input.default }),
      ...(input.choices === undefined ? {} : { choices: input.choices }),
    };
  }
  return compiled;
}

function validateInputChoices(
  input: Pick<CompiledInput, "type" | "default" | "choices"> | AuthoredInput,
  path: string,
): void {
  if (input.choices === undefined) return;
  if (input.choices.some((choice) => !matchesInputType(choice, input.type))) {
    throw new Error(`${path} choices do not match type`);
  }
  if (input.default !== undefined && !input.choices.some((choice) => choice === input.default)) {
    throw new Error(`${path} default is not an allowed choice`);
  }
}

function validateInputFilters(
  trigger: AuthoredTrigger,
  inputs: Readonly<Record<string, CompiledInput>>,
): void {
  for (const [name, value] of Object.entries(trigger.filters?.inputs ?? {})) {
    const definition = inputs[name];
    if (definition === undefined) {
      throw new Error(`trigger ${trigger.name} input filter references undeclared input ${name}`);
    }
    if (!matchesInputType(value, definition.type)) {
      throw new Error(`trigger ${trigger.name} input filter ${name} does not match type`);
    }
    if (
      definition.choices !== undefined &&
      !definition.choices.some((choice) => choice === value)
    ) {
      throw new Error(`trigger ${trigger.name} input filter ${name} is not an allowed choice`);
    }
  }
}

function validateEnvironmentInputChoices(
  trigger: AuthoredTrigger,
  inputs: Readonly<Record<string, CompiledInput>>,
  environmentNames: ReadonlySet<string>,
  environments: ReadonlyMap<string, AuthoredEnvironment>,
): void {
  for (const step of trigger.steps) {
    for (const choice of environmentInputChoices(step.environment, inputs)) {
      if (typeof choice !== "string" || !environmentNames.has(choice)) {
        throw new Error(
          `trigger ${trigger.name} step ${step.id} environment choice ${String(choice)} is not a configured environment`,
        );
      }
      if (environments.get(choice)?.kind !== "daemon") {
        throw new Error(
          `trigger ${trigger.name} step ${step.id} environment choice ${choice} must be a daemon environment`,
        );
      }
    }
  }
}

function validateCompiledInputs(trigger: CompiledTrigger): void {
  for (const [name, input] of Object.entries(trigger.inputs)) {
    if (!INPUT_NAME.test(name)) throw new Error(`invalid input name: ${name}`);
    if (!matchesInputType(input.default, input.type)) {
      throw new Error(`input ${name} default does not match type`);
    }
    if (input.required && input.default !== undefined) {
      throw new Error(`input ${name} cannot be both required and defaulted`);
    }
    validateInputChoices(input, `input ${name}`);
  }
  validateCompiledInputFilters(trigger);
}

function validateCompiledInputFilters(trigger: CompiledTrigger): void {
  for (const [name, value] of Object.entries(trigger.filters?.inputs ?? {})) {
    const input = trigger.inputs[name];
    if (input === undefined || !matchesInputType(value, input.type)) {
      throw new Error(`input filter ${name} does not match a declared input`);
    }
    if (input.choices !== undefined && !input.choices.some((choice) => choice === value)) {
      throw new Error(`input filter ${name} is not an allowed choice`);
    }
  }
}

interface ExpressionContract {
  trigger: CompiledTrigger;
  environments: ReadonlyMap<string, AuthoredEnvironment | CompiledEnvironment>;
  environmentNames: ReadonlySet<string>;
  stepOrdinals: ReadonlyMap<string, number>;
  valueNames: ReadonlySet<string>;
  visiting: Set<string>;
}

interface ExpressionSite {
  ordinal: number;
  path: string;
  authorityBearing?: boolean;
  contextAllowed?: boolean;
}

function validateExpressionContract(
  triggerName: string,
  trigger: CompiledTrigger,
  environments: ExpressionContract["environments"],
): void {
  const contract: ExpressionContract = {
    trigger,
    environments,
    environmentNames: new Set(environments.keys()),
    stepOrdinals: new Map(trigger.steps.map((step, ordinal) => [step.id, ordinal])),
    valueNames: new Set(Object.keys(trigger.values)),
    visiting: new Set<string>(),
  };

  for (const name of contract.valueNames) validateValue(contract, name);
  for (const [ordinal, step] of trigger.steps.entries()) {
    validateStepExpressions(contract, step, ordinal, ["triggers", triggerName, "steps", step.id]);
  }
  if (
    trigger.steps.some((step) => step.environment.includes("${{")) &&
    contract.environmentNames.size === 0
  ) {
    throw new Error(`trigger ${triggerName} has no configured environments`);
  }
}

function validateStepExpressions(
  contract: ExpressionContract,
  step: CompiledStep,
  ordinal: number,
  stepPath: readonly string[],
): void {
  const { condition } = step;
  if (condition !== undefined)
    compileAt([...stepPath, "if"], () =>
      validateExpression(contract, condition, { ordinal, path: `step ${step.id} if` }),
    );
  compileAt([...stepPath, "environment"], () => {
    validateTemplate(contract, step.environment, {
      ordinal,
      path: `step ${step.id} environment`,
      authorityBearing: true,
    });
    validateEnvironmentSelection(contract, step.environment, ordinal, step.id);
  });
  if (!isScriptStep(step)) validateAgentStepExpressions(contract, step, ordinal, stepPath);
}

function validateAgentStepExpressions(
  contract: ExpressionContract,
  step: CompiledAgentStep,
  ordinal: number,
  stepPath: readonly string[],
): void {
  const { title } = step;
  if (title !== undefined)
    compileAt([...stepPath, "title"], () => validateTitleTemplate(title, `step ${step.id} title`));
  const { agent } = step;
  if ("selector" in agent)
    compileAt([...stepPath, "agent"], () =>
      validateAgentSelection(contract, agent, ordinal, step.id),
    );
  for (const [index, block] of step.prompt.entries()) {
    compileAt([...stepPath, "prompt", index], () =>
      validateTemplate(contract, block.kind === "text" ? block.value : block.content, {
        ordinal,
        path: `step ${step.id} prompt[${index}]`,
        contextAllowed: true,
      }),
    );
  }
}

function validateAgentSelection(
  contract: ExpressionContract,
  selection: CompiledNamedAgentSelection,
  ordinal: number,
  stepId: string,
): void {
  validateTemplate(contract, selection.selector, {
    ordinal,
    path: `step ${stepId} agent`,
    authorityBearing: true,
  });
  const selected = finiteTemplateValues(contract, selection.selector, ordinal);
  if (selected === undefined) {
    throw new Error(`step ${stepId} agent must resolve from finite choices`);
  }
  for (const name of selected) {
    if (!Object.hasOwn(selection.choices, name)) {
      throw new Error(`step ${stepId} agent resolves to unknown named agent ${name}`);
    }
  }
}

function validateEnvironmentSelection(
  contract: ExpressionContract,
  template: string,
  ordinal: number,
  stepId: string,
): void {
  const selected = finiteTemplateValues(contract, template, ordinal);
  if (selected === undefined) {
    throw new Error(`step ${stepId} environment must resolve from finite choices`);
  }
  for (const name of selected) {
    if (!contract.environmentNames.has(name)) {
      throw new Error(`step ${stepId} resolves to unknown environment ${name}`);
    }
    if (contract.environments.get(name)?.kind !== "daemon") {
      throw new Error(`step ${stepId} environment ${name} must be a daemon environment`);
    }
  }
}

function finiteTemplateValues(
  contract: ExpressionContract,
  template: string,
  ordinal: number,
): readonly string[] | undefined {
  let results = [""];
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf(EXPRESSION_START, cursor);
    if (start < 0) break;
    const end = template.indexOf(EXPRESSION_END, start + EXPRESSION_START.length);
    if (end < 0) return undefined;
    const literal = template.slice(cursor, start);
    const choices = finiteExpressionValues(
      contract,
      parseExpression(template.slice(start + EXPRESSION_START.length, end)),
      ordinal,
    );
    if (choices === undefined) return undefined;
    results = results.flatMap((prefix) =>
      choices.map((choice) => prefix + literal + interpolatedValue(choice)),
    );
    cursor = end + EXPRESSION_END.length;
  }
  return cursor < template.length
    ? results.map((prefix) => prefix + template.slice(cursor))
    : [...new Set(results)];
}

function finiteExpressionValues(
  contract: ExpressionContract,
  expression: Expression,
  ordinal: number,
): readonly JsonValue[] | undefined {
  if (expression.kind === "literal" || expression.kind === "path") {
    return expression.kind === "literal"
      ? [expression.value]
      : finitePathValues(contract, expression.value, ordinal);
  }
  if (expression.kind === "not") {
    const values = finiteExpressionValues(contract, expression.value, ordinal);
    return values === undefined ? undefined : [...new Set(values.map((value) => !truthy(value)))];
  }
  return finiteBinaryValues(contract, expression, ordinal);
}

function finiteBinaryValues(
  contract: ExpressionContract,
  expression: Extract<Expression, { kind: "binary" }>,
  ordinal: number,
): readonly JsonValue[] | undefined {
  const left = finiteExpressionValues(contract, expression.left, ordinal);
  const right = finiteExpressionValues(contract, expression.right, ordinal);
  if (left === undefined || right === undefined) return undefined;
  const results: JsonValue[] = [];
  for (const leftValue of left) {
    for (const rightValue of right) {
      results.push(finiteBinaryValue(expression.operator, leftValue, rightValue));
    }
  }
  return uniqueJsonValues(results);
}

function finitePathValues(
  contract: ExpressionContract,
  reference: ExpressionPath,
  ordinal: number,
): readonly JsonValue[] | undefined {
  if (reference.namespace === "paseo") {
    return finiteInputPathValues(contract.trigger.inputs, reference.path);
  }
  if (reference.namespace === "values") {
    const value = contract.trigger.values[reference.name];
    return value === undefined ? undefined : finiteExpressionValues(contract, value, ordinal);
  }
  const referencedOrdinal = contract.stepOrdinals.get(reference.stepId);
  const output =
    referencedOrdinal === undefined || referencedOrdinal >= ordinal
      ? undefined
      : contract.trigger.steps[referencedOrdinal]?.output;
  return output === undefined ? undefined : finiteSchemaChoices(output.schema, reference.path);
}

function finiteInputPathValues(
  inputs: CompiledTrigger["inputs"],
  path: Extract<ExpressionPath, { namespace: "paseo" }>["path"],
): readonly JsonValue[] | undefined {
  if (!Array.isArray(path)) return undefined;
  const input = inputs[path[1]];
  if (input?.choices === undefined) return undefined;
  return input.required || input.default !== undefined ? input.choices : [...input.choices, null];
}

function validateValue(
  contract: ExpressionContract,
  name: string,
  ordinal = Number.POSITIVE_INFINITY,
): void {
  if (contract.visiting.has(name)) throw new Error(`value dependency cycle includes ${name}`);
  const expression = contract.trigger.values[name];
  if (expression === undefined) throw new Error(`value ${name} is unavailable`);
  contract.visiting.add(name);
  validateExpression(contract, expression, { ordinal, path: `value ${name}` });
  contract.visiting.delete(name);
}

function validateExpression(
  contract: ExpressionContract,
  expression: Expression,
  site: ExpressionSite,
): void {
  for (const reference of expressionPaths(expression)) {
    validateReference(contract, reference, site);
    if (reference.namespace === "values") validateValue(contract, reference.name, site.ordinal);
  }
  if (site.authorityBearing && !isFiniteAuthorityExpression(contract, expression)) {
    throw new Error(
      `${site.path} uses an agent-produced authority without provable finite choices; use a finite enum or const`,
    );
  }
}

function validateTemplate(
  contract: ExpressionContract,
  value: string | undefined,
  site: ExpressionSite,
): void {
  if (value === undefined) return;
  let cursor = 0;
  while (true) {
    const start = value.indexOf(EXPRESSION_START, cursor);
    if (start < 0) return;
    const end = value.indexOf(EXPRESSION_END, start + EXPRESSION_START.length);
    if (end < 0) throw new Error(`${site.path} uses an unterminated expression`);
    const expression = parseExpression(value.slice(start + EXPRESSION_START.length, end));
    validateExpression(contract, expression, site);
    cursor = end + EXPRESSION_END.length;
  }
}

function validateReference(
  contract: ExpressionContract,
  reference: ExpressionPath,
  site: ExpressionSite,
): void {
  if (reference.namespace === "paseo") {
    validatePaseoReference(contract.trigger.inputs, reference.path, site);
  } else if (reference.namespace === "values") {
    if (!contract.valueNames.has(reference.name))
      throw new Error(`${site.path} references undeclared value ${reference.name}`);
  } else {
    validateStepReference(contract, reference, site);
  }
}

function validatePaseoReference(
  inputs: CompiledTrigger["inputs"],
  referencePath: Extract<ExpressionPath, { namespace: "paseo" }>["path"],
  { path, authorityBearing, contextAllowed }: ExpressionSite,
): void {
  if (referencePath === "prompt") {
    if (authorityBearing)
      throw new Error(`${path} uses paseo.prompt in an authority-bearing field`);
    return;
  }
  if (referencePath === "context") {
    if (!contextAllowed) throw new Error(`${path} uses paseo.context outside a step prompt`);
    return;
  }
  if (referencePath[0] === "execution") {
    throw new Error(
      `${path} uses paseo.execution outside environment worktree.newBranch or a step title`,
    );
  }
  const inputName = referencePath[1];
  const input = inputs[inputName];
  if (input === undefined) throw new Error(`${path} references undeclared input ${inputName}`);
  if (authorityBearing && input.choices === undefined) {
    throw new Error(`${path} uses input ${inputName} without finite choices`);
  }
}

function validateStepReference(
  contract: ExpressionContract,
  reference: Extract<ExpressionPath, { namespace: "steps" }>,
  { ordinal, path, authorityBearing }: ExpressionSite,
): void {
  const referencedOrdinal = contract.stepOrdinals.get(reference.stepId);
  if (referencedOrdinal === undefined)
    throw new Error(`${path} references unknown step ${reference.stepId}`);
  if (referencedOrdinal >= ordinal) {
    throw new Error(`${path} cannot reference forward step ${reference.stepId}`);
  }
  const referencedStep = contract.trigger.steps[referencedOrdinal];
  if (referencedStep?.output === undefined) {
    throw new Error(
      `${path} references output from step ${reference.stepId} without an output schema`,
    );
  }
  if (authorityBearing && !hasFiniteSchemaChoices(referencedStep.output.schema, reference.path)) {
    throw new Error(
      `${path} uses agent output without provable finite choices for authority; use a finite enum or const`,
    );
  }
}

function isFiniteAuthorityExpression(
  contract: ExpressionContract,
  expression: Expression,
): boolean {
  if (expression.kind === "literal" || expression.kind === "not") {
    return expression.kind === "not" || expression.value !== null;
  }
  if (expression.kind === "binary") {
    return (
      expression.operator === "==" ||
      expression.operator === "!=" ||
      (isFiniteAuthorityExpression(contract, expression.left) &&
        isFiniteAuthorityExpression(contract, expression.right))
    );
  }
  return isFiniteAuthorityReference(contract, expression.value);
}

function isFiniteAuthorityReference(
  contract: ExpressionContract,
  reference: ExpressionPath,
): boolean {
  if (reference.namespace === "paseo") {
    return (
      reference.path !== "prompt" &&
      contract.trigger.inputs[reference.path[1]]?.choices !== undefined
    );
  }
  if (reference.namespace === "values") {
    const value = contract.trigger.values[reference.name];
    return value !== undefined && isFiniteAuthorityExpression(contract, value);
  }
  const referencedOrdinal = contract.stepOrdinals.get(reference.stepId);
  const step =
    referencedOrdinal === undefined ? undefined : contract.trigger.steps[referencedOrdinal];
  return step?.output !== undefined && hasFiniteSchemaChoices(step.output.schema, reference.path);
}

function compileAt<T>(path: readonly (string | number)[], operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HubConfigurationCompilationError) throw error;
    throw new HubConfigurationCompilationError(
      path,
      error instanceof Error ? error.message : "invalid Hub configuration",
      { cause: error },
    );
  }
}

function truthy(value: JsonValue): boolean {
  return value !== false && value !== null && value !== 0 && value !== "";
}

function interpolatedValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function uniqueJsonValues(values: readonly JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finiteBinaryValue(
  operator: Extract<Expression, { kind: "binary" }>["operator"],
  left: JsonValue,
  right: JsonValue,
): JsonValue {
  if (operator === "&&") return truthy(left) ? right : left;
  if (operator === "||") return truthy(left) ? left : right;
  if (operator === "??") return left === null ? right : left;
  if (operator === "==") return JSON.stringify(left) === JSON.stringify(right);
  return JSON.stringify(left) !== JSON.stringify(right);
}

function matchesInputType(value: JsonPrimitive | undefined, type: AuthoredInput["type"]): boolean {
  if (value === undefined) return true;
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function validateCompiledContract(config: CompiledHubConfig): void {
  validateEnvironmentTemplates(config.environments);
  const environments = validateCompiledEnvironments(config.environments);
  const triggerIds = new Set<string>();
  for (const trigger of config.triggers) {
    if (triggerIds.has(trigger.name)) throw new Error(`duplicate trigger id: ${trigger.name}`);
    triggerIds.add(trigger.name);
    validateCompiledTrigger(trigger, environments);
  }
}

function validateCompiledEnvironments(
  configured: readonly CompiledEnvironment[],
): ReadonlyMap<string, CompiledEnvironment> {
  const environments = new Map<string, CompiledEnvironment>();
  for (const environment of configured) {
    if (environments.has(environment.name)) {
      throw new Error(`duplicate environment id: ${environment.name}`);
    }
    if (!IDENTIFIER.test(environment.name))
      throw new Error(`invalid environment name: ${environment.name}`);
    environments.set(environment.name, environment);
  }
  return environments;
}

function validateCompiledTrigger(
  trigger: CompiledTrigger,
  environments: ReadonlyMap<string, CompiledEnvironment>,
): void {
  if (trigger.steps.length === 0)
    throw new Error(`trigger ${trigger.name} must contain a workflow step`);
  validateCompiledSteps(trigger, environments);
  validateCompiledInputs(trigger);
  for (const [name, expression] of Object.entries(trigger.values)) {
    assertIdentifier(name, "value name");
    if (!isExpression(expression)) throw new Error(`value ${name} contains an invalid expression`);
  }
  validateExpressionContract(trigger.name, trigger, environments);
  validateTriggerLaunchSecurity(trigger);
}

function validateCompiledSteps(
  trigger: CompiledTrigger,
  environments: ReadonlyMap<string, CompiledEnvironment>,
): void {
  const stepIds = new Set<string>();
  for (const step of trigger.steps) {
    if (stepIds.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
    stepIds.add(step.id);
    if (!environments.has(step.environment) && !step.environment.includes(EXPRESSION_START)) {
      throw new Error(`step ${step.id} references unknown environment ${step.environment}`);
    }
    validateCompiledStepEnvironment(step, trigger.inputs, environments);
    if (isScriptStep(step)) {
      validateScriptText(step.script);
      validateCompiledStepCondition(step);
    } else {
      validateCompiledAgentStep(trigger, step);
    }
  }
}

function validateCompiledAgentStep(trigger: CompiledTrigger, step: CompiledAgentStep): void {
  validateStepEnvironmentContract(trigger, step.id, step);
  if (step.idleTimeoutMs > step.maxRuntimeMs) {
    throw new Error(`step ${step.id} idle_timeout must not exceed max_runtime`);
  }
  validateCompiledPromptBlocks(step);
  assertTurnEndCompletionAllowed(step.id, {
    enabled: step.completeOnTurnEnd === true,
    structuredOutput: step.output !== undefined,
    requiredOutputs: step.allowOutputs.some((output) => output.required),
  });
  validateCompiledStepCondition(step);
  if (step.output !== undefined)
    validateOutputSchema(step.output.schema, `step ${step.id} output.schema`);
}

function validateCompiledStepCondition(step: CompiledStep): void {
  if (step.condition !== undefined && !isExpression(step.condition)) {
    throw new Error(`step ${step.id} contains an invalid condition`);
  }
}

/**
 * A title is presentation: it may carry the execution id so runs of one trigger can be told
 * apart, but never event text, so prompt, context, and inputs are refused by name.
 */
function validateTitleTemplate(title: string, path: string): void {
  for (const reference of expressionPathsInTemplate(title)) {
    if (reference.namespace !== "paseo") {
      throw new Error(
        `${path} uses ${reference.namespace}; a title supports only paseo.execution.id`,
      );
    }
    const name = typeof reference.path === "string" ? reference.path : reference.path[0];
    if (name === "execution") continue;
    throw new Error(
      `${path} uses paseo.${name}; a title is presentation and supports only paseo.execution.id`,
    );
  }
}

function validateEnvironmentTemplates(
  environments: readonly (AuthoredEnvironment | CompiledEnvironment)[],
): void {
  for (const environment of environments) {
    if (environment.kind !== "daemon" || environment.worktree?.mode !== "branch-off") continue;
    const newBranch = environment.worktree.newBranch;
    compileAt(["environments", environment.name, "worktree", "newBranch"], () => {
      validateExecutionTemplate(newBranch);
    });
  }
}

function validateCompiledStepEnvironment(
  step: CompiledStep,
  inputs: Readonly<Record<string, CompiledInput>>,
  environments: ReadonlyMap<string, CompiledEnvironment>,
): void {
  const staticEnvironment = environments.get(step.environment);
  if (staticEnvironment !== undefined && staticEnvironment.kind !== "daemon") {
    throw new Error(`step ${step.id} environment ${step.environment} must be a daemon environment`);
  }
  for (const choice of environmentInputChoices(step.environment, inputs)) {
    if (typeof choice !== "string") continue;
    const choiceEnvironment = environments.get(choice);
    if (choiceEnvironment !== undefined && choiceEnvironment.kind !== "daemon") {
      throw new Error(`step ${step.id} environment choice ${choice} must be a daemon environment`);
    }
  }
}

function environmentInputChoices(
  environment: string,
  inputs: Readonly<Record<string, CompiledInput>>,
): readonly JsonPrimitive[] {
  const inputName = DYNAMIC_INPUT_REFERENCE.exec(environment)?.[1];
  return inputName === undefined ? [] : (inputs[inputName]?.choices ?? []);
}

function validateStepEnvironmentContract(
  { name: triggerName, on: triggerEvent }: { name: string; on: string },
  stepId: string,
  { env, github }: Pick<CompiledAgentStep, "env" | "github">,
): void {
  if (env !== undefined) {
    for (const [key, value] of Object.entries(env)) {
      validateConnectionTemplate(value, `trigger ${triggerName} step ${stepId} env.${key}`);
      if (github !== undefined && isGitHubAuthorityEnvironmentKey(key)) {
        throw new Error(
          `trigger ${triggerName} step ${stepId} env.${key}: reserved by the step-level github authority; remove it from env`,
        );
      }
    }
  }
  if (github !== undefined) {
    validateGitHubAuthority(github, `trigger ${triggerName} step ${stepId} github`);
    if (github.repositories === undefined && !triggerEvent.startsWith("github.")) {
      throw new Error(
        `trigger ${triggerName} step ${stepId} github.repositories is required for non-GitHub triggers; list the repositories explicitly`,
      );
    }
  }
}

function validateCompiledPromptBlocks(step: CompiledAgentStep): void {
  for (const block of step.prompt) {
    if (block.kind !== "partial") continue;
    try {
      validateResolvedPromptPartialPath(block.path);
    } catch {
      throw new Error(`step ${step.id} contains an unsafe resolved prompt partial path`);
    }
    if (hashPromptPartialContent(block.content) !== block.contentHash) {
      throw new Error(`step ${step.id} contains invalid prompt partial content evidence`);
    }
  }
}

function validateOutputSchema(schema: JsonValue, path: string): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`${path} must be a JSON Schema object`);
  }
  try {
    compileJsonSchema(schema);
  } catch (error) {
    throw new Error(
      `${path} is invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

function hasFiniteSchemaChoices(schema: JsonValue, path: readonly string[]): boolean {
  return finiteSchemaChoices(schema, path) !== undefined;
}

function isExpression(value: unknown): value is Expression {
  if (!isRecord(value) || typeof value["kind"] !== "string") return false;
  if (value["kind"] === "literal") return isJsonValue(value["value"]);
  if (value["kind"] === "path") return isExpressionPath(value["value"]);
  if (value["kind"] === "not") return isExpression(value["value"]);
  return (
    value["kind"] === "binary" &&
    ["==", "!=", "&&", "||", "??"].includes(String(value["operator"])) &&
    isExpression(value["left"]) &&
    isExpression(value["right"])
  );
}

function isExpressionPath(value: unknown): boolean {
  return isRecord(value) && typeof value["namespace"] === "string" && hasExpressionPath(value);
}

function hasExpressionPath(value: Record<string, unknown>): boolean {
  if (value["namespace"] === "values") return typeof value["name"] === "string";
  if (value["namespace"] === "steps") {
    return (
      typeof value["stepId"] === "string" &&
      Array.isArray(value["path"]) &&
      value["path"].every((part) => typeof part === "string")
    );
  }
  return value["namespace"] === "paseo" && isPaseoExpressionPath(value["path"]);
}

function isPaseoExpressionPath(path: unknown): boolean {
  return (
    path === "prompt" ||
    (Array.isArray(path) &&
      path.length === 2 &&
      ((path[0] === "inputs" && typeof path[1] === "string") ||
        (path[0] === "execution" && path[1] === "id")))
  );
}

function validateAuthoredIds(config: AuthoredHubConfig): void {
  const environments = new Set<string>();
  for (const environment of config.environments) {
    assertIdentifier(environment.name, "environment name");
    if (environments.has(environment.name))
      throw new Error(`duplicate environment id: ${environment.name}`);
    environments.add(environment.name);
  }
  const triggers = new Set<string>();
  for (const trigger of config.triggers) {
    assertIdentifier(trigger.name, "trigger name");
    if (triggers.has(trigger.name)) throw new Error(`duplicate trigger id: ${trigger.name}`);
    triggers.add(trigger.name);
    const steps = new Set<string>();
    for (const step of trigger.steps) {
      assertIdentifier(step.id, "step id");
      if (steps.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
      steps.add(step.id);
    }
  }
}

/**
 * A script runs arbitrary code as the daemon's user, so the event that starts it must name who
 * or what may start it. A wildcard actor allowlist would let anyone who can reach the
 * connection run code on the host.
 */
function validateScriptTriggerSecurity(trigger: CompiledTrigger): void {
  if (trigger.on === "schedule.tick") return;
  if (trigger.on === "github.notification") {
    validateNotificationScriptFilters(trigger);
    return;
  }
  const users = trigger.filters?.from_users;
  if (users === undefined || users.length === 0 || users.includes("*")) {
    throw new Error(
      `trigger ${trigger.name} runs a script, so ${trigger.on} needs filters.from_users that names the people allowed to start it. A wildcard or empty list would let anyone who can reach this event run code on the host.`,
    );
  }
}

/**
 * A notification has no actor to allowlist, so the filters are the only thing between an
 * outsider and the host. Both are required, and the reason must be one a third party cannot cause.
 */
function validateNotificationScriptFilters(trigger: CompiledTrigger): void {
  const { repo, reason } = trigger.filters ?? {};
  const allowed = SCRIPT_NOTIFICATION_REASONS.join(", ");
  const prefix = `trigger ${trigger.name} runs a script on github.notification, which has no actor to allowlist.`;
  if (repo === undefined || reason === undefined) {
    throw new Error(
      `${prefix} Set both filters.repo and filters.reason. reason must be one of ${allowed}.`,
    );
  }
  if (!(SCRIPT_NOTIFICATION_REASONS as readonly string[]).includes(reason)) {
    throw new Error(
      `${prefix} filters.reason "${reason}" is not allowed for a script. Use one of ${allowed}. Third parties can cause mention, team_mention, comment, subscribed and manual notifications, so those could let an outsider run code on the host.`,
    );
  }
}

function validateTriggerLaunchSecurity(trigger: CompiledTrigger): void {
  if (trigger.steps.some(isScriptStep)) validateScriptTriggerSecurity(trigger);
  // A notification carries no actor, so an allowlist could never be enforced. Fail closed.
  if (trigger.on === "github.notification" && trigger.filters?.from_users !== undefined) {
    throw new Error(`trigger ${trigger.name}: ${NOTIFICATION_FROM_USERS_MESSAGE}`);
  }
  if (isEditorEvent(trigger.on) && eventDefinition(trigger.on).origin === "hub") return;
  validateExternalTriggerLaunch(trigger);
}

function validateExternalTriggerLaunch(trigger: CompiledTrigger): void {
  // A project scout is an intentionally autonomous, project-scoped policy. Every other
  // externally-originated Linear action remains actor-allowlisted below.
  if (trigger.on === "linear.issue_entered_scope") {
    if (trigger.filters?.project === undefined) {
      throw new Error(
        `trigger ${trigger.name} requires filters.project for linear.issue_entered_scope`,
      );
    }
    return;
  }
  if ((trigger.filters?.from_users?.length ?? 0) === 0) {
    throw new Error(
      `trigger ${trigger.name} requires a non-empty filters.from_users allowlist for externally sourced events`,
    );
  }
}

function assertIdentifier(value: string, kind: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`invalid ${kind}: ${value}`);
}

function rejectRemovedFields(raw: unknown): void {
  rejectTimeoutAnywhere(raw);
  if (!isRecord(raw)) return;
  const triggers: unknown = raw["triggers"];
  if (!Array.isArray(triggers)) return;
  triggers.forEach((trigger: unknown, index) => rejectTriggerFields(trigger, index));
}

function rejectTriggerFields(value: unknown, index: number): void {
  if (!isRecord(value)) return;
  for (const field of [
    "environment",
    "agent",
    "prompt",
    "idle_timeout",
    "auto_archive",
    "background",
    "allow_outputs",
  ]) {
    if (field in value) {
      throw new Error(
        `triggers[${index}].${field}: trigger-level ${field} was removed; put ${field} on the relevant workflow step`,
      );
    }
  }
}

function rejectTimeoutAnywhere(value: unknown, path = "configuration"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectTimeoutAnywhere(child, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  if ("timeout" in value) throw new Error(`${path}.timeout: timeout was removed; use max_runtime`);
  for (const [key, child] of Object.entries(value)) rejectTimeoutAnywhere(child, `${path}.${key}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function cloneJsonValue(value: unknown): JsonValue {
  const cloned: unknown = structuredClone(value);
  if (!isJsonValue(cloned)) throw new Error("value is not valid JSON");
  return cloned;
}

function cloneJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const cloned = cloneJsonValue(value);
  if (!isRecord(cloned)) throw new Error("value is not a JSON object");
  return cloned as Record<string, JsonValue>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const child of value as unknown[]) deepFreeze(child);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function hashConfiguration(configuration: unknown): string {
  return createHash("sha256").update(stableJson(configuration)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
