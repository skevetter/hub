import { otherDropPredicate, routingDropPredicate } from "./dropped-events.js";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { JsonValue } from "../config/compiler.js";
import { INVITATION_ROLES, ORGANIZATION_ROLES } from "../auth/organization-contract.js";
import { API_KEY_SCOPES } from "../auth/api-key-contract.js";

export { INVITATION_ROLES, ORGANIZATION_ROLES };

export const MACHINE_STATUSES = ["spawning", "alive", "terminated"] as const;
export const AGENT_EXECUTION_STATUSES = ["spawning", "running", "succeeded", "failed"] as const;
export const INVITATION_STATUSES = ["pending", "accepted", "rejected", "canceled"] as const;

export type MachineStatus = (typeof MACHINE_STATUSES)[number];
export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATUSES)[number];

export const PROJECT_STATUSES = ["active", "archived"] as const;
export const CONFIGURATION_SOURCE_KINDS = ["github", "manual"] as const;
export const TRIGGER_FORMATS = ["single_run", "legacy_multistep"] as const;
export const CONNECTION_PROVIDERS = ["github", "slack", "discord", "linear"] as const;
export type ReceiptPayloadExpiryState = "expiring" | "expired";
export type ReceiptPreRoutingDrop =
  | "no_project_route"
  | "no_trigger_for_source"
  | "configuration_unavailable"
  | "unsupported_event";

export interface ManualReceiptReplayBinding {
  projectId: string;
  configurationRevisionId: string;
  triggerName: string;
  triggerId: string | null;
}

export type MachineSource =
  | { kind: "manual"; userId?: string }
  | { kind: "daemon"; daemonId: string };

export const machineStatus = pgEnum("machine_status", MACHINE_STATUSES);
export const agentExecutionStatus = pgEnum("agent_execution_status", AGENT_EXECUTION_STATUSES);

export const providerEventReceipts = pgTable(
  "provider_event_receipts",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text()
      .$type<
        (typeof CONNECTION_PROVIDERS)[number] | "manual" | "schedule" | "github_notification"
      >()
      .notNull(),
    connectionId: uuid("connection_id"),
    resourceId: text("resource_id"),
    deliveryId: text("delivery_id").notNull(),
    signatureHash: text("signature_hash"),
    providerApplicationId: text("provider_application_id"),
    providerConfigurationVersion: integer("provider_configuration_version"),
    source: text().notNull(),
    repo: text(),
    startedByUserId: text("started_by_user_id"),
    payload: jsonb().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    droppedReason: text("dropped_reason"),
    acceptedRoutes: jsonb("accepted_routes"),
    payloadExpiryState: text("payload_expiry_state").$type<ReceiptPayloadExpiryState>(),
    payloadExpiredAt: timestamp("payload_expired_at", { withTimezone: true }),
    preRoutingDrop: text("pre_routing_drop").$type<ReceiptPreRoutingDrop>(),
    manualReplayBinding: jsonb("manual_replay_binding").$type<ManualReceiptReplayBinding>(),
  },
  (table) => [
    uniqueIndex("provider_event_receipts_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    uniqueIndex("provider_event_receipts_organization_delivery_unique").on(
      table.organizationId,
      table.deliveryId,
    ),
    index("provider_event_receipts_delivery_idx").on(table.deliveryId),
    index("provider_event_receipts_unmarked_idx")
      .on(table.id)
      .where(sql`${table.payloadExpiryState} is null`),
    index("provider_event_receipts_expiring_idx")
      .on(table.id)
      .where(sql`${table.payloadExpiryState} = 'expiring'`),
    uniqueIndex("provider_event_receipts_signature_unique")
      .on(table.signatureHash)
      .where(sql`${table.signatureHash} is not null`),
    index("provider_event_receipts_organization_received_idx").on(
      table.organizationId,
      table.receivedAt.desc(),
    ),
    index("provider_event_receipts_org_dropped_order_idx")
      .on(
        table.organizationId,
        table.receivedAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
        table.provider,
        table.droppedReason,
      )
      .where(sql`${table.droppedReason} is not null`),
    index("provider_event_receipts_org_dropped_provider_idx")
      .on(
        table.organizationId,
        table.provider,
        table.receivedAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
      )
      .where(sql`${table.droppedReason} is not null`),
    index("provider_event_receipts_org_dropped_source_idx")
      .on(
        table.organizationId,
        table.source,
        table.receivedAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
      )
      .where(sql`${table.droppedReason} is not null`),
    index("provider_event_receipts_org_dropped_reason_idx")
      .on(
        table.organizationId,
        table.droppedReason,
        table.receivedAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
      )
      .where(sql`${table.droppedReason} is not null`),
    index("provider_event_receipts_org_dropped_routing_idx")
      .on(table.organizationId, table.receivedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql.raw(routingDropPredicate("dropped_reason"))),
    index("provider_event_receipts_org_dropped_other_idx")
      .on(table.organizationId, table.receivedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql.raw(otherDropPredicate("dropped_reason"))),
    index("provider_event_receipts_org_webhook_idx")
      .on(table.organizationId, table.id)
      .where(sql`${table.provider} = 'manual' and ${table.source} = 'webhook.received'`),
    index("provider_event_receipts_resource_idx").on(
      table.organizationId,
      table.provider,
      table.connectionId,
      table.resourceId,
    ),
    check(
      "provider_event_receipts_provider_check",
      sql`${table.provider} in ('github', 'slack', 'discord', 'linear', 'manual', 'schedule', 'github_notification')`,
    ),
    check(
      "provider_event_receipts_payload_expiry_check",
      sql`(${table.payloadExpiryState} is null and ${table.payloadExpiredAt} is null)
        or (${table.payloadExpiryState} is not null and ${table.payloadExpiryState} in ('expiring', 'expired')
            and ${table.payloadExpiredAt} is not null)`,
    ),
    check(
      "provider_event_receipts_pre_routing_drop_check",
      sql`${table.preRoutingDrop} is null or (${table.preRoutingDrop} in ('no_project_route', 'no_trigger_for_source', 'configuration_unavailable', 'unsupported_event')
        and (${table.preRoutingDrop} <> 'unsupported_event' or ${table.provider} = 'linear')
        and ${table.preRoutingDrop} is not distinct from ${table.droppedReason} and ${table.acceptedRoutes} is null)`,
    ),
  ],
);

export const attachmentCapabilities = pgTable(
  "attachment_capabilities",
  {
    id: uuid().defaultRandom().primaryKey(),
    providerEventReceiptId: uuid("provider_event_receipt_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    provider: text().$type<"slack" | "discord">().notNull(),
    sourceId: text("source_id").notNull(),
    locator: jsonb().notNull(),
    filename: text().notNull(),
    contentType: text("content_type"),
    byteSize: bigint("byte_size", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("attachment_capabilities_receipt_provider_source_unique").on(
      table.providerEventReceiptId,
      table.provider,
      table.sourceId,
    ),
    index("attachment_capabilities_receipt_idx").on(table.providerEventReceiptId),
    check("attachment_capabilities_provider_check", sql`${table.provider} in ('slack', 'discord')`),
    foreignKey({
      columns: [table.providerEventReceiptId, table.organizationId],
      foreignColumns: [providerEventReceipts.id, providerEventReceipts.organizationId],
      name: "attachment_capabilities_receipt_organization_fk",
    }).onDelete("cascade"),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    slug: text().notNull(),
    status: text().$type<(typeof PROJECT_STATUSES)[number]>().default("active").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    activeConfigurationRevisionId: uuid("active_configuration_revision_id").references(
      (): AnyPgColumn => projectConfigurationRevisions.id,
    ),
  },
  (table) => [
    uniqueIndex("projects_organization_slug_unique").on(table.organizationId, table.slug),
    uniqueIndex("projects_id_organization_unique").on(table.id, table.organizationId),
    index("projects_organization_status_idx").on(table.organizationId, table.status),
    check("projects_status_check", sql`${table.status} in ('active', 'archived')`),
    check(
      "projects_archive_shape_check",
      sql`(${table.status} = 'active' and ${table.archivedAt} is null) or (${table.status} = 'archived' and ${table.archivedAt} is not null and ${table.activeConfigurationRevisionId} is null)`,
    ),
  ],
);

export const projectConfigurationRevisions = pgTable(
  "project_configuration_revisions",
  {
    id: uuid().defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    organizationId: text("organization_id").notNull(),
    version: integer().notNull(),
    sourceKind: text("source_kind").$type<(typeof CONFIGURATION_SOURCE_KINDS)[number]>().notNull(),
    sourceEvidence: jsonb("source_evidence").notNull(),
    rawYaml: text("raw_yaml"),
    normalizedConfiguration: jsonb("normalized_configuration").notNull(),
    validationErrors: jsonb("validation_errors"),
    contentHash: text("content_hash").notNull(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }),
    githubRepositoryFullName: text("github_repository_full_name"),
    githubCommitSha: text("github_commit_sha"),
    githubCommitUrl: text("github_commit_url"),
    githubRef: text("github_ref"),
    githubWebhookDeliveryId: text("github_webhook_delivery_id"),
    githubSender: text("github_sender"),
    githubAuthor: text("github_author"),
    githubCommitter: text("github_committer"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("project_configuration_revisions_project_version_unique").on(
      table.projectId,
      table.version,
    ),
    uniqueIndex("project_configuration_revisions_id_project_organization_unique").on(
      table.id,
      table.projectId,
      table.organizationId,
    ),
    index("project_configuration_revisions_project_created_idx").on(
      table.projectId,
      table.createdAt.desc(),
    ),
    check(
      "project_configuration_revisions_source_kind_check",
      sql`${table.sourceKind} in ('github', 'manual')`,
    ),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "project_configuration_revisions_project_organization_fk",
    }).onDelete("cascade"),
  ],
);

