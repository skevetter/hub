import { z } from "zod";

/** What a finished script step stores as its output, and what the run history shows. */
/** A terminal the daemon never confirmed stopped, left for the sweep to find. */
export const ScriptStepCleanupSchema = z.object({
  daemon_id: z.string().min(1),
  cwd: z.string().min(1),
  name: z.string().min(1),
  terminal_id: z.string().min(1).optional(),
});
export type ScriptStepCleanup = z.infer<typeof ScriptStepCleanupSchema>;

export const ScriptStepResultSchema = z.object({
  /** Null when the script never reported one: a timeout, a lost terminal, a refusal. */
  exit_code: z.number().int().nullable(),
  output_tail: z.string(),
  truncated: z.boolean(),
  /** Present only while a stop is unconfirmed. */
  cleanup: ScriptStepCleanupSchema.optional(),
});
export type ScriptStepResult = z.infer<typeof ScriptStepResultSchema>;

/** What a running script step stores, so a restarted Hub can find and stop its terminal. */
export const ScriptStepHandleSchema = z.object({
  daemon_id: z.string().min(1),
  cwd: z.string().min(1),
  /** Absent between the step starting and the terminal existing. */
  terminal_id: z.string().min(1).optional(),
});
export type ScriptStepHandle = z.infer<typeof ScriptStepHandleSchema>;

export function readScriptStepResult(value: unknown): ScriptStepResult | undefined {
  const parsed = ScriptStepResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function readScriptStepHandle(value: unknown): ScriptStepHandle | undefined {
  const parsed = ScriptStepHandleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Every terminal Hub opens for a script is named with this prefix, so a sweep can find it. */
export const SCRIPT_TERMINAL_PREFIX = "hub-script-";

/** The terminal's name on the host: the prefix and the step run's id, not the step's name. */
export function scriptTerminalName(stepRunId: string): string {
  return `${SCRIPT_TERMINAL_PREFIX}${stepRunId}`;
}

/** The step run id a script terminal's name carries, or undefined for any other terminal. */
export function stepRunIdFromTerminalName(name: string): string | undefined {
  return name.startsWith(SCRIPT_TERMINAL_PREFIX)
    ? name.slice(SCRIPT_TERMINAL_PREFIX.length)
    : undefined;
}
