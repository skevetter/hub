import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import type { SessionPrincipal } from "../interactive-sessions/types.js";
import type {
  Database,
  OrganizationConnectionUsage,
  OrganizationRunCount,
  OrganizationRunRecord,
  DroppedProviderEventCount,
} from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import { hasRequiredSlackScopes } from "../providers/slack/client.js";
import { projectTriggerForm } from "../triggers/configuration/editor.js";
import { deriveChecklist } from "./checklist.js";
import { HOME_MONTH_DAYS, HOME_OPEN_SESSIONS_LIMIT } from "./limits.js";

/** How far back the overview looks. One week is long enough to hold a first run and short enough that a nudge fades once a trigger listens. */
export const HOME_WINDOW_DAYS = 7;
const RUNS_SHOWN = 50;
const DAY_MS = 86_400_000;

export interface RunTally {
  total: number;
  succeeded: number;
  failed: number;
}

/** What the reader can see of interactive sessions; absent when the feature is off. */
export interface HomeSessions {
  /** Profiles a session can start from. */
  profiles: number;
  /** Sessions the reader takes part in that are not closed. */
  open: number;
  openCapped: boolean;
  /** Whether the reader has ever taken part in a session, open or not. */
  started: boolean;
}

export interface HomeSnapshot {
  organization: { id: string; name: string; slug: string };
  checklistCompletedAt: string | null;
  /** Whether any provider app (GitHub, Slack, Discord, Linear) is set up on this Hub at all. */
  appsConfigured: boolean;
  connections: readonly {
    provider: "github" | "slack" | "discord" | "linear";
    slug: string;
    label: string;
    /** The grant no longer covers what Hub needs, or the provider suspended it. */
    needsAuthorization: boolean;
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
  /** Every run in the last 24 hours and the last `HOME_MONTH_DAYS` days, not only the ones listed. */
  runCounts: { day: RunTally; month: RunTally };
  sessions: HomeSessions | null;
  dropped: readonly DroppedProviderEventCount[];
  windowDays: number;
}

export interface HomeDashboardOptions {
  now?: () => Date;
  /** Whether this Hub runs interactive sessions at all. */
  interactiveSessions?: boolean;
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
    private readonly options: HomeDashboardOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async snapshot(request: Request, organizationSlug: string): Promise<HomeSnapshot> {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    return this.readSnapshot(tenant.organization, readerOf(tenant, account.account.id));
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

    const snapshot = await this.readSnapshot(organization, readerOf(tenant, account.account.id));
    if (snapshot.checklistCompletedAt !== null) return snapshot.checklistCompletedAt;
    if (!deriveChecklist(snapshot).complete)
      throw new ProductRequestError(409, "checklist_incomplete");
    return (await this.database.completeHomeChecklist(organization.id)).toISOString();
  }

  private async readSnapshot(
    organization: HomeSnapshot["organization"],
    reader: SessionPrincipal,
  ): Promise<HomeSnapshot> {
    const organizationId = organization.id;
    const now = this.now().getTime();
    const since = new Date(now - HOME_WINDOW_DAYS * DAY_MS);
    const triggers = await this.database.listOrganizationTriggers(organizationId);
    const [
      connections,
      daemons,
      revisions,
      runs,
      dayRuns,
      monthRuns,
      sessions,
      dropped,
      checklistCompletedAt,
    ] = await Promise.all([
      this.database.organizationConnectionUsage(organizationId),
      this.database.listDaemonsForOrganization(organizationId),
      Promise.all(
        triggers.map((trigger) =>
          this.database.findOrganizationTriggerRevision(trigger.id, trigger.activeRevisionId),
        ),
      ),
      this.database.listOrganizationRunsSince(organizationId, since, RUNS_SHOWN),
      this.database.countOrganizationRunsSince(organizationId, new Date(now - DAY_MS)),
      this.database.countOrganizationRunsSince(
        organizationId,
        new Date(now - HOME_MONTH_DAYS * DAY_MS),
      ),
      this.readSessions(reader),
      this.database.countRecentDroppedEvents(organizationId, since),
      this.database.getHomeChecklistCompletedAt(organizationId),
    ]);
    return {
      organization,
      checklistCompletedAt: checklistCompletedAt?.toISOString() ?? null,
      appsConfigured: this.providerAppsConfigured(connections),
      connections: [
        ...connections.github.map(({ slug, accountLogin, status }) => ({
          provider: "github" as const,
          slug,
          label: accountLogin,
          needsAuthorization: status === "suspended",
        })),
        ...connections.slack.map(({ slug, teamName, scopes }) => ({
          provider: "slack" as const,
          slug,
          label: teamName,
          needsAuthorization: !hasRequiredSlackScopes(scopes),
        })),
        ...connections.discord.map(({ slug, guildName }) => ({
          provider: "discord" as const,
          slug,
          label: guildName,
          needsAuthorization: false,
        })),
        ...connections.linear.map((connection) => ({
          provider: "linear" as const,
          slug: connection.slug,
          label: connection.linearOrganizationName,
          needsAuthorization: linearConnectionRequiresReauthorization(connection),
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
      runCounts: { day: tally(dayRuns), month: tally(monthRuns) },
      sessions,
      dropped,
      windowDays: HOME_WINDOW_DAYS,
    };
  }

  /**
   * Sessions are visible to their participants only, so these are the reader's own numbers. The
   * second list is asked only when nothing is open: an open session already proves one exists.
   */
  private async readSessions(reader: SessionPrincipal): Promise<HomeSessions | null> {
    if (this.options.interactiveSessions !== true) return null;
    const [profiles, open] = await Promise.all([
      this.database.listSessionProfiles(reader.organizationId),
      this.database.listInteractiveSessions(reader.organizationId, reader, {
        filter: "active",
        cursor: null,
        limit: HOME_OPEN_SESSIONS_LIMIT,
      }),
    ]);
    const started =
      open.sessions.length > 0 ||
      (
        await this.database.listInteractiveSessions(reader.organizationId, reader, {
          filter: "all",
          cursor: null,
          limit: 1,
        })
      ).sessions.length > 0;
    return {
      profiles: profiles.filter(({ status }) => status === "active").length,
      open: open.sessions.length,
      openCapped: open.nextCursor !== null,
      started,
    };
  }
}

function readerOf(
  tenant: { organization: { id: string }; membership: { role: SessionPrincipal["role"] } },
  userId: string,
): SessionPrincipal {
  return { organizationId: tenant.organization.id, userId, role: tenant.membership.role };
}

const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out", "rejected"]);

function tally(counts: readonly OrganizationRunCount[]): RunTally {
  const result = { total: 0, succeeded: 0, failed: 0 };
  for (const { status, count } of counts) {
    result.total += count;
    if (status === "succeeded") result.succeeded += count;
    else if (FAILED_RUN_STATUSES.has(status)) result.failed += count;
  }
  return result;
}

/** The one event a self-contained trigger listens for; a legacy document has none to name. */
function triggerEvent(yaml: string | undefined): string {
  if (yaml === undefined) return "manual.run";
  const projection = projectTriggerForm(yaml);
  return projection.status === "editable" ? projection.value.event : "manual.run";
}