export const projectTriggerRoutes = pgTable(
  "project_trigger_routes",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    configurationRevisionId: uuid("configuration_revision_id").notNull(),
    provider: text().$type<(typeof CONNECTION_PROVIDERS)[number]>().notNull(),
    connectionId: uuid("connection_id").notNull(),
    resourceId: text("resource_id"),
    triggerName: text("trigger_name").notNull(),
  },
  (table) => [
    uniqueIndex("project_trigger_routes_shape_unique").on(
      table.projectId,
      table.configurationRevisionId,
      table.provider,
      table.connectionId,
      table.resourceId,
      table.triggerName,
    ),
    index("project_trigger_routes_resource_idx").on(
      table.organizationId,
      table.provider,
      table.connectionId,
      table.resourceId,
    ),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "project_trigger_routes_project_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.configurationRevisionId, table.projectId, table.organizationId],
      foreignColumns: [
        projectConfigurationRevisions.id,
        projectConfigurationRevisions.projectId,
        projectConfigurationRevisions.organizationId,
      ],
      name: "project_trigger_routes_revision_project_organization_fk",
    }).onDelete("cascade"),
    check(
      "project_trigger_routes_provider_check",
      sql`${table.provider} in ('github', 'slack', 'discord', 'linear')`,
    ),
  ],
);

/** Organization-owned trigger identity. Authored files and UI edits create immutable revisions. */
export const organizationTriggers = pgTable(
  "organization_triggers",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    enabled: boolean().default(true).notNull(),
    format: text().$type<(typeof TRIGGER_FORMATS)[number]>().notNull(),
    runtimeProjectId: uuid("runtime_project_id").references(() => projects.id),
    activeRevisionId: uuid("active_revision_id").references(
      (): AnyPgColumn => organizationTriggerRevisions.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("organization_triggers_organization_name_unique").on(
      table.organizationId,
      table.name,
    ),
    uniqueIndex("organization_triggers_id_organization_unique").on(table.id, table.organizationId),
    index("organization_triggers_organization_updated_idx").on(
      table.organizationId,
      table.updatedAt.desc(),
    ),
    index("organization_triggers_organization_name_c_id_idx")
      .on(table.organizationId, sql`${table.name} collate "C"`, table.id)
      .where(sql`${table.activeRevisionId} is not null`),
    check(
      "organization_triggers_format_check",
      sql`${table.format} in ('single_run', 'legacy_multistep')`,
    ),
  ],
);

export const organizationTriggerRevisions = pgTable(
  "organization_trigger_revisions",
  {
    id: uuid().defaultRandom().primaryKey(),
    triggerId: uuid("trigger_id").notNull(),
    organizationId: text("organization_id").notNull(),
    version: integer().notNull(),
    yaml: text().notNull(),
    normalizedConfiguration: jsonb("normalized_configuration").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceKind: text("source_kind").$type<"manual" | "github" | "project_migration">().notNull(),
    sourceEvidence: jsonb("source_evidence").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("organization_trigger_revisions_trigger_version_unique").on(
      table.triggerId,
      table.version,
    ),
    uniqueIndex("organization_trigger_revisions_id_trigger_organization_unique").on(
      table.id,
      table.triggerId,
      table.organizationId,
    ),
    index("organization_trigger_revisions_trigger_created_idx").on(
      table.triggerId,
      table.createdAt.desc(),
    ),
    check(
      "organization_trigger_revisions_source_kind_check",
      sql`${table.sourceKind} in ('manual', 'github', 'project_migration')`,
    ),
    foreignKey({
      columns: [table.triggerId, table.organizationId],
      foreignColumns: [organizationTriggers.id, organizationTriggers.organizationId],
      name: "organization_trigger_revisions_trigger_organization_fk",
    }).onDelete("cascade"),
  ],
);

export const organizationTriggerRoutes = pgTable(
  "organization_trigger_routes",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    triggerId: uuid("trigger_id").notNull(),
    triggerRevisionId: uuid("trigger_revision_id").notNull(),
    provider: text().$type<(typeof CONNECTION_PROVIDERS)[number]>().notNull(),
    connectionId: uuid("connection_id").notNull(),
    resourceId: text("resource_id"),
    configuredEventName: text("configured_event_name").notNull(),
  },
  (table) => [
    uniqueIndex("organization_trigger_routes_shape_unique").on(
      table.triggerId,
      table.triggerRevisionId,
      table.provider,
      table.connectionId,
      table.resourceId,
      table.configuredEventName,
    ),
    index("organization_trigger_routes_resource_idx").on(
      table.organizationId,
      table.provider,
      table.connectionId,
      table.resourceId,
    ),
    foreignKey({
      columns: [table.triggerId, table.organizationId],
      foreignColumns: [organizationTriggers.id, organizationTriggers.organizationId],
      name: "organization_trigger_routes_trigger_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.triggerRevisionId, table.triggerId, table.organizationId],
      foreignColumns: [
        organizationTriggerRevisions.id,
        organizationTriggerRevisions.triggerId,
        organizationTriggerRevisions.organizationId,
      ],
      name: "organization_trigger_routes_revision_trigger_organization_fk",
    }).onDelete("cascade"),
  ],
);

/** One row means the project's active revision was atomically exploded into organization triggers. */
export const projectTriggerMigrations = pgTable(
  "project_trigger_migrations",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    configurationRevisionId: uuid("configuration_revision_id").notNull(),
    migratedAt: timestamp("migrated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("project_trigger_migrations_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.configurationRevisionId, table.projectId, table.organizationId],
      foreignColumns: [
        projectConfigurationRevisions.id,
        projectConfigurationRevisions.projectId,
        projectConfigurationRevisions.organizationId,
      ],
      name: "project_trigger_migrations_revision_project_organization_fk",
    }),
  ],
);

