import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import type { TriggerFormValue } from "./configuration/editor.js";
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
  agent: "",
  mode: "",
  thinkingOptionId: "",
  providerOptions: "",
  continuationMode: "conversation",
  continuationKey: "",
  maxRuntime: "10m",
  idleTimeout: "10m",
  completeOnTurnEnd: false,
  githubConnection: "",
  githubRepositories: "",
  githubPermissions: "",
  githubDuration: "",
  prompt: "",
  action: "script",
  script: 'echo "$HUB_EVENT_JSON"\n',
};

const promptForm: TriggerFormValue = { ...form, action: "prompt" };
const noop = () => undefined;

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
    const markup = render({ script: "Script is required." });
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
      <>{triggerSecondaryLine({ draft: { action: "script", agent: "" } })}</>,
    );
    assert.match(markup, /<svg[^>]*lucide-square-terminal/u);
    assert.match(markup, /Script/u);
  });

  it("still shows the agent for a prompt trigger", () => {
    assert.equal(
      triggerSecondaryLine({ draft: { action: "prompt", agent: "codex/gpt-5.4" } }),
      "codex/gpt-5.4",
    );
    assert.equal(triggerSecondaryLine({ draft: null }), "Advanced YAML");
    assert.equal(triggerSecondaryLine({ format: "legacy_multistep", draft: null }), "Legacy YAML");
  });
});
