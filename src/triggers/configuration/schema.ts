import { RecurrenceSchema } from "../schedule/recurrence.js";
import { z } from "zod";
import { ContinuationSchema } from "../continuation.js";
import { hasProgressDestination, PROGRESS_DESTINATION_REQUIRED } from "../progress-events.js";
import {
  eventDefinition,
  isEditorEvent,
  NOTIFICATION_FILTER_KEYS,
  NOTIFICATION_FROM_USERS_MESSAGE,
  replyMessageError,
} from "./events.js";
import { AuthoredGitHubAuthoritySchema } from "../../config/github-authority.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const WorktreeTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("branch-off"),
    newBranch: z.string().min(1),
    base: z.string().min(1).optional(),
  }),
  z.object({ mode: z.literal("checkout-branch"), branch: z.string().min(1) }),
  z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
]);

/** A trigger or choice name: the document's own alphabet, shared with the form that writes one. */
export const IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const EVENT_NAME = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/u;
const CONNECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const InputValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const TriggerInputSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    required: z.boolean().optional(),
    default: InputValueSchema.optional(),
    choices: z.array(InputValueSchema).min(1).optional(),
  })
  .strict();

export const TriggerFilterSchema = z
  .object({
    pattern: z.string().optional(),
    contains: z.string().optional(),
    /** GitHub text which makes an event ineligible, such as a command another trigger owns. */
    exclude_contains: z.string().optional(),
    label: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).min(1).optional(),
    repo: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    guild: z.string().min(1).optional(),
    workspace: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    states: z.array(z.string().min(1)).min(1).optional(),
    exclude_labels: z.array(z.string().min(1)).min(1).optional(),
    assignees: z.array(z.string().min(1)).min(1).optional(),
    channels: z.array(z.string().min(1)).optional(),
    from_users: z.array(z.string().min(1)).optional(),
    inputs: z.record(z.string(), InputValueSchema).optional(),
  })
  .strict();

export const TriggerEventSchema = z
  .object({
    recurrence: RecurrenceSchema.optional(),
    connection: z.string().regex(CONNECTION_SLUG).optional(),
    filters: TriggerFilterSchema.optional(),
  })
  .strict();

export const TriggerAgentSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    options: z.record(z.string(), z.custom<JsonValue>()).optional(),
  })
  .strict();

export const TriggerAgentSelectionSchema = z.union([
  TriggerAgentSchema,
  z
    .object({
      select: z.string().min(1),
      choices: z.record(z.string().regex(IDENTIFIER), TriggerAgentSchema),
    })
    .strict(),
]);

export const TriggerTargetSchema = z
  .object({
    daemon: z.string().min(1),
    cwd: z.string().min(1),
    worktree: WorktreeTargetSchema.optional(),
  })
  .strict();

export const TriggerOutputSchema = z
  .object({
    max: z.number().int().positive().optional(),
    required: z.boolean().optional(),
  })
  .strict();

export const TriggerAgentRunSchema = z
  .object({
    target: TriggerTargetSchema,
    agent: TriggerAgentSelectionSchema,
    continuation: ContinuationSchema.default({ mode: "conversation" }),
    /** Workspace title template: literal text plus `${{ paseo.execution.id }}`. */
    title: z.string().min(1).optional(),
    prompt: z.string().min(1),
    max_runtime: z.string().min(1).default("2h"),
    idle_timeout: z.string().min(1).default("10m"),
    startup_timeout: z.string().min(1).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
    github: AuthoredGitHubAuthoritySchema.optional(),
    output: z
      .object({ schema: z.record(z.string(), z.unknown()) })
      .strict()
      .optional(),
    outputs: z.record(z.string().regex(EVENT_NAME), TriggerOutputSchema).optional(),
    auto_archive: z.boolean().default(true),
    background: z.boolean().default(false),
    /** Count a finished agent turn as done when the agent never calls finish_execution. */
    complete_on_turn_end: z.boolean().optional(),
  })
  .strict();