export const triggerRuns = pgTable(
  "trigger_runs",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    configurationRevisionId: uuid("configuration_revision_id").notNull(),
    providerEventReceiptId: uuid("provider_event_receipt_id").notNull(),
    configuredTriggerName: text("configured_trigger_name").notNull(),
    conversation: jsonb().$type<import("../triggers/continuation.js").Conversation>(),
    outcome: text().$type<"accepted" | "rejected">().notNull().default("accepted"),
    status: text()
      .$type<"running" | "succeeded" | "failed" | "timed_out" | "canceled" | "rejected">()
      .notNull(),
    prompt: text().notNull(),
    inputs: jsonb().notNull().default({}),
    values: jsonb().notNull().default({}),
    triggerContext: jsonb("trigger_context").notNull().default({}),
    outputContext: jsonb("output_context").notNull().default({}),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    deadlineKind: text("deadline_kind").$type<"step_hard" | "step_idle" | "whole_run">(),
    failureReason: text("failure_reason"),
    reactionState: jsonb("reaction_state"),
    terminalNotificationPendingAt: timestamp("terminal_notification_pending_at", {
      withTimezone: true,
    }),
    terminalNotificationDeliveredAt: timestamp("terminal_notification_delivered_at", {
      withTimezone: true,
    }),
    terminalNotificationLeaseExpiresAt: timestamp("terminal_notification_lease_expires_at", {
      withTimezone: true,
    }),
    terminalNotificationGeneration: integer("terminal_notification_generation")
      .notNull()
      .default(0),
    payloadExpiredAt: timestamp("payload_expired_at", { withTimezone: true }),
    payloadExpiryState: text("payload_expiry_state").$type<"expiring" | "expired">(),
    payloadSummary:
      jsonb("payload_summary").$type<
        import("../run-payload-retention/summary.js").RunPayloadSummary
      >(),
    rejection: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("trigger_runs_id_organization_unique").on(table.id, table.organizationId),
    uniqueIndex("trigger_runs_receipt_project_configured_unique").on(
      table.providerEventReceiptId,
      table.projectId,
      table.configuredTriggerName,
    ),
    index("trigger_runs_status_deadline_idx").on(table.status, table.deadlineAt),
    index("trigger_runs_project_created_idx").on(table.projectId, table.createdAt.desc()),
    index("trigger_runs_organization_created_id_idx").on(
      table.organizationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("trigger_runs_payload_expiry_idx")
      .on(table.completedAt, table.id)
      .where(
        sql`${table.status} <> 'running' and ${table.payloadExpiryState} is distinct from 'expired'`,
      ),
    index("trigger_runs_terminal_notification_idx").on(
      table.terminalNotificationDeliveredAt,
      table.terminalNotificationLeaseExpiresAt,
    ),
    check(
      "trigger_runs_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'timed_out', 'canceled', 'rejected')`,
    ),
    check(
      "trigger_runs_payload_expiry_check",
      sql`(${table.payloadExpiryState} is null and ${table.payloadExpiredAt} is null and ${table.payloadSummary} is null)
        or (${table.payloadExpiryState} is not null and ${table.payloadExpiryState} in ('expiring', 'expired')
            and ${table.payloadExpiredAt} is not null and ${table.payloadSummary} is not null)`,
    ),
    check(
      "trigger_runs_outcome_check",
      sql`(${table.outcome} = 'accepted' and ${table.status} <> 'rejected' and ${table.rejection} is null)
        or (${table.outcome} = 'rejected' and ${table.status} = 'rejected' and ${table.rejection} is not null)`,
    ),
    check(
      "trigger_runs_deadline_kind_check",
      sql`${table.deadlineKind} is null or ${table.deadlineKind} in ('step_hard', 'step_idle', 'whole_run')`,
    ),
    check(
      "trigger_runs_deadline_shape_check",
      sql`(${table.outcome} = 'accepted' and ${table.deadlineAt} is not null)
        or (${table.outcome} = 'rejected' and ${table.deadlineAt} is null)`,
    ),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
      name: "trigger_runs_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "trigger_runs_project_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.configurationRevisionId, table.projectId, table.organizationId],
      foreignColumns: [
        projectConfigurationRevisions.id,
        projectConfigurationRevisions.projectId,
        projectConfigurationRevisions.organizationId,
      ],
      name: "trigger_runs_revision_project_organization_fk",
    }),
    foreignKey({
      columns: [table.providerEventReceiptId, table.organizationId],
      foreignColumns: [providerEventReceipts.id, providerEventReceipts.organizationId],
      name: "trigger_runs_receipt_organization_fk",
    }),
  ],
);

export const runTimelineEvents = pgTable(
  "run_timeline_events",
  {
    triggerRunId: uuid("trigger_run_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    kind: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull(),
    stepId: text("step_id").notNull().default(""),
    data: jsonb().notNull().default({}),
  },
  (table) => [
    primaryKey({ columns: [table.triggerRunId, table.seq] }),
    check("run_timeline_events_seq_check", sql`${table.seq} between 1 and 5110`),
    check(
      "run_timeline_events_kind_check",
      sql`${table.kind} in ('run_started', 'step_started', 'agent_started', 'turn_started', 'turn_ended', 'tool_started', 'tool_finished', 'permission_requested', 'permission_resolved', 'turn_failed', 'turn_canceled', 'step_finished', 'run_finished', 'truncated')`,
    ),
    check(
      "run_timeline_events_data_check",
      sql`octet_length(${table.data}::text) <= case when ${table.kind} = 'truncated' then 128 when ${table.kind} in ('step_finished', 'run_finished') then 512 else 1024 end`,
    ),
    foreignKey({
      columns: [table.triggerRunId, table.organizationId],
      foreignColumns: [triggerRuns.id, triggerRuns.organizationId],
      name: "run_timeline_events_run_organization_fk",
    }).onDelete("cascade"),
    uniqueIndex("run_timeline_events_lifecycle_unique")
      .on(table.triggerRunId, table.kind, table.stepId)
      .where(
        sql`${table.kind} in ('run_started', 'step_started', 'step_finished', 'run_finished', 'agent_started')`,
      ),
    uniqueIndex("run_timeline_events_call_unique")
      .on(table.triggerRunId, table.stepId, table.kind, sql`(${table.data}->>'callId')`)
      .where(
        sql`${table.kind} in ('tool_started', 'tool_finished') and (${table.data}->>'callId') is not null`,
      ),
    index("run_timeline_events_organization_at_idx").on(table.organizationId, table.at),
  ],
);

export const runTimelineState = pgTable(
  "run_timeline_state",
  {
    triggerRunId: uuid("trigger_run_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventCount: integer("event_count").notNull().default(0),
    byteCount: integer("byte_count").notNull().default(0),
    stepEndCount: integer("step_end_count").notNull().default(0),
    stepEndBytes: integer("step_end_bytes").notNull().default(0),
    stepRowsOmitted: integer("step_rows_omitted").notNull().default(0),
    droppedCount: integer("dropped_count").notNull().default(0),
    accountingBatchIds: text("accounting_batch_ids").array(),
    sealedSeq: integer("sealed_seq"),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    origin: text().$type<"captured" | "derived">().notNull(),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.triggerRunId, table.organizationId],
      foreignColumns: [triggerRuns.id, triggerRuns.organizationId],
      name: "run_timeline_state_run_organization_fk",
    }).onDelete("cascade"),
    check("run_timeline_state_origin_check", sql`${table.origin} in ('captured', 'derived')`),
    check(
      "run_timeline_state_budget_check",
      sql`${table.eventCount} between 0 and 5102 and ${table.byteCount} between 0 and 196608 and ${table.stepEndCount} between 0 and 100 and ${table.stepEndBytes} between 0 and 51200 and ${table.droppedCount} >= 0 and ${table.stepRowsOmitted} >= 0`,
    ),
  ],
);

