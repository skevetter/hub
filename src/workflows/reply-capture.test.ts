import { describe, expect, it } from "vitest";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { capturesReply } from "./reply-capture.js";

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