export const DEFAULT_SCRIPT_MAX_RUNTIME = "10m";

export const TriggerScriptRunSchema = z
  .object({
    target: z.object({ daemon: z.string().min(1), cwd: z.string().min(1) }).strict(),
    /** The script text `/bin/sh -c` runs. It is literal: event data arrives in HUB_EVENT_JSON. */
    script: z.string().refine((script) => script.trim().length > 0, "script must not be blank"),
    max_runtime: z.string().min(1).default(DEFAULT_SCRIPT_MAX_RUNTIME),
  })
  .strict();

export type TriggerAgentRun = z.infer<typeof TriggerAgentRunSchema>;
export type TriggerScriptRun = z.infer<typeof TriggerScriptRunSchema>;
export type TriggerRun = TriggerAgentRun | TriggerScriptRun;

export function isScriptRun(run: TriggerRun): run is TriggerScriptRun {
  return "script" in run;
}

/** The run as an agent run, for code that is only ever given one. */
export function agentRun(run: TriggerRun): TriggerAgentRun {
  if (isScriptRun(run)) throw new Error("expected an agent run");
  return run;
}

const TWO_TRIGGERS = "To do both, use two triggers on the same event.";

/** Why each agent-only option has no meaning for a script, so the author is told what to do instead. */
const SCRIPT_REJECTED_OPTIONS: Readonly<Record<string, string>> = {
  agent: `agent does not apply to a script. A trigger runs an agent prompt or a script. ${TWO_TRIGGERS}`,
  prompt: `prompt does not apply to a script. A trigger runs an agent prompt or a script. ${TWO_TRIGGERS}`,
  continuation:
    "continuation does not apply to a script. It has no agent conversation to continue.",
  output: "output does not apply to a script. Hub records the exit code and the output tail.",
  outputs: "outputs does not apply to a script. Hub records the exit code and the output tail.",
  github:
    "github does not apply to a script. Hub mints no token for it; the script runs as the daemon's user.",
  env: "env does not apply to a script. It inherits the daemon's environment and reads the event from HUB_EVENT_JSON. Set other variables inside the script.",
  idle_timeout: "idle_timeout does not apply to a script. Use max_runtime.",
  startup_timeout: "startup_timeout does not apply to a script. Use max_runtime.",
  title: "title does not apply to a script. It creates no workspace.",
  background: "background does not apply to a script. It creates no workspace.",
  auto_archive: "auto_archive does not apply to a script. It creates no workspace.",
  complete_on_turn_end: "complete_on_turn_end does not apply to a script. It has no agent turn.",
};

/**
 * `run` is one of two shapes, chosen by the `script` key, so each reports its own field errors
 * instead of a union's "Invalid input".
 */
export const TriggerRunSchema = z.unknown().transform((value, context): TriggerRun => {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue([], "run must be an object with a target and an action: agent and prompt, or script.");
    return z.NEVER;
  }
  if (!("script" in value)) {
    if (!("agent" in value) && !("prompt" in value)) {
      issue([], "run needs an action: agent with prompt, or script.");
      return z.NEVER;
    }
    const parsed = TriggerAgentRunSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const found of parsed.error.issues) issue(issuePath(found.path), found.message);
    return z.NEVER;
  }
  const refused = Object.entries(SCRIPT_REJECTED_OPTIONS).filter(([key]) => key in value);
  for (const [key, message] of refused) issue([key], message);
  const target: unknown = "target" in value ? value.target : undefined;
  const worktree = typeof target === "object" && target !== null && "worktree" in target;
  if (worktree) {
    issue(
      ["target", "worktree"],
      "worktree does not apply to a script. It runs in the working directory as it is.",
    );
  }
  if (refused.length > 0 || worktree) return z.NEVER;
  const parsed = TriggerScriptRunSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  for (const found of parsed.error.issues) issue(issuePath(found.path), found.message);
  return z.NEVER;
});

function issuePath(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((segment) =>
    typeof segment === "symbol" ? (segment.description ?? String(segment)) : segment,
  );
}

