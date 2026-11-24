import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import { isScriptStep, parseCompiledHubConfig, type CompiledTrigger } from "../config/compiler.js";
import type { SessionPrincipal } from "../interactive-sessions/types.js";
import type {
  Database,
  DaemonRecord,
  OrganizationConnectionUsage,
  OrganizationRunCount,
  OrganizationRunRecord,
  OrganizationTriggerRecord,
  OrganizationTriggerRevisionRecord,
} from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import { hasRequiredSlackScopes } from "../providers/slack/client.js";
import { projectTriggerForm } from "../triggers/configuration/editor.js";
import { matchGitHubInvocations } from "../triggers/github/match.js";
import { matchLinearInvocations } from "../triggers/linear/match.js";
import { incompleteSetupStepTitles, SETUP_INCOMPLETE } from "./checklist.js";
import { HOME_MONTH_DAYS } from "./limits.js";
import { commentExamples, isTryCommentEvent } from "./things-to-try.js";

/** How far back the overview looks. One week is long enough to hold a first run. */
const HOME_WINDOW_DAYS = 7;
const RUNS_SHOWN = 50;
const DAY_MS = 86_400_000;

export interface RunTally {
  total: number;
  succeeded: number;
  failed: number;
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
    commentEvents?: readonly {
      on: string;
      hasReplyOutput: boolean;
      /** Text before an example. Null means the reader must evaluate the filters. */
      commentPrefix: string | null;
    }[];
  }[];
  runs: readonly (Omit<OrganizationRunRecord, "receivedAt"> & { receivedAt: string })[];
  /** Every run in the last 24 hours and the last `HOME_MONTH_DAYS` days, not only the ones listed. */
  runCounts: { day: RunTally; month: RunTally };
  /** Whether the reader started or joined a session. Null means Sessions is off. */
  sessionStarted: boolean | null;
  windowDays: number;
}

export interface HomeDashboardOptions {
  now?: () => Date;
  /** Whether this Hub runs interactive sessions at all. */
  interactiveSessions?: boolean;
}

class HomeSetupIncompleteError extends ProductRequestError {
  constructor(readonly stepTitles: readonly string[]) {
    super(409, SETUP_INCOMPLETE);
  }
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
    const incomplete = incompleteSetupStepTitles(snapshot);
    if (incomplete.length > 0) throw new HomeSetupIncompleteError(incomplete);
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
      sessionStarted,
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
      reader !== null && this.options.interactiveSessions === true
        ? this.database.hasOwnInteractiveSession(reader)
        : null,
      this.database.getHomeChecklistCompletedAt(organizationId),
    ]);
    return {
      organization,
      checklistCompletedAt: checklistCompletedAt?.toISOString() ?? null,
      appsConfigured: this.providerAppsConfigured(connections),
      connections: snapshotConnections(connections),
      daemons: snapshotDaemons(daemons),
      triggers: snapshotTriggers(triggers, revisions, connections),
      runs: snapshotRuns(runs),
      runCounts: { day: tally(dayRuns), month: tally(monthRuns) },
      sessionStarted,
      windowDays: HOME_WINDOW_DAYS,
    };
  }
}

function snapshotConnections(
  connections: OrganizationConnectionUsage,
): HomeSnapshot["connections"] {
  return [
    ...connections.github.map<HomeSnapshot["connections"][number]>(
      ({ slug, accountLogin, status }) => ({
        provider: "github",
        slug,
        label: accountLogin,
        needsAuthorization: status === "suspended",
      }),
    ),
    ...connections.slack.map<HomeSnapshot["connections"][number]>(({ slug, teamName, scopes }) => ({
      provider: "slack",
      slug,
      label: teamName,
      needsAuthorization: !hasRequiredSlackScopes(scopes),
    })),
    ...connections.discord.map<HomeSnapshot["connections"][number]>(({ slug, guildName }) => ({
      provider: "discord",
      slug,
      label: guildName,
      needsAuthorization: false,
    })),
    ...connections.linear.map<HomeSnapshot["connections"][number]>((connection) => ({
      provider: "linear",
      slug: connection.slug,
      label: connection.linearOrganizationName,
      needsAuthorization: linearConnectionRequiresReauthorization(connection),
    })),
  ];
}

