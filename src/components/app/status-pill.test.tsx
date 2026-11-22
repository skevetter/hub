import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { StatusPill } from "./status-pill.js";

it("renders a status with its tone", () => {
  const markup = renderToStaticMarkup(<StatusPill tone="danger">Failed</StatusPill>);
  assert.match(markup, /bg-danger-surface text-danger/u);
  assert.match(markup, /Failed/u);
});
