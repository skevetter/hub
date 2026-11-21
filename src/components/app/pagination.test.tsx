import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Pagination } from "./pagination.js";

vi.mock("@tanstack/react-router", () => ({ useRouterState: () => false }));

const pageSize = { value: 25, accountId: "alice", onChange: vi.fn() } as const;

describe("Pagination", () => {
  it("renders the selected size in a named control beside the page links", () => {
    const html = renderToStaticMarkup(
      <Pagination
        label="Activity pages"
        position=""
        fallbackFocusId="activity-title"
        summary="1 to 25"
        newer={null}
        older={null}
        pageSize={pageSize}
      />,
    );

    expect(html).toMatch(/<label for="([^"]+)">Rows per page<\/label><select[^>]*id="\1"/u);
    expect(html).toContain('<option value="25" selected="">25</option>');
    for (const size of [15, 50, 100]) {
      expect(html).toContain(`<option value="${size}">${size}</option>`);
    }
  });
});