function snapshotDaemons(daemons: readonly DaemonRecord[]): HomeSnapshot["daemons"] {
  return daemons
    .filter(({ status }) => status === "active")
    .map(({ id, slug, presence, permissions }) => ({
      id,
      slug,
      presence,
      canExecute: permissions.includes("hub.execute"),
    }));
}

function snapshotTriggers(
  triggers: readonly OrganizationTriggerRecord[],
  revisions: readonly (OrganizationTriggerRevisionRecord | undefined)[],
  connections: OrganizationConnectionUsage,
): HomeSnapshot["triggers"] {
  return triggers.map((trigger, index) =>
    Object.assign(
      { id: trigger.id, name: trigger.name, enabled: trigger.enabled },
      triggerFacts(revisions[index], trigger.format, connections),
    ),
  );
}

function snapshotRuns(runs: readonly OrganizationRunRecord[]): HomeSnapshot["runs"] {
  return runs.map((run) => ({
    id: run.id,
    triggerName: run.triggerName,
    provider: run.provider,
    source: run.source,
    status: run.status,
    receivedAt: run.receivedAt.toISOString(),
    agent: run.agent,
    payloadExpiredAt: run.payloadExpiredAt ?? null,
  }));
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
): Pick<HomeSnapshot["triggers"][number], "event" | "commentEvents"> {
  if (revision === undefined) return { event: "" };
  const projection = projectTriggerForm(revision.yaml);
  const primaryEvent = projection.status === "editable" ? projection.value.event : undefined;
  // A form-owned event is the whole configuration, and needs no comment projection here.
  if (primaryEvent !== undefined && !isTryCommentEvent(primaryEvent))
    return { event: primaryEvent };

  const { triggers } = parseCompiledHubConfig(revision.normalizedConfiguration);
  const comments = triggers.filter(({ on }) => isTryCommentEvent(on));
  const event = primaryEvent ?? fallbackTriggerEvent(format, comments, triggers);
  return comments.length === 0
    ? { event }
    : { event, commentEvents: comments.map((comment) => commentFacts(comment, connections)) };
}

function fallbackTriggerEvent(
  format: OrganizationTriggerRecord["format"],
  comments: readonly CompiledTrigger[],
  triggers: readonly CompiledTrigger[],
): string {
  return format === "legacy_multistep" ? "" : (comments[0]?.on ?? triggers[0]?.on ?? "");
}

function commentFacts(comment: CompiledTrigger, connections: OrganizationConnectionUsage) {
  const replyType = `${comment.on.split(".", 1)[0]}.reply`;
  const hasReplyOutput = comment.steps.some(
    (step) => !isScriptStep(step) && step.allowOutputs.some(({ type }) => type === replyType),
  );
  return {
    on: comment.on,
    hasReplyOutput,
    commentPrefix: hasReplyOutput ? acceptedCommentPrefix(comment, connections) : null,
  };
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
  const results = examples.map(({ prompt }) =>
    trigger.on === "linear.comment_created"
      ? linearAcceptsExample(configuration, connections.linear, prompt)
      : githubAcceptsExample(configuration, connections.github, prompt, trigger),
  );

  return results.length > 0 && results.every(Boolean) ? prefix : null;
}

function linearAcceptsExample(
  configuration: { triggers: CompiledTrigger[] },
  connections: OrganizationConnectionUsage["linear"],
  prompt: string,
): boolean {
  const healthy = connections.filter(
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

function githubAcceptsExample(
  configuration: { triggers: CompiledTrigger[] },
  connections: OrganizationConnectionUsage["github"],
  prompt: string,
  trigger: CompiledTrigger,
): boolean {
  const healthy = connections.filter(({ status }) => status !== "suspended");
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
}
