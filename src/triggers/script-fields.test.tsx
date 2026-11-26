import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { newStepFormValue, type TriggerFormValue } from "./configuration/editor.js";
import { ProgressMessageField } from "./panel.js";
import { ActionField, ScriptFields, triggerSecondaryLine } from "./script-fields.js";

const form: TriggerFormValue = {
  name: "deploy",
  enabled: true,
  event: "manual.run",
  connection: "",
  allowedUsers: "alice",
  qualifiers: {},
  daemon: "devbox",
  cwd: "/workspace/webapp",
  runMaxRuntime: "",
  steps: [
    newStepFormValue({ action: "script", maxRuntime: "10m", script: 'echo "$HUB_EVENT_JSON"\n' }),
  ],
};

const promptForm: TriggerFormValue = { ...form, steps: [newStepFormValue()] };
const noop = () => undefined;

describe("trigger progress message field", () => {
  it.each(["github.push", "manual.run", "schedule.tick", "discord.mention"] as const)(
    "hides the control on %s",
    (event) => {
      const markup = renderToStaticMarkup(
        <ProgressMessageField event={event} checked={false} hubEnabled onChange={noop} />,
      );
      assert.equal(markup, "");
    },
  );

  it.each(["github.notification", "slack.mention", "linear.comment_created"] as const)(
    "shows the checkbox and its visibility copy on %s",
    (event) => {
      const markup = renderToStaticMarkup(
        <ProgressMessageField event={event} checked hubEnabled onChange={noop} />,
      );
      assert.match(markup, /type="checkbox"[^>]*checked=""/u);
      assert.match(markup, /Post live progress at the source/u);
      assert.match(
        markup,
        /Anyone who can see the source can read the message\. It shows only run status, counts, and durations/u,
      );
      assert.match(markup, /never includes agent output/u);
      assert.doesNotMatch(markup, /turned off/u);
    },
  );

  it("explains when the Hub switch is off and still allows authors to opt in", () => {
    const markup = renderToStaticMarkup(
      <ProgressMessageField
        event="slack.mention"
        checked={false}
        hubEnabled={false}
        onChange={noop}
      />,
    );
    assert.match(markup, /This Hub has progress messages turned off/u);
    assert.match(markup, /type="checkbox"/u);
    assert.doesNotMatch(markup, /(?:disabled|checked)=""/u);
  });
});

describe("trigger action choice", () => {
  it("offers Prompt and Script, with Script chosen for a script trigger", () => {
    const markup = renderToStaticMarkup(<ActionField value={form} onChange={noop} />);
    assert.match(markup, /Action/u);
    assert.match(markup, /Prompt/u);
    assert.match(markup, /Script/u);
    assert.match(markup, /role="radio"[^>]*aria-checked="true"[^>]*>(?:(?!<\/button>).)*Script/su);
    assert.doesNotMatch(
      markup,
      /role="radio"[^>]*aria-checked="true"[^>]*>(?:(?!<\/button>).)*Prompt/su,
    );
  });

  it("chooses Prompt for a prompt trigger", () => {
    const markup = renderToStaticMarkup(<ActionField value={promptForm} onChange={noop} />);
    assert.match(markup, /role="radio"[^>]*aria-checked="true"[^>]*>(?:(?!<\/button>).)*Prompt/su);
  });

  it("changes only the first action and preserves later steps", () => {
    const second = newStepFormValue({ id: "later", prompt: "Keep this" });
    const original = { ...promptForm, steps: [...promptForm.steps, second] };
    let updated: TriggerFormValue | undefined;
    const control = ActionField({ value: original, onChange: (value) => (updated = value) });
    control.props.onChange("script");
    assert.equal(updated?.steps[0]?.action, "script");
    assert.equal(updated?.steps[1], second);
    assert.equal(original.steps[0]?.action, "prompt");
  });
});

describe("script fields", () => {
  const render = (errors = {}) =>
    renderToStaticMarkup(<ScriptFields value={form} errors={errors} onChange={noop} />);

  it("shows the script in a monospace textarea", () => {
    const markup = render();
    assert.match(markup, /<textarea[^>]*name="script"/u);
    assert.match(markup, /font-mono text-xs/u);
    assert.ok(markup.includes("echo &quot;$HUB_EVENT_JSON&quot;"));
    assert.match(markup, /HUB_EVENT_JSON environment variable/u);
    assert.match(markup, /required/u);
  });

  it("notes whose user runs it, where, and which permissions Hub needs", () => {
    const markup = render();
    assert.match(markup, /runs as the daemon(&#x27;|')s user/u);
    assert.match(markup, /open project in\s+Paseo/u);
    assert.match(markup, /workspace\.read and workspace\.write permissions on the daemon/u);
  });

  it("marks the script field with its error", () => {
    const markup = render({ "steps.0.script": "Script is required." });
    assert.match(markup, /aria-invalid="true"/u);
    assert.match(markup, /Script is required\./u);
  });

  it("uses no weight, uppercase, or tracking utilities", () => {
    const markup = render() + renderToStaticMarkup(<ActionField value={form} onChange={noop} />);
    assert.doesNotMatch(markup, /font-(medium|semibold|bold)|uppercase|tracking-/u);
  });
});

describe("trigger list line", () => {
  it("shows Script with a terminal glyph in place of the agent", () => {
    const markup = renderToStaticMarkup(
      <>{triggerSecondaryLine({ draft: { steps: [newStepFormValue({ action: "script" })] } })}</>,
    );
    assert.match(markup, /<svg[^>]*lucide-square-terminal/u);
    assert.match(markup, /Script/u);
  });

  it("still shows the agent for a prompt trigger", () => {
    assert.equal(
      triggerSecondaryLine({ draft: { steps: [newStepFormValue({ agent: "codex/gpt-5.4" })] } }),
      "codex/gpt-5.4",
    );
    assert.equal(triggerSecondaryLine({ draft: null }), "Advanced YAML");
    assert.equal(triggerSecondaryLine({ format: "legacy_multistep", draft: null }), "Legacy YAML");
  });
});
