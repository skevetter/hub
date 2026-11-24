import { createSerializationAdapter } from "@tanstack/react-router";
import { createServerOnlyFn } from "@tanstack/react-start";
import { reportFailure } from "./failures/index.js";
import { isSafeRouteMessage, publicRouteMessage, referenceIn } from "./failures/reference.js";

const reportOnServer = createServerOnlyFn(
  (error: Error): string =>
    reportFailure(error, { operation: "ssr.route_error", component: "router" }).requestId,
);

/**
 * What the page may carry for an error raised while rendering on the server. Router state is
 * serialized into the HTML, so the original message, which can name a table or a host, stays in
 * the log under a reference and the page gets only the reader-safe text.
 */
export function serializedRouteMessage(error: Error, report: (error: Error) => string): string {
  const { message } = error;
  const reference = isSafeRouteMessage(message)
    ? undefined
    : (referenceIn(message) ?? report(error));
  return publicRouteMessage(message, reference);
}

export const routeErrorAdapter = createSerializationAdapter({
  key: "hub-route-error",
  test: (value: unknown): value is Error => value instanceof Error,
  toSerializable: (error: Error) => ({ message: serializedRouteMessage(error, reportOnServer) }),
  fromSerializable: ({ message }: { message: string }) => new Error(message),
});
