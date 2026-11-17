import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database, OrganizationTriggerRecord } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import { ProjectCommandError } from "../projects/command-error.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import type { DaemonAgentConfigurationValidator } from "../configuration/store.js";
import { projectTriggerForm } from "./configuration/editor.js";
import { OrganizationTriggerStore } from "./store.js";
import { notificationStatusView, type NotificationStatusView } from "./notification-status.js";
import { summarizeRecentRuns, type RecentRuns } from "./recent-runs.js";
import { summarizeTrigger } from "../projects/activity-summary.js";
import { activityRunDetailView } from "../projects/activity-run-view.js";
import { isRunTimelineExpired, retentionCutoff } from "../run-timeline/retention.js";
import { timelineStepId } from "../run-timeline/data.js";
import type { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import type { RunProgressSettings } from "../run-progress/settings.js";
import type { TriggerRunRecord } from "../db/types.js";
import type { RunDetailSnapshot, RunEventPage } from "./run-events.js";
import type { RunTimelineState } from "../run-timeline/store.js";

const DAY_MS = 24 * 60 * 60_000;
const NOTIFICATION_EVENT = "github.notification";

export interface TriggerDashboardOptions {
  /** True when this Hub has a token for the GitHub notification poll. The token never leaves it. */
  githubNotificationsEnabled?: boolean;
  /** Seconds between polls, as configured. Shown on the status card. */
  githubNotificationsPollSeconds?: number;
  now?: () => Date;
  runProgress?: Pick<
    RunProgressSettings,
    "runTimelineEnabled" | "runStreamEnabled" | "retentionDays" | "progressMessagesEnabled"
  >;
  reconciler?: Pick<RunTimelineReconciler, "reconcileBeforeTerminal">;
}

export class TriggerDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly agentValidator: DaemonAgentConfigurationValidator,
    private readonly options: TriggerDashboardOptions = {},
  ) {}

  /** Only an organization that uses the event sees the poll's health. */
  private async notificationStatus(
    organizationId: string,
    triggers: readonly { event: string }[],
  ): Promise<NotificationStatusView | undefined> {
    if (!triggers.some(({ event }) => event === NOTIFICATION_EVENT)) return undefined;
    const now = (this.options.now ?? (() => new Date()))();
    const store = this.database.githubNotifications;
    const [status, delivered24h] = await Promise.all([
      store.readStatus(),
      store.countDelivered(organizationId, new Date(now.getTime() - DAY_MS)),
    ]);
    return notificationStatusView({
      enabled: this.options.githubNotificationsEnabled === true,
      ...(this.options.githubNotificationsPollSeconds === undefined
        ? {}
        : { pollIntervalSeconds: this.options.githubNotificationsPollSeconds }),
      status,
      delivered24h,
      now,
    });
  }

  async snapshot(request: Request, organizationSlug: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const store = new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    );
    const [triggers, daemons, connections] = await Promise.all([
      store.list(),
      this.database.listDaemonsForOrganization(tenant.organization.id),
      this.database.organizationConnectionUsage(tenant.organization.id),
    ]);
    const perTrigger = await Promise.all(
      triggers.map((trigger) => this.activityForTrigger(trigger)),
    );
    const activity = perTrigger
      .flat()
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, 100);
    const now = (this.options.now ?? (() => new Date()))();
    const triggerViews = await Promise.all(
      triggers.map((trigger, index) => {
        // The summary uses the trigger's own newest runs, not the page-wide list cut to 100.
        const own = perTrigger[index] ?? [];
        const latest = own.reduce<(typeof own)[number] | undefined>(
          (found, run) => (found === undefined || run.receivedAt > found.receivedAt ? run : found),
          undefined,
        );
        return triggerView(store, trigger, latest, summarizeRecentRuns(own, now));
      }),
    );
    const notifications = await this.notificationStatus(tenant.organization.id, triggerViews);
    return {
      organization: tenant.organization,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      triggers: triggerViews,
      ...(notifications === undefined ? {} : { notifications }),
      activity,
      // Only a daemon that can run agents is a target; one enrolled without `hub.execute` would
      // be refused at save, and Home says how to grant it.
      daemons: daemons
        .filter(
          ({ status, permissions }) => status === "active" && permissions.includes("hub.execute"),
        )
        .map(({ id, slug, presence }) => ({ id, slug, presence })),
      connections: [
        ...connections.slack.map(({ id, slug, teamName }) => ({
          id,
          slug,
          provider: "slack" as const,
          label: teamName,
        })),
        ...connections.discord.map(({ id, slug, guildName }) => ({
          id,
          slug,
          provider: "discord" as const,
          label: guildName,
        })),
        ...connections.github.map(({ id, slug, accountLogin }) => ({
          id,
          slug,
          provider: "github" as const,
          label: accountLogin,
        })),
        ...connections.linear.map(({ id, slug, linearOrganizationName }) => ({
          id,
          slug,
          provider: "linear" as const,
          label: linearOrganizationName,
        })),
      ],
    };
  }
  async runDetail(
    request: Request,
    organizationSlug: string,
    runId: string,
  ): Promise<RunDetailSnapshot | null> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const run = await this.database.findTriggerRunForOrganization(tenant.organization.id, runId);
    if (run === undefined) return null;
    const activity = await this.database.findProjectActivityRun(run.projectId, runId);
    if (activity === undefined) return null;
    const [executions, timeline, progress] = await Promise.all([
      Promise.all(
        activity.steps.map(async (step) =>
          step.agentExecutionId === null
            ? undefined
            : this.database.findAgentExecutionById(step.agentExecutionId),
        ),
      ),
      this.timelinePage(tenant.organization.id, run, 0),
      this.database.findRunProgressMessage(tenant.organization.id, runId),
    ]);
    const detail = activityRunDetailView(activity, executions);
    return {
      ...detail,
      steps: detail.steps.map((step) =>
        Object.assign(step, { timelineStepId: timelineStepId(step.stepId) }),
      ),
      timeline,
      progressMessagesEnabled: this.options.runProgress?.progressMessagesEnabled ?? false,
      progress:
        progress === undefined
          ? null
          : { state: progress.state, provider: progress.provider, failure: progress.failure },
    };
  }

  async runEvents(
    request: Request,
    organizationSlug: string,
    runId: string,
    after: number,
  ): Promise<RunEventPage | null> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const run = await this.database.findTriggerRunForOrganization(tenant.organization.id, runId);
    if (run === undefined) return null;
    return this.timelinePage(tenant.organization.id, run, after);
  }

  private async timelinePage(
    organizationId: string,
    run: TriggerRunRecord,
    after: number,
  ): Promise<RunEventPage> {
    const settings = this.options.runProgress ?? {
      runTimelineEnabled: false,
      runStreamEnabled: false,
      retentionDays: 30,
      progressMessagesEnabled: false,
    };
    const retentionDays = settings.retentionDays;
    const cutoff = retentionCutoff((this.options.now ?? (() => new Date()))(), retentionDays);
    let state = await this.database.readRunTimelineState(organizationId, run.id);
    let expired = isRunTimelineExpired(
      { completedAt: run.completedAt, expiredAt: state?.expiredAt ?? null },
      cutoff,
    );
    if (
      !expired &&
      settings.runTimelineEnabled &&
      run.outcome === "accepted" &&
      run.status !== "running" &&
      state?.sealedSeq == null
    ) {
      await this.options.reconciler?.reconcileBeforeTerminal(organizationId, run.id);
      state = await this.database.readRunTimelineState(organizationId, run.id);
      expired = isRunTimelineExpired(
        { completedAt: run.completedAt, expiredAt: state?.expiredAt ?? null },
        cutoff,
      );
    }
    const events = expired
      ? []
      : await this.database.listRunTimelineEvents(organizationId, run.id, {
          afterSeq: after,
          limit: 100,
        });
    return {
      events: events.map(({ seq, kind, at, stepId, data }) => ({
        seq,
        kind,
        at: at.toISOString(),
        stepId,
        data,
      })),
      status: run.status,
      ...timelineSummary(state),
      expired,
      timelineEnabled: settings.runTimelineEnabled,
      timelineUnavailable:
        !settings.runTimelineEnabled && state === undefined && events.length === 0,
      streamEnabled: settings.runStreamEnabled,
      retentionDays,
    };
  }

  private async activityForTrigger(trigger: OrganizationTriggerRecord) {
    const migrationRevision = await this.database.findOrganizationTriggerMigrationRevision(
      trigger.id,
    );
    const evidence = record(migrationRevision?.sourceEvidence);
    const legacyProjectId = string(evidence?.["legacyProjectId"]);
    const legacyTriggerName =
      migrationRevision === undefined
        ? undefined
        : parseCompiledHubConfig(migrationRevision.normalizedConfiguration).triggers[0]?.name;
    const [current, historical] = await Promise.all([
      this.database.listProjectActivityRuns(trigger.runtimeProjectId, 100),
      legacyProjectId === undefined
        ? Promise.resolve([])
        : this.database.listProjectActivityRuns(legacyProjectId, 100),
    ]);
    return [...current, ...historical]
      .filter(
        ({ run }) =>
          current.some((candidate) => candidate.run.id === run.id) ||
          run.configuredTriggerName === legacyTriggerName,
      )
      .map(({ run, receipt, webhookActor }) =>
        Object.assign(
          {
            id: run.id,
            triggerId: trigger.id,
            triggerName: trigger.name,
            provider: receipt.provider,
            source: receipt.source,
            repo: receipt.repo,
            status: run.status,
            receivedAt: receipt.receivedAt.toISOString(),
          },
          receipt.source === "webhook.received"
            ? {
                webhookSummary: summarizeTrigger(receipt.source, {
                  actor: webhookActor,
                  input: run.prompt,
                  trigger: run.configuredTriggerName,
                }),
              }
            : {},
        ),
      );
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: { triggerId?: string; yaml: string },
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    ).save({
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
      yaml: input.yaml,
      userId: account.account.id,
    });
  }
}

