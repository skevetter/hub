import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import type { ActivityRunDetail as RunDetail } from "../projects/dashboard.js";
import { ActivityRunDetail } from "./activity-run-panel.js";

const detail: RunDetail = {
  run: {
    id: "run-1",
    providerEventReceiptId: "receipt-1",
    provider: "github",
    deliveryId: "delivery-1",
    source: "push",
    repo: "owner/repo",
    receivedAt: "2026-01-01T00:00:00.000Z",
    rawPayload: null,
    configuredTriggerName: "Deploy",
    prompt: "",
    inputs: null,
    values: null,
    triggerContext: null,
    outputContext: null,
    createdAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:02:00.000Z",
    outcome: "accepted",
    status: "failed",
    deadlineAt: null,
    deadlineKind: null,
    failureReason: "Run failed",
    rejectionReason: null,
  },
  steps: [],
};

const step: RunDetail["steps"][number] = {
  id: "step-1",
  stepId: "build",
  ordinal: 0,
  status: "failed",
  agentExecutionId: null,
  agentId: null,
  agentSessionId: null,
  agentSessionAction: null,
  deadlineAt: null,
  idleDeadlineAt: null,
  deadlineKind: null,
  startedAt: "2026-01-01T00:01:00.000Z",
  completedAt: "2026-01-01T00:02:00.000Z",
  output: null,
  failureReason: "Build failed",
};

const render = (value: RunDetail) => renderToStaticMarkup(<ActivityRunDetail detail={value} />);

describe("activity run detail", () => {
  it("shows run status, outcome, timestamps, failure, and empty steps", () => {
    const markup = render(detail);
    assert.match(markup, /Deploy/u);
    assert.match(markup, /Failed/u);
    assert.match(markup, /Run failed/u);
    assert.match(markup, /2026-01-01T00:02:00.000Z/u);
    assert.match(markup, /No steps/u);
  });

  it("renders a successful script result", () => {
    const markup = render({
      ...detail,
      steps: [
        {
          ...step,
          status: "succeeded",
          failureReason: null,
          output: { exit_code: 0, output_tail: "build complete", truncated: false },
        },
      ],
    });
    assert.match(markup, /Succeeded/u);
    assert.match(markup, /Exit code 0/u);
    assert.match(markup, /build complete/u);
    assert.match(markup, /Everything the script printed/u);
  });

  it("renders ordered steps, script results, and absent output", () => {
    const markup = render({
      ...detail,
      steps: [
        {
          ...step,
          output: { exit_code: 3, output_tail: "<script>bad</script>", truncated: false },
        },
        { ...step, id: "step-2", stepId: "review", ordinal: 1, output: null },
      ],
    });
    assert.ok(markup.indexOf("build") < markup.indexOf("review"));
    assert.match(markup, /Exit code 3/u);
    assert.match(markup, /&lt;script&gt;bad&lt;\/script&gt;/u);
    assert.match(markup, /No output/u);
    assert.match(markup, /Build failed/u);
    assert.match(markup, /aria-expanded="false"/u);
  });

  it("keeps agent output as plain text even when it resembles script output and caps it", () => {
    const markup = render({
      ...detail,
      steps: [
        {
          ...step,
          agentExecutionId: "execution-1",
          output: { exit_code: 0, output_tail: "x".repeat(70_000), truncated: false },
        },
      ],
    });
    assert.doesNotMatch(markup, /Exit code 0/u);
    assert.match(markup, /Output limited to 65,536 characters/u);
    assert.doesNotMatch(markup, /x{65537}/u);
  });

  it("shows an empty agent output explicitly", () => {
    const markup = render({
      ...detail,
      steps: [{ ...step, agentExecutionId: "execution-1", output: "" }],
    });
    assert.match(markup, /\(no output\)/u);
  });
  it("shows explicit and inferred agent completion", () => {
    for (const completion of ["explicit_finish", "inferred_from_turn_end"]) {
      const markup = render({
        ...detail,
        steps: [
          { ...step, agentExecutionId: "execution-1", output: { completion, output: "finished" } },
        ],
      });
      assert.match(markup, new RegExp(completion, "u"));
      assert.match(markup, /finished/u);
    }
  });

  it("shows a timed out script result", () => {
    const markup = render({
      ...detail,
      steps: [
        {
          ...step,
          status: "timed_out",
          failureReason: "script timed out",
          output: { exit_code: null, output_tail: "partial", truncated: true },
        },
      ],
    });
    assert.match(markup, /script timed out/u);
    assert.match(markup, /No exit code/u);
    assert.match(markup, /partial/u);
  });
});
