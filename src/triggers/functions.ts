import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import type { BrowserStopResult } from "./run-stop.js";
import { getApplication } from "../server/runtime.js";
import { ACTIVITY_PAGE_SIZE_MAX } from "./activity-cursor.js";
import type { TriggerDashboard } from "./dashboard.js";

import type { RunDetailSnapshot, RunEventPage } from "./run-events.js";
const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });
const saveSchema = scopeSchema.extend({
  triggerId: z.string().uuid().optional(),
  yaml: z.string().min(1),
});

const runScopeSchema = scopeSchema.extend({ runId: z.string().uuid() });

export const runDetailSnapshot = createServerFn({ method: "GET" })
  .validator(runScopeSchema)
  .handler(async ({ data }): Promise<Result<RunDetailSnapshot | null>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.runDetail(getRequest(), data.organizationSlug, data.runId));
    } catch (error) {
      return respondWithFailure(error, triggerContext("run.detail", data.organizationSlug), {
        fallback: "Hub couldn't load this run.",
      });
    }
  });

export const stopRun = createServerFn({ method: "POST" })
  .validator(
    runScopeSchema.extend({
      confirmedPeerCount: z.number().int().nonnegative(),
      retryAttemptId: z.string().uuid().optional(),
    }),
  )
  .handler(async ({ data }): Promise<Result<BrowserStopResult>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      const result = await dashboard.stopRun(
        getRequest(),
        data.organizationSlug,
        data.runId,
        data.confirmedPeerCount,
        data.retryAttemptId,
      );
      if (result.status === "stopped") return respondOk(result);
      if (result.status === "conflict") {
        setResponseStatus(409);
        return respondOk(result);
      }
      setResponseStatus(result.status === "forbidden" ? 403 : 404);
      return respondError({
        message:
          result.status === "forbidden"
            ? "You don't have permission to stop this run."
            : "This run is unavailable.",
      });
    } catch (error) {
      return respondWithFailure(error, triggerContext("run.stop", data.organizationSlug), {
        fallback: "Hub couldn't stop this run.",
      });
    }
  });

export const runEventsSnapshot = createServerFn({ method: "GET" })
  .validator(runScopeSchema.extend({ after: z.number().int().nonnegative() }))
  .handler(async ({ data }): Promise<Result<RunEventPage | null>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(
        await dashboard.runEvents(getRequest(), data.organizationSlug, data.runId, data.after),
      );
    } catch (error) {
      return respondWithFailure(error, triggerContext("run.events", data.organizationSlug), {
        fallback: "Hub couldn't load this run.",
      });
    }
  });

export const triggerSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<TriggerSnapshot>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.snapshot(getRequest(), data.organizationSlug));
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.list", data.organizationSlug), {
        fallback: "Hub couldn't load this organization's triggers. Reload the page.",
      });
    }
  });

const activityPageSchema = scopeSchema.extend({
  limit: z.number().int().min(1).max(ACTIVITY_PAGE_SIZE_MAX).optional(),
  cursor: z.string().optional(),
});

export const triggerActivityPage = createServerFn({ method: "GET" })
  .validator(activityPageSchema)
  .handler(async ({ data }): Promise<Result<TriggerActivityPage>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(
        await dashboard.activityPage(getRequest(), data.organizationSlug, {
          ...(data.limit === undefined ? {} : { limit: data.limit }),
          ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
        }),
      );
    } catch (error) {
      return respondWithFailure(error, triggerContext("activity.list", data.organizationSlug), {
        fallback: "Hub couldn't load trigger activity.",
      });
    }
  });

export const saveTrigger = createServerFn({ method: "POST" })
  .validator(saveSchema)
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      await dashboard.save(getRequest(), data.organizationSlug, {
        ...(data.triggerId === undefined ? {} : { triggerId: data.triggerId }),
        yaml: data.yaml,
      });
      return respondOk({ state: "complete" });
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.save", data.organizationSlug), {
        fallback: error instanceof Error ? error.message : "Hub couldn't save this trigger.",
        forbidden: "You don't have permission to manage triggers.",
        validation: error instanceof Error ? error.message : "This trigger is invalid.",
        conflict: "A trigger with this name already exists.",
      });
    }
  });

export type TriggerSnapshot = Awaited<ReturnType<TriggerDashboard["snapshot"]>>;
export type TriggerActivityPage = Awaited<ReturnType<TriggerDashboard["activityPage"]>>;

function triggerContext(operation: string, organizationSlug: string) {
  return { operation, component: "triggers", organizationSlug } as const;
}
