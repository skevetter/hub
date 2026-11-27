/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- the controls bind one trigger form */
import { Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Card } from "../components/app/card.js";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { Disclosure } from "../components/app/disclosure.js";
import { WarningAlert } from "../components/app/failure-alert.js";
import { FormField } from "../components/app/form-field.js";
import { RowActions } from "../components/app/row-actions.js";
import { Button } from "../components/ui/button.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  addStep,
  earlierStepOutputs,
  moveStep,
  removeStep,
  sharedYamlField,
  stepListEditError,
  type TriggerFormValue,
} from "./configuration/editor.js";
import type { StepListChange } from "./configuration/editor-steps.js";
import { MAX_TRIGGER_STEPS } from "./configuration/schema.js";
import {
  StepActionField,
  StepAgentFields,
  StepLimitFields,
  StepScriptFields,
  agentStepDescription,
  useFlaggedOpen,
  type StepAgentProps,
} from "./step-fields.js";
import {
  fieldError,
  outputReferences,
  patchStepAt,
  reorderRowKeys,
  reservedStepIdError,
  staleRunIfError,
  stepAt,
  stepFieldId,
  stepFieldKey,
  stepNeedsAttention,
  stepSummary,
  type TriggerFieldProps,
} from "./step-form-model.js";
import { selectedProviderModel } from "./provider-catalog.js";

export interface StepRows {
  keys: readonly string[];
  error: string | undefined;
  status: string;
  /** The row being edited. Every other row is a one-line summary unless something needs attention. */
  active: string;
  activate: (key: string) => void;
  open: (index: number) => void;
  add: () => void;
  move: (from: number, to: number) => void;
  remove: (index: number) => void;
}

interface Refusal {
  message: string;
  form: TriggerFormValue;
}

interface Focus {
  target: "id" | "menu";
  index: number;
}

const stepCount = (count: number) => `${String(count)} ${count === 1 ? "step" : "steps"}`;

function focusStepControl({ target, index }: Focus) {
  const selector =
    target === "id"
      ? `#${stepFieldId("trigger-step-id", index)}`
      : `[aria-label="Actions for step ${String(index + 1)}"]`;
  document.querySelector<HTMLElement>(selector)?.focus();
}

