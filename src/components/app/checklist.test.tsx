/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- a test renders each element once */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

import { Checklist, ChecklistItem, ChecklistProgress } from "./checklist.js";

describe("checklist progress", () => {
  it("is a progress bar that says the count in words and draws one segment per step", () => {
    const markup = renderToStaticMarkup(
      <ChecklistProgress label="Getting started" done={2} total={5} />,
    );

    assert.match(markup, /role="progressbar"/u);
    assert.match(markup, /aria-label="Getting started"/u);
    assert.match(markup, /aria-valuenow="2"/u);
    assert.match(markup, /aria-valuemax="5"/u);
    assert.match(markup, /aria-valuetext="2 of 5 done"/u);
    assert.equal([...markup.matchAll(/bg-success/gu)].length, 2);
    assert.equal([...markup.matchAll(/bg-border/gu)].length, 3);
  });
});

describe("a checklist step", () => {
  it("says a finished step's state to a screen reader without printing it", () => {
    const markup = renderToStaticMarkup(
      <Checklist label="Getting started">
        <ChecklistItem state="done" stateLabel="Done" title="Connect a daemon" hint="devbox" />
      </Checklist>,
    );

    assert.match(markup, /<ul aria-label="Getting started"/u);
    assert.match(markup, /Connect a daemon<span class="sr-only"> Done<\/span>/u);
    assert.match(markup, /text-muted-foreground">Connect a daemon/u);
  });

  it("prints the state of a step that needs attention, beside its title", () => {
    const markup = renderToStaticMarkup(
      <ChecklistItem state="attention" stateLabel="Cannot run agents" title="Connect a daemon" />,
    );

    assert.match(markup, /text-warning">[^<]*Cannot run agents/u);
    assert.doesNotMatch(markup, /sr-only/u);
  });

  it("carries one action and something to copy", () => {
    const action = <a href="/triggers/new">New trigger</a>;
    const markup = renderToStaticMarkup(
      <ChecklistItem state="todo" stateLabel="To do" title="Create a trigger" action={action}>
        <code>paseo hub login</code>
      </ChecklistItem>,
    );

    assert.match(markup, /<a href="\/triggers\/new">New trigger<\/a>/u);
    assert.match(markup, /<code>paseo hub login<\/code>/u);
    assert.match(markup, /Create a trigger<span class="sr-only"> To do<\/span>/u);
  });
});
