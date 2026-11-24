import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getRouter } from "../../router.js";
import {
  ErrorPage,
  homeFor,
  NotFoundPage,
  RouteErrorBoundary,
  RouteNotFound,
} from "./route-state.js";

describe("route states", () => {
  it("renders not found with a home action", () => {
    const html = renderToStaticMarkup(<NotFoundPage home="/o/acme/home" />);
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/o/acme/home"');
    expect(html).toContain("Go home");
  });

  it("uses the safe error page for every route without its own", () => {
    expect(getRouter().options.defaultErrorComponent).toBe(RouteErrorBoundary);
  });

  it("uses the shared not found page under nested layouts", () => {
    expect(getRouter().options.defaultNotFoundComponent).toBe(RouteNotFound);
  });

  it("sends home to the organization when one is in the address", () => {
    expect(homeFor(undefined)).toBe("/");
    expect(homeFor("acme corp")).toBe("/o/acme%20corp/home");
  });

  it("hides unknown errors and shows both actions", () => {
    const error = new Error("secret database message");
    error.stack = "secret stack trace";
    const html = renderToStaticMarkup(<ErrorPage error={error} home="/" retry={vi.fn()} />);
    expect(html).toContain("The page could not be loaded.");
    expect(html).toContain("Retry");
    expect(html).toContain("Go home");
    expect(html).not.toContain("secret");
  });

  it("shows an allowed message and a safe reference", () => {
    const known = renderToStaticMarkup(
      <ErrorPage error={new Error("Organization unavailable.")} home="/" retry={vi.fn()} />,
    );
    expect(known).toContain("Organization unavailable.");
    const unknown = new Error(
      "secret. If it happens again, quote reference 12345678-1234-1234-1234-123456789abc when reporting it.",
    );
    const html = renderToStaticMarkup(<ErrorPage error={unknown} home="/" retry={vi.fn()} />);
    expect(html).toContain("12345678-1234-1234-1234-123456789abc");
    expect(html).not.toContain("secret");
  });
});