/** The control a list edit leaves the reader on, once the rows have been redrawn. */
function useStepFocus() {
  const [focus, setFocus] = useState<Focus>();
  useEffect(() => {
    if (focus === undefined) return undefined;
    const timer = setTimeout(() => {
      focusStepControl(focus);
      setFocus(undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [focus]);
  return setFocus;
}

function activeAfter(change: StepListChange, keys: readonly string[], next: readonly string[]) {
  if (change.kind === "move") return keys[change.from];
  return next[Math.min(change.index, next.length - 1)];
}

function menuAfter(change: StepListChange, count: number): number {
  return change.kind === "remove" ? Math.min(change.index, count - 1) : change.to;
}

function editStatus(change: StepListChange, count: number): string {
  return change.kind === "remove"
    ? `Step removed. ${stepCount(count - 1)}.`
    : `Step moved to position ${String(change.to + 1)} of ${String(count)}.`;
}

/**
 * A step list is edited by position, but each row carries a key of its own that never reaches the
 * document. It keeps a row's open sections and its cursor with the row through a move, and keeps
 * a step's name from deciding which row is which while it is typed.
 */
export function useStepRows({
  form,
  onChange,
  onAdd,
}: TriggerFieldProps & { onAdd: () => void }): StepRows {
  const counter = useRef(form.steps.length);
  const [stored, setStored] = useState(() =>
    form.steps.map((_, position) => `row-${String(position)}`),
  );
  const [active, setActive] = useState(() => stored[0] ?? "");
  const [refusal, setRefusal] = useState<Refusal>();
  const [status, setStatus] = useState("");
  const setFocus = useStepFocus();
  const keys = form.steps.map((_, position) => stored[position] ?? `row-extra-${String(position)}`);
  const edit = (change: StepListChange) => {
    const message = stepListEditError(form, change);
    if (message !== undefined) {
      setRefusal({ message, form });
      setActive(keys[change.kind === "move" ? change.from : change.index] ?? active);
      return;
    }
    const next =
      change.kind === "remove"
        ? removeStep(form, change.index)
        : moveStep(form, change.from, change.to);
    if (next === form) return;
    const nextKeys = reorderRowKeys(keys, change);
    setStored(nextKeys);
    setActive(activeAfter(change, keys, nextKeys) ?? active);
    onChange(next);
    setStatus(editStatus(change, form.steps.length));
    setFocus({ target: "menu", index: menuAfter(change, next.steps.length) });
  };
  const add = () => {
    const next = addStep(form);
    if (next === form) return;
    counter.current += 1;
    setStored([...keys, `row-${String(counter.current)}`]);
    setActive(`row-${String(counter.current)}`);
    onChange(next);
    onAdd();
    setStatus(`Step added. ${stepCount(next.steps.length)}.`);
    setFocus({ target: "id", index: next.steps.length - 1 });
  };
  return {
    keys,
    error: refusal?.form === form ? refusal.message : undefined,
    status,
    active: keys.includes(active) ? active : (keys[0] ?? ""),
    activate: setActive,
    open: (index) => {
      setActive(keys[index] ?? active);
      setFocus({ target: "id", index });
    },
    add,
    move: (from, to) => edit({ kind: "move", from, to }),
    remove: (index) => edit({ kind: "remove", index }),
  };
}

/** The action, and the fields that action needs. */
export function StepBody(props: StepAgentProps & { hasDaemon: boolean }) {
  const { hasDaemon, ...fields } = props;
  const script = stepAt(fields.form, fields.index).action === "script";
  return (
    <>
      <StepActionField {...fields} />
      {script ? <StepScriptFields {...fields} /> : null}
      {script || !hasDaemon ? null : <StepAgentFields {...fields} />}
    </>
  );
}

export function StepCard(props: StepAgentProps & { hasDaemon: boolean; rows: StepRows }) {
  const { rows, ...fields } = props;
  const { form, errors, index, hasDaemon } = fields;
  const step = stepAt(form, index);
  const key = rows.keys[index] ?? "";
  const name = step.id.trim() === "" ? "Unnamed step" : step.id;
  const menu = <StepMenu index={index} count={form.steps.length} name={name} rows={rows} />;
  const label = `Step ${String(index + 1)}: ${name}`;
  if (key !== rows.active && !stepNeedsAttention(form, errors, index)) {
    return <CollapsedStep {...fields} rows={rows} label={label} name={name} menu={menu} />;
  }
  const body = {
    ...fields,
    onChange: (next: TriggerFormValue) => {
      rows.activate(key);
      fields.onChange(next);
    },
  };
  const description = agentStepDescription(step.action === "script", hasDaemon);
  return (
    <Card
      label={label}
      title={name}
      action={menu}
      {...(description === undefined ? {} : { description })}
    >
      <StepIdField {...body} />
      <StepBody {...body} />
      <div className="grid gap-4 sm:grid-cols-2">
        <StepLimitFields {...body} />
      </div>
      <StepConditionFields {...body} />
    </Card>
  );
}

/** What a step that is not being edited shows, on one row: what it runs, and a way back in. */
function CollapsedStep(
  props: StepAgentProps & { rows: StepRows; label: string; name: string; menu: ReactNode },
) {
  const { rows, label, name, menu, ...fields } = props;
  const { form, index, providerCatalog } = fields;
  const step = stepAt(form, index);
  const model = selectedProviderModel(providerCatalog.entries, step.agent).model?.label;
  const summary = stepSummary(step, model);
  return (
    <section
      aria-label={label}
      className="flex min-w-0 items-center gap-3 rounded-sm border bg-card px-6 py-3"
    >
      <h2 className="shrink-0 text-sm text-foreground">{name}</h2>
      <p className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">{summary}</p>
      {step.runIf === "" ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">Condition</span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Edit step ${String(index + 1)}`}
        onClick={() => rows.open(index)}
      >
        Edit
      </Button>
      {menu}
    </section>
  );
}

function StepIdField(props: TriggerFieldProps & { index: number }) {
  const { form, errors, onChange, index } = props;
  const key = stepFieldKey(index, "id");
  const error = errors[key] ?? reservedStepIdError(stepAt(form, index).id);
  return (
    <FormField
      id={stepFieldId("trigger-step-id", index)}
      label="Step ID"
      description="Lowercase letters, digits, and hyphens. Later steps read this step's outputs by its ID."
      kind="text"
      name="stepId"
      value={stepAt(form, index).id}
      onChange={(id) => onChange(patchStepAt(form, index, { id }))}
      required
      {...sharedYamlField(form, key)}
      {...(error === undefined ? {} : { error })}
    />
  );
}

function StepMenu({
  index,
  count,
  name,
  rows,
}: {
  index: number;
  count: number;
  name: string;
  rows: StepRows;
}) {
  return (
    <RowActions label={`Actions for step ${String(index + 1)}`}>
      <DropdownMenuItem disabled={index === 0} onSelect={() => rows.move(index, index - 1)}>
        Move up
      </DropdownMenuItem>
      <DropdownMenuItem disabled={index >= count - 1} onSelect={() => rows.move(index, index + 1)}>
        Move down
      </DropdownMenuItem>
      <ConfirmMenuItem
        label="Remove step"
        busy={count <= 1}
        title="Remove this step?"
        description={`"${name}" and its settings are removed from this trigger. Nothing is saved until you save the trigger.`}
        confirmLabel="Remove step"
        cancelLabel="Keep step"
        destructive
        onConfirm={() => rows.remove(index)}
      />
    </RowActions>
  );
}

const SCHEMA_PLACEHOLDER = '{"type":"object","properties":{"verdict":{"enum":["ok","fix"]}}}';

function runIfDescription(form: TriggerFormValue, index: number): string {
  const references = outputReferences(earlierStepOutputs(form, index));
  const [first] = references;
  if (first === undefined) {
    return "Leave empty to always run. A condition can read the outputs of earlier steps that have an output schema.";
  }
  return `Leave empty to always run. Skips this step when false, for example \${{ ${first} == 'fix' }}. Available: ${references.join(", ")}.`;
}

function StepConditionFields(props: StepAgentProps) {
  const { form, errors, onChange, index } = props;
  const step = stepAt(form, index);
  const ifKey = stepFieldKey(index, "runIf");
  const schemaKey = stepFieldKey(index, "outputSchema");
  const stale = staleRunIfError(form, index);
  const ifError = errors[ifKey] ?? stale;
  const schemaError = errors[schemaKey];
  const flagged = ifError !== undefined || schemaError !== undefined;
  const [open, setOpen] = useFlaggedOpen(flagged, step.runIf !== "" || step.outputSchema !== "");
  const agent = step.action === "prompt";
  return (
    <Disclosure
      id={stepFieldId("trigger-step-conditions", index)}
      open={open}
      onOpenChange={setOpen}
      title={agent ? "Condition and output" : "Condition"}
      description={
        agent
          ? "Run this step only when a condition holds, and declare the output later steps can read."
          : "Run this step only when a condition holds."
      }
    >
      <div className="grid gap-4">
        <FormField
          id={stepFieldId("trigger-step-if", index)}
          label="Run only if"
          description={runIfDescription(form, index)}
          kind="text"
          name="runIf"
          value={step.runIf}
          onChange={(runIf) => onChange(patchStepAt(form, index, { runIf }))}
          placeholder="${{ steps.review.outputs.verdict == 'fix' }}"
          {...sharedYamlField(form, ifKey)}
          {...(ifError === undefined ? {} : { error: ifError })}
        />
        {agent ? (
          <FormField
            id={stepFieldId("trigger-step-output-schema", index)}
            label="Output schema (JSON)"
            description="The shape of the output this step's agent must write."
            kind="multiline"
            name="outputSchema"
            value={step.outputSchema}
            onChange={(outputSchema) => onChange(patchStepAt(form, index, { outputSchema }))}
            placeholder={SCHEMA_PLACEHOLDER}
            {...sharedYamlField(form, schemaKey)}
            {...fieldError(errors, schemaKey)}
          />
        ) : null}
      </div>
    </Disclosure>
  );
}

/** Add a step, and say why a move or a removal did not happen. */
export function StepListFooter({ rows, count }: { rows: StepRows; count: number }) {
  return (
    <div className="grid justify-items-start gap-3">
      <p role="status" className="sr-only">
        {rows.status}
      </p>
      {rows.error === undefined ? null : (
        <WarningAlert title="Steps not changed">
          <p>{rows.error}</p>
        </WarningAlert>
      )}
      {count >= MAX_TRIGGER_STEPS ? (
        <p className="text-sm text-muted-foreground">
          A trigger can have at most {MAX_TRIGGER_STEPS} steps.
        </p>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={rows.add}>
          <Plus aria-hidden="true" /> Add step
        </Button>
      )}
    </div>
  );
}

/** The deadline for the whole run. Each step still keeps its own. */
export function RunLimitField({ form, errors, onChange }: TriggerFieldProps) {
  const [open, setOpen] = useState(form.runMaxRuntime !== "");
  if (form.steps.length < 2 && form.runMaxRuntime === "") return null;
  return (
    <Disclosure
      id="trigger-run-limit"
      open={open}
      onOpenChange={setOpen}
      title="Advanced"
      description="A deadline for the whole run, across all steps."
    >
      <FormField
        id="trigger-run-max-runtime"
        label="Run time limit"
        description="For example 3h. Empty uses the sum of the step limits, up to 24h."
        kind="text"
        name="runMaxRuntime"
        value={form.runMaxRuntime}
        onChange={(runMaxRuntime) => onChange({ ...form, runMaxRuntime })}
        {...sharedYamlField(form, "runMaxRuntime")}
        {...fieldError(errors, "runMaxRuntime")}
      />
    </Disclosure>
  );
}
