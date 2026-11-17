import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger.js";
import {
  failureWasReported,
  reportFailure,
  runWithFailureTracking,
  withReference,
} from "../failures/index.js";
import { INTERNAL_CLIENT_ADDRESS_HEADER } from "./client-address.js";
import { takeResponseLifecycle } from "./response-lifecycle.js";
import { TRUSTED_REQUEST_ORIGIN_HEADER } from "./request-origin.js";
import { HttpRequestDrain } from "./request-drain.js";
import { problem, requestIdentifier } from "../public-api/problem.js";

const requestDrains = new WeakMap<Server, HttpRequestDrain>();
const FETCH_FORBIDDEN_METHODS: Readonly<Record<string, true>> = {
  CONNECT: true,
  TRACE: true,
  TRACK: true,
};

export type FetchHandler = (request: Request) => Response | Promise<Response>;

interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

interface FetchServerOptions {
  trustedClientIpHeader?: string;
  /** Explicit public URL whose origin is authoritative over proxy request metadata. */
  canonicalRequestOrigin?: string;
  /** Test and embedded adapters may terminate TLS directly; production normally uses its proxy. */
  tls?: { key: string; cert: string };
  logger?: Pick<Logger, "warn" | "error">;
  handleUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export function createFetchServer(
  fetchHandler: FetchHandler,
  options: FetchServerOptions = {},
): Server {
  const resolvedOptions = {
    ...options,
    ...(options.canonicalRequestOrigin === undefined
      ? {}
      : { canonicalRequestOrigin: parseHttpOrigin(options.canonicalRequestOrigin) }),
  };
  const drain = new HttpRequestDrain();
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    if (!drain.admit(response)) return;
    const forwarding = Object.hasOwn(FETCH_FORBIDDEN_METHODS, request.method ?? "")
      ? rejectTransportMethod(request, response, options.logger ?? defaultLogger)
      : forwardRequest(fetchHandler, request, response, resolvedOptions);
    void forwarding.finally(() => {
      drain.complete(response);
    });
  };
  const server =
    resolvedOptions.tls === undefined
      ? createServer(handler)
      : createHttpsServer(resolvedOptions.tls, handler);
  requestDrains.set(server, drain);
  const handleUpgrade = options.handleUpgrade;
  if (handleUpgrade !== undefined) {
    server.on("upgrade", (request, socket, head) => {
      if (!drain.acceptsUpgrades()) {
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      handleUpgrade(request, socket, head);
    });
  }
  return server;
}

export function beginHttpShutdown(server: Server): {
  drained: Promise<void>;
  expire: () => ReadonlySet<Socket>;
  readonly activeRequests: number;
} {
  const drain = requestDrains.get(server) ?? new HttpRequestDrain();
  return {
    drained: drain.begin(),
    expire: () => drain.expire(),
    get activeRequests() {
      return drain.activeRequests;
    },
  };
}

async function rejectTransportMethod(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  logger: Pick<Logger, "warn" | "error">,
): Promise<void> {
  try {
    const response = problem(
      requestIdentifier({ headers: requestHeaders(incoming) }),
      405,
      "method_not_allowed",
      "Method not allowed",
      "This transport does not support the requested method.",
      undefined,
      { allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" },
    );
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    outgoing.end(await response.text());
  } catch (error) {
    respondToRequestFailure(error, incoming, outgoing, logger);
  }
}

async function forwardRequest(
  fetchHandler: FetchHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: FetchServerOptions,
): Promise<void> {
  try {
    const clientAddress = resolveClientAddress(incoming, options.trustedClientIpHeader);
    const request = toRequest(incoming, outgoing, clientAddress, options);
    const tracked = await runWithFailureTracking(async () => {
      const response = await fetchHandler(request);
      return { response, failureReported: failureWasReported() };
    }, options.logger);
    const { response } = tracked;
    if (outgoing.writableEnded || outgoing.destroyed) {
      void response.body?.cancel().catch((error: unknown) => {
        reportFailure(
          error,
          { operation: "http.response.cancel", component: "http", method: request.method },
          { logger: options.logger ?? defaultLogger },
        );
      });
      return;
    }
    let responseRequestId: string | undefined;
    if (response.status >= 400 && !tracked.failureReported) {
      const requestId = response.headers.get("x-request-id");
      responseRequestId = reportFailure(
        new Error(`HTTP response completed with status ${response.status}`),
        {
          operation: "http.response",
          component: "http",
          method: request.method,
          path: new URL(request.url).pathname,
          status: response.status,
          ...(requestId === null ? {} : { requestId }),
        },
        {
          status: response.status,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        },
      ).requestId;
    }
    const lifecycle = takeResponseLifecycle(response);
    let responseForwarded = false;
    let lifecycleSettled = false;
    const runLifecycle = (callback: (() => void | Promise<void>) | undefined): void => {
      if (callback === undefined || lifecycleSettled) return;
      lifecycleSettled = true;
      void Promise.resolve(callback()).catch((error: unknown) => {
        reportFailure(
          error,
          { operation: "http.response.lifecycle", component: "http", method: request.method },
          options.logger === undefined ? {} : { logger: options.logger },
        );
      });
    };
    const abortLifecycle = (): void => {
      if (lifecycle === undefined) return;
      runLifecycle(lifecycle.onAbort);
    };
    if (lifecycle !== undefined) {
      const removeLifecycleListeners = () => {
        outgoing.off("finish", finishLifecycle);
        outgoing.off("close", markResponseAborted);
        outgoing.off("error", markResponseAborted);
      };
      const finishLifecycle = () => {
        removeLifecycleListeners();
        if (!responseForwarded) abortLifecycle();
        else runLifecycle(lifecycle.onFinish);
      };
      const markResponseAborted = () => {
        removeLifecycleListeners();
        if (outgoing.writableFinished) return;
        responseForwarded = false;
        abortLifecycle();
      };
      outgoing.once("finish", finishLifecycle);
      outgoing.once("close", markResponseAborted);
      outgoing.once("error", markResponseAborted);
    }
    outgoing.statusCode = response.status;
    outgoing.statusMessage = response.statusText;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    if (responseRequestId !== undefined) outgoing.setHeader("x-request-id", responseRequestId);
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
    if (response.headers.get("content-type")?.startsWith("text/event-stream"))
      outgoing.removeHeader("connection");
    else if (!outgoing.shouldKeepAlive) outgoing.setHeader("connection", "close");
    if (response.body === null) {
      responseForwarded = true;
      outgoing.end();
      return;
    }
    responseForwarded = await forwardResponseBody(
      response.body,
      outgoing,
      request.method,
      options.logger ?? defaultLogger,
      lifecycle !== undefined,
    );
    if (responseForwarded) outgoing.end();
  } catch (error) {
    respondToRequestFailure(error, incoming, outgoing, options.logger ?? defaultLogger);
  }
}

async function forwardResponseBody(
  body: ReadableStream<Uint8Array>,
  outgoing: ServerResponse,
  method: string,
  logger: Pick<Logger, "warn" | "error">,
  boundedStall: boolean,
): Promise<boolean> {
  const reader = body.getReader();
  let canceled = false;
  const cancelReader = () => {
    if (canceled) return;
    canceled = true;
    void reader.cancel().catch((error: unknown) => {
      reportFailure(
        error,
        { operation: "http.response.cancel", component: "http", method },
        { logger },
      );
    });
  };
  const onError = (error: Error) => {
    reportFailure(
      error,
      { operation: "http.response.stream", component: "http", method },
      { logger },
    );
    cancelReader();
    outgoing.destroy();
  };
  outgoing.once("close", cancelReader);
  outgoing.once("error", onError);
  try {
    if (outgoing.destroyed || outgoing.writableEnded) {
      cancelReader();
      return false;
    }
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || canceled || outgoing.destroyed) break;
      if (!outgoing.write(chunk.value) && !canceled) {
        if (!(await waitForResponseDrain(outgoing, boundedStall))) {
          cancelReader();
          break;
        }
      }
    }
    return !canceled && !outgoing.destroyed;
  } catch (error) {
    cancelReader();
    outgoing.destroy();
    throw error;
  } finally {
    outgoing.off("close", cancelReader);
    outgoing.off("error", onError);
    reader.releaseLock();
  }
}

