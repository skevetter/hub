import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { attachRouterServerSsrUtils } from "@tanstack/router-core/ssr/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createServerOnlyFn: (fn: unknown) => fn,
}));
const reportFailure = vi.hoisted(() => vi.fn());
vi.mock("./failures/index.js", () => ({ reportFailure }));

const { getRouter } = await import("./router.js");
const {
  installRouteErrorGuard,
  routeErrorAdapter,
  routePromiseAdapter,
  routeSerializationAdapters,
  serializedRouteMessage,
} = await import("./ssr-errors.js");

const SERIALIZATION = { serializationAdapters: routeSerializationAdapters };
const REFERENCE = "12345678-1234-1234-1234-123456789abc";

function rendered(error: unknown): Promise<string> {
  return renderedLoader(() => {
    throw error;
  });
}

function rejected(reason: unknown): Promise<never> {
  const pending = Promise.reject(reason);
  pending.catch(() => undefined);
  return pending;
}

function renderedLoader(loader: () => unknown): Promise<string> {
  const root = createRootRoute();
  const broken = createRoute({ getParentRoute: () => root, path: "/", loader });
  const router = createRouter({
    routeTree: root.addChildren([broken]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    ...SERIALIZATION,
  });
  return dehydrated(router as AnyRouter);
}

async function dehydrated(router: AnyRouter): Promise<string> {
  installRouteErrorGuard(router);
  attachRouterServerSsrUtils({ router, manifest: undefined });
  const ssr = router.serverSsr;
  if (ssr === undefined) throw new Error("server SSR utilities were not attached");
  await router.load();
  const finished = new Promise<void>((resolve) => ssr.onSerializationFinished(resolve));
  await ssr.dehydrate();
  ssr.setRenderFinished();
  await finished;
  return `${ssr.takeBufferedScripts()?.children ?? ""}${ssr.takeBufferedHtml() ?? ""}`;
}

describe("server-rendered route errors", () => {
  it("is registered on the app router", () => {
    const adapters = getRouter().options.serializationAdapters;
    expect(adapters).toContain(routeErrorAdapter);
    expect(adapters).toContain(routePromiseAdapter);
  });

  it("keeps the original message out of the page and gives a reference", async () => {
    reportFailure.mockReturnValue({ kind: "internal", requestId: REFERENCE });
    const html = await rendered(new Error('relation "secret_table" does not exist'));
    expect(html).not.toContain("secret_table");
    expect(html).toContain(`quote reference ${REFERENCE} when reporting it.`);
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it.each([
    ["a string", "SECRET_string_value"],
    ["a plain object", { message: "SECRET_object_value", code: "SECRET_code" }],
  ])("keeps %s thrown by a loader out of the page", async (_name, thrown) => {
    reportFailure.mockReturnValue({ kind: "internal", requestId: REFERENCE });
    const html = await rendered(thrown);
    expect(html).not.toContain("SECRET");
    expect(html).toContain(`quote reference ${REFERENCE} when reporting it.`);
  });

  it.each([
    ["a string", "SECRET_string_value"],
    ["a plain object", { message: "SECRET_object_value", code: "SECRET_code" }],
    ["an Error", new Error("SECRET_error_value")],
  ])("keeps a promise in loader data rejected with %s out of the page", async (_name, reason) => {
    reportFailure.mockReturnValue({ kind: "internal", requestId: REFERENCE });
    const html = await renderedLoader(() => ({ rows: [{ pending: rejected(reason) }] }));
    expect(html).not.toContain("SECRET");
    expect(html).toContain(`quote reference ${REFERENCE} when reporting it.`);
  });

  it("still delivers a promise that resolves", async () => {
    const html = await renderedLoader(() => ({ pending: Promise.resolve("visible_value") }));
    expect(html).toContain("visible_value");
  });

  it("keeps an allowed message and an existing reference", async () => {
    expect(await rendered(new Error("Organization unavailable."))).toContain(
      "Organization unavailable.",
    );
    const html = await rendered(
      new Error(
        `secret detail. If it happens again, quote reference ${REFERENCE} when reporting it.`,
      ),
    );
    expect(html).not.toContain("secret detail");
    expect(html).toContain(REFERENCE);
  });
});

describe("serializedRouteMessage", () => {
  it("reports only errors that carry no reference and no allowed message", () => {
    const report = vi.fn(() => REFERENCE);
    serializedRouteMessage(new Error("Organization unavailable."), report);
    serializedRouteMessage(new Error(`x quote reference ${REFERENCE} when reporting it.`), report);
    expect(report).not.toHaveBeenCalled();
    expect(serializedRouteMessage(new Error("boom"), report)).toBe(
      `The page could not be loaded. If it happens again, quote reference ${REFERENCE} when reporting it.`,
    );
  });
});
