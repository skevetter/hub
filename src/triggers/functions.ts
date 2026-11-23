import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { classifyFailure, respondWithFailure } from "../failures/index.js";
import type { BrowserStopResult } from "./run-stop.js";
import { getApplication } from "../server/runtime.js";
import { PAGE_SIZES } from "../components/app/page-size.js";
import { activityFiltersSchema, droppedActivityFiltersSchema } from "./activity-query.js";
import { triggerSearchSchema } from "./trigger-query.js";
import type { TriggerDashboard } from "./dashboard.js";
import { isTenantRouteNotFoundError } from "../projects/access.js";

import type { RunDetailSnapshot, RunEventPage } from "./run-events.js";
const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });
const saveSchema = scopeSchema.extend({
  triggerId: z.uuid().optional(),
  yaml: z.string().min(1),
});

const runScopeSchema = scopeSchema.extend({ runId: z.uuid() });

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
      retryAttemptId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data }): Promise<Result<BrowserStopResult>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      const result = await dashboard.stopRun({
        request: getRequest(),
        organizationSlug: data.organizationSlug,
        runId: data.runId,
        confirmedPeerCount: data.confirmedPeerCount,
        retryAttemptId: data.retryAttemptId,
      });
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

export const runManualTrigger = createServerFn({ method: "POST" })
  .validator(
    scopeSchema.extend({
      triggerId: z.uuid(),
      deliveryKey: z.uuid(),
      input: z.unknown().optional(),
    }),
  )
  .handler(async ({ data }) => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) return manualRunError("infrastructure_unavailable");
      const result = await dashboard.runManualTrigger(getRequest(), data);
      if (result.status === "dispatched") return respondOk({ runId: result.triggerRunId });
      return manualRunError(
        result.status,
        result.status === "invalid_input" ? result.issues : undefined,
      );
    } catch (error) {
      if (isTenantRouteNotFoundError(error)) return manualRunError("trigger_not_found");
      const failure = classifyFailure(error);
      if (failure === "authentication") return manualRunError("unauthenticated");
      if (failure === "forbidden") return manualRunError("forbidden");
      setResponseStatus(500);
      return respondWithFailure(error, triggerContext("run.manual", data.organizationSlug), {
        fallback: "Hub couldn't start this run.",
      });
    }
  });

const manualRunErrors = {
  project_not_found: [404, "This trigger is unavailable."],
  configuration_not_found: [404, "This trigger is unavailable."],
  trigger_not_found: [404, "This trigger is unavailable."],
  unauthenticated: [401, "Sign in to start this trigger."],
  forbidden: [403, "This request cannot start a run."],
  actor_forbidden: [403, "This trigger doesn't allow your account."],
  key_actor_required: [403, "This trigger requires an API key with a bound actor."],
  invalid_input: [422, "Check the trigger inputs and try again."],
  expected_configuration_not_current: [409, "This trigger changed. Refresh and try again."],
  dispatch_conflict: [409, "Hub couldn't start this run. Retry the same request."],
  daemon_offline: [409, "The selected daemon is offline."],
  infrastructure_unavailable: [503, "Run now is unavailable."],
} as const;

function manualRunError(
  code: keyof typeof manualRunErrors,
  issues?: readonly { path: readonly (string | number)[]; message: string }[],
) {
  const [status, message] = manualRunErrors[code];
  setResponseStatus(status);
  return {
    ...respondError({ message }),
    error: { code, message, ...(issues === undefined ? {} : { issues }) },
  };
}

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

export const triggerListPage = createServerFn({ method: "GET" })
  .validator(scopeSchema.extend(triggerSearchSchema.shape))
  .handler(async ({ data: { organizationSlug, ...search } }): Promise<Result<TriggerListPage>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.triggerPage(getRequest(), organizationSlug, search));
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.list", organizationSlug), {
        fallback: "Hub couldn't load this organization's triggers. Reload the page.",
      });
    }
  });

export const triggerEditorSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema.extend({ triggerId: z.string() }))
  .handler(async ({ data }): Promise<Result<TriggerSnapshot>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(
        await dashboard.editorSnapshot(getRequest(), data.organizationSlug, data.triggerId),
      );
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.editor", data.organizationSlug), {
        fallback: "Hub couldn't load this trigger. Reload the page.",
      });
    }
  });

const activityPageSchema = scopeSchema.extend(activityFiltersSchema.shape).extend({
  limit: z.number().int().min(1).max(PAGE_SIZES[3]).optional(),
  cursor: z.string().optional(),
});

export const triggerActivityPage = createServerFn({ method: "GET" })
  .validator(activityPageSchema)
  .handler(
    async ({ data: { organizationSlug, ...input } }): Promise<Result<TriggerActivityPage>> => {
      try {
        const dashboard = (await getApplication()).triggerDashboard;
        if (dashboard == null) throw new Error("trigger dashboard unavailable");
        return respondOk(await dashboard.activityPage(getRequest(), organizationSlug, input));
      } catch (error) {
        return respondWithFailure(error, triggerContext("activity.list", organizationSlug), {
          fallback: "Hub couldn't load trigger activity.",
        });
      }
    },
  );

export const droppedActivityPage = createServerFn({ method: "GET" })
  .validator(
    scopeSchema.extend(droppedActivityFiltersSchema.shape).extend({
      limit: z.number().int().min(1).max(PAGE_SIZES[3]).optional(),
      cursor: z.string().optional(),
    }),
  )
  .handler(
    async ({ data: { organizationSlug, ...input } }): Promise<Result<DroppedActivityPage>> => {
      try {
        const dashboard = (await getApplication()).triggerDashboard;
        if (dashboard == null) throw new Error("trigger dashboard unavailable");
        return respondOk(
          await dashboard.droppedActivityPage(getRequest(), organizationSlug, input),
        );
      } catch (error) {
        return respondWithFailure(error, triggerContext("activity.dropped", organizationSlug), {
          fallback: "Hub couldn't load dropped events.",
        });
      }
    },
  );

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
export type TriggerListPage = Awaited<ReturnType<TriggerDashboard["triggerPage"]>>;
export type DroppedActivityPage = Awaited<ReturnType<TriggerDashboard["droppedActivityPage"]>>;
export type TriggerActivityPage = Awaited<ReturnType<TriggerDashboard["activityPage"]>>;

function triggerContext(operation: string, organizationSlug: string) {
  return { operation, component: "triggers", organizationSlug } as const;
}
