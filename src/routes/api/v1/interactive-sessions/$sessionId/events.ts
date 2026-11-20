import { createFileRoute } from "@tanstack/react-router";
import { getInteractiveSessionRuntime } from "../../../../../interactive-sessions/functions.js";
import { interactiveSessionStreamFailure } from "../../../../../interactive-sessions/stream.js";
import { requestIdentifier } from "../../../../../public-api/problem.js";

export async function handleInteractiveSessionEvents({
  request,
  params,
}: {
  request: Request;
  params: { sessionId: string };
}) {
  const runtime = await getInteractiveSessionRuntime();
  if (runtime === null)
    return interactiveSessionStreamFailure(requestIdentifier(request), "not_found");
  return runtime.stream.handle(request, params.sessionId);
}

export const Route = createFileRoute(
  // @ts-ignore The route id is added by the TanStack route generator at build time.
  "/api/v1/interactive-sessions/$sessionId/events",
)({
  server: {
    handlers: {
      GET: handleInteractiveSessionEvents,
      HEAD: handleInteractiveSessionEvents,
      ANY: handleInteractiveSessionEvents,
    },
  },
});
