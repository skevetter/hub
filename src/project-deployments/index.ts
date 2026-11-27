import { ProjectSlugConflictError } from "../db/errors.js";
import type { Database, ProjectRecord } from "../db/types.js";

export type DeploymentProjectResolution =
  | { status: "resolved"; project: ProjectRecord; created: boolean }
  | { status: "would_create"; projectSlug: string }
  | { status: "project_not_found" };

/** Resolves the project targeted by one configuration deployment, including race-safe upsert. */
export class DeploymentProjects {
  constructor(private readonly database: Database) {}

  async resolve(input: {
    organizationId: string;
    explicitProjectSlug?: string | undefined;
    bundleName?: string | undefined;
    dryRun: boolean;
  }): Promise<DeploymentProjectResolution> {
    if (input.explicitProjectSlug !== undefined) {
      const project = await this.findActive(input.organizationId, input.explicitProjectSlug);
      return project === undefined
        ? { status: "project_not_found" }
        : { status: "resolved", project, created: false };
    }

    const projectSlug = input.bundleName ?? "default";
    const existing = await this.database.findProjectBySlugForOrganization(
      input.organizationId,
      projectSlug,
    );
    if (existing !== undefined) {
      if (existing.status === "active" || input.dryRun) {
        return { status: "resolved", project: existing, created: false };
      }
    } else if (input.dryRun) return { status: "would_create", projectSlug };

    return this.database.withAdvisoryLock(
      projectLock(input.organizationId, projectSlug),
      async () => {
        const raced = await this.database.findProjectBySlugForOrganization(
          input.organizationId,
          projectSlug,
        );
        if (raced !== undefined) return this.resolveExisting(raced);
        return this.createOrResolve(input.organizationId, projectSlug);
      },
    );
  }

  /** A writer outside the lock can take the slug between the check and the insert. */
  private async createOrResolve(
    organizationId: string,
    projectSlug: string,
  ): Promise<DeploymentProjectResolution> {
    try {
      const project = await this.database.createProject({
        organizationId,
        name: projectSlug,
        slug: projectSlug,
        createdByUserId: null,
      });
      return { status: "resolved", project, created: true };
    } catch (error) {
      if (!(error instanceof ProjectSlugConflictError)) throw error;
      const existing = await this.database.findProjectBySlugForOrganization(
        organizationId,
        projectSlug,
      );
      if (existing === undefined) throw error;
      return this.resolveExisting(existing);
    }
  }

  private async resolveExisting(existing: ProjectRecord): Promise<DeploymentProjectResolution> {
    const project =
      existing.status === "active"
        ? existing
        : await this.database.restoreProject(existing.organizationId, existing.id);
    return { status: "resolved", project, created: false };
  }

  private async findActive(
    organizationId: string,
    projectSlug: string,
  ): Promise<ProjectRecord | undefined> {
    const project = await this.database.findProjectBySlugForOrganization(
      organizationId,
      projectSlug,
    );
    return project?.status === "active" ? project : undefined;
  }
}

function projectLock(organizationId: string, projectSlug: string): string {
  return `deployment-project:${JSON.stringify([organizationId, projectSlug])}`;
}
