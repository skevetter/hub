import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../../../server/runtime.js";

export const Route = createFileRoute("/api/v1/runs/$runId/events")({
  server: {
    handlers: {
      GET: async ({ request, params }: { request: Request; params: { runId: string } }) =>
        (await getApplication()).runStream.handle(request, params.runId),
    },
  },
});
