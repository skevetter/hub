import { expect, it, vi } from "vitest";
import {
  classifyFailure,
  failureWasReported,
  reportFailure,
  runWithFailureTracking,
} from "./index.js";

it("classifies by status, code or reason, error name, then direct cause", () => {
  const error = new Error("opaque", { cause: { code: "ETIMEDOUT" } });
  error.name = "NotFoundError";
  expect(classifyFailure(error)).toBe("notFound");
  expect(classifyFailure(Object.assign(error, { reason: "network" }))).toBe("network");
  expect(classifyFailure(Object.assign(error, { code: "unknown" }))).toBe("notFound");
  expect(classifyFailure(Object.assign(error, { status: 401 }))).toBe("authentication");
  expect(classifyFailure(error, 429)).toBe("rateLimited");
  expect(classifyFailure(error, 200)).toBe("notFound");
  expect(classifyFailure(new Error("opaque", { cause: { code: "ETIMEDOUT" } }))).toBe("timeout");
  expect(classifyFailure(new Error("opaque", { cause: { code: "unmapped" } }))).toBe("internal");
  expect(classifyFailure("opaque")).toBe("internal");
});

it("logs ordered structured context once for the same object and tracks repeats per request", () => {
  const requestLogger = {
    warn: vi.fn<(record?: object, message?: string) => void>(),
    error: vi.fn(),
  };
  const logger = { warn: vi.fn<(record?: object, message?: string) => void>(), error: vi.fn() };
  const context = { operation: "load", component: "service", requestId: "request", status: 500 };
  const failure = { status: 401 };
  const report = runWithFailureTracking(() => {
    const reported = reportFailure(failure, context, {
      logger,
      kind: "validation",
      status: 400,
      scrubValues: ["test-value"],
      diagnostic: { sample: "test-value", visible: "ok" },
    });
    expect(failureWasReported()).toBe(true);
    return reported;
  }, requestLogger);
  expect(failureWasReported()).toBe(false);
  expect(JSON.stringify(report)).toBe('{"kind":"validation","requestId":"request"}');
  expect(logger.warn.mock.calls.length).toBe(1);
  const [record, message] = logger.warn.mock.calls[0] ?? [];
  expect(Object.keys(record ?? {})).toEqual([
    "err",
    "failureKind",
    "requestId",
    "operation",
    "component",
    "status",
    "diagnostic",
  ]);
  expect(message).toBe("load failed");
  expect(record).toEqual({
    err: new Error("non-Error failure"),
    failureKind: "validation",
    requestId: "request",
    operation: "load",
    component: "service",
    status: 400,
    diagnostic: { sample: "[Redacted]", visible: "ok" },
  });
  runWithFailureTracking(() => {
    expect(reportFailure(failure, context)).toBe(report);
    expect(failureWasReported()).toBe(true);
    reportFailure("opaque", context);
  }, requestLogger);
  expect(requestLogger.warn.mock.calls.length).toBe(0);
  expect(requestLogger.error.mock.calls.length).toBe(1);
});
