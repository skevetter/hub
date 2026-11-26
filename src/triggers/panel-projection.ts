import { projectTriggerForm } from "./configuration/editor.js";

type Projection = ReturnType<typeof projectTriggerForm>;

/** The panel form edits one step, so a step list is left to YAML until the form lists every step. */
export function projectPanelForm(yaml: string): Projection {
  const projection = projectTriggerForm(yaml);
  if (projection.status === "editable" && projection.value.steps.length > 1) {
    return {
      status: "yaml_only",
      reason: "Triggers with several steps can only be edited in YAML.",
    };
  }
  return projection;
}