export const runProgressMessages = pgTable(
  "run_progress_messages",
  {
    triggerRunId: uuid("trigger_run_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text().$type<"github" | "linear" | "slack">().notNull(),
    state: text()
      .$type<
        | "pending"
        | "creating"
        | "active"
        | "finished"
        | "gone"
        | "unavailable"
        | "refused"
        | "abandoned"
      >()
      .notNull()
      .default("pending"),
    externalRef: jsonb("external_ref").$type<JsonValue>(),
    version: integer().notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastRenderedHash: text("last_rendered_hash"),
    lastEditAt: timestamp("last_edit_at", { withTimezone: true }),
    lastRegularAttemptAt: timestamp("last_regular_attempt_at", { withTimezone: true }),
    lastRegularReservationVersion: integer("last_regular_reservation_version"),
    editCount: integer("edit_count").notNull().default(0),
    failedEdits: integer("failed_edits").notNull().default(0),
    finalFailures: integer("final_failures").notNull().default(0),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    credentialKey: text("credential_key"),
    credentialRetryAt: timestamp("credential_retry_at", { withTimezone: true }),
    credentialRejectedUntil: timestamp("credential_rejected_until", { withTimezone: true }),
    settleAt: timestamp("settle_at", { withTimezone: true }),
    repeatFinal: boolean("repeat_final").notNull().default(false),
    visibility: text().$type<"public" | "private" | "unknown">(),
    visibilityCheckedAt: timestamp("visibility_checked_at", { withTimezone: true }),
    failure: text(),
    compensationRequestedGen: integer("compensation_requested_gen").notNull().default(0),
    compensationDoneGen: integer("compensation_done_gen").notNull().default(0),
    compensationNotBefore: timestamp("compensation_not_before", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.triggerRunId, table.organizationId],
      foreignColumns: [triggerRuns.id, triggerRuns.organizationId],
      name: "run_progress_messages_run_organization_fk",
    }).onDelete("cascade"),
    check(
      "run_progress_messages_provider_check",
      sql`${table.provider} in ('github', 'linear', 'slack')`,
    ),
    check(
      "run_progress_messages_state_check",
      sql`${table.state} in ('pending', 'creating', 'active', 'finished', 'gone', 'unavailable', 'refused', 'abandoned')`,
    ),
    check(
      "run_progress_messages_visibility_check",
      sql`${table.visibility} is null or ${table.visibility} in ('public', 'private', 'unknown')`,
    ),
    check(
      "run_progress_messages_generation_check",
      sql`${table.compensationRequestedGen} >= ${table.compensationDoneGen} and ${table.compensationDoneGen} >= 0`,
    ),
    index("run_progress_messages_settle_idx")
      .on(table.settleAt)
      .where(sql`${table.settleAt} is not null`),
    index("run_progress_messages_credential_idx")
      .on(table.credentialKey)
      .where(sql`${table.credentialKey} is not null`),
    index("run_progress_messages_sweep_idx").on(table.state, table.leaseExpiresAt),
  ],
);
export const workflowStepRuns = pgTable(
  "workflow_step_runs",
  {
    id: uuid().defaultRandom().primaryKey(),
    triggerRunId: uuid("trigger_run_id").notNull(),
    stepId: text("step_id").notNull(),
    ordinal: integer().notNull(),
    status: text()
      .$type<
        "pending" | "running" | "succeeded" | "skipped" | "failed" | "timed_out" | "canceled"
      >()
      .notNull(),
    agentExecutionId: uuid("agent_execution_id"),
    output: jsonb(),
    failureReason: text("failure_reason"),
    deadlineKind: text("deadline_kind").$type<"step_hard" | "step_idle" | "whole_run">(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    idleDeadlineAt: timestamp("idle_deadline_at", { withTimezone: true }),
    dispatchIntent: jsonb("dispatch_intent").$type<LaunchMachineIntent>(),
    payloadSummary:
      jsonb("payload_summary").$type<
        import("../run-payload-retention/summary.js").StepPayloadSummary
      >(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workflow_step_runs_trigger_ordinal_unique").on(table.triggerRunId, table.ordinal),
    uniqueIndex("workflow_step_runs_trigger_step_unique").on(table.triggerRunId, table.stepId),
    uniqueIndex("workflow_step_runs_agent_execution_unique")
      .on(table.agentExecutionId)
      .where(sql`${table.agentExecutionId} is not null`),
    index("workflow_step_runs_trigger_status_idx").on(table.triggerRunId, table.status),
    check(
      "workflow_step_runs_status_check",
      sql`${table.status} in ('pending', 'running', 'succeeded', 'skipped', 'failed', 'timed_out', 'canceled')`,
    ),
    check(
      "workflow_step_runs_deadline_kind_check",
      sql`${table.deadlineKind} is null or ${table.deadlineKind} in ('step_hard', 'step_idle', 'whole_run')`,
    ),
    foreignKey({
      columns: [table.triggerRunId],
      foreignColumns: [triggerRuns.id],
      name: "workflow_step_runs_trigger_run_fk",
    }).onDelete("cascade"),
  ],
);

export const workflowWakeups = pgTable(
  "workflow_wakeups",
  {
    triggerRunId: uuid("trigger_run_id").primaryKey(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  },
  (table) => [
    index("workflow_wakeups_available_lease_idx").on(table.availableAt, table.leaseExpiresAt),
    foreignKey({
      columns: [table.triggerRunId],
      foreignColumns: [triggerRuns.id],
      name: "workflow_wakeups_trigger_run_fk",
    }).onDelete("cascade"),
  ],
);

export const machines = pgTable(
  "machines",
  {
    id: uuid().defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    source: jsonb().$type<MachineSource>().notNull(),
    status: machineStatus().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    shutdownReason: text("shutdown_reason"),
    triggerName: text("trigger_name"),
    triggerContext: jsonb("trigger_context"),
    specs: jsonb(),
  },
  (table) => [
    uniqueIndex("machines_id_org_id_unique").on(table.id, table.orgId),
    index("machines_org_id_idx").on(table.orgId),
    index("machines_status_idx").on(table.status),
  ],
);

export const daemonEnrollmentTokens = pgTable("daemon_enrollment_tokens", {
  id: uuid().primaryKey(),
  verifier: text().notNull().unique(),
  organizationId: text("organization_id"),
  issuedByApiKeyId: uuid("issued_by_api_key_id"),
  issuedByCliCredentialId: uuid("issued_by_cli_credential_id").references(
    (): AnyPgColumn => organizationCliCredentials.id,
    { onDelete: "set null" },
  ),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const daemons = pgTable(
  "daemons",
  {
    id: uuid().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    enrollmentVerifier: text("enrollment_verifier").notNull(),
    slug: text().notNull(),
    machineId: uuid("machine_id").notNull(),
    organizationId: text("organization_id").notNull(),
    serverId: text("server_id").notNull(),
    daemonPublicKey: text("daemon_public_key").notNull(),
    credentialVerifier: text("credential_verifier").notNull(),
    permissions: jsonb("scopes").$type<string[]>().notNull(),
    registeredByApiKeyId: uuid("registered_by_api_key_id"),
    registeredByCliCredentialId: uuid("registered_by_cli_credential_id").references(
      (): AnyPgColumn => organizationCliCredentials.id,
      { onDelete: "set null" },
    ),
    status: text().$type<"active" | "revoked">().notNull(),
    presence: text().$type<"offline" | "connected">().default("offline").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("daemons_machine_id_unique").on(table.machineId),
    uniqueIndex("daemons_id_organization_unique").on(table.id, table.organizationId),
    uniqueIndex("daemons_organization_slug_unique").on(table.organizationId, table.slug),
    foreignKey({
      columns: [table.machineId, table.organizationId],
      foreignColumns: [machines.id, machines.orgId],
      name: "daemons_machine_organization_fk",
    }),
    check("daemons_status_check", sql`${table.status} in ('active', 'revoked')`),
    check("daemons_presence_check", sql`${table.presence} in ('offline', 'connected')`),
  ],
);

export const cliAuthorizations = pgTable(
  "cli_authorizations",
  {
    id: uuid().primaryKey(),
    deviceVerifier: text("device_verifier").notNull().unique(),
    userCodeVerifier: text("user_code_verifier").notNull().unique(),
    fingerprintVerifier: text("fingerprint_verifier").notNull(),
    status: text().$type<"pending" | "approved" | "denied" | "expired" | "disclosed">().notNull(),
    pollIntervalSeconds: integer("poll_interval_seconds").notNull(),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull(),
    approvedOrganizationId: text("approved_organization_id"),
    approvedByUserId: text("approved_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    credentialId: uuid("credential_id").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("cli_authorizations_fingerprint_idx").on(table.fingerprintVerifier, table.expiresAt),
    index("cli_authorizations_status_expiry_idx").on(table.status, table.expiresAt),
    check(
      "cli_authorizations_status_check",
      sql`${table.status} in ('pending', 'approved', 'denied', 'expired', 'disclosed')`,
    ),
    check("cli_authorizations_poll_interval_check", sql`${table.pollIntervalSeconds} >= 5`),
  ],
);

export const organizationCliCredentials = pgTable(
  "organization_cli_credentials",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    prefix: text().notNull(),
    verifier: text().notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("organization_cli_credentials_prefix_unique").on(table.prefix),
    index("organization_cli_credentials_organization_created_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
  ],
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid().primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    continuationKey: text("continuation_key"),
    data: jsonb().$type<import("../agent-sessions/index.js").AgentSessionRecord>().notNull(),
    creationOptions:
      jsonb("creation_options").$type<
        import("../agent-sessions/index.js").AgentSessionRecord["creationOptions"]
      >(),
    optionsReducedAt: timestamp("options_reduced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_sessions_project_key_unique").on(table.projectId, table.continuationKey),
  ],
);

export const agentExecutions = pgTable(
  "agent_executions",
  {
    id: uuid().defaultRandom().primaryKey(),
    agentSessionAction:
      text("agent_session_action").$type<import("../agent-sessions/index.js").AgentSessionAction>(),
    agentSessionId: uuid("agent_session_id").references(() => agentSessions.id),
    organizationId: text("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    machineId: uuid("machine_id"),
    status: agentExecutionStatus().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByAgentAt: timestamp("completed_by_agent_at", {
      withTimezone: true,
    }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    idleDeadlineAt: timestamp("idle_deadline_at", { withTimezone: true }),
    result: jsonb(),
    payloadCompletion:
      text("payload_completion").$type<
        import("../run-payload-retention/summary.js").PayloadCompletion
      >(),
    triggerContext: jsonb("trigger_context"),
    outputContext: jsonb("output_context"),
    reactionState: jsonb("reaction_state"),
    configurationRevisionId: uuid("configuration_revision_id").notNull(),
    completionTokenHash: text("completion_token_hash"),
    replyClaimedAt: timestamp("reply_claimed_at", { withTimezone: true }),
    replyClaimCount: integer("reply_claim_count").default(0).notNull(),
    outputEmissions: jsonb("output_emissions").notNull().default({}),
    outputDeliveryAttempts: jsonb("output_delivery_attempts").notNull().default({}),
    launchIntent: jsonb("launch_intent"),
    usedTemporaryCredentials: boolean("used_temporary_credentials"),
    launchIntentExpiredAt: timestamp("launch_intent_expired_at", { withTimezone: true }),
    launchRunId: uuid("launch_run_id"),
    launchAgent:
      jsonb("launch_agent").$type<
        import("../run-payload-retention/summary.js").PayloadAgentSummary
      >(),
    daemonId: uuid("daemon_id"),
    daemonAgentId: text("daemon_agent_id"),
    workflowStepRunId: uuid("workflow_step_run_id"),
    hubAction: text("hub_action").$type<"interrupt" | "archive">(),
    hubActionCompletedAt: timestamp("hub_action_completed_at", {
      withTimezone: true,
    }),
    hubActionReadyAt: timestamp("hub_action_ready_at", {
      withTimezone: true,
    }),
    hubActionAcknowledgements: jsonb("hub_action_acknowledgements")
      .notNull()
      .default({ terminal_at: null, idle_at: null, finish_execution_call: null }),
  },
  (table) => [
    index("agent_executions_session_idx").on(table.agentSessionId),
    index("agent_executions_machine_id_idx").on(table.machineId),
    index("agent_executions_project_started_at_idx").on(table.projectId, table.startedAt.desc()),
    index("agent_executions_status_idx").on(table.status),
    index("agent_executions_workflow_step_idx")
      .on(table.workflowStepRunId)
      .where(sql`${table.workflowStepRunId} is not null`),
    index("agent_executions_legacy_run_idx")
      .on(table.organizationId, table.projectId, sql`(${table.launchIntent} ->> 'triggerRunId')`)
      .where(
        sql`${table.workflowStepRunId} is null and ${table.launchIntent} ->> 'kind' = 'launch_machine'`,
      ),
    index("agent_executions_launch_run_idx")
      .on(table.organizationId, table.projectId, table.launchRunId)
      .where(sql`${table.launchRunId} is not null`),
    check(
      "agent_executions_launch_expiry_check",
      sql`${table.launchIntentExpiredAt} is null or
        (${table.launchIntent} is null and ${table.usedTemporaryCredentials} is not null)`,
    ),
    check(
      "agent_executions_hub_action_check",
      sql`${table.hubAction} is null or ${table.hubAction} in ('interrupt', 'archive')`,
    ),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "agent_executions_project_organization_fk",
    }),
    foreignKey({
      columns: [table.configurationRevisionId, table.projectId, table.organizationId],
      foreignColumns: [
        projectConfigurationRevisions.id,
        projectConfigurationRevisions.projectId,
        projectConfigurationRevisions.organizationId,
      ],
      name: "agent_executions_revision_project_organization_fk",
    }),
    foreignKey({
      columns: [table.machineId, table.organizationId],
      foreignColumns: [machines.id, machines.orgId],
      name: "agent_executions_machine_organization_fk",
    }),
    foreignKey({
      columns: [table.daemonId, table.organizationId],
      foreignColumns: [daemons.id, daemons.organizationId],
      name: "agent_executions_daemon_organization_fk",
    }),
    foreignKey({
      columns: [table.workflowStepRunId],
      foreignColumns: [workflowStepRuns.id],
      name: "agent_executions_workflow_step_run_fk",
    }),
  ],
);

export const users = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  mustChangePassword: boolean("must_change_password").default(false).notNull(),
  isInstanceOperator: boolean("is_instance_operator").default(false).notNull(),
});

export const sessions = pgTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("sessions_active_organization_id_idx").on(table.activeOrganizationId)],
);

export const accounts = pgTable("account", {
  id: text().primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text(),
  password: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const verifications = pgTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const organizations = pgTable("organization", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: text(),
  homeChecklistCompletedAt: timestamp("home_checklist_completed_at", { withTimezone: true }),
});

export const organizationConnectionAttempts = pgTable(
  "organization_connection_attempts",
  {
    id: uuid().defaultRandom().primaryKey(),
    provider: text().$type<"github" | "discord" | "slack" | "linear">().notNull(),
    phase: text()
      .$type<
        | "github_setup"
        | "github_user_authorization"
        | "discord_authorization"
        | "slack_authorization"
        | "linear_authorization"
      >()
      .notNull(),
    stateVerifier: text("state_verifier").notNull().unique(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    returnRoute: text("return_route").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    candidateExternalId: text("candidate_external_id"),
    pkceVerifier: text("pkce_verifier"),
    configurationVersion: integer("configuration_version").notNull(),
    providerApplicationId: text("provider_application_id"),
    callbackOrigin: text("callback_origin").notNull(),
    configurationSnapshot: jsonb("configuration_snapshot").notNull(),
    expectedConfigurationVersion: integer("expected_configuration_version"),
    activateConfiguration: boolean("activate_configuration").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("organization_connection_attempts_expiry_idx").on(table.expiresAt),
    check(
      "organization_connection_attempts_provider_check",
      sql`${table.provider} in ('github', 'discord', 'slack', 'linear')`,
    ),
    check(
      "organization_connection_attempts_phase_check",
      sql`${table.phase} in ('github_setup', 'github_user_authorization', 'discord_authorization', 'slack_authorization', 'linear_authorization')`,
    ),
    check(
      "organization_connection_attempts_shape_check",
      sql`(${table.phase} = 'github_setup' and ${table.provider} = 'github' and ${table.candidateExternalId} is null and ${table.pkceVerifier} is null)
        or (${table.phase} = 'github_user_authorization' and ${table.provider} = 'github' and ${table.candidateExternalId} is not null and (${table.pkceVerifier} is not null or ${table.consumedAt} is not null))
        or (${table.phase} = 'discord_authorization' and ${table.provider} = 'discord' and ${table.candidateExternalId} is null and ${table.pkceVerifier} is null)
        or (${table.phase} = 'slack_authorization' and ${table.provider} = 'slack' and ${table.candidateExternalId} is null and ${table.pkceVerifier} is null)
        or (${table.phase} = 'linear_authorization' and ${table.provider} = 'linear' and ${table.candidateExternalId} is null and ${table.pkceVerifier} is null)`,
    ),
  ],
);

export const githubConnections = pgTable(
  "github_connections",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
    providerApplicationId: text("provider_application_id"),
    slug: text().notNull(),
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    status: text().$type<"active" | "suspended">().notNull(),
    connectedByUserId: text("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("github_connections_installation_unique").on(table.installationId),
    uniqueIndex("github_connections_organization_slug_unique").on(table.organizationId, table.slug),
    uniqueIndex("github_connections_id_organization_unique").on(table.id, table.organizationId),
    index("github_connections_organization_idx").on(table.organizationId),
    check("github_connections_status_check", sql`${table.status} in ('active', 'suspended')`),
  ],
);

export type GitHubSyncAuditLink =
  | { kind: "receipt"; receiptId: string; organizationId: string }
  | { kind: "none" }
  | { kind: "unproven" };

export const githubInstallationSyncs = pgTable(
  "github_installation_syncs",
  {
    id: uuid().defaultRandom().primaryKey(),
    kind: text().$type<"webhook" | "reconcile">().notNull(),
    providerApplicationId: text("provider_application_id"),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    // Preserve the original binding after disconnect; work must not follow its replacement.
    connectionId: uuid("connection_id"),
    deliveryId: text("delivery_id").unique(),
    signatureHash: text("signature_hash").unique(),
    source: text(),
    payload: jsonb(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true }).defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    auditLink: jsonb("audit_link").$type<GitHubSyncAuditLink>(),
    payloadExpiredAt: timestamp("payload_expired_at", { withTimezone: true }),
  },
  (table) => [
    index("github_installation_syncs_payload_unmarked_idx")
      .on(table.id)
      .where(sql`${table.kind} = 'webhook' and ${table.payloadExpiredAt} is null`),
    index("github_installation_syncs_pending_idx")
      .on(table.retryAt)
      .where(sql`${table.retryAt} is not null`),
    check(
      "github_installation_syncs_settlement_check",
      sql`(${table.settledAt} is null and ${table.auditLink} is null and ${table.payloadExpiredAt} is null)
        or (${table.kind} = 'webhook' and ${table.settledAt} is not null
            and ${table.retryAt} is null and ${table.auditLink} is not null)`,
    ),
    check(
      "github_installation_syncs_evidence_check",
      sql`(
    ${table.kind} = 'webhook' AND ${table.providerApplicationId} IS NOT NULL AND ${table.deliveryId} IS NOT NULL AND ${table.signatureHash} IS NOT NULL
    AND ${table.source} IS NOT NULL AND ${table.source} IN ('github.installation', 'github.installation_repositories') AND ${table.payload} IS NOT NULL
  ) OR (
    ${table.kind} = 'reconcile' AND ${table.connectionId} IS NOT NULL AND ${table.deliveryId} IS NULL
    AND ${table.signatureHash} IS NULL AND ${table.source} IS NULL AND ${table.payload} IS NULL
  )`,
    ),
  ],
);

export const githubRepositories = pgTable(
  "github_repositories",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("github_repositories_connection_repository_unique").on(
      table.connectionId,
      table.repositoryId,
    ),
    index("github_repositories_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.connectionId, table.organizationId],
      foreignColumns: [githubConnections.id, githubConnections.organizationId],
      name: "github_repositories_connection_organization_fk",
    }).onDelete("cascade"),
  ],
);

