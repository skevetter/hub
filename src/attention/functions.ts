import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import type { AttentionSnapshot } from "./contract.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });

export const attentionSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(({ data }) => attentionSnapshotRequest(getRequest(), data.organizationSlug));

export const markFailedRunsSeen = createServerFn({ method: "POST" })
  .validator(scopeSchema)
  .handler(({ data }) => markFailedRunsSeenRequest(getRequest(), data.organizationSlug));

export const attentionSnapshotRequest = createServerOnlyFn(
  async (request: Request, organizationSlug: string): Promise<Result<AttentionSnapshot>> => {
    try {
      const dashboard = (await getApplication()).attentionDashboard;
      if (dashboard == null) throw new Error("attention dashboard unavailable");
      return respondOk(await dashboard.snapshot(request, organizationSlug));
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "attention.snapshot", component: "attention", organizationSlug },
        { fallback: "Attention could not load.", notFound: "Organization unavailable." },
      );
    }
  },
);

export const markFailedRunsSeenRequest = createServerOnlyFn(
  async (request: Request, organizationSlug: string): Promise<Result<null>> => {
    try {
      const dashboard = (await getApplication()).attentionDashboard;
      if (dashboard == null) throw new Error("attention dashboard unavailable");
      await dashboard.markFailedRunsSeen(request, organizationSlug);
      return respondOk(null);
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "attention.mark_failed_runs_seen", component: "attention", organizationSlug },
        {
          fallback: "Hub could not mark runs as seen. Try again.",
          notFound: "Organization unavailable.",
        },
      );
    }
  },
);
