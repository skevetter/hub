import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";

import { Section } from "./section.js";

const action = <a href="/activity">View all</a>;

it("gives trailing section links a 24 px minimum height at every width", () => {
  const markup = renderToStaticMarkup(
    <Section title="Recent runs" action={action}>
      Runs
    </Section>,
  );
  assert.match(markup, /class="[^"]*\[&amp;&gt;a\]:min-h-6[^"]*"[^>]*><a href="\/activity"/u);
});

it("names a titled section using its heading", () => {
  const markup = renderToStaticMarkup(<Section title="Where it runs">Fields</Section>);
  const id = markup.match(/aria-labelledby="([^"]+)"/u)?.[1];
  assert.ok(id);
  assert.ok(markup.includes(`id="${id}"`));
  assert.doesNotMatch(renderToStaticMarkup(<Section>Fields</Section>), /aria-labelledby/u);
});