async function triggerView(
  store: OrganizationTriggerStore,
  trigger: OrganizationTriggerRecord,
  lastTriggered:
    | { provider: string; source: string; status: string; receivedAt: string }
    | undefined,
  recentRuns: RecentRuns,
) {
  const revision = await store.activeRevision(trigger);
  const evidence = record(revision.sourceEvidence);
  const event = triggerEvent(revision.yaml, lastTriggered?.source);
  const operational =
    lastTriggered === undefined
      ? null
      : { status: lastTriggered.status, receivedAt: lastTriggered.receivedAt };
  if (trigger.format === "legacy_multistep") {
    return {
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      format: trigger.format,
      yaml: revision.yaml,
      updatedAt: trigger.updatedAt.toISOString(),
      blockers: stringArray(evidence?.["conversionBlockers"]),
      draft: null,
      event,
      provider: triggerProvider(event, lastTriggered?.provider),
      lastTriggered: operational,
      recentRuns,
    };
  }
  const projection = projectTriggerForm(revision.yaml);
  return {
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    format: trigger.format,
    yaml: revision.yaml,
    updatedAt: trigger.updatedAt.toISOString(),
    blockers: [],
    draft: projection.status === "editable" ? projection.value : null,
    event: projection.status === "editable" ? projection.value.event : event,
    provider: triggerProvider(
      projection.status === "editable" ? projection.value.event : event,
      lastTriggered?.provider,
    ),
    lastTriggered: operational,
    recentRuns,
  };
}

function triggerEvent(yaml: string, fallback: string | undefined): string {
  const inline = /^on:\s+([a-z]+(?:\.[a-z_]+)+)\s*$/mu.exec(yaml)?.[1];
  if (inline !== undefined) return inline;
  const nested = /^on:\s*$[\s\S]*?^\s{2}([a-z]+(?:\.[a-z_]+)+):\s*$/mu.exec(yaml)?.[1];
  return nested ?? fallback ?? "manual.run";
}

function triggerProvider(
  event: string,
  fallback: string | undefined,
): "github" | "discord" | "slack" | "linear" | "manual" | "schedule" | "github_notification" {
  if (event === "github.notification") return "github_notification";
  const provider = event.split(".")[0] ?? fallback;
  if (
    provider === "schedule" ||
    provider === "github" ||
    provider === "discord" ||
    provider === "slack" ||
    provider === "linear"
  ) {
    return provider;
  }
  return "manual";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function timelineSummary(state: RunTimelineState | undefined) {
  return {
    sealedSeq: state?.sealedSeq ?? null,
    stepRowsOmitted: state?.stepRowsOmitted ?? 0,
    origin: state?.origin ?? null,
    droppedCount: state?.droppedCount ?? 0,
  };
}
