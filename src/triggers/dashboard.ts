import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database, OrganizationTriggerRecord } from "../db/types.js";
import { canStopRun, type StopRun } from "./run-stop.js";
import { resolveRouteTenant } from "../projects/access.js";
import { ProjectCommandError } from "../projects/command-error.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import type { DaemonAgentConfigurationValidator } from "../configuration/store.js";
import { projectTriggerForm } from "./configuration/editor.js";
import { OrganizationTriggerStore } from "./store.js";
import { notificationStatusView, type NotificationStatusView } from "./notification-status.js";
import {
  activityCursorScope,
  decodeActivityCursor,
  droppedActivityCursorScope,
  encodeActivityCursor,
} from "./activity-cursor.js";
import type { ActivityFilters, DroppedActivityFilters } from "./activity-query.js";
import { decodeTriggerCursor, encodeTriggerCursor, triggerCursorScope } from "./trigger-cursor.js";
import { triggerSearchSchema, type TriggerSearch } from "./trigger-query.js";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "../components/app/page-size.js";
import { summarizeRecentRuns, type RecentRuns } from "./recent-runs.js";
import { summarizeTrigger } from "../projects/activity-summary.js";
import { activityRunDetailView, readActivityExecutions } from "../projects/activity-run-view.js";
import { isRunTimelineExpired, retentionCutoff } from "../run-timeline/retention.js";
import { timelineStepId } from "../run-timeline/data.js";
import type { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import type { RunProgressSettings } from "../run-progress/settings.js";
import type { ProjectActivityRunListRecord, TriggerRunRecord } from "../db/types.js";
import type { RunDetailSnapshot, RunEventPage } from "./run-events.js";
import type { RunTimelineState } from "../run-timeline/store.js";
import { z } from "zod";

const DAY_MS = 24 * 60 * 60_000;
const ACTIVITY_RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;
const NOTIFICATION_EVENT = "github.notification";
const triggerIdSchema = z.uuid();

type DashboardTenant = Awaited<ReturnType<typeof resolveRouteTenant>>["tenant"];

export interface TriggerDashboardOptions {
  stopRun?: StopRun;
  /** True when this Hub has a token for the GitHub notification poll. The token never leaves it. */
  githubNotificationsEnabled?: boolean;
  progressMessagesEnabled?: boolean;
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
  private readonly progressMessagesEnabled: boolean;

  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly agentValidator: DaemonAgentConfigurationValidator,
    private readonly options: TriggerDashboardOptions = {},
  ) {
    this.progressMessagesEnabled =
      options.progressMessagesEnabled ?? options.runProgress?.progressMessagesEnabled ?? false;
  }

  /** Only an organization that uses the event sees the poll's health. */
  private async notificationStatus(
    organizationId: string,
    configured: boolean,
  ): Promise<NotificationStatusView | undefined> {
    if (!configured) return undefined;
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
    return this.snapshotData(tenant, store, await store.list(), { includeActivity: true });
  }

  async editorSnapshot(request: Request, organizationSlug: string, triggerId: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const store = new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    );
    const trigger = triggerIdSchema.safeParse(triggerId).success
      ? await store.find(triggerId)
      : undefined;
    return this.snapshotData(tenant, store, trigger === undefined ? [] : [trigger], {
      includeActivity: false,
      hasNotifications: false,
    });
  }

  async triggerPage(request: Request, organizationSlug: string, input: TriggerSearch) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const organizationId = tenant.organization.id;
    const store = new OrganizationTriggerStore(this.database, organizationId, this.agentValidator);
    const search = triggerSearchSchema.parse(input);
    const { state, provider, q, cursor } = search;
    const limit = search.size ?? DEFAULT_PAGE_SIZE;
    const scope = triggerCursorScope(organizationId, limit, search);
    const read = (position: ReturnType<typeof decodeTriggerCursor>) =>
      this.database.listOrganizationTriggerPage(organizationId, {
        limit,
        ...(state === undefined ? {} : { enabled: state === "enabled" }),
        ...(provider === undefined ? {} : { provider }),
        ...(q === undefined ? {} : { nameContains: q }),
        ...(position === undefined ? {} : { position }),
      });
    const position = decodeTriggerCursor(cursor, scope);
    const [requested, hasNotifications] = await Promise.all([
      read(position),
      this.database.hasOrganizationTriggerEvent(organizationId, NOTIFICATION_EVENT),
    ]);
    const page =
      requested.records.length === 0 && position !== undefined ? await read(undefined) : requested;
    return {
      ...(await this.snapshotData(tenant, store, page.records, {
        includeActivity: true,
        hasNotifications,
      })),
      nextCursor: page.next === null ? null : encodeTriggerCursor("next", page.next, scope),
      previousCursor:
        page.previous === null ? null : encodeTriggerCursor("previous", page.previous, scope),
    };
  }

  private async snapshotData(
    tenant: DashboardTenant,
    store: OrganizationTriggerStore,
    triggers: readonly OrganizationTriggerRecord[],
    { includeActivity, hasNotifications }: { includeActivity: boolean; hasNotifications?: boolean },
  ) {
    const now = this.options.now?.() ?? new Date();
    const [daemons, connections, triggerViews] = await Promise.all([
      this.database.listDaemonsForOrganization(tenant.organization.id),
      this.database.organizationConnectionUsage(tenant.organization.id),
      Promise.all(
        triggers.map(async (trigger) => {
          const own = includeActivity ? await this.activityForTrigger(trigger) : [];
          const latest = own.reduce<(typeof own)[number] | undefined>(
            (found, run) =>
              found === undefined || run.receivedAt > found.receivedAt ? run : found,
            undefined,
          );
          return triggerView(store, trigger, latest, summarizeRecentRuns(own, now));
        }),
      ),
    ]);
    const notifications = await this.notificationStatus(
      tenant.organization.id,
      hasNotifications ?? triggerViews.some(({ event }) => event === NOTIFICATION_EVENT),
    );
    return {
      organization: tenant.organization,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      progressMessagesEnabled: this.progressMessagesEnabled,
      triggers: triggerViews,
      ...(notifications === undefined ? {} : { notifications }),
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
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const run = await this.database.findTriggerRunForOrganization(tenant.organization.id, runId);
    if (run === undefined) return null;
    const detail = await this.runDetailForProject(tenant.organization.id, run.projectId, runId);
    if (detail === null) return null;
    const canAuthorizeStop =
      this.options.stopRun !== undefined &&
      canStopRun(
        {
          organizationId: tenant.organization.id,
          role: tenant.membership.role,
          userId: account.account.id,
        },
        run,
      );
    const stopDetails =
      (canAuthorizeStop && detail.timeline.status === "running") || detail.run.status === "canceled"
        ? await this.database.readRunStopDetails(tenant.organization.id, runId)
        : undefined;
    const canStop =
      canAuthorizeStop &&
      (detail.timeline.status === "running" || stopDetails?.retryAttemptId != null);
    return { ...detail, canStop, ...(stopDetails === undefined ? {} : { stopDetails }) };
  }

  async stopRun(
    request: Request,
    organizationSlug: string,
    runId: string,
    confirmedPeerCount: number,
    retryAttemptId?: string,
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (this.options.stopRun === undefined) throw new Error("run stop is unavailable");
    return this.options.stopRun(
      {
        organizationId: tenant.organization.id,
        role: tenant.membership.role,
        userId: account.account.id,
      },
      runId,
      confirmedPeerCount,
      retryAttemptId,
    );
  }

  private async runDetailForProject(
    organizationId: string,
    projectId: string,
    runId: string,
  ): Promise<RunDetailSnapshot | null> {
    const read = await readActivityExecutions(this.database, () =>
      this.database.findProjectActivityRun(projectId, runId),
    );
    if (read === undefined || read.activity.run.organizationId !== organizationId) return null;
    const { activity, executions } = read;
    const [timeline, progress, reply] = await Promise.all([
      this.timelinePage(organizationId, activity.run, 0),
      this.database.findRunProgressMessage(organizationId, runId),
      activity.receipt.provider === "linear"
        ? this.database.runReplies.find({ organizationId, runId })
        : undefined,
    ]);
    if (activity.run.payloadExpiredAt == null) {
      const current = await this.database.findTriggerRunForOrganization(organizationId, runId);
      if (current === undefined) return null;
      if (current.payloadExpiredAt != null)
        return this.runDetailForProject(organizationId, projectId, runId);
    }
    const detail = activityRunDetailView(activity, executions);
    return {
      ...detail,
      steps: detail.steps.map((step) =>
        Object.assign(step, { timelineStepId: timelineStepId(step.stepId) }),
      ),
      timeline,
      progressMessagesEnabled: this.progressMessagesEnabled,
      progressUnavailable: progress === undefined && timeline.expired,
      ...(reply === undefined ? {} : { reply: { state: reply.state, failure: reply.failure } }),
      progress:
        progress === undefined || activity.run.payloadExpiredAt != null
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
      {
        completedAt: run.completedAt,
        expiredAt: state?.expiredAt ?? null,
        payloadExpiredAt: run.payloadExpiredAt,
      },
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
        {
          completedAt: run.completedAt,
          expiredAt: state?.expiredAt ?? null,
          payloadExpiredAt: run.payloadExpiredAt,
        },
        cutoff,
      );
    }
    const events = expired
      ? []
      : await this.database.listRunTimelineEvents(organizationId, run.id, {
          afterSeq: after,
          limit: 100,
        });
    if (!expired) {
      const current = await this.database.findTriggerRunForOrganization(organizationId, run.id);
      expired = current?.payloadExpiredAt != null;
    }
    return {
      events: (expired ? [] : events).map(({ seq, kind, at, stepId, data }) => ({
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

  private async triggerScopes(trigger: OrganizationTriggerRecord) {
    const migrationRevision = await this.database.findOrganizationTriggerMigrationRevision(
      trigger.id,
    );
    const evidence = record(migrationRevision?.sourceEvidence);
    const legacyProjectId = string(evidence?.["legacyProjectId"]);
    const legacyTriggerName =
      migrationRevision === undefined
        ? undefined
        : parseCompiledHubConfig(migrationRevision.normalizedConfiguration).triggers[0]?.name;
    return { legacyProjectId, legacyTriggerName };
  }

  private async activityForTrigger(trigger: OrganizationTriggerRecord) {
    const { legacyProjectId, legacyTriggerName } = await this.triggerScopes(trigger);
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
      .map((entry) => activityRow(trigger, entry));
  }

  async droppedActivityPage(
    request: Request,
    organizationSlug: string,
    input: DroppedActivityFilters & { limit?: number | undefined; cursor?: string | undefined },
  ) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const organizationId = tenant.organization.id;
    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, PAGE_SIZES[3]);
    const { provider, source, reason, range } = input;
    const receivedSince =
      range === undefined
        ? undefined
        : new Date(
            (this.options.now?.() ?? new Date()).getTime() - ACTIVITY_RANGE_DAYS[range] * DAY_MS,
          );
    const scope = droppedActivityCursorScope(organizationId, limit, input);
    const requested = decodeActivityCursor(input.cursor, scope);
    const read = (position?: ReturnType<typeof decodeActivityCursor>) =>
      this.database.listDroppedEventPage(organizationId, {
        limit,
        ...(provider === undefined ? {} : { provider }),
        ...(source === undefined ? {} : { source }),
        ...(reason === undefined ? {} : { reason }),
        ...(receivedSince === undefined ? {} : { receivedSince }),
        ...(position === undefined
          ? {}
          : { position: { direction: position.direction, key: position.key } }),
      });
    let page = await read(requested);
    if (page.records.length === 0 && requested !== undefined) page = await read();
    const startOffset = page.newer === null ? 0 : requested?.offset || null;
    return {
      events: page.records,
      startOffset,
      nextCursor:
        page.older === null
          ? null
          : encodeActivityCursor(
              "before",
              page.older,
              scope,
              startOffset === null ? undefined : startOffset + page.records.length,
            ),
      previousCursor:
        page.newer === null
          ? null
          : encodeActivityCursor(
              "after",
              page.newer,
              scope,
              startOffset === null ? undefined : Math.max(0, startOffset - limit),
            ),
    };
  }

  /** One newest-first page of every trigger's runs, with opaque cursors to the pages either side. */
  async activityPage(
    request: Request,
    organizationSlug: string,
    input: ActivityFilters & { limit?: number | undefined; cursor?: string | undefined },
  ) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, PAGE_SIZES[3]);
    const triggers = await new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    ).list();
    const scoped = await Promise.all(
      triggers
        .filter(({ id }) => input.trigger === undefined || id === input.trigger)
        .map(async (trigger) => {
          const { legacyProjectId, legacyTriggerName } = await this.triggerScopes(trigger);
          return { trigger, legacyProjectId, legacyTriggerName };
        }),
    );
    const scopes = scoped.flatMap(({ trigger, legacyProjectId, legacyTriggerName }) => [
      { projectId: trigger.runtimeProjectId },
      ...(legacyProjectId === undefined || legacyTriggerName === undefined
        ? []
        : [
            {
              projectId: legacyProjectId,
              triggerName: legacyTriggerName,
            },
          ]),
    ]);
    const { status, provider, range } = input;
    const createdSince =
      range === undefined
        ? undefined
        : new Date(
            (this.options.now?.() ?? new Date()).getTime() - ACTIVITY_RANGE_DAYS[range] * DAY_MS,
          );
    const read = (position: ReturnType<typeof decodeActivityCursor>) =>
      this.database.listOrganizationActivityPage(tenant.organization.id, scopes, {
        limit,
        ...(status === undefined ? {} : { status }),
        ...(provider === undefined ? {} : { provider }),
        ...(createdSince === undefined ? {} : { createdSince }),
        ...(position === undefined
          ? {}
          : { position: { direction: position.direction, key: position.key } }),
      });
    const cursorScope = activityCursorScope(tenant.organization.id, limit, input);
    const requested = decodeActivityCursor(input.cursor, cursorScope);
    let page = await read(requested);
    // A page emptied by deletions would strand the reader without controls.
    if (page.records.length === 0 && requested !== undefined) page = await read(undefined);
    const rows = page.records.flatMap((entry) => {
      const owner = scoped.find(
        ({ trigger, legacyProjectId, legacyTriggerName }) =>
          trigger.runtimeProjectId === entry.run.projectId ||
          (legacyProjectId === entry.run.projectId &&
            legacyTriggerName === entry.run.configuredTriggerName),
      );
      return owner === undefined ? [] : [activityRow(owner.trigger, entry)];
    });
    // Only the newest page has a known rank after insertions ahead of a reverse cursor.
    const startOffset = page.newer === null ? 0 : requested?.offset || null;
    const nextOffset = startOffset === null ? undefined : startOffset + rows.length;
    const previousOffset = startOffset === null ? undefined : Math.max(0, startOffset - limit);
    return {
      organization: tenant.organization,
      activity: rows,
      triggers: triggers.map(({ id, name }) => ({ id, name })),
      limit,
      startOffset,
      nextCursor:
        page.older === null
          ? null
          : encodeActivityCursor("before", page.older, cursorScope, nextOffset),
      previousCursor:
        page.newer === null
          ? null
          : encodeActivityCursor("after", page.newer, cursorScope, previousOffset),
    };
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

function activityRow(
  trigger: OrganizationTriggerRecord,
  { run, receipt, webhookActor }: ProjectActivityRunListRecord,
) {
  return Object.assign(
    {
      id: run.id,
      triggerId: trigger.id,
      triggerName: trigger.name,
      provider: receipt.provider,
      source: receipt.source,
      repo: run.payloadExpiredAt == null ? receipt.repo : (run.payloadSummary?.repository ?? null),
      payloadExpiredAt: run.payloadExpiredAt?.toISOString() ?? null,
      status: run.status,
      receivedAt: receipt.receivedAt.toISOString(),
    },
    run.payloadExpiredAt == null &&
      receipt.payloadExpiryState == null &&
      receipt.source === "webhook.received"
      ? {
          webhookSummary: summarizeTrigger(receipt.source, {
            actor: webhookActor,
            input: run.prompt,
            trigger: run.configuredTriggerName,
          }),
        }
      : {},
  );
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
