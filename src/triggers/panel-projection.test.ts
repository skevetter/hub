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

const RUN = `name: build-review
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace/app }
  agent: { provider: codex, mode: full-access }
  prompt: Review it.
  max_runtime: 30m
`;

describe("the panel projection", () => {
  it("opens a run with its own limit, and leaves a whole-run deadline to YAML", () => {
    expect(projectPanelForm(RUN).status).toBe("editable");
    const deadline = `${HEAD}max_runtime: 5m\nsteps:\n  - id: only\n    script: make\n    max_runtime: 5m\n`;
    expect(projectPanelForm(deadline).status).toBe("yaml_only");
    expect(projectTriggerForm(deadline).status).toBe("editable");
  });

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
