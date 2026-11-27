/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- the controls bind one trigger form */
import { MessageSquareText, SquareTerminal } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";

import { CheckboxField } from "../components/app/checkbox-field.js";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { FormField } from "../components/app/form-field.js";
import { LoadingLine } from "../components/app/loading.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import {
  changeStepAction,
  sharedYamlField,
  type TriggerAction,
  type TriggerStepField,
  type TriggerStepFormValue,
} from "./configuration/editor.js";
import {
  fieldError,
  patchStepAt,
  stepAt,
  stepFieldId,
  stepFieldKey,
  type StepFieldProps,
} from "./step-form-model.js";
import type { DaemonProviderCatalog } from "./use-daemon-provider-catalog.js";
import type { TriggerSnapshot } from "./functions.js";
import {
  selectedProviderModel,
  unattendedAgentOptions,
  unattendedModeOptions,
} from "./provider-catalog.js";

type StepFieldUpdate = <Key extends TriggerStepField & keyof TriggerStepFormValue>(
  key: Key,
  value: TriggerStepFormValue[Key],
) => void;

function stepUpdate({ form, onChange, index }: StepFieldProps): StepFieldUpdate {
  return (key, value) => onChange(patchStepAt(form, index, { [key]: value }));
}

/** The field's own error slot and its YAML-sharing state, both keyed by this step. */
/** Whether any of these fields of the step carries an error the reader has to see. */
function stepHasError(props: StepFieldProps, fields: readonly TriggerStepField[]): boolean {
  return fields.some((field) => props.errors[stepFieldKey(props.index, field)] !== undefined);
}

/**
 * A section that holds a flagged field is open, including when the step it belongs to is drawn
 * again after being a one-line summary.
 */
export function useFlaggedOpen(flagged: boolean, initial: boolean) {
  const [open, setOpen] = useState(initial || flagged);
  useEffect(() => {
    if (flagged) setOpen(true);
  }, [flagged]);
  return [open, setOpen] as const;
}

function stepFieldState(props: StepFieldProps, field: TriggerStepField) {
  const key = stepFieldKey(props.index, field);
  return { ...sharedYamlField(props.form, key), ...fieldError(props.errors, key) };
}

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
    hint: "Run a shell script on the daemon's host.",
  },
];

function parseAction(value: string): TriggerAction {
  return value === "script" ? "script" : "prompt";
}

/** What this step runs when its turn comes. */
export function StepActionField({
  form,
  onChange,
  index,
}: StepFieldProps): ReactElement<ComponentProps<typeof SegmentedControl>> {
  return (
    <SegmentedControl
      label="Action"
      description="What runs at this step."
      value={stepAt(form, index).action}
      options={ACTION_OPTIONS}
      onChange={(action) => onChange(changeStepAction(form, index, parseAction(action)))}
    />
  );
}