function waitForResponseDrain(outgoing: ServerResponse, boundedStall: boolean): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = boundedStall
    ? setTimeout(() => {
        outgoing.destroy();
        finish(false);
      }, 30_000).unref()
    : undefined;
  const finish = (drained: boolean) => {
    clearTimeout(timer);
    outgoing.off("drain", onDrain);
    outgoing.off("close", onClose);
    outgoing.off("error", onClose);
    resolve(drained);
  };
  const onDrain = () => finish(true);
  const onClose = () => finish(false);
  outgoing.once("drain", onDrain);
  outgoing.once("close", onClose);
  outgoing.once("error", onClose);
  if (outgoing.destroyed || outgoing.writableEnded) finish(false);
  return promise;
}

function respondToRequestFailure(
  error: unknown,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  logger: Pick<Logger, "warn" | "error">,
): void {
  if (outgoing.writableEnded || outgoing.destroyed) return;
  const path = safeRequestPath(incoming.url);
  const report = reportFailure(
    error,
    {
      operation: "http.request",
      component: "http",
      method: incoming.method ?? "GET",
      path,
    },
    { logger },
  );
  outgoing.statusCode = 500;
  outgoing.setHeader("x-request-id", report.requestId);
  if (path.startsWith("/api/")) {
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.end(
      JSON.stringify({
        error: "internal_error",
        message: "Hub couldn't complete this API request.",
        requestId: report.requestId,
      }),
    );
    return;
  }
  outgoing.setHeader("content-type", "text/plain; charset=utf-8");
  outgoing.end(withReference("Hub couldn't complete this request.", report.requestId));
}

