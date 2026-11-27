/**
 * The capability MCP servers are stateless and POST-only: every call opens a fresh transport
 * and closes it once the response finishes, so there is no SSE stream to resume (GET) or
 * session to terminate (DELETE). Without an explicit handler these methods fell through to the
 * SPA route render, which returned a misleading 200 (unknown id) or crashed to 500 (real id)
 * instead of the 405 the MCP Streamable HTTP spec requires for an unsupported method. A 500
 * makes MCP clients mark the server as dead instead of retrying.
 */
export function mcpMethodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
