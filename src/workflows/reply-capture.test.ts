import { describe, expect, it } from "vitest";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { capturesReply, isReplyCaptureCandidate } from "./reply-capture.js";

const ON = `on:
  linear.comment_created:
    connection: linear
    filters:
      from_users: [alice]
`;

function stepsDocument(replyMessage: boolean): string {
  return `name: replying
${ON}${replyMessage ? "reply_message: true\n" : ""}target: { daemon: devbox, cwd: /workspace/app }
steps:
  - id: build
    script: make
  - id: plan
    agent: { provider: codex }
    prompt: Plan
  - id: answer
    agent: { provider: codex }
    prompt: Answer
`;
}

describe("reply capture", () => {
  it("applies to the last agent step of a steps trigger only", () => {
    const trigger = compileTriggerDocument(stepsDocument(true)).events[0];
    if (trigger === undefined) throw new Error("expected a compiled trigger");
    expect(trigger.steps.map((step) => capturesReply(trigger, step))).toEqual([false, false, true]);
  });

  it("is off when the trigger does not reply", () => {
    const trigger = compileTriggerDocument(stepsDocument(false)).events[0];
    if (trigger === undefined) throw new Error("expected a compiled trigger");
    expect(trigger.steps.map((step) => capturesReply(trigger, step))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("still applies to the one step of a run document", () => {
    const yaml = `name: replying
${ON}reply_message: true
run:
  target: { daemon: devbox, cwd: /workspace/app }
  agent: { provider: codex }
  prompt: Answer
`;
    const trigger = compileTriggerDocument(yaml).events[0];
    if (trigger === undefined) throw new Error("expected a compiled trigger");
    expect(trigger.steps.map((step) => capturesReply(trigger, step))).toEqual([true]);
  });
});

function conditionalStepsDocument(conditions: readonly (string | undefined)[]): string {
  const steps = conditions
    .map(
      (condition, index) =>
        `  - id: step${index}\n${condition === undefined ? "" : `    if: "${condition}"\n`}    agent: { provider: codex }\n    prompt: Go\n`,
    )
    .join("");
  return `name: replying\n${ON}reply_message: true\ntarget: { daemon: devbox, cwd: /workspace/app }\nsteps:\n  - id: build\n    script: make\n${steps}`;
}

function candidates(conditions: readonly (string | undefined)[]): boolean[] {
  const trigger = compileTriggerDocument(conditionalStepsDocument(conditions)).events[0];
  if (trigger === undefined) throw new Error("expected a compiled trigger");
  return trigger.steps.map((step) => isReplyCaptureCandidate(trigger, step));
}

describe("reply capture candidates", () => {
  const SKIP = "${{ false }}";

  it("watches only the last agent step when it always runs", () => {
    expect(candidates([undefined, undefined])).toEqual([false, false, true]);
  });

  it("watches earlier steps while every step after them can be skipped", () => {
    expect(candidates([undefined, SKIP])).toEqual([false, true, true]);
    expect(candidates([SKIP, undefined, SKIP, SKIP])).toEqual([false, false, true, true, true]);
    expect(candidates([SKIP, SKIP])).toEqual([false, true, true]);
  });

  it("never watches a script step or a trigger that does not reply", () => {
    const off = compileTriggerDocument(stepsDocument(false)).events[0];
    if (off === undefined) throw new Error("expected a compiled trigger");
    expect(off.steps.map((step) => isReplyCaptureCandidate(off, step))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("keeps the reply message flag on the last agent step only", () => {
    const trigger = compileTriggerDocument(conditionalStepsDocument([undefined, SKIP])).events[0];
    if (trigger === undefined) throw new Error("expected a compiled trigger");
    expect(trigger.steps.map((step) => capturesReply(trigger, step))).toEqual([false, false, true]);
  });
});
