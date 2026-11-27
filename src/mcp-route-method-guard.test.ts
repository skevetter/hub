import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Route as ExecutionRoute } from "./routes/agent-executions/$executionId/mcp.js";
import { Route as SessionRoute } from "./routes/agent-sessions/$sessionId/mcp.js";

/**
 * TanStack's `Constrain<ObjectLiteral, Fn>` handlers type resolves member
 * access against the function-form branch of the union even though these
 * routes declare the plain object-literal form, so the generated route
 * type cannot express calling an individual method handler directly.
 */
interface McpRouteMethodHandlers {
  GET(): Response | Promise<Response>;
  DELETE(): Response | Promise<Response>;
}

// The capability MCP servers are stateless and POST-only. Before this guard,
// an unhandled GET (SSE stream open) or DELETE (session terminate) fell
// through to the SPA route render: 200 HTML for an unknown id, or a 500 for a
// real one. A 500 makes MCP Streamable HTTP clients treat the server as dead
// instead of retrying with the one method it actually supports.
describe.each([
  ["execution", ExecutionRoute],
  ["session", SessionRoute],
])("the %s MCP route", (_, route) => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express calling one handler directly
  const handlers = route.options.server?.handlers as unknown as McpRouteMethodHandlers;

  it.each(["GET", "DELETE"] as const)("rejects %s with 405 and Allow: POST", async (method) => {
    const response = await handlers[method]();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.deepEqual(await response.json(), { error: "method_not_allowed" });
  });
});
