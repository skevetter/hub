import type * as ReactStart from "@tanstack/react-start";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Route as LegacyAppsRoute } from "../routes/_shell/apps.js";
import { Route as InstanceAppsRoute } from "../routes/_shell/o/$organizationSlug/settings/instance/apps.js";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("../projects/context.js", () => ({
  useRouteTenant: () => ({ organization: { id: "orbit-id", slug: "orbit" } }),
}));
vi.mock("../auth/active-account.js", () => ({
  useActiveAccount: () => ({
    isInstanceOperator: false,
    organization: { id: "acme-id", slug: "acme" },
  }),
}));
vi.mock("./functions.js", () => ({ providerApplicationsOverview: () => undefined }));
vi.mock("../queries/index.js", () => ({
  useSnapshotQuery: () => ({
    status: "success",
    data: { providers: {}, callbackOrigin: "https://hub.test" },
  }),
}));
vi.mock("./provider-section.js", () => ({
  ProviderSection: ({ organizationId }: { organizationId: string }) => (
    <button type="button" data-organization-id={organizationId}>
      Connect
    </button>
  ),
  ProviderSectionLoading: () => null,
}));

it("gives provider sections the route tenant, not the default organization", async () => {
  const InstanceApps = InstanceAppsRoute.options.component!;
  const LegacyApps = LegacyAppsRoute.options.component!;
  for (const component of [InstanceApps, LegacyApps]) {
    if ("preload" in component && typeof component.preload === "function") {
      await component.preload();
    }
  }

  expect(renderToStaticMarkup(<InstanceApps />)).toContain('data-organization-id="orbit-id"');
  expect(renderToStaticMarkup(<LegacyApps />)).toContain('data-organization-id="acme-id"');
});