export const discordConnections = pgTable(
  "discord_connections",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    guildId: text("guild_id").notNull().unique(),
    providerApplicationId: text("provider_application_id"),
    slug: text().notNull(),
    guildName: text("guild_name").notNull(),
    connectedByUserId: text("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("discord_connections_id_organization_unique").on(table.id, table.organizationId),
    uniqueIndex("discord_connections_organization_slug_unique").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const slackConnections = pgTable(
  "slack_connections",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull().unique(),
    providerApplicationId: text("provider_application_id"),
    slug: text().notNull(),
    teamName: text("team_name").notNull(),
    botUserId: text("bot_user_id").notNull(),
    botAccessToken: text("bot_access_token").notNull(),
    scopes: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    connectedByUserId: text("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("slack_connections_id_organization_unique").on(table.id, table.organizationId),
    uniqueIndex("slack_connections_organization_slug_unique").on(table.organizationId, table.slug),
  ],
);

/**
 * One OAuth installation per Linear workspace. Tokens belong to the Hub organization, never to
 * an individual Paseo project; project-scoped trigger routes select the Linear project later.
 */
export const linearConnections = pgTable(
  "linear_connections",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    linearOrganizationId: text("linear_organization_id").notNull().unique(),
    providerApplicationId: text("provider_application_id"),
    slug: text().notNull(),
    linearOrganizationName: text("linear_organization_name").notNull(),
    appUserId: text("app_user_id").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    scopes: jsonb()
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    connectedByUserId: text("connected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("linear_connections_id_organization_unique").on(table.id, table.organizationId),
    uniqueIndex("linear_connections_organization_slug_unique").on(table.organizationId, table.slug),
    uniqueIndex("linear_connections_organization_external_unique").on(
      table.organizationId,
      table.linearOrganizationId,
    ),
  ],
);

export const projectConfigurationSources = pgTable(
  "project_configuration_sources",
  {
    organizationId: text("organization_id").notNull(),
    projectId: uuid("project_id").primaryKey(),
    kind: text().$type<(typeof CONFIGURATION_SOURCE_KINDS)[number]>().notNull(),
    githubConnectionId: uuid("github_connection_id"),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }),
    githubRepositoryFullName: text("github_repository_full_name"),
    githubDefaultBranch: text("github_default_branch"),
    automaticDeploymentEnabled: boolean("automatic_deployment_enabled").default(false).notNull(),
    selectedByUserId: text("selected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "project_configuration_sources_project_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.githubConnectionId, table.organizationId],
      foreignColumns: [githubConnections.id, githubConnections.organizationId],
      name: "project_configuration_sources_github_connection_organization_fk",
    }).onDelete("restrict"),
    check(
      "project_configuration_sources_authority_shape_check",
      sql`(${table.kind} = 'manual' and ${table.githubConnectionId} is null and ${table.githubRepositoryId} is null and not ${table.automaticDeploymentEnabled}) or (${table.kind} = 'github' and ${table.githubConnectionId} is not null and ${table.githubRepositoryId} is not null)`,
    ),
  ],
);

