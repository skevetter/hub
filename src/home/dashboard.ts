import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import { isScriptStep, parseCompiledHubConfig, type CompiledTrigger } from "../config/compiler.js";
import type { SessionPrincipal } from "../interactive-sessions/types.js";
import type {
  Database,
  OrganizationConnectionUsage,
  OrganizationRunCount,
  OrganizationRunRecord,
  DroppedProviderEventCount,
  OrganizationTriggerRevisionRecord,
} from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import { hasRequiredSlackScopes } from "../providers/slack/client.js";
import { projectTriggerForm } from "../triggers/configuration/editor.js";
import { matchGitHubInvocations } from "../triggers/github/match.js";
import { matchLinearInvocations } from "../triggers/linear/match.js";
import { canFinishSetup } from "./checklist.js";
import { HOME_MONTH_DAYS, HOME_OPEN_SESSIONS_LIMIT } from "./limits.js";
import { commentExamples, isTryCommentEvent } from "./things-to-try.js";

/** How far back the overview looks. One week is long enough to hold a first run and short enough that a nudge fades once a trigger listens. */
export const HOME_WINDOW_DAYS = 7;
const RUNS_SHOWN = 50;
const DAY_MS = 86_400_000;

export interface RunTally {
  total: number;
  succeeded: number;
  failed: number;
}

/** Session profiles and the reader's own sessions; absent when the feature is off. */
export interface HomeSessions {
  /** Profiles a session can start from. */
  profiles: number;
  /** Open sessions the reader started or participates in, up to the Home limit. */
  open: number;
  openCapped: boolean;
  /** Whether the reader started or participates in any session, open or closed. */
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
  triggers: readonly {
    id: string;
    name: string;
    event: string;
    enabled: boolean;
    hasReplyOutput?: boolean;
    /** Text to put before an example. Null means the reader must evaluate the filters. */
    commentPrefix?: string | null;
  }[];
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

    const snapshot = await this.readSnapshot(organization, null);
    if (snapshot.checklistCompletedAt !== null) return snapshot.checklistCompletedAt;
    if (!canFinishSetup(snapshot)) throw new ProductRequestError(409, "checklist_incomplete");
    return (await this.database.completeHomeChecklist(organization.id)).toISOString();
  }

  private async readSnapshot(
    organization: HomeSnapshot["organization"],
    reader: SessionPrincipal | null,
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
      reader === null
        ? []
        : this.database.countOrganizationRunsSince(organizationId, new Date(now - DAY_MS)),
      reader === null
        ? []
        : this.database.countOrganizationRunsSince(
            organizationId,
            new Date(now - HOME_MONTH_DAYS * DAY_MS),
          ),
      reader === null ? null : this.readSessions(reader),
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
      triggers: triggers.map((trigger, index) =>
        Object.assign(
          { id: trigger.id, name: trigger.name, enabled: trigger.enabled },
          triggerFacts(revisions[index], trigger.format, connections),
        ),
      ),
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

  private async readSessions(reader: SessionPrincipal): Promise<HomeSessions | null> {
    if (this.options.interactiveSessions !== true) return null;
    const [profiles, own] = await Promise.all([
      this.database.listSessionProfiles(reader.organizationId),
      this.database.countOwnInteractiveSessions(reader, HOME_OPEN_SESSIONS_LIMIT),
    ]);
    return {
      profiles: profiles.filter(({ status }) => status === "active").length,
      ...own,
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

function triggerFacts(
  revision: OrganizationTriggerRevisionRecord | undefined,
  format: "single_run" | "legacy_multistep",
  connections: OrganizationConnectionUsage,
): Pick<HomeSnapshot["triggers"][number], "event" | "hasReplyOutput" | "commentPrefix"> {
  if (revision === undefined) return { event: "manual.run" };
  const projection = projectTriggerForm(revision.yaml);
  const primaryEvent = projection.status === "editable" ? projection.value.event : undefined;
  if (primaryEvent !== undefined && !isTryCommentEvent(primaryEvent))
    return { event: primaryEvent };
  if (primaryEvent === undefined && format === "legacy_multistep") return { event: "manual.run" };

  const { triggers } = parseCompiledHubConfig(revision.normalizedConfiguration);
  const comment = triggers.find(({ on }) =>
    primaryEvent === undefined ? isTryCommentEvent(on) : on === primaryEvent,
  );
  const event = comment?.on ?? primaryEvent ?? "manual.run";
  const replyType = `${event.split(".", 1)[0]}.reply`;
  const hasReplyOutput = comment?.steps.some(
    (step) => !isScriptStep(step) && step.allowOutputs.some(({ type }) => type === replyType),
  );
  return comment !== undefined && hasReplyOutput
    ? { event, hasReplyOutput, commentPrefix: acceptedCommentPrefix(comment, connections) }
    : { event };
}

function acceptedCommentPrefix(
  trigger: CompiledTrigger,
  connections: OrganizationConnectionUsage,
): string | null {
  const { pattern = "", contains = "" } = trigger.filters ?? {};
  const prefix = [pattern, pattern.includes(contains) ? "" : contains].filter(Boolean).join(" ");
  const configuration = { triggers: [trigger] };
  const examples = commentExamples(trigger.on, prefix);

  // Preview a comment with no claim about the reader's provider identity or the target's scope.
  const results = examples.map(({ prompt }) => {
    if (trigger.on === "linear.comment_created") {
      const healthy = connections.linear.filter(
        (connection) => !linearConnectionRequiresReauthorization(connection),
      );
      return (
        healthy.length > 0 &&
        healthy.every((connection) =>
          matchLinearInvocations(
            configuration,
            {
              type: "comment",
              action: "create",
              id: "home-preview",
              organizationId: connection.linearOrganizationId,
              actor: null,
              comment: { id: "home-preview", body: prompt, issueId: "home-preview" },
              issue: {
                id: "home-preview",
                title: "",
                description: null,
                projectId: null,
                stateId: null,
                assigneeId: null,
                labelIds: [],
              },
            },
            connection.id,
            connection.appUserId,
          ).some(({ invocation }) => invocation.status === "accepted"),
        )
      );
    }

    const healthy = connections.github.filter(({ status }) => status !== "suspended");
    const type =
      trigger.on === "github.pull_request_review_comment"
        ? "pull_request_review_comment"
        : "issue_comment";
    return (
      healthy.length > 0 &&
      healthy.every((connection) => {
        const matches = matchGitHubInvocations(
          configuration,
          {
            id: "home-preview",
            type,
            repo: "",
            repositoryId: 0,
            installationId: connection.installationId,
            createdAt: "",
            payload: {
              action: "created",
              comment: { body: prompt },
              issue: trigger.on === "github.issue_comment_created" ? {} : { pull_request: {} },
            },
          },
          { source: `github.${type}`, connectionId: connection.id },
        );
        return (
          typeof matches !== "string" &&
          matches.some(({ invocation }) => invocation.status === "accepted")
        );
      })
    );
  });

  return results.length > 0 && results.every(Boolean) ? prefix : null;
}
