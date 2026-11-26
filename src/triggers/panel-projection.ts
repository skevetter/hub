import { projectTriggerForm } from "./configuration/editor.js";

type Projection = ReturnType<typeof projectTriggerForm>;

/**
 * The panel form edits the first step and shows its limit. A step list, or a whole-run deadline it
 * does not show, is left to YAML until the form lists every step and that deadline.
 */
export function projectPanelForm(yaml: string): Projection {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") return projection;
  const { steps, runMaxRuntime } = projection.value;
  if (steps.length > 1) {
    return {
      status: "yaml_only",
      reason: "Triggers with several steps can only be edited in YAML.",
    };
  }
  if (runMaxRuntime !== "") {
    return {
      status: "yaml_only",
      reason: "Triggers with a whole-run deadline can only be edited in YAML.",
    };
  }
  return projection;
}
