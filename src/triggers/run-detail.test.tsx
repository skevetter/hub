import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { ConnectionPill, RunDetailView, progressMessageLabel } from "./run-detail.js";
import { timelineRows } from "./run-timeline-view.js";
import { emptyTimeline, runDetailFixture, runEvent } from "./test-utils/run-detail.js";
import type { RunDetailSnapshot } from "./run-events.js";

const render = (detail: RunDetailSnapshot) =>
  renderToStaticMarkup(<RunDetailView detail={detail} />);

const confirmStop = async () => undefined;

describe("run timeline UI", () => {
  it("shows the stored reply refusal even when the run timeline is off", () => {
    const detail = {
      ...runDetailFixture,
      timeline: { ...emptyTimeline, status: "succeeded", timelineEnabled: false },
      reply: { state: "refused", failure: "rate_limited" } as const,
    };
    assert.match(
      render(detail),
      /Reply not posted: This organization reached the reply limit for the last hour\./u,
    );
  });

  it("shows Stop only for people with permission while the run is live", () => {
    const detail = { ...runDetailFixture, canStop: true };
    const view = (snapshot: RunDetailSnapshot) =>
      renderToStaticMarkup(<RunDetailView detail={snapshot} onStop={confirmStop} />);
    assert.match(view(detail), />Stop run</u);
    assert.doesNotMatch(view({ ...detail, canStop: false }), />Stop run</u);
    assert.doesNotMatch(
      view({ ...detail, timeline: { ...detail.timeline, status: "canceled" } }),
      />Stop run</u,
    );
  });

  it("shows the stopping person's name and the current cleanup outcome", () => {
    const detail: RunDetailSnapshot = {
      ...runDetailFixture,
      timeline: { ...runDetailFixture.timeline, status: "canceled" },
      stopDetails: {
        stoppedByName: "Avery",
        cleanupState: "waiting_for_daemon",
        coalesced: false,
        retryAttemptId: null,
        otherAttachedRunCount: 0,
      },
    };
    assert.match(render(detail), /Stopped by Avery/u);
    assert.match(render(detail), /waiting for the daemon/u);
    assert.match(
      render({ ...detail, stopDetails: { ...detail.stopDetails!, cleanupState: "confirmed" } }),
      /daemon confirmed cleanup/u,
    );
    assert.match(
      render({
        ...detail,
        stopDetails: { ...detail.stopDetails!, cleanupState: "confirmed", coalesced: true },
      }),
      /Another Stop covered this run/u,
    );
  });

  it("marks expired run content and keeps safe script and progress summaries", () => {
    const expiredAt = "2026-11-17T10:00:00.000Z";
    const script = runDetailFixture.steps[0];
    assert.ok(script);
    const markup = render({
      ...runDetailFixture,
      run: {
        ...runDetailFixture.run,
        status: "failed",
        completedAt: expiredAt,
        payloadExpiredAt: expiredAt,
        payloadSummary: {
          version: 1,
          workflowKey: "review",
          repository: "example/service",
          providerLink: "https://github.com/example/service/pull/7",
          failureCode: "run_failed",
          stepCounts: { failed: 1 },
          timelineCounts: { events: 2, dropped: 0 },
          progress: { status: "unknown", link: null },
        },
      },
      steps: [
        {
          ...script,
          isAgent: false,
          status: "failed",
          completedAt: expiredAt,
          outputExpired: true,
          output: { output_tail: "raw-sentinel-render-output" },
          payloadSummary: {
            version: 1,
            stepKey: "review",
            status: "failed",
            durationMs: 1000,
            hadOutput: true,
            exitCode: 7,
            truncated: true,
            provider: null,
            model: null,
            failureCode: "step_failed",
          },
        },
      ],
      timeline: { ...emptyTimeline, status: "failed", expired: true },
      progressUnavailable: true,
    });
    assert.match(markup, /Run payload expired/u);
    assert.match(markup, /original event, inputs, prompts, and outputs expired/u);
    assert.match(markup, /Output expired/u);
    assert.match(markup, /Exit code 7/u);
    assert.match(markup, /Output was truncated/u);
    assert.match(markup, /2 timeline events/u);
    assert.match(markup, /href="https:\/\/github\.com\/example\/service\/pull\/7"/u);
    assert.match(markup, /Unavailable/u);
    assert.doesNotMatch(markup, /raw-sentinel-render-output/u);
  });

  it("shows summary counts from merged tool calls and distinct steps", () => {
    const markup = render({
      ...runDetailFixture,
      timeline: {
        ...emptyTimeline,
        events: [
          runEvent(1, "tool_started", { callId: "same", tool: "Bash", category: "command" }),
          runEvent(2, "tool_finished", {
            callId: "same",
            tool: "Bash",
            category: "command",
            status: "completed",
          }),
          runEvent(3, "tool_started", { callId: "same", tool: "Read", category: "read" }, "later"),
        ],
      },
    });
    assert.match(markup, /1 command, 1 read/u);
    assert.equal([...markup.matchAll(/>Bash - completed/gu)].length, 1);
    assert.match(markup, />Tool finished</u);
    assert.match(markup, />Tool running</u);
    for (const label of ["Status", "Source", "Started", "Duration", "Activity", "Progress message"])
      assert.ok(markup.includes(`>${label}</dt>`));
    assert.match(markup, /Not posted: this Hub has progress messages off/u);
  });

  it.each([
    { name: "no finish", events: [], label: "Tool running" },
    {
      name: "an earlier step finish",
      events: [runEvent(1, "step_finished")],
      label: "Tool running",
    },
    {
      name: "an earlier run finish",
      events: [runEvent(1, "run_finished", {}, "")],
      label: "Tool running",
    },
    {
      name: "a different step finishes",
      events: [runEvent(3, "step_finished", {}, "other-step")],
      label: "Tool running",
    },
    {
      name: "the call's step finishes",
      events: [runEvent(3, "step_finished")],
      label: "Tool called",
    },
    {
      name: "the run finishes",
      events: [runEvent(3, "run_finished", {}, "")],
      label: "Tool called",
    },
    {
      name: "a matching tool finish",
      events: [
        runEvent(3, "tool_finished", { callId: "finish", status: "completed" }),
        runEvent(4, "run_finished", {}, ""),
      ],
      label: "Tool finished",
    },
    {
      name: "a matching tool finish arrives before the start",
      events: [
        runEvent(1, "tool_finished", { callId: "finish", status: "completed" }),
        runEvent(3, "run_finished", {}, ""),
      ],
      label: "Tool finished",
    },
  ])("shows $label with $name", ({ events, label }) => {
    const started = runEvent(2, "tool_started", {
      tool: "mcp__hub__finish_execution",
      callId: "finish",
      category: "finish",
    });
    const tools = timelineRows(
      [...events, started].sort((a, b) => a.seq - b.seq),
      0,
    ).filter((row) => row.tool);
    assert.deepEqual(
      tools.map((row) => row.label),
      [label],
    );
  });

  it("shows an open permission wait, resolves it in place and displays final dropped count", () => {
    const waiting = runEvent(1, "permission_requested", { tool: "Bash" });
    const truncated = runEvent(2, "truncated", { dropped: 1 });
    const markup = render({
      ...runDetailFixture,
      timeline: { ...emptyTimeline, events: [waiting, truncated], droppedCount: 42 },
    });
    assert.match(markup, /Waiting for permission: Bash/u);
    assert.match(markup, /42 events dropped/u);
    const rows = timelineRows([waiting, truncated, runEvent(3, "permission_resolved")], 42);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.label, "Permission resolved");
    assert.doesNotMatch(rows[0].detail, /Waiting/u);
  });

  it("renders no-id tools as separate rows and stored text only as escaped text", () => {
    const markup = render({
      ...runDetailFixture,
      timeline: {
        ...emptyTimeline,
        events: [
          runEvent(1, "tool_finished", { tool: "<script>alert(1)</script>", category: "other" }),
          runEvent(2, "tool_finished", { tool: "https://example.test", category: "other" }),
          runEvent(3, "turn_failed", { error: "[click](https://example.test)" }),
        ],
      },
    });
    assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
    assert.match(markup, /\[click\]\(https:\/\/example.test\)/u);
    assert.doesNotMatch(markup, /<script>|href="https:\/\/example.test"/u);
    assert.match(markup, /2 other tools/u);
  });

  it("distinguishes disabled, derived and expired timelines without reconstructing expired rows", () => {
    const off = render({
      ...runDetailFixture,
      timeline: { ...emptyTimeline, timelineEnabled: false },
    });
    assert.match(off, /The run timeline is off on this Hub/u);
    const derived = render({
      ...runDetailFixture,
      timeline: { ...emptyTimeline, origin: "derived", events: [runEvent(1, "run_started")] },
    });
    assert.match(derived, /This run finished before the timeline was turned on/u);
    assert.match(derived, /No tool events were recorded for this run/u);
    assert.match(derived, /Run started/u);
    const expired = render({
      ...runDetailFixture,
      timeline: {
        ...emptyTimeline,
        expired: true,
        events: [runEvent(1, "tool_started", { tool: "Must not show" })],
      },
    });
    assert.match(expired, /The timeline for this run expired after 30 days/u);
    assert.doesNotMatch(expired, /Must not show|aria-label="Run timeline"/u);
  });

  it("shows live step status and script exit code without waiting for snapshot refresh", () => {
    const detail = {
      ...runDetailFixture,
      steps: [{ ...runDetailFixture.steps.at(0)!, isAgent: false, status: "pending" as const }],
    };
    const running = render({
      ...detail,
      timeline: { ...emptyTimeline, events: [runEvent(1, "step_started")] },
    });
    assert.match(running, /Running/u);
    const finished = render({
      ...detail,
      timeline: {
        ...emptyTimeline,
        events: [runEvent(1, "step_finished", { status: "succeeded", exitCode: 0 })],
      },
    });
    assert.match(finished, /Succeeded/u);
    assert.match(finished, /Exit code 0/u);
    const ended = render({ ...detail, timeline: { ...emptyTimeline, status: "failed" } });
    assert.match(ended, /Not run/u);
  });

  it("shows each connection state and removes the pill once complete", () => {
    for (const connection of ["Live", "Reconnecting", "Polling"] as const)
      assert.match(
        renderToStaticMarkup(<ConnectionPill connection={connection} />),
        new RegExp(`>${connection}<`, "u"),
      );
    assert.equal(renderToStaticMarkup(<ConnectionPill connection={null} />), "");
  });

  it("describes progress only from the stored provider, state and fixed failure codes", () => {
    assert.equal(
      progressMessageLabel({ progress: null, progressMessagesEnabled: true }),
      "Off for this trigger",
    );
    for (const [provider, label] of [
      ["github", "GitHub"],
      ["slack", "Slack"],
      ["linear", "Linear"],
    ] as const) {
      assert.equal(
        progressMessageLabel({
          progress: { provider, state: "finished", failure: null },
          progressMessagesEnabled: true,
        }),
        `Posted to ${label}`,
      );
    }
    const cases = [
      ["gone", null, "Message was deleted"],
      ["refused", "public_repository", "Not posted: public repository"],
      ["refused", "visibility_changed", "Not posted: repository became public"],
      ["unavailable", "no_credential", "Not posted: no credential"],
      [
        "refused",
        "org_not_mapped",
        "Not posted: this organization is not approved for the GitHub credential",
      ],
      ["unavailable", "no_destination", "Not posted: no place to post"],
      ["abandoned", "unknown", "Not posted: could not confirm the message was created"],
      ["pending", null, "Not posted yet"],
      ["creating", null, "Not posted yet"],
    ] as const;
    for (const [state, failure, label] of cases)
      assert.equal(
        progressMessageLabel({
          progress: { provider: "github", state, failure },
          progressMessagesEnabled: true,
        }),
        label,
      );
  });
});