export const configurationSyncAttempts = pgTable(
  "configuration_sync_attempts",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: uuid("project_id").notNull(),
    githubConnectionId: uuid("github_connection_id"),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }),
    webhookDeliveryId: text("webhook_delivery_id"),
    commitSha: text("commit_sha"),
    outcome: text().notNull(),
    evidence: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("configuration_sync_attempts_project_created_idx").on(
      table.projectId,
      table.createdAt.desc(),
    ),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "configuration_sync_attempts_project_organization_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.githubConnectionId, table.organizationId],
      foreignColumns: [githubConnections.id, githubConnections.organizationId],
      name: "configuration_sync_attempts_github_connection_organization_fk",
    }).onDelete("set null"),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    actorKind: text("actor_kind").$type<"user" | "github" | "system">().notNull(),
    actorIdentity: text("actor_identity").notNull(),
    action: text().notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    evidence: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_organization_created_idx").on(table.organizationId, table.createdAt.desc()),
    index("audit_events_project_created_idx").on(table.projectId, table.createdAt.desc()),
    check("audit_events_actor_kind_check", sql`${table.actorKind} in ('user', 'github', 'system')`),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "audit_events_project_organization_fk",
    }).onDelete("cascade"),
  ],
);

export const members = pgTable(
  "member",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("members_organization_user_unique").on(table.organizationId, table.userId),
    index("members_user_id_idx").on(table.userId),
    index("members_organization_id_idx").on(table.organizationId),
    check("members_role_check", sql`${table.role} in ('owner', 'admin', 'member')`),
  ],
);

export const invitations = pgTable(
  "invitation",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: text().notNull(),
    status: text().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("invitations_organization_status_idx").on(table.organizationId, table.status),
    uniqueIndex("invitations_pending_organization_email_unique")
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(sql`${table.status} = 'pending'`),
    check("invitations_role_check", sql`${table.role} in ('admin', 'member')`),
    check(
      "invitations_status_check",
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'canceled')`,
    ),
  ],
);

export const instanceBootstrap = pgTable(
  "instance_bootstrap",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    appOnboardingCompletedAt: timestamp("app_onboarding_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "instance_bootstrap_completion_check",
      sql`${table.completedAt} is null or (${table.organizationId} is not null and ${table.ownerUserId} is not null)`,
    ),
  ],
);

export const runtimeConfiguration = pgTable(
  "runtime_configuration",
  {
    singleton: boolean().primaryKey().default(true),
    authSecret: text("auth_secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check("runtime_configuration_singleton_check", sql`${table.singleton}`)],
);

export const runtimeProviderConfiguration = pgTable(
  "runtime_provider_configuration",
  {
    provider: text().$type<(typeof CONNECTION_PROVIDERS)[number]>().primaryKey(),
    configuration: jsonb().notNull(),
    verifiedExternalIdentity: jsonb("verified_external_identity").notNull(),
    version: integer().default(1).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    check(
      "runtime_provider_configuration_provider_check",
      sql`${table.provider} in ('github', 'slack', 'discord', 'linear')`,
    ),
    check("runtime_provider_configuration_version_check", sql`${table.version} > 0`),
  ],
);

export const runtimeProviderActivations = pgTable(
  "runtime_provider_activation",
  {
    provider: text().$type<(typeof CONNECTION_PROVIDERS)[number]>().primaryKey(),
    providerApplicationId: text("provider_application_id").notNull(),
    configurationVersion: integer("configuration_version").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "runtime_provider_activation_provider_check",
      sql`${table.provider} in ('github', 'slack', 'discord', 'linear')`,
    ),
    check("runtime_provider_activation_version_check", sql`${table.configurationVersion} >= 0`),
  ],
);

export const organizationApiKeys = pgTable(
  "organization_api_keys",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    prefix: text().notNull(),
    verifier: text().notNull(),
    scopes: text().array().$type<readonly (typeof API_KEY_SCOPES)[number][]>().notNull(),
    actor: text(),
    allowedTriggers: text("allowed_triggers").array(),
    webhookAuthMode: text("webhook_auth_mode").$type<"hmac">(),
    webhookSignatureProfile: text("webhook_signature_profile").$type<"github_sha256">(),
    webhookTargetTriggerId: uuid("webhook_target_trigger_id"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("organization_api_keys_prefix_unique").on(table.prefix),
    uniqueIndex("organization_api_keys_org_id_unique").on(table.organizationId, table.id),
    check(
      "organization_api_keys_webhook_auth_check",
      sql`(
        ${table.webhookAuthMode} is null and ${table.webhookSignatureProfile} is null
        and ${table.webhookTargetTriggerId} is null
      ) or (
        ${table.webhookAuthMode} is not null and ${table.webhookAuthMode} = 'hmac'
        and ${table.webhookSignatureProfile} is not null
        and ${table.webhookSignatureProfile} = 'github_sha256'
        and ${table.webhookTargetTriggerId} is not null and ${table.actor} is not null
        and ${table.scopes} = ARRAY['events:send']::text[]
        and ${table.allowedTriggers} is not null and cardinality(${table.allowedTriggers}) = 1
        and coalesce(${table.allowedTriggers}[1] ~ '^[a-z][a-z0-9_-]*$', false)
      )`,
    ),
    index("organization_api_keys_organization_created_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    check(
      "organization_api_keys_scopes_check",
      sql`${table.scopes} <@ ARRAY['projects:read', 'configuration:validate', 'configuration:install', 'runs:dispatch', 'runs:read', 'daemons:enroll', 'events:send']::text[] and cardinality(${table.scopes}) > 0`,
    ),
    check(
      "organization_api_keys_actor_check",
      sql`${table.actor} is null or ${table.actor} ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'`,
    ),
  ],
);

