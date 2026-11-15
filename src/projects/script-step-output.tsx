import { useState } from "react";

import { CodeBlock } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { readScriptStepHandle, readScriptStepResult } from "../workflows/script-output.js";

/**
 * A script step's output, or `undefined` when the value is not one, so the caller can fall back
 * to the generic JSON view. A script that is still running shows no result yet.
 */
export function ScriptStepOutput({ stepId, output }: { stepId: string; output: unknown }) {
  const result = readScriptStepResult(output);
  const [open, setOpen] = useState(false);
  if (result === undefined) {
    return readScriptStepHandle(output) === undefined ? null : (
      <span className="text-muted-foreground">Running on the daemon</span>
    );
  }
  return (
    <div className="grid gap-2">
      <span>
        {result.exit_code === null ? "No exit code" : `Exit code ${String(result.exit_code)}`}
      </span>
      <Disclosure
        id={`script-output-${stepId}`}
        open={open}
        onOpenChange={setOpen}
        title="Output"
        description={
          result.truncated ? "The last 64 KB of the output." : "Everything the script printed."
        }
      >
        <CodeBlock label="Script output">
          {result.output_tail === "" ? "(no output)" : result.output_tail}
        </CodeBlock>
      </Disclosure>
    </div>
  );
}

/** Whether the value is something this step kind shows, so the table can pick a view. */
export function isScriptStepOutput(output: unknown): boolean {
  return readScriptStepResult(output) !== undefined || readScriptStepHandle(output) !== undefined;
}
