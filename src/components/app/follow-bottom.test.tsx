import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FollowBottom } from "./follow-bottom.js";

it("keeps the run timeline defaults", () => {
  const html = renderToStaticMarkup(<FollowBottom version={1}>Event</FollowBottom>);
  expect(html).toContain('aria-label="Run timeline"');
  expect(html).toContain("max-h-96");
});

it("supports a transcript label and height", () => {
  const html = renderToStaticMarkup(
    <FollowBottom version={1} label="Session transcript" maxHeight="50vh">
      Message
    </FollowBottom>,
  );
  expect(html).toContain('aria-label="Session transcript"');
  expect(html).toContain("max-height:50vh");
});
