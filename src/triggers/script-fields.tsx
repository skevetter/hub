/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- the controls bind one trigger form */
import { MessageSquareText, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";

import { NoticeAlert } from "../components/app/failure-alert.js";
import { FormField } from "../components/app/form-field.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import { Textarea } from "../components/ui/textarea.js";
import {
  changeTriggerAction,
  type TriggerAction,
  type TriggerFieldErrors,
  type TriggerFormValue,
} from "./configuration/editor.js";

const ACTION_OPTIONS: readonly SegmentedOption[] = [
  {
    value: "prompt",
    label: "Prompt",
    icon: MessageSquareText,
    hint: "Start an agent on the daemon with these instructions.",
  },
  {
    value: "script",
    label: "Script",
    icon: SquareTerminal,
    hint: "Run a shell script on the daemon's host. To also start an agent, add a second trigger on the same event.",
  },
];

/** What the trigger runs when its event arrives. */
export function ActionField({
  value,
  onChange,
}: {
  value: TriggerFormValue;
  onChange: (value: TriggerFormValue) => void;
}) {
  return (
    <SegmentedControl
      label="Action"
      description="What runs when the event arrives."
      value={value.action}
      options={ACTION_OPTIONS}
      onChange={(action) => onChange(changeTriggerAction(value, parseAction(action)))}
    />
  );
}

function parseAction(value: string): TriggerAction {
  return value === "script" ? "script" : "prompt";
}

/** The script, and what the author is taking on by running one. */
export function ScriptFields({
  value,
  errors,
  onChange,
}: {
  value: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}) {
  const error = errors.script;
  return (
    <>
      <FormField
        id="trigger-script"
        label="Script"
        description="Run by /bin/sh -c. Output and the exit code are kept in the run history. Event data is in the HUB_EVENT_JSON environment variable."
        required
        {...(error === undefined ? {} : { error })}
      >
        {(control) => (
          <Textarea
            {...control}
            name="script"
            value={value.script}
            onChange={(event) => onChange({ ...value, script: event.target.value })}
            rows={10}
            spellCheck={false}
            placeholder={'echo "$HUB_EVENT_JSON"'}
            className="min-h-48 font-mono text-xs"
          />
        )}
      </FormField>
      <NoticeAlert tone="neutral" title="Runs on the daemon's host">
        <p>
          The script runs as the daemon's user. The working directory must be an open project in
          Paseo. Hub needs the workspace.read and workspace.write permissions on the daemon.
        </p>
      </NoticeAlert>
    </>
  );
}

/**
 * The line under a trigger's name in the list: what it runs. A script has no provider to name,
 * so it says so with the terminal glyph.
 */
export function triggerSecondaryLine(trigger: {
  format?: string | undefined;
  draft: Pick<TriggerFormValue, "action" | "agent"> | null;
}): ReactNode {
  if (trigger.format === "legacy_multistep") return "Legacy YAML";
  if (trigger.draft?.action === "script") {
    return (
      <span className="inline-flex items-center gap-1">
        <SquareTerminal aria-hidden="true" className="size-3.5 shrink-0" />
        Script
      </span>
    );
  }
  return trigger.draft?.agent ?? "Advanced YAML";
}