export const organizationWebhookSecrets = pgTable(
  "organization_webhook_secrets",
  {
    organizationId: text("organization_id").notNull(),
    apiKeyId: uuid("api_key_id").notNull(),
    slot: text().$type<"current" | "previous">().notNull(),
    versionId: uuid("version_id").notNull().unique(),
    masterKeyId: text("master_key_id").notNull(),
    salt: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    acceptUntil: timestamp("accept_until", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.apiKeyId, table.slot] }),
    foreignKey({
      name: "organization_webhook_secrets_parent_fk",
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [organizationApiKeys.organizationId, organizationApiKeys.id],
    }).onDelete("cascade"),
    check(
      "organization_webhook_secrets_slot_check",
      sql`(${table.slot} = 'current' and ${table.acceptUntil} is null)
        or (${table.slot} = 'previous' and ${table.acceptUntil} is not null)`,
    ),
    check(
      "organization_webhook_secrets_material_check",
      sql`${table.masterKeyId} ~ '^[A-Za-z0-9_-]{1,64}$'
        and ${table.salt} ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'`,
    ),
  ],
);

export const ENTITLEMENT_CHANGE_SOURCES = ["provisioning", "plan_stamp", "override"] as const;

export const organizationEntitlements = pgTable("organization_entitlements", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  granted: jsonb().notNull(),
  overrides: jsonb().notNull().default({}),
  planId: text("plan_id"),
  planVersion: text("plan_version"),
  stampedAt: timestamp("stamped_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const entitlementChanges = pgTable(
  "entitlement_changes",
  {
    id: uuid().defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actor: text(),
    source: text().$type<(typeof ENTITLEMENT_CHANGE_SOURCES)[number]>().notNull(),
    before: jsonb(),
    after: jsonb().notNull(),
    reason: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("entitlement_changes_organization_created_idx").on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    check(
      "entitlement_changes_source_check",
      sql`${table.source} in ('provisioning', 'plan_stamp', 'override')`,
    ),
  ],
);

export const organizationUsage = pgTable(
  "organization_usage",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    meter: text().notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    used: bigint({ mode: "number" }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.meter, table.periodStart] }),
    index("organization_usage_organization_meter_idx").on(table.organizationId, table.meter),
    // Usage only ever accumulates; a negative counter would be a corruption, so the database
    // refuses it independently of any caller validation.
    check("organization_usage_used_non_negative", sql`${table.used} >= 0`),
  ],
);

export const BILLING_PLAN_PRICE_INTERVALS = ["monthly", "annual"] as const;

// Mirror of Stripe's plan catalog (products + prices tagged `metadata.paseo_plan=true`).
// `id` is the Stripe product id; nothing else in the schema references it — see the plan's
// "materialize, don't reference" decision. Self-hosted instances never sync, so these tables
// stay empty rather than absent.
export const billingPlans = pgTable("billing_plans", {
  id: text().primaryKey(),
  // Unique: `slug` is catalog identity (`{slug}_{interval}` lookup keys resolve prices, and
  // checkout selects a plan by slug). Two products claiming one slug is a rejected ambiguity, not
  // an arbitrary winner — the sync drops the colliding products and this constraint is the backstop.
  slug: text().notNull().unique(),
  name: text().notNull(),
  template: jsonb().notNull(),
  templateHash: text("template_hash").notNull(),
  marketing: jsonb().notNull(),
  active: boolean().notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
});

export const billingPlanPrices = pgTable(
  "billing_plan_prices",
  {
    id: text().primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => billingPlans.id, { onDelete: "cascade" }),
    lookupKey: text("lookup_key").notNull(),
    interval: text().$type<(typeof BILLING_PLAN_PRICE_INTERVALS)[number]>().notNull(),
    unitAmount: integer("unit_amount").notNull(),
    currency: text().notNull(),
    active: boolean().notNull(),
  },
  (table) => [
    index("billing_plan_prices_plan_id_idx").on(table.planId),
    check("billing_plan_prices_interval_check", sql`${table.interval} in ('monthly', 'annual')`),
  ],
);

// The organization's current Stripe subscription, mirrored locally. One row per organization
// (`referenceId = organizationId`). `plan_id` is a soft reference to `billing_plans.id`, resolved
// from the subscription's price at webhook time — never dereferenced by enforcement, which reads
// only `organization_entitlements`. `status` carries Stripe's own vocabulary verbatim, so no
// check constraint drifts against it. Self-hosted instances never write here.
export const organizationBillingCustomers = pgTable("organization_billing_customers", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Scheduling owns recurrence and one active run across revisions and disable/re-enable. */
export const triggerSchedules = pgTable(
  "trigger_schedules",
  {
    triggerId: uuid("trigger_id")
      .primaryKey()
      .references(() => organizationTriggers.id, { onDelete: "cascade" }),
    recurrence: jsonb(),
    nextAt: timestamp("next_at", { withTimezone: true }),
    activeRunId: uuid("active_run_id").references(() => triggerRuns.id, { onDelete: "set null" }),
  },
  (table) => [index("trigger_schedules_due_idx").on(table.nextAt)],
);

/** Where the GitHub notifications poll resumes. One row per source; Hub has a single source. */
export const githubNotificationCursors = pgTable("github_notification_cursors", {
  source: text().primaryKey(),
  /** Last-Modified of the newest successful response, replayed as If-Modified-Since. */
  lastModified: text("last_modified"),
  since: timestamp({ withTimezone: true }).notNull(),
  /** Earliest time the next poll may run, from the poll interval GitHub asked for. */
  nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  /** Shown in the Triggers page. Not read by the poll itself. */
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  /** The latest failure message with the token removed. Cleared by the next success. */
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  diagnosticExpiredAt: timestamp("diagnostic_expired_at", { withTimezone: true }),
});

export const executionAuthorities = pgTable("execution_authorities", {
  executionId: uuid("execution_id")
    .primaryKey()
    .references(() => agentExecutions.id, { onDelete: "cascade" }),
  data: jsonb("data").notNull(),
});

export const executionCredentialLeases = pgTable(
  "execution_credential_leases",
  {
    id: uuid("id").primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => agentExecutions.id, { onDelete: "cascade" }),
    data: jsonb("data").notNull(),
  },
  (table) => [index("execution_credential_leases_execution_idx").on(table.executionId)],
);

