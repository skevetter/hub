/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- event controls bind their own configuration */
import { FormField } from "../components/app/form-field.js";
import { eventDefinition, type QualifierKey } from "./configuration/events.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";
import { ScheduleFields } from "./schedule/fields.js";

/** Source-specific controls live behind the event form boundary. */
export function EventFields({
  value,
  errors,
  onChange,
}: {
  value: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}) {
  const updateQualifier = (key: QualifierKey, next: string) =>
    onChange({ ...value, qualifiers: { ...value.qualifiers, [key]: next } });
  const { qualifiers } = eventDefinition(value.event);
  return (
    <>
      <ScheduleFields
        event={value.event}
        value={value.recurrence}
        error={errors.recurrence}
        onChange={(recurrence) => onChange({ ...value, recurrence })}
      />
      {qualifiers.length === 0 ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          {qualifiers.map((qualifier) => {
            const error = errors[`qualifiers.${qualifier.key}`];
            const draft = value.qualifiers[qualifier.key] ?? "";
            return (
              <FormField
                key={qualifier.key}
                id={`trigger-qualifier-${qualifier.key}`}
                name={qualifier.key}
                label={qualifier.label}
                description={
                  qualifier.kind === "list"
                    ? `${qualifier.description} Enter one per line.`
                    : qualifier.description
                }
                kind={qualifier.kind === "text" && !draft.includes("\n") ? "text" : "multiline"}
                value={draft}
                onChange={(next) => updateQualifier(qualifier.key, next)}
                required={qualifier.required}
                {...(error === undefined ? {} : { error })}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
