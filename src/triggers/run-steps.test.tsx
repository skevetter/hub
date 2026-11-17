import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import type { ActivityRunDetail as RunDetail } from "../projects/activity-run-view.js";
import { summarizeTrigger } from "../projects/activity-summary.js";
import { RunDetailView } from "./run-detail.js";
import { emptyTimeline } from "./test-utils/run-detail.js";

const detail: RunDetail = {
  run: {
    id: "run-1",
    provider: "github",
    source: "push",
    repo: "owner/repo",
    receivedAt: "2026-01-01T00:00:00.000Z",
    configuredTriggerName: "Deploy",
    createdAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:02:00.000Z",
    outcome: "accepted",
    status: "failed",
    failureReason: "Run failed",
  },
  steps: [],
};

const step: RunDetail["steps"][number] = {
  id: "step-1",
  stepId: "build",
  ordinal: 0,
  status: "failed",
  isAgent: false,
  completion: null,
  startedAt: "2026-01-01T00:01:00.000Z",
  completedAt: "2026-01-01T00:02:00.000Z",
  output: null,
  failureReason: "Build failed",
};

function detailWithTimeline(value: RunDetail) {
  return {
    ...value,
    steps: value.steps.map((item) => Object.assign({}, item, { timelineStepId: item.stepId })),
    timeline: { ...emptyTimeline, status: value.run.status },
    progress: null,
    progressMessagesEnabled: false,
  };
}

const render = (value: RunDetail) => {
  const data = detailWithTimeline(value);
  return renderToStaticMarkup(<RunDetailView detail={data} />);
};

describe("activity run detail", () => {
  it("shows run status, outcome, timestamps, failure, and empty steps", () => {
    const markup = render(detail);
    assert.match(markup, /Deploy/u);
    assert.match(markup, /Failed/u);
    assert.match(markup, /Run failed/u);
    assert.match(markup, /2026-01-01T00:02:00.000Z/u);
    assert.match(markup, /No steps/u);
  });

  it("labels webhook detail from its receipt source while retaining the manual provider", () => {
    const summary = summarizeTrigger("webhook.received", {
      actor: "ci-partner",
      trigger: "build-finished",
      input: `${"x".repeat(120)}private tail`,
    });
    const markup = render({
      ...detail,
      run: {
        ...detail.run,
        provider: "manual",
        source: "webhook.received",
        configuredTriggerName: "build-finished",
        webhookSummary: summary,
      },
    });
    assert.match(markup, /Webhook from ci-partner/u);
    assert.match(markup, /build-finished/u);
    assert.match(markup, /lucide-webhook/u);
    assert.match(markup, /Message/u);
    assert.match(markup, /x{119}/u);
    assert.doesNotMatch(markup, /x{120}|private tail|lucide-terminal/u);
  });

  it("leaves an ordinary manual detail label and glyph unchanged", () => {
    const markup = render({
      ...detail,
      run: { ...detail.run, provider: "manual", source: "manual.run" },
    });
    assert.match(markup, /manual.run/u);
    assert.match(markup, /lucide-terminal/u);
    assert.doesNotMatch(markup, /Webhook|lucide-webhook/u);
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
          isAgent: true,
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
      steps: [{ ...step, isAgent: true, output: "" }],
    });
    assert.match(markup, /\(no output\)/u);
  });
  it("shows explicit completion without unwrapping structured user output", () => {
    const markup = render({
      ...detail,
      steps: [
        {
          ...step,
          isAgent: true,
          completion: "explicit_finish",
          output: { status: "succeeded", completion: "user value", output: "finished", extra: 42 },
        },
      ],
    });
    assert.match(markup, /Completion: explicit_finish/u);
    assert.match(markup, /user value/u);
    assert.match(markup, /extra/u);
    assert.match(markup, /42/u);
  });

  it("unwraps only the inferred completion envelope", () => {
    const markup = render({
      ...detail,
      steps: [
        {
          ...step,
          isAgent: true,
          completion: "inferred_from_turn_end",
          output: { status: "succeeded", completion: "inferred_from_turn_end", output: "finished" },
        },
      ],
    });
    assert.match(markup, /Completion: inferred_from_turn_end/u);
    assert.match(markup, /finished/u);
    assert.doesNotMatch(markup, /&quot;status&quot;/u);
  });

  it("does not infer completion or script output from a no-finish agent result", () => {
    const markup = render({
      ...detail,
      steps: [
        {
          ...step,
          isAgent: true,
          completion: null,
          output: {
            completion: "explicit_finish",
            output: "user output",
            exit_code: 0,
            output_tail: "tail",
            truncated: false,
          },
        },
      ],
    });
    assert.doesNotMatch(markup, /Completion: explicit_finish/u);
    assert.doesNotMatch(markup, /Exit code 0/u);
    assert.match(markup, /explicit_finish/u);
    assert.match(markup, /user output/u);
    assert.match(markup, /output_tail/u);
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
