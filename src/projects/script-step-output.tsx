import { useCallback, useState } from "react";

import { CodeBlock } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { readScriptStepHandle, readScriptStepResult } from "../workflows/script-output.js";

/**
 * A script step's output, or `undefined` when the value is not one, so the caller can fall back
 * to the generic JSON view. A script that is still running shows no result yet.
 */
export function ScriptStepOutput({
  stepId,
  status,
  output,
}: {
  stepId: string;
  status: string;
  output: unknown;
}) {
  const result = readScriptStepResult(output);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const showMore = useCallback(() => setExpanded(true), []);
  if (result === undefined) {
    if (readScriptStepHandle(output) === undefined) return null;
    // Only a running step is still running. One the deadline ended has no result to show.
    return (
      <span className="text-muted-foreground">
        {status === "running" ? "Running on the daemon" : "Stopped before it reported a result"}
      </span>
    );
  }
  const outputTail = result.output_tail.slice(-64 * 1024);
  const truncated = result.truncated || outputTail.length < result.output_tail.length;
  return (
    <div className="grid gap-2">
      <span>{exitCodeLabel(result.exit_code)}</span>
      <Disclosure
        id={`script-output-${stepId}`}
        open={open}
        onOpenChange={setOpen}
        title="Output"
        description={truncated ? "The last 64 KB of the output." : "Everything the script printed."}
      >
        <CodeBlock label="Script output">
          {outputTail === "" ? "(no output)" : outputTail.slice(expanded ? 0 : -4096)}
        </CodeBlock>
        {!expanded && outputTail.length > 4096 ? (
          <button type="button" onClick={showMore}>
            Show more
          </button>
        ) : null}
      </Disclosure>
    </div>
  );
}

function exitCodeLabel(exitCode: number | null): string {
  return exitCode === null ? "No exit code" : `Exit code ${String(exitCode)}`;
}

/** Whether the value is something this step kind shows, so the table can pick a view. */
export function isScriptStepOutput(output: unknown): boolean {
  return readScriptStepResult(output) !== undefined || readScriptStepHandle(output) !== undefined;
}
