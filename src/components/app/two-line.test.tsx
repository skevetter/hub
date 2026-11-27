import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

import { TwoLine } from "./two-line.js";

describe("TwoLine", () => {
  it("renders a plain primary without a secondary", () => {
    const markup = renderToStaticMarkup(<TwoLine primary="Name" />);
    assert.match(markup, /<span class="flex/u);
    assert.match(markup, /title="Name">Name<\/span>/u);
    assert.doesNotMatch(markup, /text-muted-foreground/u);
  });

  it("renders a heading and a path with isolated direction", () => {
    const markup = renderToStaticMarkup(
      <TwoLine primary="Name" secondary="/work/dir" heading path />,
    );
    assert.match(markup, /<h2 class="break-words/u);
    assert.match(markup, /font-mono text-left/u);
    assert.match(markup, /title="\/work\/dir" dir="rtl"><bdi dir="ltr">\/work\/dir<\/bdi>/u);
  });

  it("renders mono secondary nodes without a title", () => {
    const markup = renderToStaticMarkup(<TwoLine primary={123} secondary={456} mono />);
    assert.match(markup, /font-mono/u);
    assert.doesNotMatch(markup, /title=/u);
    assert.match(markup, />456<\/span>/u);
  });
});
