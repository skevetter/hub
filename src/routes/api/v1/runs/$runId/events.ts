import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../../../server/runtime.js";

async function handleRunEvents({
  request,
  params,
}: {
  request: Request;
  params: { runId: string };
}) {
  return (await getApplication()).runStream.handle(request, params.runId);
}

export const Route = createFileRoute("/api/v1/runs/$runId/events")({
  server: {
    handlers: {
      GET: handleRunEvents,
      HEAD: handleRunEvents,
      ANY: handleRunEvents,
    },
  },
});
