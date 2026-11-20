import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AcceptedTriggerRunRecord, WorkflowStepRunRecord } from "../db/types.js";
import { TOOL_CATEGORIES } from "../run-timeline/categories.js";
import type { RunTimelineEvent } from "../run-timeline/store.js";
import { renderProgress, type ProgressRenderInput } from "./render.js";

const AUTHOR_TEXT = "QZX9".repeat(2500);
const RUN_ID = "10000000-0000-4000-8000-000000000001";
const start = new Date("2026-11-17T10:02:11Z");
const finish = new Date("2026-11-17T10:06:13Z");
const working = new Date("2026-11-17T10:02:14Z");
const run: AcceptedTriggerRunRecord = {
  id: RUN_ID,
  outcome: "accepted",
  status: "running",
  organizationId: "org",
  projectId: "project",
  configurationRevisionId: "revision",
  providerEventReceiptId: "receipt",
  configuredTriggerName: AUTHOR_TEXT,
  prompt: AUTHOR_TEXT,
  inputs: AUTHOR_TEXT,
  values: AUTHOR_TEXT,
  triggerContext: AUTHOR_TEXT,
  outputContext: AUTHOR_TEXT,
  conversation: null,
  createdAt: start,
  deadlineAt: finish,
  deadlineKind: null,
  failureReason: null,
  reactionState: null,
  terminalNotificationPendingAt: null,
  terminalNotificationDeliveredAt: null,
  terminalNotificationLeaseExpiresAt: null,
  completedAt: null,
};
function step(status: WorkflowStepRunRecord["status"], ordinal: number): WorkflowStepRunRecord {
  return {
    status,
    ordinal,
    id: AUTHOR_TEXT,
    triggerRunId: RUN_ID,
    stepId: AUTHOR_TEXT,
    agentExecutionId: null,
    output: AUTHOR_TEXT,
    failureReason: AUTHOR_TEXT,
    deadlineKind: null,
    deadlineAt: null,
    idleDeadlineAt: null,
    completedAt: null,
    startedAt: status === "pending" ? null : working,
    dispatchIntent: null,
  };
}
function event(
  kind: RunTimelineEvent["kind"],
  seq: number,
  at: Date,
  data: RunTimelineEvent["data"] = {},
): RunTimelineEvent {
  return { triggerRunId: RUN_ID, organizationId: "org", stepId: AUTHOR_TEXT, kind, seq, at, data };
}
const events = [
  event("run_started", 1, start),
  event("tool_started", 2, working, { callId: "1", category: "command", tool: AUTHOR_TEXT }),
  event("tool_finished", 3, working, {
    callId: "1",
    category: "command",
    status: "failed",
    tool: AUTHOR_TEXT,
  }),
  event("tool_finished", 4, working, {
    callId: "2",
    category: "read",
    status: "completed",
    result: AUTHOR_TEXT,
  }),
];
const defaults: ProgressRenderInput = {
  run,
  steps: [step("succeeded", 0), step("running", 1), step("pending", 2)],
  events,
  provider: "linear",
  maxBodyChars: 4000,
  publicBaseUrl: "https://hub.example.org/base",
  organizationSlug: "acme",
};

