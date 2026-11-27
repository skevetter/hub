import { SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";

import type { TriggerFormValue } from "./configuration/editor.js";

/**
 * The line under a trigger's name in the list: what it runs. A script has no provider to name,
 * so it says so with the terminal glyph.
 */
export function triggerSecondaryLine(trigger: {
  format?: string | undefined;
  draft: Pick<TriggerFormValue, "steps"> | null;
}): ReactNode {
  if (trigger.format === "legacy_multistep") return "Legacy YAML";
  if (trigger.draft?.steps[0]?.action === "script") {
    return (
      <span className="inline-flex items-center gap-1">
        <SquareTerminal aria-hidden="true" className="size-3.5 shrink-0" />
        Script
      </span>
    );
  }
  return trigger.draft?.steps[0]?.agent ?? "Advanced YAML";
}
