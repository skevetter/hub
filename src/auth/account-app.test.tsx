import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { AccountApp } from "./account-app.js";
import { leaveReader, resetQueriesOnReaderChange } from "./reader-cache.js";

test("the reload boundary renders only the loading entry without account or route providers", () => {
  const client = new QueryClient();
  const reload = vi.fn(() => {
    const html = renderToStaticMarkup(<AccountApp />);
    expect(html).toContain('aria-label="Loading Paseo Hub"');
    expect(html).not.toContain("Sign out");
  });
  resetQueriesOnReaderChange(client, { reload });

  leaveReader(client);

  expect(reload).toHaveBeenCalledOnce();
});