describe("progress message vocabulary", () => {
  it("describes a canceled run as stopped by a person", () => {
    const body = renderProgress({
      ...defaults,
      run: { ...run, status: "canceled", completedAt: finish },
      steps: [step("skipped", 0)],
      events: [],
    });
    assert.match(body, /stopped by a person/u);
    assert.doesNotMatch(body, /Failed|run_failed/u);
  });

  it("renders running and permission-wait states from durable events", () => {
    const body = [
      "Paseo run: Running",
      "Started `10:02:11 UTC`. Updated `10:02:14 UTC`.",
      "Activity: `1 command`, `1 read`. `2 tool calls`, `1` failed.",
      "Step `2` of `3` running since `10:02:14 UTC`.",
      `Run details: \`https://hub.example.org/base/o/acme/activity/${RUN_ID}\``,
    ];
    assert.equal(renderProgress(defaults), body.join("\n"));
    body.splice(2, 0, "Now: waiting for permission");
    assert.equal(
      renderProgress({
        ...defaults,
        events: [...events, event("permission_requested", 5, working, { request: AUTHOR_TEXT })],
      }),
      body.join("\n"),
    );
  });

  it("renders a successful GitHub final message without hidden identifiers", () => {
    const actual = renderProgress({
      ...defaults,
      provider: "github",
      run: { ...run, completedAt: finish, status: "succeeded" },
      steps: [step("succeeded", 0), step("succeeded", 1), step("succeeded", 2)],
    });
    assert.equal(
      actual,
      [
        "Paseo run: Succeeded in 4m 02s",
        "Finished 10:06:13 UTC.",
        "Activity: 1 command, 1 read. 2 tool calls, 1 failed.",
        "Steps: 3 succeeded of 3.",
        `Run details: https://hub.example.org/base/o/acme/activity/${RUN_ID}`,
      ].join("\n"),
    );
  });

  it("renders fixed failure text and counts steps that did not run", () => {
    const actual = renderProgress({
      ...defaults,
      run: { ...run, completedAt: finish, status: "failed", failureReason: "step_idle_timeout" },
      steps: [step("succeeded", 0), step("failed", 1), step("pending", 2), step("pending", 3)],
    });
    assert.equal(
      actual,
      [
        "Paseo run: `Failed` in `4m 02s`: `the agent was idle too long` (`idle_timeout`).",
        "Finished `10:06:13 UTC`.",
        "Activity: `1 command`, `1 read`. `2 tool calls`, `1` failed.",
        "Steps: `1 succeeded`, `1 failed`, `2 not run` of `4`.",
        `Run details: \`https://hub.example.org/base/o/acme/activity/${RUN_ID}\``,
      ].join("\n"),
    );
  });

  it("keeps every provider body in the closed ASCII grammar with 150 steps and a 10,000-character name", () => {
    const steps = [
      ...Array.from({ length: 148 }, (_, index) => step("succeeded", index)),
      step("running", 148),
      step("pending", 149),
    ];
    const adversarial = `${AUTHOR_TEXT} @everyone <!channel> https://secret.example # title`;
    const activity = Array.from({ length: 5000 }, (_, index) =>
      event("tool_finished", index + 2, working, {
        callId: String(index),
        category: TOOL_CATEGORIES[index % TOOL_CATEGORIES.length]!,
        status: "failed",
        tool: adversarial,
        subject: adversarial,
      }),
    );
    const statuses = {
      running: "Running",
      failed: "Failed in 4m 02s: the run failed (failed).",
      timed_out: "Timed out in 4m 02s: the run reached its time limit (run_timeout).",
      succeeded: "Succeeded in 4m 02s",
    };
    const linearStatuses = {
      running: "Running",
      failed: "`Failed` in `4m 02s`: `the run failed` (`failed`).",
      timed_out: "`Timed out` in `4m 02s`: `the run reached its time limit` (`run_timeout`).",
      succeeded: "Succeeded in `4m 02s`",
    };
    const authored = new Set(
      Array.from({ length: AUTHOR_TEXT.length - 3 }, (_, index) =>
        AUTHOR_TEXT.slice(index, index + 4),
      ),
    );
    for (const provider of ["github", "linear", "slack"] as const) {
      for (const status of ["running", "failed", "timed_out", "succeeded"] as const) {
        const maxBodyChars = provider === "slack" ? 3000 : 4000;
        const body = renderProgress({
          ...defaults,
          provider,
          maxBodyChars,
          steps,
          events: [
            events[0]!,
            ...activity,
            event("tool_finished", 5002, working, {
              callId: "invalid",
              category: adversarial,
              status: "failed",
            }),
            event("permission_requested", 5003, working, { request: adversarial }),
          ],
          run: {
            ...run,
            status,
            completedAt: status === "running" ? null : finish,
            failureReason: adversarial,
          },
        });
        const expected = [];
        const linear = provider === "linear";
        expected.push(`Paseo run: ${(linear ? linearStatuses : statuses)[status]}`);
        if (status === "running") {
          expected.push(
            linear
              ? "Started `10:02:11 UTC`. Updated `10:02:14 UTC`."
              : "Started 10:02:11 UTC. Updated 10:02:14 UTC.",
            "Now: waiting for permission",
          );
        } else {
          expected.push(linear ? "Finished `10:06:13 UTC`." : "Finished 10:06:13 UTC.");
        }
        if (linear) {
          expected.push(
            "Activity: `556 commands`, `556 reads`, `556 edits`, `556 web calls`, `556 subagents`, `555 plans`, `555 MCP calls`, `555 finish calls`, `555 other calls`. `5001 tool calls`, `5001` failed.",
            status === "running"
              ? "Step `149` of `150` running since `10:02:14 UTC`."
              : "Steps: `148 succeeded`, `2 not run` of `150`.",
            `Run details: \`https://hub.example.org/base/o/acme/activity/${RUN_ID}\``,
          );
        } else {
          expected.push(
            "Activity: 556 commands, 556 reads, 556 edits, 556 web calls, 556 subagents, 555 plans, 555 MCP calls, 555 finish calls, 555 other calls. 5001 tool calls, 5001 failed.",
            status === "running"
              ? "Step 149 of 150 running since 10:02:14 UTC."
              : "Steps: 148 succeeded, 2 not run of 150.",
            `Run details: https://hub.example.org/base/o/acme/activity/${RUN_ID}`,
          );
        }
        assert.equal(body, expected.join("\n"));
        for (const fragment of authored) assert.equal(body.includes(fragment), false);
        assert.doesNotMatch(body, /@everyone|<!channel>|secret\.example/u);
        assert.equal(Buffer.byteLength(body, "utf8"), body.length);
        assert.ok(body.length <= maxBodyChars);
      }
    }
  });

  it("keeps a mention-like URL inside its Linear code span", () => {
    const body = renderProgress({
      ...defaults,
      publicBaseUrl: "https://hub.example.org/@operator/`",
      organizationSlug: "@workspace",
    });
    assert.equal(
      body.split("\n").at(-1),
      `Run details: \`https://hub.example.org/@operator/%60/o/%40workspace/activity/${RUN_ID}\``,
    );
  });

  it("keeps the status within the provider limit when a configured link is too long", () => {
    const body = renderProgress({
      ...defaults,
      maxBodyChars: 3000,
      publicBaseUrl: "https://hub.example.org/" + "a".repeat(5000),
    });
    assert.match(body, /^Paseo run: Running/u);
    assert.doesNotMatch(body, /Run details/u);
    assert.ok(body.length <= 3000);
  });
});
