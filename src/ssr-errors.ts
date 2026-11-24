import { createSerializationAdapter, isNotFound, isRedirect } from "@tanstack/react-router";
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

function thrownValue(error: unknown): boolean {
  return (
    error !== undefined && !(error instanceof Error) && !isRedirect(error) && !isNotFound(error)
  );
}

function asError(reason: unknown): unknown {
  if (!thrownValue(reason)) return reason;
  return new Error("A promise was rejected with a value that is not an Error.", { cause: reason });
}

// The value type is a stand-in: the router's serialization types accept only known shapes.
type RoutePromise = Promise<string>;

const normalized = new WeakSet<RoutePromise>();

/**
 * A promise in loader data is serialized as a rejection when it fails, and the rejection value
 * does not pass through the error adapter unless it is an Error. This swaps each promise for one
 * that rejects only with an Error. The swapped promise is remembered so it is not swapped again.
 */
export const routePromiseAdapter = createSerializationAdapter({
  key: "hub-route-promise",
  test: (value: unknown): value is RoutePromise =>
    typeof window === "undefined" && value instanceof Promise && !normalized.has(value),
  toSerializable: (promise: RoutePromise) => {
    const safe = promise.catch((reason: unknown): string => {
      throw asError(reason);
    });
    normalized.add(safe);
    return safe;
  },
  fromSerializable: (promise: RoutePromise) => promise,
});

export const routeSerializationAdapters = [routeErrorAdapter, routePromiseAdapter];

interface MatchState {
  id: string;
  error?: unknown;
}

/** The parts of the router the guard touches, so the node project need not resolve its route tree. */
interface GuardedRouter {
  load(options?: unknown): Promise<unknown>;
  state: { matches: readonly MatchState[] };
  updateMatch(id: string, update: (previous: MatchState) => MatchState): void;
}

/**
 * The adapter above only sees Error instances. A loader that throws a string or a plain object
 * would ship it as is. The router emits no load events on the server, so the guard wraps load():
 * once it settles, those values become an Error and take the same path. The original value stays
 * in the log through `cause`.
 */
export function installRouteErrorGuard(router: GuardedRouter): void {
  if (typeof window !== "undefined") return;
  const load = router.load.bind(router);
  router.load = async (options) => {
    const result = await load(options);
    wrapThrownValues(router);
    return result;
  };
}

function wrapThrownValues(router: GuardedRouter): void {
  for (const match of router.state.matches) {
    if (!thrownValue(match.error)) continue;
    router.updateMatch(match.id, (previous) => ({
      ...previous,
      error: new Error("A route failed with a value that is not an Error.", {
        cause: previous.error,
      }),
    }));
  }
}
