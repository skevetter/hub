import { describe, expect, it } from "vitest";
import { projectTriggerForm } from "./configuration/editor.js";
import { projectPanelForm } from "./panel-projection.js";

const HEAD = `name: build-review
on:
  manual.run: {}
target: { daemon: devbox, cwd: /workspace/app }
`;

const ONE = `${HEAD}steps:
  - id: only
    script: make
    max_runtime: 5m
`;

const TWO = `${ONE}  - id: second
    script: make test
    max_runtime: 5m
`;

describe("the panel projection", () => {
  it("opens a one-step document in the form", () => {
    expect(projectPanelForm(ONE).status).toBe("editable");
  });

  it("leaves a step list to YAML while the form edits one step", () => {
    expect(projectPanelForm(TWO)).toEqual({
      status: "yaml_only",
      reason: "Triggers with several steps can only be edited in YAML.",
    });
    expect(projectTriggerForm(TWO).status).toBe("editable");
  });
});
