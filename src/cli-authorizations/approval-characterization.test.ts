import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx } from "react/jsx-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const identity = { accountId: "account", organizationId: "organization" };
const code = "fixture-code";
const queryKey = ["cli-authorization", identity.accountId, identity.organizationId, code];

async function render(client: QueryClient, search: string | undefined): Promise<string> {
  const name = "approval";
  const entry = z.object({
    CliLoginApproval: z.custom<ComponentType<typeof identity>>(
      (value) => typeof value === "function",
    ),
  });
  const { CliLoginApproval } = entry.parse(await import(`./${name}.tsx`));
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (search !== undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search } },
    });
  }
  try {
    return renderToStaticMarkup(
      jsx(RouterContextProvider, {
        router,
        children: createElement(
          QueryClientProvider,
          { client },
          createElement(CliLoginApproval, identity),
        ),
      }),
    );
  } finally {
    if (oldWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", oldWindow);
  }
}

describe("CLI login approval", () => {
  it("prompts for the code without a browser URL and loads when a code is present", async () => {
    const entry = await render(new QueryClient(), undefined);
    expect(entry).toContain('name="code"');
    expect(entry).not.toContain('value="approve"');
    const loading = await render(new QueryClient(), `?code=${code}`);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('value="approve"');
  });

  it("only offers approve and deny for a manageable request", async () => {
    for (const canManage of [false, true]) {
      const client = new QueryClient();
      client.setQueryData(queryKey, {
        canManage,
        expiresAt: "2099-01-01T00:00:00Z",
        organization: { id: "target", name: "Fixture target", slug: "target" },
      });
      const html = await render(client, `?code=${code}`);
      expect(html).toContain("Fixture target");
      expect(html.includes('value="approve"')).toBe(canManage);
      expect(html.includes('value="deny"')).toBe(canManage);
      expect(html.includes("Approval required")).toBe(!canManage);
    }
  });
});
