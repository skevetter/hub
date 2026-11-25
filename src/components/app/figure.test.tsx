import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { Figure, FigureSkeleton, Figures } from "./figure.js";

describe("Figure", () => {
  it("sets the numeral over a heavy rule with its unit and caption", () => {
    const markup = renderToStaticMarkup(<Figure value="14" unit="runs today" caption="3 failed" />);
    assert.match(markup, /class="[^"]*border-t-2[^"]*border-foreground/u);
    assert.match(markup, /<span class="[^"]*font-strong text-3xl tabular-nums[^"]*">14<\/span>/u);
    assert.match(markup, /<span class="text-sm">runs today<\/span>/u);
    assert.match(markup, /<p class="text-xs text-muted-foreground">3 failed<\/p>/u);
  });

  it("spends a state ink only when it is asked to", () => {
    assert.doesNotMatch(renderToStaticMarkup(<Figure value="0" unit="failing" />), /-text/u);
    assert.match(
      renderToStaticMarkup(<Figure value="2" unit="failing" tone="attention" />),
      /text-attention-text/u,
    );
    assert.match(
      renderToStaticMarkup(<Figure value="1" unit="running" tone="live" />),
      /text-live-text/u,
    );
  });

  it("omits the caption line when there is nothing to add", () => {
    assert.equal(
      renderToStaticMarkup(<Figure value="1" unit="daemon" />).includes("text-xs"),
      false,
    );
  });
});

describe("Figures", () => {
  it("groups figures under a label, two across on a phone and three from md", () => {
    const markup = renderToStaticMarkup(
      <Figures label="Overview">
        <Figure value="1" unit="a" />
      </Figures>,
    );
    assert.match(markup, /role="group" aria-label="Overview"/u);
    assert.match(markup, /grid-cols-2[^"]*md:grid-cols-3/u);
  });

  it("reserves the loaded figure's rule and is hidden from assistive technology", () => {
    const markup = renderToStaticMarkup(<FigureSkeleton />);
    assert.match(markup, /aria-hidden="true"/u);
    assert.match(markup, /border-t-2 border-foreground/u);
  });
});