/** The script, and what the author is taking on by running one. */
export function StepScriptFields(props: StepFieldProps) {
  const { form, onChange, index } = props;
  return (
    <>
      <FormField
        id={stepFieldId("trigger-script", index)}
        label="Script"
        description="Run by /bin/sh -c. Output and the exit code are kept in the run history. Event data is in the HUB_EVENT_JSON environment variable."
        required
        {...stepFieldState(props, "script")}
      >
        {(control) => (
          <Textarea
            {...control}
            name="script"
            value={stepAt(form, index).script}
            onChange={(event) => onChange(patchStepAt(form, index, { script: event.target.value }))}
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

const AGENT_LIMIT_COPY = "Hard deadline for the agent, for example 2h.";
const SCRIPT_LIMIT_COPY = "Hub stops the script at this deadline, for example 10m.";

/** The run limit of this step, and for an agent the idle timeout. */
export function StepLimitFields(props: StepFieldProps) {
  const { form, index } = props;
  const step = stepAt(form, index);
  const update = stepUpdate(props);
  const script = step.action === "script";
  return (
    <>
      <FormField
        id={stepFieldId("trigger-max-runtime", index)}
        label="Maximum runtime"
        description={script ? SCRIPT_LIMIT_COPY : AGENT_LIMIT_COPY}
        kind="text"
        name="maxRuntime"
        value={step.maxRuntime}
        onChange={(value) => update("maxRuntime", value)}
        required
        {...stepFieldState(props, "maxRuntime")}
      />
      {script ? null : (
        <FormField
          id={stepFieldId("trigger-idle-timeout", index)}
          label="Idle timeout"
          description="Stop an unresponsive agent, for example 10m."
          kind="text"
          name="idleTimeout"
          value={step.idleTimeout}
          onChange={(value) => update("idleTimeout", value)}
          required
          {...stepFieldState(props, "idleTimeout")}
        />
      )}
    </>
  );
}

export interface StepAgentProps extends StepFieldProps {
  providerCatalog: DaemonProviderCatalog;
  connections: TriggerSnapshot["connections"];
}

/** Everything an agent step is made of, in the order it is decided. */
export function StepAgentFields(props: StepAgentProps) {
  const { providerCatalog, connections, ...fields } = props;
  return (
    <>
      <StepProviderFields {...fields} providerCatalog={providerCatalog} />
      <StepContinuityFields {...fields} />
      <StepPromptFields {...fields} />
      <StepGitHubFields {...fields} connections={connections} />
    </>
  );
}

function StepProviderFields({
  providerCatalog,
  ...fields
}: StepFieldProps & { providerCatalog: DaemonProviderCatalog }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <StepAgentChoice
          {...fields}
          entries={providerCatalog.entries}
          loading={providerCatalog.loading}
        />
      </div>
      {providerCatalog.loading ? (
        <LoadingLine>{`Loading providers from ${fields.form.daemon}…`}</LoadingLine>
      ) : null}
      {providerCatalog.error === undefined ? null : (
        <FailureAlert
          title="Providers unavailable"
          error={providerCatalog.error}
          fallback="Hub couldn't load this daemon's providers."
          onRetry={providerCatalog.refresh}
        />
      )}
    </>
  );
}

interface ProviderEntries {
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
}

function StepAgentChoice(props: StepFieldProps & ProviderEntries) {
  const { form, onChange, index, entries, loading } = props;
  const agentOptions = unattendedAgentOptions(entries) satisfies ComboboxOption[];
  return (
    <>
      <FormField
        id={stepFieldId("trigger-agent", index)}
        label="Agent"
        description="Models the selected daemon can run unattended: Claude, Codex, OpenCode, or omp."
        required
        {...stepFieldState(props, "agent")}
      >
        {(control) => (
          <Combobox
            {...control}
            required
            loading={loading}
            value={stepAt(form, index).agent}
            options={agentOptions}
            placeholder="Select a model"
            searchPlaceholder="Search models…"
            empty="No models found."
            onChange={(option) =>
              onChange(
                patchStepAt(form, index, { agent: option.value, mode: "", thinkingOptionId: "" }),
              )
            }
          />
        )}
      </FormField>
      <StepExecutionFields {...props} />
    </>
  );
}

function StepExecutionFields(props: StepFieldProps & ProviderEntries) {
  const { form, onChange, index, entries } = props;
  const step = stepAt(form, index);
  const selected = selectedProviderModel(entries, step.agent);
  const modeOptions = unattendedModeOptions(selected.entry);
  const thinkingOptions = (selected.model?.thinkingOptions ?? []).map((option) => ({
    value: option.id,
    label: option.label,
  }));
  return (
    <>
      <FormField
        id={stepFieldId("trigger-mode", index)}
        label="Execution mode"
        description="Modes reported for the selected provider. omp runs unattended only in full."
        required
        {...stepFieldState(props, "mode")}
      >
        {(control) => (
          <Combobox
            {...control}
            required
            value={step.mode}
            options={modeOptions}
            placeholder="Select a mode"
            empty="No modes found."
            onChange={(option) => onChange(patchStepAt(form, index, { mode: option.value }))}
          />
        )}
      </FormField>
      {thinkingOptions.length === 0 ? null : (
        <FormField
          id={stepFieldId("trigger-thinking", index)}
          label="Thinking"
          description="Thinking options reported for the selected model."
          required
          {...stepFieldState(props, "thinkingOptionId")}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              value={step.thinkingOptionId}
              options={thinkingOptions}
              placeholder="Select a thinking option"
              empty="No thinking options found."
              onChange={(option) =>
                onChange(patchStepAt(form, index, { thinkingOptionId: option.value }))
              }
            />
          )}
        </FormField>
      )}
    </>
  );
}

const CONTINUITY_OPTIONS: readonly SegmentedOption[] = [
  {
    value: "new",
    label: "New agent",
    hint: "Create a separate agent for every request.",
  },
  {
    value: "conversation",
    label: "Same conversation",
    hint: "Continue the same agent for this conversation. Events without a conversation start a new agent. Archived workspaces are restored.",
  },
  {
    value: "key",
    label: "Custom key",
    hint: "Arrivals with the same key in this project share an agent. Agent and workspace settings must match.",
  },
];

function StepContinuityFields(props: StepFieldProps) {
  const { form, index } = props;
  const step = stepAt(form, index);
  const update = stepUpdate(props);
  const mode = stepFieldState(props, "continuationMode");
  return (
    <>
      <fieldset disabled={mode.disabled}>
        <SegmentedControl
          label="Agent continuity"
          description={mode.description ?? "Agent continuity"}
          value={step.continuationMode}
          onChange={(value) => update("continuationMode", value)}
          options={CONTINUITY_OPTIONS}
        />
        {mode.error === undefined ? null : (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {mode.error}
          </p>
        )}
      </fieldset>
      {step.continuationMode === "key" ? (
        <FormField
          id={stepFieldId("trigger-continuation-key", index)}
          label="Continuation key"
          kind="text"
          name="continuationKey"
          value={step.continuationKey}
          onChange={(value) => update("continuationKey", value)}
          description="A key or expression, for example ${{ paseo.inputs.ticket }}."
          required
          {...stepFieldState(props, "continuationKey")}
        />
      ) : null}
    </>
  );
}

function StepPromptFields(props: StepFieldProps) {
  const { form, index } = props;
  const step = stepAt(form, index);
  const update = stepUpdate(props);
  const [optionsExpanded, setOptionsExpanded] = useFlaggedOpen(
    stepHasError(props, ["providerOptions"]),
    false,
  );
  return (
    <>
      <PromptEditor
        id={stepFieldId("trigger-prompt", index)}
        value={step.prompt}
        {...stepFieldState(props, "prompt")}
        onChange={(prompt) => update("prompt", prompt)}
      />
      <CheckboxField
        id={stepFieldId("trigger-complete-on-turn-end", index)}
        label="Complete when the agent ends its turn"
        description="If the agent stops without calling finish_execution, count the run as done instead of failing it at the idle timeout. Not for runs with a structured output or a required output."
        checked={step.completeOnTurnEnd}
        {...sharedYamlField(form, stepFieldKey(index, "completeOnTurnEnd"))}
        onChange={(checked) => update("completeOnTurnEnd", checked)}
      />
      <Disclosure
        id={stepFieldId("trigger-provider-options", index)}
        open={optionsExpanded}
        onOpenChange={setOptionsExpanded}
        title="Advanced provider options"
        description="Fields the form does not model, passed through to the provider."
      >
        <FormField
          id={stepFieldId("trigger-provider-options-json", index)}
          label="Provider options (JSON)"
          description="Passed to the provider on your daemon. YAML-only agent fields remain untouched."
          kind="multiline"
          name="providerOptions"
          value={step.providerOptions}
          onChange={(value) => update("providerOptions", value)}
          placeholder={'{"sandbox_mode":"workspace-write"}'}
          {...stepFieldState(props, "providerOptions")}
        />
      </Disclosure>
    </>
  );
}

const MERGE_TAGS = ["${{ paseo.prompt }}", "${{ paseo.context }}"] as const;

function PromptEditor({
  id,
  value,
  error,
  disabled,
  description,
  onChange,
}: {
  id: string;
  value: string;
  error?: string;
  disabled?: boolean;
  description?: string;
  onChange: (value: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${String(element.scrollHeight)}px`;
  }, [value]);
  const insert = (mergeTag: string) => {
    const element = textarea.current;
    if (element === null) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    onChange(`${value.slice(0, start)}${mergeTag}${value.slice(end)}`);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + mergeTag.length, start + mergeTag.length);
    });
  };
  return (
    <div className="grid gap-2">
      <FormField
        id={id}
        label="Instructions"
        {...(disabled === undefined ? {} : { disabled })}
        {...(description === undefined ? {} : { description })}
        required
        {...(error === undefined ? {} : { error })}
      >
        {(control) => (
          <Textarea
            {...control}
            ref={textarea}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={8}
            spellCheck={false}
            className="min-h-48 resize-none overflow-hidden font-mono text-xs"
          />
        )}
      </FormField>
      <PromptMergeTags disabled={disabled} insert={insert} />
    </div>
  );
}

function PromptMergeTags({
  disabled,
  insert,
}: {
  disabled: boolean | undefined;
  insert: (tag: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Insert merge tag:</span>
      {MERGE_TAGS.map((mergeTag) => (
        <Button
          key={mergeTag}
          type="button"
          variant="outline"
          size="xs"
          className="font-mono"
          disabled={disabled}
          onClick={() => insert(mergeTag)}
        >
          {mergeTag}
        </Button>
      ))}
    </div>
  );
}

const GITHUB_FIELDS = [
  "githubConnection",
  "githubRepositories",
  "githubPermissions",
  "githubDuration",
] as const;

function StepGitHubFields(props: StepFieldProps & { connections: TriggerSnapshot["connections"] }) {
  const { form, index, connections } = props;
  const step = stepAt(form, index);
  const [expanded, setExpanded] = useFlaggedOpen(
    stepHasError(props, GITHUB_FIELDS),
    step.githubConnection !== "",
  );
  const update = stepUpdate(props);
  const options = [
    { value: "", label: "Do not inject a GitHub token" },
    ...connections
      .filter((connection) => connection.provider === "github")
      .map((connection) => ({ value: connection.slug, label: connection.label })),
  ];
  return (
    <Disclosure
      id={stepFieldId("trigger-github", index)}
      open={expanded}
      onOpenChange={setExpanded}
      title="GitHub access"
      description="Give the run a short-lived token scoped to the repositories you name."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={stepFieldId("trigger-github-connection", index)}
          label="GitHub connection"
          description="Mints a short-lived, restricted GH_TOKEN for this run."
          {...sharedYamlField(form, stepFieldKey(index, "githubConnection"))}
        >
          {(control) => (
            <Combobox
              {...control}
              value={step.githubConnection}
              options={options}
              placeholder="Select a GitHub connection"
              empty="No GitHub connections found."
              onChange={(option) => update("githubConnection", option.value)}
            />
          )}
        </FormField>
        {step.githubConnection === "" ? null : <StepGitHubScope {...props} />}
      </div>
    </Disclosure>
  );
}

function StepGitHubScope(props: StepFieldProps) {
  const step = stepAt(props.form, props.index);
  const update = stepUpdate(props);
  return (
    <>
      <FormField
        id={stepFieldId("trigger-github-repositories", props.index)}
        label="GitHub repositories"
        description="Comma-separated owner/repository names."
        kind="text"
        name="githubRepositories"
        value={step.githubRepositories}
        onChange={(value) => update("githubRepositories", value)}
        {...stepFieldState(props, "githubRepositories")}
        required
      />
      <FormField
        id={stepFieldId("trigger-github-duration", props.index)}
        label="GitHub token lifetime"
        description="At most 1h."
        kind="text"
        name="githubDuration"
        value={step.githubDuration}
        onChange={(value) => update("githubDuration", value)}
        {...stepFieldState(props, "githubDuration")}
        required
      />
      <FormField
        id={stepFieldId("trigger-github-permissions", props.index)}
        label="GitHub permissions (JSON)"
        description="Defaults to read-only repository contents when empty."
        kind="multiline"
        name="githubPermissions"
        value={step.githubPermissions}
        onChange={(value) => update("githubPermissions", value)}
        placeholder={'{"contents":"write","pull_requests":"write"}'}
        {...stepFieldState(props, "githubPermissions")}
      />
    </>
  );
}

const NO_AGENT_DESCRIPTION =
  "Choose a daemon first. The agents you can run are the ones it reports.";
const SCRIPT_DESCRIPTION = "A shell script, run by /bin/sh on the daemon's host.";

/** What a step says while the decision above it is still missing. */
export function agentStepDescription(script: boolean, hasDaemon: boolean): string | undefined {
  if (script) return SCRIPT_DESCRIPTION;
  return hasDaemon ? undefined : NO_AGENT_DESCRIPTION;
}
