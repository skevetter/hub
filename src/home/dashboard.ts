import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import type {
  Database,
  OrganizationConnectionUsage,
  OrganizationRunRecord,
  DroppedProviderEventCount,
} from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { projectTriggerForm } from "../triggers/configuration/editor.js";
import { deriveChecklist } from "./checklist.js";

/** How far back the overview looks. One week is long enough to hold a first run and short enough that a nudge fades once a trigger listens. */
export const HOME_WINDOW_DAYS = 7;
const RUNS_SHOWN = 50;

export interface HomeSnapshot {
  organization: { id: string; name: string; slug: string };
  checklistCompletedAt: string | null;
  /** Whether any provider app (GitHub, Slack, Discord, Linear) is set up on this Hub at all. */
  appsConfigured: boolean;
  connections: readonly {
    provider: "github" | "slack" | "discord" | "linear";
    slug: string;
    label: string;
  }[];
  daemons: readonly {
    id: string;
    slug: string;
    presence: "offline" | "connected";
    /** Enrolled with `hub.execute`; without it Hub can see the daemon but launch nothing on it. */
    canExecute: boolean;
  }[];
  triggers: readonly { id: string; name: string; event: string; enabled: boolean }[];
  runs: readonly (Omit<OrganizationRunRecord, "receivedAt"> & { receivedAt: string })[];
  dropped: readonly DroppedProviderEventCount[];
  windowDays: number;
}

export class HomeDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    /**
     * Whether any provider app is configured, answered by the same registrations the
     * connections status reads; a self-hosted Hub with none has nothing to connect yet.
     */
    private readonly providerAppsConfigured: (bindings: OrganizationConnectionUsage) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async snapshot(request: Request, organizationSlug: string): Promise<HomeSnapshot> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    return this.readSnapshot(tenant.organization);
  }

  async completeChecklist(request: Request, organizationSlug: string): Promise<string> {
    if (this.auth.rejectCookieMutation(request, { requireOrigin: true }) !== undefined)
      throw new ProductRequestError(400, "invalid_origin");
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!account.isInstanceOperator) throw new ProductRequestError(403, "forbidden");

    const { organization } = tenant;
    const completedAt = await this.database.getHomeChecklistCompletedAt(organization.id);
    if (completedAt !== null) return completedAt.toISOString();

    const snapshot = await this.readSnapshot(organization);
    if (snapshot.checklistCompletedAt !== null) return snapshot.checklistCompletedAt;
    if (!deriveChecklist(snapshot).complete)
      throw new ProductRequestError(409, "checklist_incomplete");
    return (await this.database.completeHomeChecklist(organization.id)).toISOString();
  }

  private async readSnapshot(organization: HomeSnapshot["organization"]): Promise<HomeSnapshot> {
    const organizationId = organization.id;
    const since = new Date(this.now().getTime() - HOME_WINDOW_DAYS * 86_400_000);
    const triggers = await this.database.listOrganizationTriggers(organizationId);
    const [connections, daemons, revisions, runs, dropped, checklistCompletedAt] =
      await Promise.all([
        this.database.organizationConnectionUsage(organizationId),
        this.database.listDaemonsForOrganization(organizationId),
        Promise.all(
          triggers.map((trigger) =>
            this.database.findOrganizationTriggerRevision(trigger.id, trigger.activeRevisionId),
          ),
        ),
        this.database.listOrganizationRunsSince(organizationId, since, RUNS_SHOWN),
        this.database.countRecentDroppedEvents(organizationId, since),
        this.database.getHomeChecklistCompletedAt(organizationId),
      ]);
    return {
      organization,
      checklistCompletedAt: checklistCompletedAt?.toISOString() ?? null,
      appsConfigured: this.providerAppsConfigured(connections),
      connections: [
        ...connections.github.map(({ slug, accountLogin }) => ({
          provider: "github" as const,
          slug,
          label: accountLogin,
        })),
        ...connections.slack.map(({ slug, teamName }) => ({
          provider: "slack" as const,
          slug,
          label: teamName,
        })),
        ...connections.discord.map(({ slug, guildName }) => ({
          provider: "discord" as const,
          slug,
          label: guildName,
        })),
        ...connections.linear.map(({ slug, linearOrganizationName }) => ({
          provider: "linear" as const,
          slug,
          label: linearOrganizationName,
        })),
      ],
      daemons: daemons
        .filter(({ status }) => status === "active")
        .map(({ id, slug, presence, permissions }) => ({
          id,
          slug,
          presence,
          canExecute: permissions.includes("hub.execute"),
        })),
      triggers: triggers.map((trigger, index) => ({
        id: trigger.id,
        name: trigger.name,
        event: triggerEvent(revisions[index]?.yaml),
        enabled: trigger.enabled,
      })),
      runs: runs.map((run) => ({
        id: run.id,
        triggerName: run.triggerName,
        provider: run.provider,
        source: run.source,
        status: run.status,
        receivedAt: run.receivedAt.toISOString(),
        agent: run.agent,
      })),
      dropped,
      windowDays: HOME_WINDOW_DAYS,
    };
  }
}

/** The one event a self-contained trigger listens for; a legacy document has none to name. */
function triggerEvent(yaml: string | undefined): string {
  if (yaml === undefined) return "manual.run";
  const projection = projectTriggerForm(yaml);
  return projection.status === "editable" ? projection.value.event : "manual.run";
}
