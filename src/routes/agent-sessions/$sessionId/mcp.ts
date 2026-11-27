import { createFileRoute } from "@tanstack/react-router";
import { mcpMethodNotAllowed } from "../../../http/mcp-method-not-allowed.js";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/agent-sessions/$sessionId/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleSessionCapabilities(
          request,
          new URL(request.url).pathname.split("/")[2] ?? "",
        ),
      GET: mcpMethodNotAllowed,
      DELETE: mcpMethodNotAllowed,
    },
  },
});