function safeRequestPath(value: string | undefined): string {
  if (value === undefined) return "/";
  try {
    return new URL(value, "http://localhost").pathname;
  } catch {
    return "<invalid-path>";
  }
}

function toRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  clientAddress: string,
  options: FetchServerOptions,
): Request {
  const method = incoming.method ?? "GET";
  const origin = `http://${incoming.headers.host ?? "localhost"}`;
  const headers = requestHeaders(incoming);
  headers.set(INTERNAL_CLIENT_ADDRESS_HEADER, clientAddress);
  headers.set(TRUSTED_REQUEST_ORIGIN_HEADER, requestOrigin(incoming, options));
  const base = { method, headers } satisfies RequestInit;
  if (method === "GET" || method === "HEAD") {
    return new Request(new URL(incoming.url ?? "/", origin), base);
  }
  const streaming = {
    ...base,
    body: requestBody(incoming, outgoing),
    duplex: "half",
  } satisfies StreamingRequestInit;
  return new Request(new URL(incoming.url ?? "/", origin), streaming);
}

function resolveClientAddress(
  incoming: IncomingMessage,
  trustedClientIpHeader: string | undefined,
): string {
  const peerAddress = incoming.socket.remoteAddress ?? "unknown";
  if (trustedClientIpHeader === undefined) return peerAddress;
  const value = incoming.headers[trustedClientIpHeader.toLowerCase()];
  if (typeof value !== "string") return peerAddress;
  const address = value.trim();
  return isIP(address) === 0 ? peerAddress : address;
}

function requestBody(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): ReadableStream<Uint8Array> {
  let stopped = false;
  let controller: ReadableByteStreamController;
  const cleanup = () => {
    stopped = true;
    incoming.off("readable", onReadable);
    incoming.off("end", onEnd);
    incoming.off("error", onError);
    incoming.off("close", onClose);
  };
  const onEnd = () => {
    if (stopped) return;
    cleanup();
    controller.close();
  };
  const onError = (error: unknown) => {
    if (stopped) return;
    cleanup();
    controller.error(error);
  };
  const onClose = () => {
    if (incoming.readableEnded) onEnd();
    else onError(new Error("Request body closed before completion"));
  };
  const onReadable = () => {
    if (stopped) return;
    try {
      const chunk: unknown = incoming.read();
      if (chunk === null) {
        if (incoming.readableEnded) onEnd();
        else incoming.once("readable", onReadable);
      } else {
        controller.enqueue(readChunk(chunk));
      }
    } catch (error) {
      onError(error);
    }
  };
  const source = {
    type: "bytes",
    start(bodyController) {
      controller = bodyController;
      incoming.once("end", onEnd);
      incoming.once("error", onError);
      incoming.once("close", onClose);
    },
    pull: onReadable,
    cancel() {
      cleanup();
      incoming.read(0);
      incoming.pause();
      incoming.socket.pause();
      outgoing.shouldKeepAlive = false;
      if (!outgoing.headersSent) outgoing.setHeader("connection", "close");
    },
  } satisfies UnderlyingByteSource;
  return new ReadableStream(source);
}

function readChunk(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  throw new TypeError("request body contained an unsupported chunk");
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  headers.delete(TRUSTED_REQUEST_ORIGIN_HEADER);
  return headers;
}

function requestOrigin(incoming: IncomingMessage, options: FetchServerOptions): string {
  if (options.canonicalRequestOrigin !== undefined) return options.canonicalRequestOrigin;
  const directProtocol = Reflect.get(incoming.socket, "encrypted") === true ? "https" : "http";
  const directHost = incoming.headers.host;
  if (options.trustedClientIpHeader === undefined) {
    return validatedOrigin(directProtocol, directHost);
  }
  const forwardedProtocol = firstForwardedValue(incoming.headers["x-forwarded-proto"]);
  const forwardedHost = firstForwardedValue(incoming.headers["x-forwarded-host"]);
  return forwardedProtocol === undefined || forwardedHost === undefined
    ? validatedOrigin(directProtocol, directHost)
    : validatedOrigin(forwardedProtocol, forwardedHost);
}

function parseHttpOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid origin");
  if (url.username !== "" || url.password !== "") throw new Error("invalid origin");
  return url.origin;
}

function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(",", 1)[0];
  const normalized = first?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function validatedOrigin(protocol: string, host: string | undefined): string {
  if (protocol !== "http" && protocol !== "https") throw new Error("invalid request protocol");
  if (host === undefined || /[\\/@\s]/u.test(host)) throw new Error("invalid request authority");
  const url = new URL(`${protocol}://${host}`);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("invalid request authority");
  }
  return url.origin;
}