export const interactiveSessionProfiles = pgTable(
  "interactive_session_profiles",
  {
    id: uuid().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    daemonId: uuid("daemon_id").notNull(),
    cwd: text().notNull(),
    worktree:
      jsonb().$type<
        import("../interactive-sessions/types.js").SessionProfileSettings["worktree"]
      >(),
    provider: text().notNull(),
    model: text(),
    mode: text(),
    thinkingOptionId: text("thinking_option_id"),
    providerOptions: jsonb("provider_options")
      .$type<Readonly<Record<string, JsonValue>>>()
      .default({})
      .notNull(),
    fullAccessAcknowledged: boolean("full_access_acknowledged").default(false).notNull(),
    status: text()
      .$type<import("../interactive-sessions/types.js").SessionProfileStatus>()
      .notNull(),
    version: integer().default(1).notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("interactive_session_profiles_id_org_unique").on(table.id, table.organizationId),
    uniqueIndex("interactive_session_profiles_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
    foreignKey({
      columns: [table.daemonId, table.organizationId],
      foreignColumns: [daemons.id, daemons.organizationId],
      name: "interactive_session_profiles_daemon_org_fk",
    }),
    check(
      "interactive_session_profiles_name_check",
      sql`char_length(${table.name}) between 1 and 80`,
    ),
    check(
      "interactive_session_profiles_cwd_check",
      sql`octet_length(${table.cwd}) <= 1024 and (
      left(${table.cwd}, 1) = '/' or left(${table.cwd}, 2) = repeat(chr(92), 2)
      or (left(${table.cwd}, 2) ~ '^[A-Za-z]:$' and substr(${table.cwd}, 3, 1) in ('/', chr(92))))`,
    ),
    check(
      "interactive_session_profiles_worktree_check",
      sql`${table.worktree} is null or (
      jsonb_typeof(${table.worktree}) = 'object' and
      ${table.worktree} @> '{"mode":"branch-off"}'::jsonb and
      ${table.worktree} - 'mode' - 'base' = '{}'::jsonb and
      (not (${table.worktree} ? 'base') or jsonb_typeof(${table.worktree}->'base') = 'string'))`,
    ),
    check(
      "interactive_session_profiles_options_check",
      sql`jsonb_typeof(${table.providerOptions}) = 'object' and octet_length(${table.providerOptions}::text) <= 4096`,
    ),
    check(
      "interactive_session_profiles_access_check",
      sql`${table.provider} <> 'omp' or
      (${table.mode} is not null and (${table.mode} <> 'full' or ${table.fullAccessAcknowledged}))`,
    ),
    check(
      "interactive_session_profiles_status_check",
      sql`${table.status} in ('active', 'disabled') and ${table.version} > 0`,
    ),
  ],
);

export const interactiveSessions = pgTable(
  "interactive_sessions",
  {
    id: uuid().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    profileVersion: integer("profile_version").notNull(),
    launch: jsonb().$type<import("../interactive-sessions/types.js").SessionLaunch>().notNull(),
    daemonId: uuid("daemon_id").notNull(),
    title: text().notNull(),
    state: text().$type<import("../interactive-sessions/types.js").SessionState>().notNull(),
    stateReason:
      text("state_reason").$type<import("../interactive-sessions/types.js").SessionStateReason>(),
    generation: integer().default(1).notNull(),
    turn: integer().default(0).notNull(),
    daemonAgentId: text("daemon_agent_id"),
    daemonWorkspaceId: text("daemon_workspace_id"),
    hubSeq: integer("hub_seq").default(0).notNull(),
    commandSeq: integer("command_seq").default(0).notNull(),
    startedByUserId: text("started_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    startIdempotencyKey: uuid("start_idempotency_key").notNull(),
    startRequestHash: text("start_request_hash").notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: text("closed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("interactive_sessions_id_org_unique").on(table.id, table.organizationId),
    uniqueIndex("interactive_sessions_start_key_unique").on(
      table.organizationId,
      table.startedByUserId,
      table.startIdempotencyKey,
    ),
    index("interactive_sessions_org_activity_idx").on(
      table.organizationId,
      table.lastActivityAt.desc(),
      table.id.desc(),
    ),
    index("interactive_sessions_open_daemon_idx")
      .on(table.daemonId)
      .where(sql`${table.state} <> 'closed'`),
    foreignKey({
      columns: [table.profileId, table.organizationId],
      foreignColumns: [interactiveSessionProfiles.id, interactiveSessionProfiles.organizationId],
      name: "interactive_sessions_profile_org_fk",
    }),
    foreignKey({
      columns: [table.daemonId, table.organizationId],
      foreignColumns: [daemons.id, daemons.organizationId],
      name: "interactive_sessions_daemon_org_fk",
    }),
    check(
      "interactive_sessions_state_check",
      sql`${table.state} in ('starting', 'running', 'idle', 'waiting_permission', 'stopping', 'failed', 'closed')`,
    ),
    check(
      "interactive_sessions_reason_check",
      sql`${table.stateReason} in ('stopped_by_person', 'launch_failed', 'agent_missing', 'daemon_revoked', 'closed_by_person')`,
    ),
    check(
      "interactive_sessions_closed_check",
      sql`(${table.state} = 'closed') = (${table.closedAt} is not null)`,
    ),
  ],
);

export const interactiveSessionParticipants = pgTable(
  "interactive_session_participants",
  {
    sessionId: uuid("session_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text().$type<import("../interactive-sessions/types.js").ParticipantRole>().notNull(),
    addedByUserId: text("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.userId] }),
    foreignKey({
      columns: [table.sessionId, table.organizationId],
      foreignColumns: [interactiveSessions.id, interactiveSessions.organizationId],
      name: "interactive_session_participants_session_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [members.organizationId, members.userId],
      name: "interactive_session_participants_member_org_fk",
    }).onDelete("cascade"),
    index("interactive_session_participants_org_user_idx").on(table.organizationId, table.userId),
    check(
      "interactive_session_participants_role_check",
      sql`${table.role} in ('controller', 'viewer')`,
    ),
  ],
);

export const interactiveSessionCommands = pgTable(
  "interactive_session_commands",
  {
    id: uuid().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull(),
    ordinal: integer().notNull(),
    generation: integer().notNull(),
    kind: text().$type<import("../interactive-sessions/types.js").CommandKind>().notNull(),
    delivery: text().$type<import("../interactive-sessions/types.js").Delivery>(),
    status: text().$type<import("../interactive-sessions/types.js").CommandStatus>().notNull(),
    failureCode:
      text("failure_code").$type<import("../interactive-sessions/types.js").CommandFailureCode>(),
    body: text(),
    bodyExpiredAt: timestamp("body_expired_at", { withTimezone: true }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    attempts: integer().default(0).notNull(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.sessionId, table.organizationId],
      foreignColumns: [interactiveSessions.id, interactiveSessions.organizationId],
      name: "interactive_session_commands_session_org_fk",
    }).onDelete("cascade"),
    uniqueIndex("interactive_session_commands_id_session_org_unique").on(
      table.id,
      table.sessionId,
      table.organizationId,
    ),
    uniqueIndex("interactive_session_commands_ordinal_unique").on(table.sessionId, table.ordinal),
    uniqueIndex("interactive_session_commands_key_unique").on(
      table.sessionId,
      table.authorUserId,
      table.idempotencyKey,
    ),
    index("interactive_session_commands_dispatch_idx")
      .on(table.sessionId, table.ordinal)
      .where(sql`${table.status} in ('pending', 'queued', 'dispatching', 'unknown')`),
    index("interactive_session_commands_expiry_idx")
      .on(table.createdAt)
      .where(sql`${table.body} is not null`),
    check(
      "interactive_session_commands_kind_check",
      sql`${table.kind} in ('message', 'stop', 'close', 'replace')`,
    ),
    check(
      "interactive_session_commands_status_check",
      sql`${table.status} in ('pending', 'queued', 'dispatching', 'delivered', 'unknown', 'superseded', 'failed', 'done')`,
    ),
    check(
      "interactive_session_commands_delivery_check",
      sql`(${table.kind} = 'message') = (${table.delivery} is not null) and ${table.delivery} in ('steer', 'queue')`,
    ),
    check(
      "interactive_session_commands_body_check",
      sql`octet_length(${table.body}) <= 16384 and
      (${table.kind} <> 'message' or ${table.body} is not null or ${table.bodyExpiredAt} is not null) and
      (${table.bodyExpiredAt} is null or ${table.body} is null)`,
    ),
    check(
      "interactive_session_commands_failure_check",
      sql`${table.failureCode} in ('key_conflict', 'agent_missing', 'daemon_rejected', 'launch_failed', 'delivery_unconfirmed')`,
    ),
  ],
);

export const interactiveSessionEvents = pgTable(
  "interactive_session_events",
  {
    sessionId: uuid("session_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    kind: text()
      .$type<import("../interactive-sessions/types.js").SessionEventRecord["kind"]>()
      .notNull(),
    commandId: uuid("command_id"),
    data: jsonb()
      .$type<import("../interactive-sessions/types.js").SessionEventRecord["data"]>()
      .notNull(),
    at: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.seq] }),
    foreignKey({
      columns: [table.sessionId, table.organizationId],
      foreignColumns: [interactiveSessions.id, interactiveSessions.organizationId],
      name: "interactive_session_events_session_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.commandId, table.sessionId, table.organizationId],
      foreignColumns: [
        interactiveSessionCommands.id,
        interactiveSessionCommands.sessionId,
        interactiveSessionCommands.organizationId,
      ],
      name: "interactive_session_events_command_session_org_fk",
    }).onDelete("cascade"),
    check(
      "interactive_session_events_kind_check",
      sql`${table.kind} in ('message', 'delivery', 'state', 'participants')`,
    ),
    check("interactive_session_events_data_check", sql`octet_length(${table.data}::text) <= 1024`),
  ],
);
