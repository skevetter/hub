import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import type { HomeSnapshot } from "./dashboard.js";

export type { HomeSnapshot } from "./dashboard.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });

export const homeSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<HomeSnapshot>> => {
    try {
      const dashboard = (await getApplication()).homeDashboard;
      if (dashboard == null) throw new Error("home dashboard unavailable");
      return respondOk(await dashboard.snapshot(getRequest(), data.organizationSlug));
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "home.snapshot", component: "home", organizationSlug: data.organizationSlug },
        { fallback: "Hub could not load this organization's activity and setup." },
      );
    }
  });

export const finishHomeSetup = createServerFn({ method: "POST" })
  .validator(scopeSchema)
  .handler(({ data }) => finishHomeSetupRequest(getRequest(), data.organizationSlug));

export const finishHomeSetupRequest = createServerOnlyFn(
  async (request: Request, organizationSlug: string): Promise<Result<{ completedAt: string }>> => {
    try {
      const dashboard = (await getApplication()).homeDashboard;
      if (dashboard == null) throw new Error("home dashboard unavailable");
      const completedAt = await dashboard.completeChecklist(request, organizationSlug);
      return respondOk({ completedAt });
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "home.finish_setup", component: "home", organizationSlug },
        {
          fallback: "Hub couldn't finish setup. Try again.",
          authentication: "Sign in again to finish setup.",
          forbidden: "Only an instance operator can finish setup.",
          notFound: "Organization unavailable.",
          conflict: "Complete every checklist step before finishing setup.",
          validation: "Reload Home and try again.",
        },
      );
    }
  },
);