export const TriggerDocumentSchema = z
  .object({
    name: z.string().regex(IDENTIFIER),
    enabled: z.boolean().default(true),
    on: z.record(z.string().regex(EVENT_NAME), TriggerEventSchema),
    inputs: z.record(z.string().regex(IDENTIFIER), TriggerInputSchema).optional(),
    /** A distinct whole-trigger deadline; new one-run triggers normally omit it. */
    max_runtime: z.string().min(1).optional(),
    progress_message: z.boolean().optional(),
    reply_message: z.boolean().optional(),
    run: TriggerRunSchema,
  })
  .strict()
  .superRefine((trigger, context) => {
    if (
      trigger.progress_message === true &&
      Object.keys(trigger.on).some((event) => !hasProgressDestination(event))
    ) {
      context.addIssue({
        code: "custom",
        path: ["progress_message"],
        message: PROGRESS_DESTINATION_REQUIRED,
      });
    }
    if (trigger.reply_message === true) {
      for (const [event, definition] of Object.entries(trigger.on)) {
        const error = replyMessageError(event, definition.filters?.from_users);
        if (error !== undefined)
          context.addIssue({ code: "custom", path: ["reply_message"], message: error });
      }
    }
  })
  .superRefine((trigger, context) => {
    for (const [event, definition] of Object.entries(trigger.on)) {
      if (event === "schedule.tick") {
        if (
          definition.recurrence === undefined ||
          definition.connection !== undefined ||
          definition.filters !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["on", event],
            message: "Schedule requires recurrence and does not accept connection or filters.",
          });
        }
        // A tick supplies no inputs; it runs with the declared defaults.
        for (const [name, input] of Object.entries(trigger.inputs ?? {})) {
          if (input.required !== true) continue;
          context.addIssue({
            code: "custom",
            path: ["inputs", name],
            message: "A trigger with a schedule cannot require an input; give it a default.",
          });
        }
      } else if (definition.recurrence !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["on", event, "recurrence"],
          message: "Recurrence is only supported for schedule.tick.",
        });
      }
      notificationIssues(definition, event, context);
      const addedLabel = isEditorEvent(event)
        ? eventDefinition(event).qualifiers.find(({ key }) => key === "label")
        : undefined;
      if (addedLabel?.required && !definition.filters?.label?.trim()) {
        context.addIssue({
          code: "custom",
          path: ["on", event, "filters", "label"],
          message: `${addedLabel.label} is required.`,
        });
      }
    }
    if (Object.keys(trigger.on).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["on"],
        message: "at least one event is required",
      });
    }
    if (
      !isScriptRun(trigger.run) &&
      "choices" in trigger.run.agent &&
      Object.keys(trigger.run.agent.choices).length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "agent", "choices"],
        message: "at least one agent choice is required",
      });
    }
  });

export type TriggerDocument = z.infer<typeof TriggerDocumentSchema>;

/** The poll has no connection and no actor; a filter it cannot evaluate must not pass silently. */
function notificationIssues(
  definition: z.infer<typeof TriggerEventSchema>,
  event: string,
  context: z.RefinementCtx,
): void {
  if (event !== "github.notification") {
    if (definition.filters?.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["on", event, "filters", "reason"],
        message: "reason is only supported for github.notification.",
      });
    }
    return;
  }
  if (definition.connection !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["on", event, "connection"],
      message: "github.notification uses the Hub notification token and takes no connection.",
    });
  }
  for (const key of Object.keys(definition.filters ?? {})) {
    if (key === "from_users") {
      context.addIssue({
        code: "custom",
        path: ["on", event, "filters", key],
        message: NOTIFICATION_FROM_USERS_MESSAGE,
      });
    } else if (!(NOTIFICATION_FILTER_KEYS as readonly string[]).includes(key)) {
      context.addIssue({
        code: "custom",
        path: ["on", event, "filters", key],
        message: `github.notification supports only these filters: ${NOTIFICATION_FILTER_KEYS.join(", ")}.`,
      });
    }
  }
}
