import assert from "node:assert/strict";
import { it } from "vitest";
import { summarizeStepPayload } from "./summary.js";

const STARTED = new Date("2026-10-01T00:00:00Z");

function step(dispatchIntent: Parameters<typeof summarizeStepPayload>[0]["dispatchIntent"]) {
  return {
    stepId: "build",
    status: "succeeded" as const,
    startedAt: STARTED,
    completedAt: new Date(STARTED.getTime() + 1500),
    agentExecutionId: "execution",
    output: { text: "raw" },
    dispatchIntent,
  } as const;
}

it("summarizes a step whose dispatch intent has no agent", () => {
  const summary = summarizeStepPayload(step({}));
  assert.equal(summary.provider, null);
  assert.equal(summary.model, null);
  assert.equal(summary.durationMs, 1500);
  assert.equal(summary.hadOutput, true);
});

it("keeps only well-formed provider and model labels", () => {
  assert.deepEqual(
    [
      summarizeStepPayload(step({ agent: { provider: "codex", model: "gpt-6.2-sol" } })),
      summarizeStepPayload(
        step({ agent: { provider: "Bad Provider!", model: "raw prompt text" } }),
      ),
    ].map(({ provider, model }) => ({ provider, model })),
    [
      { provider: "codex", model: "gpt-6.2-sol" },
      { provider: null, model: null },
    ],
  );
});
