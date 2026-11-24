import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { getApplication } from "../server/runtime.js";
import { respondWithFailure } from "../failures/index.js";
import { isTenantRouteNotFoundError } from "./access.js";
import { ProjectCommandError } from "./command-error.js";
import { ORGANIZATION_UNAVAILABLE, PROJECT_UNAVAILABLE } from "./unavailable.js";
import type { ProjectDashboard } from "./dashboard.js";

const organizationScopeSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
  .strict();

export const tenantContext = createServerFn({ method: "GET" })
  .validator(
    organizationScopeSchema.extend({ projectSlug: z.string().trim().min(1).max(100).optional() }),
  )
  .handler(
    async ({ data }): Promise<Result<Awaited<ReturnType<ProjectDashboard["tenantContext"]>>>> =>
      read(data, (dashboard) => dashboard.tenantContext(getRequest(), data)),
  );

export const organizationSnapshot = createServerFn({ method: "GET" })
  .validator(organizationScopeSchema)
  .handler(
    async ({
      data,
    }): Promise<Result<Awaited<ReturnType<ProjectDashboard["organizationSnapshot"]>>>> =>
      read(data, (dashboard) => dashboard.organizationSnapshot(getRequest(), data)),
  );

async function read<T>(
  scope: { organizationSlug: string; projectSlug?: string | undefined },
  operation: (dashboard: ProjectDashboard) => Promise<T>,
): Promise<Result<T>> {
  try {
    return respondOk(await operation(await requireDashboard()));
  } catch (error) {
    const message = readUnavailableMessage(error, scope.projectSlug !== undefined);
    return respondWithFailure(error, projectFailureContext("project.read", scope), {
      fallback: message,
      notFound: message,
      forbidden: message,
    });
  }
}

function projectFailureContext(
  operation: string,
  scope: { organizationSlug: string; projectSlug?: string | undefined },
) {
  return {
    operation,
    component: "projects",
    organizationSlug: scope.organizationSlug,
    ...(scope.projectSlug === undefined ? {} : { projectSlug: scope.projectSlug }),
  } as const;
}

async function requireDashboard(): Promise<ProjectDashboard> {
  return (await getApplication()).projectDashboard ?? unavailable();
}

function unavailable(): never {
  throw new ProjectCommandError("dashboard_unavailable");
}

export function readUnavailableMessage(error: unknown, projectScoped: boolean): string {
  if (isTenantRouteNotFoundError(error)) {
    return projectScoped ? PROJECT_UNAVAILABLE : ORGANIZATION_UNAVAILABLE;
  }
  return projectScoped
    ? "Hub couldn't load this project's configuration. Reload the page to try again."
    : "Hub couldn't load this organization. Reload the page to try again.";
}
