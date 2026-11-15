import { z } from "zod";

/** What a finished script step stores as its output, and what the run history shows. */
export const ScriptStepResultSchema = z.object({
  /** Null when the script never reported one: a timeout, a lost terminal, a refusal. */
  exit_code: z.number().int().nullable(),
  output_tail: z.string(),
  truncated: z.boolean(),
});
export type ScriptStepResult = z.infer<typeof ScriptStepResultSchema>;

/** What a running script step stores, so a restarted Hub can find and stop its terminal. */
export const ScriptStepHandleSchema = z.object({
  terminal_id: z.string().min(1),
  daemon_id: z.string().min(1),
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

/** The terminal's name on the host, which ties it to one step run. */
export function scriptTerminalName(stepRunId: string): string {
  return `hub-script-${stepRunId}`;
}
