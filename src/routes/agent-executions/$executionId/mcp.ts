import { createFileRoute } from "@tanstack/react-router";
import { mcpMethodNotAllowed } from "../../../http/mcp-method-not-allowed.js";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/agent-executions/$executionId/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleExecutionCapabilities(
          request,
          new URL(request.url).pathname.split("/")[2] ?? "",
        ),
      GET: mcpMethodNotAllowed,
      DELETE: mcpMethodNotAllowed,
    },
  },
});
