import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { isScriptStepOutput, ScriptStepOutput } from "./script-step-output.js";

const render = (output: unknown, status = "succeeded") =>
  renderToStaticMarkup(<ScriptStepOutput stepId="step-1" status={status} output={output} />);

describe("script step output in the run history", () => {
  it("shows the exit code and a collapsed output tail", () => {
    const markup = render({ exit_code: 3, output_tail: "line one\nline two", truncated: false });
    assert.match(markup, /Exit code 3/u);
    assert.match(markup, /line one\nline two/u);
    // Collapsed: the body is mounted but hidden.
    assert.match(markup, /aria-expanded="false"/u);
    assert.match(markup, /hidden/u);
    assert.match(markup, /Everything the script printed\./u);
  });

  it("says when only the end of the output is kept", () => {
    const markup = render({ exit_code: 0, output_tail: "tail", truncated: true });
    assert.match(markup, /Exit code 0/u);
    assert.match(markup, /The last 64 KB of the output\./u);
  });

  it("says there was no exit code when the script never reported one", () => {
    const markup = render({ exit_code: null, output_tail: "", truncated: false });
    assert.match(markup, /No exit code/u);
    assert.match(markup, /\(no output\)/u);
  });

  it("caps oversized script output to its tail", () => {
    const markup = render({
      exit_code: 0,
      output_tail: "x".repeat(70_000) + "tail",
      truncated: false,
    });
    assert.match(markup, /The last 64 KB of the output\./u);
    assert.match(markup, /tail/u);
    assert.doesNotMatch(markup, /x{65536}/u);
  });

  it("escapes what the script printed", () => {
    const markup = render({
      exit_code: 1,
      output_tail: "<img src=x onerror=alert(1)>",
      truncated: false,
    });
    assert.doesNotMatch(markup, /<img/u);
    assert.match(markup, /&lt;img/u);
  });

  it("shows a running script without its terminal handle", () => {
    const handle = { terminal_id: "terminal-1", daemon_id: "daemon-1", cwd: "/work" };
    const markup = render(handle, "running");
    assert.match(markup, /Running on the daemon/u);
    assert.doesNotMatch(markup, /terminal-1/u);
    // A step the deadline ended while its output still names a terminal is not running.
    assert.match(render(handle, "timed_out"), /Stopped before it reported a result/u);
  });

  it("recognises only script step output", () => {
    assert.equal(isScriptStepOutput({ exit_code: 0, output_tail: "", truncated: false }), true);
    assert.equal(isScriptStepOutput({ terminal_id: "t", daemon_id: "d", cwd: "/w" }), true);
    assert.equal(isScriptStepOutput({ repo: "paseo" }), false);
    assert.equal(isScriptStepOutput(null), false);
  });
});
