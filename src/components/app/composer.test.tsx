import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

import {
  Composer,
  MAX_COMPOSER_BYTES,
  composerActions,
  composerKeyIntent,
  messageBytes,
  type ComposerAgentState,
} from "./composer.js";

const NOOP = async (): Promise<boolean> => true;

function render(props: Partial<Parameters<typeof Composer>[0]> = {}): string {
  return renderToStaticMarkup(
    <Composer agentState="running" onSteer={NOOP} onQueue={NOOP} {...props} />,
  );
}

describe("composer actions by agent state", () => {
  it("offers Steer now and Queue for next turn while the agent runs", () => {
    const actions = composerActions("running", false);
    assert.deepEqual(actions, {
      mode: "split",
      steer: { enabled: true },
      queue: { enabled: true },
    });
    const markup = render();
    assert.match(markup, /Steer now/u);
    assert.match(markup, /Queue for next turn/u);
  });

  it("offers one Send when the agent is idle", () => {
    assert.deepEqual(composerActions("idle", false), { mode: "single", send: { enabled: true } });
    const markup = render({ agentState: "idle" });
    assert.match(markup, />Send</u);
    assert.doesNotMatch(markup, /Steer now/u);
    assert.doesNotMatch(markup, /Queue for next turn/u);
  });

  it("refuses steer and explains it while a permission waits", () => {
    const actions = composerActions("waiting_permission", false);
    assert.equal(actions.mode, "split");
    if (actions.mode !== "split") return;
    assert.equal(actions.steer.enabled, false);
    assert.match(actions.steer.enabled ? "" : actions.steer.reason, /permission/u);
    assert.equal(actions.queue.enabled, true);
    assert.match(render({ agentState: "waiting_permission" }), /permission/u);
  });

  it("disables both while a send is in flight", () => {
    for (const state of ["idle", "running", "waiting_permission"] as ComposerAgentState[]) {
      const actions = composerActions(state, true);
      const buttons = actions.mode === "single" ? [actions.send] : [actions.steer, actions.queue];
      assert.ok(buttons.every((button) => !button.enabled));
    }
    const markup = render({ busy: true });
    assert.equal(markup.match(/disabled=""/gu)?.length, 2);
  });

  it("disables everything with a reason when the session cannot take messages", () => {
    const markup = render({ disabledReason: "Daemon is offline." });
    assert.match(markup, /Daemon is offline\./u);
    assert.match(markup, /<textarea[^>]*disabled/u);
  });

  it("renders the Stop slot only when given one", () => {
    assert.doesNotMatch(render(), />Stop</u);
    assert.match(render({ onStop: () => {} }), />Stop</u);
  });
});

describe("composer size limit", () => {
  it("counts bytes, not characters", () => {
    assert.equal(messageBytes("abc"), 3);
    assert.equal(messageBytes("é"), 2);
    assert.equal(messageBytes("\u{1F600}"), 4);
  });

  it("refuses a message over 16 KiB", () => {
    assert.equal(MAX_COMPOSER_BYTES, 16 * 1024);
    const over = "a".repeat(MAX_COMPOSER_BYTES + 1);
    const actions = composerActions("running", false, messageBytes(over));
    assert.equal(actions.mode === "split" && actions.steer.enabled, false);
    assert.equal(actions.mode === "split" && actions.queue.enabled, false);
    const markup = render({ initialDraft: over });
    assert.match(markup, /Message is over 16 KiB/u);
    assert.match(markup, /aria-invalid="true"/u);
  });

  it("accepts exactly 16 KiB", () => {
    const actions = composerActions("running", false, MAX_COMPOSER_BYTES);
    assert.equal(actions.mode === "split" && actions.steer.enabled, true);
  });

  it("shows a counter near the limit and not far from it", () => {
    assert.doesNotMatch(render({ initialDraft: "short" }), /KiB left|bytes left/u);
    const near = render({ initialDraft: "a".repeat(MAX_COMPOSER_BYTES - 100) });
    assert.match(near, /100 bytes left/u);
  });

  it("does not offer a send for an empty or blank draft", () => {
    const actions = composerActions("running", false, 0);
    assert.equal(actions.mode === "split" && actions.steer.enabled, false);
  });
});

describe("composer keyboard and failure", () => {
  it("submits on Cmd or Ctrl+Enter and lets plain Enter type a newline", () => {
    assert.equal(composerKeyIntent({ key: "Enter", metaKey: true, ctrlKey: false }), "submit");
    assert.equal(composerKeyIntent({ key: "Enter", metaKey: false, ctrlKey: true }), "submit");
    assert.equal(composerKeyIntent({ key: "Enter", metaKey: false, ctrlKey: false }), "none");
    assert.equal(composerKeyIntent({ key: "a", metaKey: true, ctrlKey: false }), "none");
  });

  it("keeps the draft and shows the failure when a send fails", () => {
    const markup = render({
      initialDraft: "my unsent words",
      error: "Daemon refused the message.",
    });
    assert.match(markup, /my unsent words/u);
    assert.match(markup, /Daemon refused the message\./u);
    assert.match(markup, /role="alert"/u);
  });

  it("labels the textarea so it can be reached by name", () => {
    assert.match(render(), /<label[^>]*>Message<\/label>/u);
  });
});
