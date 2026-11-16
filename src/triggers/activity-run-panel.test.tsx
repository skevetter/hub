import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, vi } from "vitest";
import type { ActivityRunDetail as RunDetail } from "../projects/dashboard.js";
import { ActivityRunDetail, pollActiveRun } from "./activity-run-panel.js";

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

describe("active run polling", () => {
  it("lets a slow request finish and stops polling after a terminal result", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let finish!: (value: RunDetail) => void;
    const request = new Promise<RunDetail>((resolve) => {
      finish = resolve;
    });
    const queryFn = vi.fn(() => request);
    const active = { ...detail, run: { ...detail.run, completedAt: null } };
    const observer = new QueryObserver(client, {
      queryKey: ["activity-run", "acme", "run-1"],
      queryFn,
      initialData: active,
      staleTime: Infinity,
    });
    const stop = pollActiveRun((options) => {
      void observer.refetch(options);
    });
    const unsubscribe = observer.subscribe((result) => {
      if (result.data !== undefined && result.data.run.completedAt !== null) stop();
    });
    try {
      await vi.advanceTimersByTimeAsync(16_000);
      assert.equal(queryFn.mock.calls.length, 1);
      finish(detail);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(observer.getCurrentResult().data?.run.completedAt, detail.run.completedAt);
      await vi.advanceTimersByTimeAsync(20_000);
      assert.equal(queryFn.mock.calls.length, 1);
    } finally {
      stop();
      unsubscribe();
      client.clear();
      vi.useRealTimers();
    }
  });
});
