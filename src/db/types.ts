import type { InteractiveSessionStore } from "../interactive-sessions/store.js";
import type { RunPayloadRetentionStore } from "../run-payload-retention/store.js";
import type {
  PayloadCompletion,
  RunPayloadSummary,
  StepPayloadSummary,
} from "../run-payload-retention/summary.js";
import type { RunTimelineStore } from "../run-timeline/store.js";
import type {
  AgentExecutionStatus,
  MachineSource,
  MachineStatus,
  ReceiptPayloadExpiryState,
  ReceiptPreRoutingDrop,
  ManualReceiptReplayBinding,
} from "./schema.js";
export type {
  ReceiptPayloadExpiryState,
  ReceiptPreRoutingDrop,
  ManualReceiptReplayBinding,
} from "./schema.js";
import type { JsonValue } from "../config/compiler.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { InvocationRejection } from "../triggers/invocation.js";
import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import type { ListProvider } from "../triggers/list-providers.js";
import type {
  EntitlementPatch,
  EntitlementTemplate,
  OverrideKey,
} from "../entitlements/catalog.js";

export type WorkflowDeadlineKind = "step_hard" | "step_idle" | "whole_run";

export interface ManualReceiptReplayTarget {
  projectId: string;
  source: string;
  publicTriggerName?: string;
  boundWebhookTrigger?: BoundWebhookTrigger;
}

export interface ProviderEventReceiptRecord {
  startedByUserId?: string;
  id: string;
  organizationId: string;
  provider:
    | "github"
    | "slack"
    | "discord"
    | "linear"
    | "manual"
    | "schedule"
    | "github_notification";
  connectionId: string | null;
  resourceId: string | null;
  deliveryId: string;
  signatureHash: string | null;
  providerApplicationId: string | null;
  providerConfigurationVersion: number | null;
  source: string;
  repo: string | null;
  payload: unknown;
  receivedAt: Date;
  droppedReason: string | null;
  acceptedRoutes: readonly ProviderEventRouteSnapshot[] | null;
  payloadExpiryState?: ReceiptPayloadExpiryState | null;
  payloadExpiredAt?: Date | null;
  preRoutingDrop?: ReceiptPreRoutingDrop | null;
  manualReplayBinding?: ManualReceiptReplayBinding | null;
}

export interface ProviderEventReceiptSummary {
  id: string;
  organizationId: string;
  provider: ProviderEventReceiptRecord["provider"];
  connectionId: string | null;
  resourceId: string | null;
  deliveryId: string;
  signatureHash: string | null;
  source: string;
  repo: string | null;
  receivedAt: Date;
  droppedReason: string | null;
  payloadExpiryState?: ReceiptPayloadExpiryState | null;
}

export type ProviderEventReplayMetadata = Pick<
  ProviderEventReceiptRecord,
  "id" | "provider" | "source" | "droppedReason" | "payloadExpiryState" | "manualReplayBinding"
>;

export type TriggerRunAdmission<T extends TriggerRunRecord> =
  | { run: T; created: boolean }
  | { created: false; receiptReplay: true; runId: string | undefined };

/** One run as an organization overview reads it: what fired, what happened, and which agent ran. */
export interface OrganizationRunRecord {
  id: string;
  /** The trigger's name as the user wrote it, never the internal name of one of its events. */
  triggerName: string;
  provider: ProviderEventReceiptRecord["provider"];
  source: string;
  status: TriggerRunRecord["status"];
  receivedAt: Date;
  payloadExpiredAt?: string | null;
  /** The agent the dispatched launch intent named; null before dispatch or when nothing launched. */
  agent: { provider: string; model: string | null } | null;
}

/** How many events a provider delivered that no trigger was listening for. */
export interface UnroutedProviderEventCount {
  provider: ProviderEventReceiptRecord["provider"];
  count: number;
}

export interface ProviderEventRouteSnapshot {
  projectId: string;
  configurationRevisionId: string;
  connectionId: string | null;
  resourceId: string | null;
}

export type AttachmentProvider = "slack" | "discord";

export interface AttachmentRecord {
  id: string;
  providerEventReceiptId: string;
  organizationId: string;
  connectionId: string;
  provider: AttachmentProvider;
  sourceId: string;
  locator: unknown;
  filename: string;
  contentType: string | null;
  byteSize: number | null;
  createdAt: Date;
}

export interface InsertAttachmentInput {
  providerEventReceiptId: string;
  organizationId: string;
  connectionId: string;
  provider: AttachmentProvider;
  sourceId: string;
  locator: unknown;
  filename: string;
  contentType?: string | null;
  byteSize?: number | null;
}

export interface MachineRecord {
  id: string;
  orgId: string;
  source: MachineSource;
  status: MachineStatus;
  startedAt: Date;
  terminatedAt: Date | null;
  shutdownReason: string | null;
  triggerName: string | null;
  triggerContext: unknown;
  specs: unknown;
}

export interface AgentExecutionRecord {
  payloadCompletion?: PayloadCompletion | null;
  agentSessionId: string | null;
  agentSessionAction: import("../agent-sessions/index.js").AgentSessionAction | null;
  id: string;
  organizationId: string;
  projectId: string;
  machineId: string | null;
  status: AgentExecutionStatus;
  startedAt: Date;
  completedAt: Date | null;
  completedByAgentAt: Date | null;
  deadlineAt: Date | null;
  idleDeadlineAt: Date | null;
  result: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  reactionState: JsonValue | null;
  configurationRevisionId: string;
  completionTokenHash: string | null;
  replyClaimedAt: Date | null;
  replyClaimCount: number;
  outputEmissions: Readonly<Record<string, number>>;
  outputDeliveryAttempts: Readonly<Record<string, AgentExecutionOutputAttempt>>;
  launchIntent: LaunchMachineIntent | null;
  usedTemporaryCredentials?: boolean | null;
  launchIntentExpiredAt?: Date | null;
  launchRunId?: string | null;
  launchAgent?: import("../run-payload-retention/summary.js").PayloadAgentSummary | null;
  daemonId: string | null;
  daemonAgentId: string | null;
  workflowStepRunId: string | null;
  hubAction: HubAction | null;
  hubActionCompletedAt: Date | null;
  hubActionReadyAt: Date | null;
  hubActionAcknowledgements: AgentExecutionHubAcknowledgements;
}

export type AgentExecutionOutputAttemptStatus = "pending" | "succeeded" | "failed";

export interface AgentExecutionOutputAttempt {
  id: string;
  outputType: string;
  status: AgentExecutionOutputAttemptStatus;
  startedAt: Date;
  leaseExpiresAt: Date;
  completedAt: Date | null;
}

export type HubAction = "interrupt" | "archive";

export type AgentExecutionHubFinishExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentExecutionHubFinishExecutionAcknowledgement {
  callId: string | null;
  status: AgentExecutionHubFinishExecutionStatus;
  observedAt: Date;
}

export type PendingHubActionScope = { kind: "ordinary" } | { kind: "stop"; limit: number };

export interface AgentExecutionHubAcknowledgements {
  terminalAt: Date | null;
  idleAt: Date | null;
  finishExecutionCall: AgentExecutionHubFinishExecutionAcknowledgement | null;
  stopInterruptGeneration?: string;
}

export type AgentExecutionHubAcknowledgementInput =
  | { kind: "terminal"; observedAt: Date }
  | { kind: "idle"; observedAt: Date }
  | {
      kind: "finish_execution";
      callId?: string | null;
      status: AgentExecutionHubFinishExecutionStatus;
      observedAt: Date;
    };

export interface DaemonRecord {
  id: string;
  slug: string;
  machineId: string;
  serverId: string;
  daemonPublicKey: string;
  credentialVerifier: string;
  permissions: string[];
  registeredByApiKeyId: string | null;
  registeredByCliCredentialId: string | null;
  status: "active" | "revoked";
  presence: "offline" | "connected";
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface DaemonSlugConflict {
  status: "slug_conflict";
  slug: string;
}

export type DaemonWriteResult = DaemonRecord | DaemonSlugConflict | undefined;

export interface EnrollmentTokenRecord {
  id: string;
  verifier: string;
  organizationId: string;
  issuedByApiKeyId?: string | null;
  issuedByCliCredentialId?: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface CliAuthorizationRecord {
  id: string;
  status: "pending" | "approved" | "denied" | "expired" | "disclosed";
  pollIntervalSeconds: number;
  approvedOrganizationId: string | null;
  approvedByUserId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface StartCliAuthorizationInput {
  id: string;
  deviceVerifier: string;
  userCodeVerifier: string;
  fingerprintVerifier: string;
  lifetimeSeconds: number;
  pollIntervalSeconds: number;
  perFingerprintLimit: number;
  globalLimit: number;
}

export type CliAuthorizationPollResult =
  | { status: "pending" | "slow_down"; intervalSeconds: number }
  | { status: "authorized"; intervalSeconds: number; organizationId: string }
  | { status: "denied" | "expired" | "disclosed"; intervalSeconds: number };

export interface DeviceDecisionAccess {
  sessionId: string;
  userId: string;
  membershipId: string;
  organizationId: string;
}

export type CliAuthorizationDecisionInput = {
  userCodeVerifier: string;
  access: DeviceDecisionAccess;
} & { decision: "approve" | "deny" };

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  status: "active" | "archived";
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  activeConfigurationRevisionId: string | null;
}

export interface TenantRouteAccess {
  organization: { id: string; name: string; slug: string };
  membership: { id: string; role: "owner" | "admin" | "member" };
  project?: ProjectRecord;
}

export interface OrganizationConnectionUsage {
  github: GitHubConnectionRecord[];
  discord: DiscordConnectionRecord[];
  slack: SlackConnectionRecord[];
  linear: LinearConnectionRecord[];
}

export interface GitHubRepositoryRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
}

export interface GitHubConfigurationTarget extends GitHubRepositoryRecord {
  projectId: string;
  installationId: number;
  automaticDeploymentEnabled: boolean;
}

export interface ConfigurationSyncAttemptRecord {
  id: string;
  projectId: string;
  githubConnectionId: string | null;
  githubRepositoryId: number | null;
  webhookDeliveryId: string | null;
  commitSha: string | null;
  outcome: string;
  evidence: unknown;
  createdAt: Date;
}

export interface ProjectConfigurationReadModel {
  authority: "manual" | "github";
  activeRevision: ProjectConfigurationRevisionRecord | null;
  lastSyncAttempt: ConfigurationSyncAttemptRecord | null;
  sourceState:
    | { kind: "manual"; formattingPreserved: boolean }
    | {
        kind: "github";
        githubConnectionId: string;
        githubRepositoryId: number;
        githubRepositoryFullName: string;
        githubDefaultBranch: string;
        automaticDeploymentEnabled: boolean;
      };
}

export interface ProjectConfigurationRevisionRecord {
  id: string;
  projectId: string;
  organizationId: string;
  version: number;
  sourceKind: "github" | "manual";
  sourceEvidence: unknown;
  rawYaml: string | null;
  normalizedConfiguration: unknown;
  validationErrors: unknown;
  contentHash: string;
  createdByUserId: string | null;
  receivedAt: Date | null;
  createdAt: Date;
  validatedAt: Date | null;
}

export interface OrganizationTriggerRecord {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  format: "single_run" | "legacy_multistep";
  /** Temporary workflow-engine adapter; never exposed as a product project. */
  runtimeProjectId: string;
  activeRevisionId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationTriggerRevisionRecord {
  id: string;
  triggerId: string;
  organizationId: string;
  version: number;
  yaml: string;
  normalizedConfiguration: unknown;
  contentHash: string;
  sourceKind: "manual" | "github" | "project_migration";
  sourceEvidence: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}

export type TriggerListKey = Pick<OrganizationTriggerRecord, "name" | "id">;

export interface TriggerListRequest {
  limit: number;
  nameContains?: string;
  enabled?: boolean;
  provider?: ListProvider;
  position?: { direction: "next" | "previous"; key: TriggerListKey };
}

export interface TriggerListPage {
  records: OrganizationTriggerRecord[];
  next: TriggerListKey | null;
  previous: TriggerListKey | null;
}

export interface PendingProjectTriggerMigration {
  project: ProjectRecord;
  revision: ProjectConfigurationRevisionRecord;
}

export type ConnectionProvider = "github" | "discord" | "slack" | "linear";

export type ConnectionAttemptPhase =
  | "github_setup"
  | "github_user_authorization"
  | "discord_authorization"
  | "slack_authorization"
  | "linear_authorization";

export interface ConnectionAccountAccess {
  sessionId: string;
  userId: string;
}

export interface ConnectionStartAuthority extends ConnectionAccountAccess {
  membershipId: string;
  organizationId: string;
  returnRoute: string;
}

export interface ConnectionAttemptRecord {
  id: string;
  provider: ConnectionProvider;
  phase: ConnectionAttemptPhase;
  organizationId: string;
  returnRoute: string;
  userId: string;
  sessionId: string;
  candidateExternalId: string | null;
  pkceVerifier: string | null;
  configurationVersion: number;
  providerApplicationId: string | null;
  callbackOrigin: string;
  configurationSnapshot: unknown;
  expectedConfigurationVersion: number | null;
  activateConfiguration: boolean;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface ConnectionAttemptConfigurationSnapshot {
  configurationVersion: number;
  callbackOrigin: string;
  configurationSnapshot: unknown;
  expectedConfigurationVersion: number | null;
  activateConfiguration: boolean;
}

export interface GitHubConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
  providerApplicationId: string | null;
}

export interface DiscordConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  guildId: string;
  guildName: string;
  providerApplicationId: string | null;
}

export interface SlackConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
  providerApplicationId: string | null;
}

export interface LinearConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  providerApplicationId: string | null;
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface StartConnectionAttemptInput {
  provider: ConnectionProvider;
  stateVerifier: string;
  access: ConnectionStartAuthority;
  lifetimeMinutes: number;
  configurationVersion: number;
  providerApplicationId: string;
  callbackOrigin: string;
  configurationSnapshot: unknown;
  expectedConfigurationVersion: number | null;
  activateConfiguration: boolean;
}

export interface ReadConnectionAttemptInput {
  stateVerifier: string;
  phase: ConnectionAttemptPhase;
  access: ConnectionAccountAccess;
}

export interface AdvanceGitHubConnectionAttemptInput extends ReadConnectionAttemptInput {
  nextStateVerifier: string;
  installationId: number;
  pkceVerifier: string;
}

export type GitHubRepositorySnapshot = Pick<
  GitHubRepositoryRecord,
  "repositoryId" | "fullName" | "defaultBranch"
>[];

export interface BindGitHubConnectionInput extends ReadConnectionAttemptInput {
  repositories: GitHubRepositorySnapshot;
  providerApplicationId: string;
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
}

export interface BindDiscordConnectionInput extends ReadConnectionAttemptInput {
  providerApplicationId: string;
  guildId: string;
  guildName: string;
}

export interface BindSlackConnectionInput extends ReadConnectionAttemptInput {
  providerApplicationId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
}

export interface CompleteSlackProviderApplicationInput extends BindSlackConnectionInput {
  providerConfiguration: {
    configuration: unknown;
    identity: { id: string };
    expectedVersion: number | undefined;
    updatedByUserId: string;
  };
}

export interface BindLinearConnectionInput extends ReadConnectionAttemptInput {
  providerApplicationId: string;
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes: string[];
}

export interface CompleteLinearProviderApplicationInput extends BindLinearConnectionInput {
  providerConfiguration: {
    configuration: unknown;
    identity: { id: string };
    expectedVersion: number | undefined;
    updatedByUserId: string;
  };
}

export interface UpdateLinearConnectionTokensInput {
  connectionId: string;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

export type LinearConnectionTokenUpdate = Omit<UpdateLinearConnectionTokensInput, "connectionId">;

export type LinearConnectionRefreshOperation<T> = (
  connection: LinearConnectionRecord | undefined,
  updateTokens: (input: LinearConnectionTokenUpdate) => Promise<void>,
) => Promise<T>;

export type DisconnectConnectionResult =
  | { provider: "github" }
  | { provider: "discord"; guildId: string | undefined }
  | {
      provider: "slack";
      teamId: string | undefined;
      botAccessToken: string | undefined;
    }
  | {
      provider: "linear";
      linearOrganizationId: string | undefined;
      accessToken: string | undefined;
    };

export type GitHubLifecycleIdentity = Omit<
  GitHubConnectionRecord,
  "id" | "organizationId" | "installationId" | "slug" | "providerApplicationId"
>;

export interface InsertProviderEventInput {
  organizationId: string;
  projectId: string | null;
  configurationRevisionId?: string | null;
  receiptId?: string;
  connectionId?: string | null;
  resourceId?: string | null;
  deliveryId: string;
  signatureHash?: string | null;
  source: string;
  repo?: string | null;
  payload: unknown;
  receivedAt: Date;
  matchedTriggerName?: string | null;
  droppedReason?: string | null;
}

export interface InsertProviderEventResult {
  inserted: boolean;
  receipt: ProviderEventReceiptRecord;
}

export interface DurableProviderEvent {
  providerEventReceiptId: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  deliveryId: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
  connectionId: string | null;
  resourceId: string | null;
}

export type ProviderEventAcceptance =
  | { status: "accepted"; events: DurableProviderEvent[]; receiptId: string }
  | { status: "duplicate"; receiptId: string; payloadExpiryState?: ReceiptPayloadExpiryState }
  | {
      status: "dropped";
      receiptId: string;
      reason: string;
      payloadExpiryState?: ReceiptPayloadExpiryState;
    };

export interface ProviderEventEvidence {
  deliveryId: string;
  signatureHash?: string | null;
  providerApplicationId?: string | null;
  providerConfigurationVersion?: number | null;
  source: string;
  repo?: string | null;
  payload: unknown;
  receivedAt: Date;
  dropReason?: string;
}

export interface AcceptGitHubEventInput extends ProviderEventEvidence {
  installationId: number;
  repositoryId?: number;
}

export interface AcceptDiscordEventInput extends ProviderEventEvidence {
  guildId: string;
}

export interface AcceptSlackEventInput extends ProviderEventEvidence {
  teamId: string;
}

export interface AcceptLinearEventInput extends ProviderEventEvidence {
  linearOrganizationId: string;
  projectId?: string;
}

export interface BoundWebhookTrigger {
  id: string;
  name: string;
  configurationRevisionId: string;
}

export interface PersistManualEventInput extends InsertProviderEventInput {
  startedByUserId?: string;
  boundWebhookTrigger?: BoundWebhookTrigger;
  publicTriggerName?: string;
  organizationId: string;
  projectId: string;
}

export type ManualEventPersistence =
  | { status: "accepted"; event: DurableProviderEvent; replayed?: boolean }
  | {
      status: "duplicate";
      providerEventReceiptId: string;
      replayed?: boolean;
      payloadExpiryState?: ReceiptPayloadExpiryState;
    };

export interface GitHubInstallationSyncOwner {
  providerApplicationId: string;
  configurationVersion: number;
}

export interface GitHubLifecycleReceiptClaimInput {
  providerApplicationId: string;
  installationId: number;
  deliveryId: string;
  signatureHash: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
}

export type GitHubInstallationSyncClaim =
  | { status: "claimed"; installationSyncId: string; installationId: number }
  | { status: "duplicate"; installationSyncId: string };

export type GitHubInstallationSyncResult =
  | { status: "absent"; removeBinding: boolean }
  | {
      status: "present";
      identity: GitHubLifecycleIdentity;
      repositories: GitHubRepositorySnapshot;
    };

export interface InsertMachineInput {
  orgId: string;
  source: MachineSource;
  status?: MachineStatus;
  triggerName?: string | null;
  triggerContext?: unknown;
  specs?: unknown;
}

export interface InsertAgentExecutionInput {
  id?: string;
  organizationId: string;
  projectId: string;
  machineId: string | null;
  daemonId?: string | null;
  startedAt?: Date;
  triggerContext: unknown;
  outputContext: unknown;
  configurationRevisionId: string;
  completionTokenHash?: string | null;
  deadlineAt?: Date | null;
  idleDeadlineAt?: Date | null;
  workflowStepRunId?: string | null;
  launchIntent?: LaunchMachineIntent | null;
  status?: "spawning" | "failed";
  result?: unknown;
  reactionState?: JsonValue | null;
}

interface TriggerRunEvidence {
  startedByUserId?: string;
  payloadExpiredAt?: Date | null;
  payloadSummary?: RunPayloadSummary | null;
  payloadExpiryState?: "expiring" | "expired" | null;
  conversation: import("../triggers/continuation.js").Conversation | null;
  id: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  providerEventReceiptId: string;
  configuredTriggerName: string;
  prompt: string;
  inputs: unknown;
  values: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  createdAt: Date;
}

export interface AcceptedTriggerRunRecord extends TriggerRunEvidence {
  outcome: "accepted";
  status: "running" | "succeeded" | "failed" | "timed_out" | "canceled";
  deadlineAt: Date;
  deadlineKind: WorkflowDeadlineKind | null;
  failureReason: string | null;
  reactionState: JsonValue | null;
  terminalNotificationGeneration?: number;
  terminalNotificationPendingAt: Date | null;
  terminalNotificationDeliveredAt: Date | null;
  terminalNotificationLeaseExpiresAt: Date | null;
  completedAt: Date | null;
}

export interface RejectedTriggerRunRecord extends TriggerRunEvidence {
  outcome: "rejected";
  status: "rejected";
  rejection: InvocationRejection;
  completedAt: Date;
}

export type TriggerRunRecord = AcceptedTriggerRunRecord | RejectedTriggerRunRecord;

export interface ProjectActivityRunRecord {
  run: TriggerRunRecord;
  receipt: ProviderEventReceiptRecord;
  steps: readonly WorkflowStepRunRecord[];
}

export interface ProjectActivityRunListRecord {
  run: TriggerRunRecord;
  receipt: ProviderEventReceiptSummary;
  webhookActor?: string;
}

/** Where a run list reads from; `triggerName` narrows a project shared with other triggers. */
export interface ActivityRunScope {
  projectId: string;
  triggerName?: string;
}

/** Position of a run in newest-first order. `createdAt` is the store's own text, so no precision is lost. */
export interface ActivityRunKey {
  createdAt: string;
  id: string;
}

export interface ActivityRunPageRequest {
  limit: number;
  status?: TriggerRunRecord["status"];
  provider?: ListProvider;
  createdSince?: Date;
  /** `before` reads older than the key, `after` reads newer. No position reads the newest page. */
  position?: { direction: "before" | "after"; key: ActivityRunKey };
}

export interface ActivityRunPageRecord {
  records: ProjectActivityRunListRecord[];
  /** Key of the last record when older runs exist. */
  older: ActivityRunKey | null;
  /** Key of the first record when newer runs exist. */
  newer: ActivityRunKey | null;
}

export interface WorkflowStepRunRecord {
  payloadSummary?: StepPayloadSummary | null;
  id: string;
  triggerRunId: string;
  stepId: string;
  ordinal: number;
  status: "pending" | "running" | "succeeded" | "skipped" | "failed" | "timed_out" | "canceled";
  agentExecutionId: string | null;
  output: unknown;
  failureReason: string | null;
  deadlineKind: WorkflowDeadlineKind | null;
  deadlineAt: Date | null;
  idleDeadlineAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  dispatchIntent: LaunchMachineIntent | null;
}

export interface WorkflowWakeupRecord {
  triggerRunId: string;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  leasedBeforeClaim: boolean;
}

export interface CreateAcceptedTriggerRunInput {
  replyMessage?: true;
  conversation?: import("../triggers/continuation.js").Conversation | null;
  id?: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  providerEventReceiptId: string;
  configuredTriggerName: string;
  prompt: string;
  inputs: unknown;
  values?: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  deadlineAt: Date;
  stepIds: readonly string[];
  createdAt?: Date;
}

export interface CreateRejectedTriggerRunInput {
  id?: string;
  organizationId: string;
  projectId: string;
  configurationRevisionId: string;
  providerEventReceiptId: string;
  configuredTriggerName: string;
  prompt: string;
  inputs: unknown;
  values?: unknown;
  triggerContext: unknown;
  outputContext: unknown;
  rejection: InvocationRejection;
  createdAt?: Date;
}

/**
 * A meter reservation the durable engine attaches to execution creation. One unit is consumed
 * in the same transaction that creates the execution, so metering is exactly per-execution:
 * a genuinely new execution reserves, a replay or recovery of an existing one does not, and a
 * denial prevents the execution from being created at all. `limit` null means unlimited — the
 * unit is still counted (for usage display) but never denied.
 */
export interface MeterReservation {
  meter: string;
  periodStart: Date;
  limit: number | null;
}

/** Returned when a reservation would exceed a non-null limit; the execution is not created. */
export interface MeterReservationDenied {
  meter: string;
  limit: number;
  current: number;
}

export interface WorkflowStepExecutionInput {
  triggerRunId: string;
  stepId: string;
  ordinal: number;
  executionId: string;
  execution: Omit<InsertAgentExecutionInput, "deadlineAt" | "idleDeadlineAt" | "startedAt"> & {
    deadlineAt: Date;
    idleDeadlineAt: Date;
    startedAt: Date;
  };
  /** When set, one meter unit is reserved atomically with creating the execution. */
  reservation?: MeterReservation;
}

export interface WorkflowScriptStepStartInput {
  stepRunId: string;
  startedAt: Date;
  /** Past this the step is timed out by deadline recovery, so it is set after the runner's own. */
  deadlineAt: Date;
  /** The step's first output, written with the start so it is never running without one. */
  output?: unknown;
}

export interface WorkflowScriptStepUpdate {
  status: "running" | "succeeded" | "failed" | "timed_out";
  /** Replaces the step output: the terminal handle while running, the result once finished. */
  output: unknown;
  failureReason?: string;
  at: Date;
}

export interface WorkflowAgentCompletionInput {
  executionId: string;
  executionStatus: "succeeded" | "failed";
  stepStatus: "succeeded" | "failed" | "timed_out";
  result?: unknown;
  stepOutput?: unknown;
  failureReason?: string;
  deadlineKind?: WorkflowDeadlineKind;
  observedAt?: Date;
  completedByAgent?: boolean;
  deadlineCondition?: TransitionAgentExecutionFields["deadlineCondition"];
  hubAction?: HubAction | null;
}

export interface EnrollDaemonInput {
  daemonId: string;
  idempotencyKey: string;
  suggestedSlug?: string;
  tokenVerifier: string;
  serverId: string;
  daemonPublicKey: string;
  credentialVerifier: string;
  permissions: string[];
  now: Date;
}

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  slug: string;
  createdByUserId: string | null;
}

export type EntitlementChangeSource = "provisioning" | "plan_stamp" | "override";

export interface OrganizationEntitlementsRecord {
  organizationId: string;
  granted: unknown;
  overrides: unknown;
  planId: string | null;
  planVersion: string | null;
  stampedAt: Date;
  updatedAt: Date;
}

/** An organization as the instance-operator surface sees it — identity only, no membership. */
export interface OperatorOrganizationRecord {
  id: string;
  name: string;
  slug: string;
}

export interface StampOrganizationEntitlementsInput {
  organizationId: string;
  granted: unknown;
  planId: string | null;
  planVersion: string;
  source: EntitlementChangeSource;
  actor: string | null;
  reason: string | null;
}

export interface OverrideOrganizationEntitlementsInput {
  organizationId: string;
  /**
   * The hand-adjustment patch, merged against the locked row inside the persistence
   * transaction — not a pre-merged document. Merging under the row lock is what stops two
   * concurrent overrides from clobbering each other's keys.
   */
  patch: EntitlementPatch;
  actor: string | null;
  reason: string;
}

export interface ClearOrganizationEntitlementsOverrideInput {
  organizationId: string;
  /** The single override key to remove, returning that entitlement to its plan-granted value. */
  key: OverrideKey;
  actor: string | null;
  reason: string;
}

export interface EntitlementChangeRecord {
  id: string;
  organizationId: string;
  actor: string | null;
  /** Display name resolved from the actor's user record, when one exists. */
  actorName: string | null;
  source: EntitlementChangeSource;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: Date;
}

export interface OrganizationUsageRecord {
  organizationId: string;
  meter: string;
  periodStart: Date;
  used: number;
}

export interface ConsumeOrganizationUsageInput {
  organizationId: string;
  meter: string;
  periodStart: Date;
  amount: number;
  /** null means unlimited: the conditional upsert never denies. */
  limit: number | null;
}

export type BillingPlanPriceInterval = "monthly" | "annual";

export interface BillingPlanMarketingFeature {
  key: string;
  label: string;
  tooltip: string | null;
}

/**
 * The plan's own numbers, as scalars. Derived once by the catalog sync from the validated
 * entitlement template (`src/billing/catalog-sync.ts`) so the public catalog can state what a
 * plan includes without the template document itself ever reaching the projection. null is
 * unlimited, matching the catalog's convention everywhere else.
 */
export interface BillingPlanIncluded {
  seats: number | null;
  executionsPerMonth: number | null;
}

export interface BillingPlanMarketing {
  included: BillingPlanIncluded;
  features: readonly BillingPlanMarketingFeature[];
  priceTooltips: Record<BillingPlanPriceInterval, string | null>;
}

export interface BillingPlanPriceRecord {
  id: string;
  planId: string;
  lookupKey: string;
  interval: BillingPlanPriceInterval;
  unitAmount: number;
  currency: string;
  active: boolean;
}

/**
 * `template` and `marketing` are `unknown` at the storage boundary, matching
 * `OrganizationEntitlementsRecord` above — both were validated once by `src/billing/` before
 * `syncBillingPlan` was called. The public plans projection re-parses `marketing`
 * (`src/billing/public-catalog.ts`) and never reads `template` at all; entitlement stamping
 * re-parses `template`.
 */
export interface BillingPlanRecord {
  id: string;
  slug: string;
  name: string;
  template: unknown;
  templateHash: string;
  marketing: unknown;
  active: boolean;
  syncedAt: Date;
  prices: BillingPlanPriceRecord[];
}

export interface SyncBillingPlanPriceInput {
  id: string;
  lookupKey: string;
  interval: BillingPlanPriceInterval;
  unitAmount: number;
  currency: string;
  active: boolean;
}

export interface SyncBillingPlanInput {
  id: string;
  slug: string;
  name: string;
  template: EntitlementTemplate;
  templateHash: string;
  marketing: BillingPlanMarketing;
  active: boolean;
  prices: readonly SyncBillingPlanPriceInput[];
}

/**
 * The organization's current Stripe subscription mirror. `planId` is the resolved
 * `billing_plans.id` (a soft reference), or null when the subscription's price is not in the
 * mirror. Enforcement never reads this — the subscription webhook re-stamps
 * `organization_entitlements` from the resolved plan's template.
 */
export interface OrganizationBillingCustomerRecord {
  organizationId: string;
  stripeCustomerId: string;
  updatedAt: Date;
}

/**
 * One convergent reconciliation of an organization's Stripe subscription: the local mirror and
 * the entitlement stamp move together in a single transaction, so a subscription webhook can
 * never leave the two disagreeing. `stamp` is present when the reconciled state should re-stamp
 * entitlements (an active plan, or Free on terminal cancellation) and absent when the state is
 * grandfathered (a transient status that leaves the last stamp untouched). The stamp reuses the
 * same idempotent logic as `stampOrganizationEntitlements`, so a replay is a no-op.
 */
export interface ReconcileOrganizationBillingInput {
  organizationId: string;
  stripeCustomerId: string;
  stamp?: Omit<StampOrganizationEntitlementsInput, "organizationId">;
}

export interface InsertProjectConfigurationRevisionInput {
  projectId: string;
  sourceKind: "github" | "manual";
  sourceEvidence: unknown;
  rawYaml?: string | null;
  normalizedConfiguration: unknown;
  validationErrors?: unknown;
  contentHash: string;
  createdByUserId?: string | null;
}

export interface ProjectTriggerRoute {
  provider: ConnectionProvider;
  connectionId: string;
  resourceId: string | null;
  triggerName: string;
}

export interface OrganizationTriggerRoute {
  provider: ConnectionProvider;
  connectionId: string;
  resourceId: string | null;
  configuredEventName: string;
}

export interface MigrateProjectTriggerInput {
  name: string;
  format: "single_run" | "legacy_multistep";
  enabled: boolean;
  yaml: string;
  normalizedConfiguration: unknown;
  contentHash: string;
  sourceEvidence: unknown;
}

export interface MigrateProjectTriggersInput {
  projectId: string;
  organizationId: string;
  configurationRevisionId: string;
  projectSlug: string;
  triggers: readonly MigrateProjectTriggerInput[];
}

export interface SaveOrganizationTriggerInput {
  recurrence?: import("../triggers/schedule/recurrence.js").Recurrence;
  organizationId: string;
  triggerId?: string;
  name: string;
  enabled: boolean;
  format: "single_run" | "legacy_multistep";
  yaml: string;
  normalizedConfiguration: unknown;
  contentHash: string;
  sourceKind: "manual" | "github";
  sourceEvidence: unknown;
  createdByUserId: string | null;
  routes: readonly OrganizationTriggerRoute[];
}

export interface SwitchProjectConfigurationToManualInput {
  projectId: string;
  userId: string;
  rawYaml: string;
  normalizedConfiguration: unknown;
  contentHash: string;
  bundle: { authoredHash: string; files: readonly { path: string; content: string }[] };
  routes: readonly ProjectTriggerRoute[];
}

export interface SetProjectGitHubConfigurationSourceInput {
  projectId: string;
  githubConnectionId: string;
  githubRepositoryId: number;
  githubRepositoryFullName: string;
  githubDefaultBranch: string;
  automaticDeploymentEnabled: boolean;
  userId: string;
}

export interface RecordConfigurationSyncAttemptInput {
  projectId: string;
  githubConnectionId: string;
  githubRepositoryId: number;
  webhookDeliveryId: string | null;
  commitSha: string;
  outcome: "activated" | "invalid" | "fetch_failed" | "superseded";
  evidence: unknown;
}

export interface TransitionAgentExecutionFields {
  result?: unknown;
  completedByAgent?: boolean;
  deadlineCondition?: {
    kind: "hard" | "idle";
    deadlineAt: Date;
    observedAt: Date;
  };
  hubAction?: HubAction | null;
}

export interface TransitionAgentExecutionResult {
  execution: AgentExecutionRecord;
  transitioned: boolean;
  deadlineKind?: WorkflowDeadlineKind;
  terminalRun?: TriggerRunRecord;
}

export interface TransitionTriggerRunResult {
  run: TriggerRunRecord;
  transitioned: boolean;
}

export interface WorkflowDeadlineRecovery {
  triggerRunId: string;
  executionIds: readonly string[];
}

export interface TerminateMachineFields {
  reason: string;
}

export interface Database
  extends RunTimelineStore, RunPayloadRetentionStore, InteractiveSessionStore {
  readonly executionAuthority: import("../execution-authority/index.js").ExecutionAuthorityStore;
  readonly schedules: import("../triggers/schedule/index.js").ScheduleStore;
  readonly githubNotifications: import("../triggers/github-notifications/index.js").GitHubNotificationStore;
  findAgentSessionByKey(
    projectId: string,
    key: string,
  ): Promise<import("../agent-sessions/index.js").AgentSessionRecord | undefined>;
  findAgentSession(
    id: string,
  ): Promise<import("../agent-sessions/index.js").AgentSessionRecord | undefined>;
  saveAgentSession(session: import("../agent-sessions/index.js").AgentSessionRecord): Promise<void>;
  attachExecutionToSession(
    executionId: string,
    sessionId: string,
    action?: import("../agent-sessions/index.js").AgentSessionAction,
  ): Promise<void>;
  listAgentSessionExecutions(sessionId: string): Promise<AgentExecutionRecord[]>;

  createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
  ): Promise<{ run: AcceptedTriggerRunRecord; created: boolean }>;
  createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
    replay: "acknowledge",
  ): Promise<TriggerRunAdmission<AcceptedTriggerRunRecord>>;
  createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
  ): Promise<{ run: RejectedTriggerRunRecord; created: boolean }>;
  createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
    replay: "acknowledge",
  ): Promise<TriggerRunAdmission<RejectedTriggerRunRecord>>;
  findTriggerRunById(id: string): Promise<TriggerRunRecord | undefined>;
  findTriggerRunsByProviderEventReceiptId(
    providerEventReceiptId: string,
  ): Promise<TriggerRunRecord[]>;
  findTriggerRunForReceipt(
    organizationId: string,
    projectId: string,
    providerEventReceiptId: string,
    triggerName: string,
  ): Promise<TriggerRunRecord | undefined>;
  listTriggerRunsForProject(projectId: string, limit: number): Promise<TriggerRunRecord[]>;
  countActiveTriggerRuns(
    organizationId: string,
    projectId: string,
    triggerName: string,
  ): Promise<number>;
  listProjectActivityRuns(
    projectId: string,
    limit: number,
  ): Promise<ProjectActivityRunListRecord[]>;
  listOrganizationActivityPage(
    organizationId: string,
    scopes: readonly ActivityRunScope[],
    request: ActivityRunPageRequest,
  ): Promise<ActivityRunPageRecord>;
  findProjectActivityRun(
    projectId: string,
    runId: string,
  ): Promise<ProjectActivityRunRecord | undefined>;
  findOrganizationActivityRun(
    organizationId: string,
    runId: string,
  ): Promise<ProjectActivityRunRecord | undefined>;
  updateTriggerRunValues(triggerRunId: string, values: unknown): Promise<TriggerRunRecord>;
  findWorkflowStepRunById(id: string): Promise<WorkflowStepRunRecord | undefined>;
  findWorkflowStepRunByTriggerRun(triggerRunId: string): Promise<WorkflowStepRunRecord | undefined>;
  listWorkflowStepRunsForTriggerRun(triggerRunId: string): Promise<WorkflowStepRunRecord[]>;
  findAgentExecutionByWorkflowStepRunId(
    stepRunId: string,
  ): Promise<AgentExecutionRecord | undefined>;
  /** Gives a claimed wakeup back. `retryAt` holds it until then instead of at once. */
  releaseWorkflowWakeup(
    triggerRunId: string,
    now: Date,
    claimedLease: Date,
    retryAt?: Date,
  ): Promise<void>;
  claimWorkflowWakeup(
    now: Date,
    leaseMs: number,
    excludedRunIds?: readonly string[],
  ): Promise<WorkflowWakeupRecord | undefined>;
  wakeWorkflowRun(triggerRunId: string, availableAt: Date): Promise<void>;
  deleteWorkflowWakeup(triggerRunId: string): Promise<void>;
  createWorkflowStepExecution(input: WorkflowStepExecutionInput): Promise<{
    stepRun: WorkflowStepRunRecord;
    execution: AgentExecutionRecord | undefined;
    created: boolean;
    /** Present only when a reservation was requested and denied; no execution was created. */
    reservationDenied?: MeterReservationDenied;
  }>;
  linkWorkflowStepRunExecution(
    stepRunId: string,
    executionId: string,
    dispatchIntent?: LaunchMachineIntent,
  ): Promise<WorkflowStepRunRecord>;
  completeWorkflowStep(
    executionId: string,
    status: "succeeded" | "failed" | "timed_out",
    result: unknown,
    failureReason?: string,
  ): Promise<{ stepRun: WorkflowStepRunRecord; run: TriggerRunRecord } | undefined>;
  completeWorkflowAgentExecution(
    input: WorkflowAgentCompletionInput,
  ): Promise<TransitionAgentExecutionResult>;
  markWorkflowStepSkipped(
    triggerRunId: string,
    stepId: string,
    reason: string,
  ): Promise<{ stepRun: WorkflowStepRunRecord; run: TriggerRunRecord } | undefined>;
  /**
   * Marks a pending script step running, once. `started` is false when the step was not pending
   * or its run is no longer running, so a script is never started twice.
   */
  startWorkflowScriptStep(
    input: WorkflowScriptStepStartInput,
  ): Promise<{ stepRun: WorkflowStepRunRecord; started: boolean } | undefined>;
  /**
   * Updates a running script step. A terminal status also wakes the run so the engine finishes
   * or fails it. A step that already ended is returned unchanged.
   */
  updateWorkflowScriptStep(
    stepRunId: string,
    update: WorkflowScriptStepUpdate,
  ): Promise<WorkflowStepRunRecord | undefined>;
  /**
   * Replaces a script step's output whatever its status, for cleanup after the step ended. An
   * agent step is left alone and `undefined` comes back.
   */
  setWorkflowScriptStepOutput(
    stepRunId: string,
    output: unknown,
  ): Promise<WorkflowStepRunRecord | undefined>;
  /**
   * Ended script steps whose output still names a terminal or a pending cleanup: a stop the
   * daemon never confirmed, or a step that deadline recovery ended while its terminal ran on.
   * Only steps with no agent execution qualify, so an agent step whose output happens to look
   * like a script's is never returned.
   */
  listWorkflowScriptStepsPendingCleanup(): Promise<WorkflowStepRunRecord[]>;
  readRunStopDetails(
    organizationId: string,
    triggerRunId: string,
  ): Promise<import("../triggers/run-stop.js").RunStopDetails | undefined>;
  cancelTriggerRun(
    organizationId: string,
    triggerRunId: string,
    stoppedByUserId?: string,
    confirmedPeerCount?: number,
    retryAttemptId?: string,
  ): Promise<
    (TransitionTriggerRunResult & { executionIds: string[]; conflict?: number }) | undefined
  >;
  readonly stopInterrupts: import("./stop-interrupt.js").StopInterruptStore;
  readonly runReplies: import("../run-replies/store.js").RunReplyStore;
  succeedTriggerRun(triggerRunId: string): Promise<TransitionTriggerRunResult | undefined>;
  failWorkflowRun(
    triggerRunId: string,
    status: "failed" | "timed_out",
    failureReason: string,
    stepId?: string,
  ): Promise<
    { stepRun: WorkflowStepRunRecord; run: TriggerRunRecord; transitioned: boolean } | undefined
  >;
  claimPendingWorkflowRunTerminalNotification(
    now: Date,
    leaseMs: number,
  ): Promise<(AcceptedTriggerRunRecord & { terminalNotificationGeneration: number }) | undefined>;
  ownsWorkflowRunTerminalNotification(
    triggerRunId: string,
    generation: number,
    now: Date,
  ): Promise<boolean>;
  markWorkflowRunTerminalNotificationDelivered(
    triggerRunId: string,
    generation: number,
    deliveredAt: Date,
    reactionState: JsonValue | null,
  ): Promise<void>;
  setWorkflowRunReactionState(
    triggerRunId: string,
    reactionState: JsonValue | null,
  ): Promise<AcceptedTriggerRunRecord | undefined>;
  recoverWorkflowDeadlines(now: Date): Promise<readonly WorkflowDeadlineRecovery[]>;
  /** `excludedRunIds` are runs a live watcher is already handling, which need no wakeup. */
  recoverWorkflowWakeups(now: Date, excludedRunIds?: readonly string[]): Promise<void>;
  markProviderEventDropped(
    providerEventReceiptId: string,
    reason: ProviderEventDropReasonCode,
    organizationId?: string,
  ): Promise<boolean>;
  acceptGitHubEvent(input: AcceptGitHubEventInput): Promise<ProviderEventAcceptance>;
  acceptDiscordEvent(input: AcceptDiscordEventInput): Promise<ProviderEventAcceptance>;
  acceptSlackEvent(input: AcceptSlackEventInput): Promise<ProviderEventAcceptance>;
  acceptLinearEvent(input: AcceptLinearEventInput): Promise<ProviderEventAcceptance>;
  findMarkedLinearReceipt(
    linearOrganizationId: string,
    deliveryId: string,
    signatureHash: string,
  ): Promise<boolean>;
  persistManualEvent(input: PersistManualEventInput): Promise<ManualEventPersistence>;
  authorizeSignedReceiptReplay(
    input: ManualReceiptReplayTarget & { organizationId: string; receiptId: string },
  ): Promise<void>;
  synchronizeGitHubInstallation<T>(installationId: number, operation: () => Promise<T>): Promise<T>;
  pendingGitHubInstallationSyncs(
    owner: GitHubInstallationSyncOwner,
    selected?: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
  ): Promise<
    Array<Extract<GitHubInstallationSyncClaim, { status: "claimed" }> & { removeBinding: boolean }>
  >;
  claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubInstallationSyncClaim>;
  applyGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    claim: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
    result: GitHubInstallationSyncResult,
  ): Promise<void>;
  retryGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    installationSyncId: string,
  ): Promise<void>;
  findProviderEventReceiptByDeliveryId(
    deliveryId: string,
    organizationId?: string,
  ): Promise<ProviderEventReceiptRecord | undefined>;
  findProviderEventReceiptById(
    id: string,
    projection?: "metadata",
  ): Promise<ProviderEventReceiptRecord | undefined>;
  findProviderEventReplayMetadata(
    organizationId: string,
    key: { id: string } | { deliveryId: string },
  ): Promise<ProviderEventReplayMetadata | undefined>;
  insertAttachment(input: InsertAttachmentInput): Promise<AttachmentRecord>;
  findAttachmentBySource(
    providerEventReceiptId: string,
    provider: AttachmentProvider,
    sourceId: string,
  ): Promise<AttachmentRecord | undefined>;
  findAttachmentForExecution(
    executionId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | undefined>;
  insertMachine(input: InsertMachineInput): Promise<MachineRecord>;
  findMachineById(id: string): Promise<MachineRecord | undefined>;
  findMachineForOrganization(
    organizationId: string,
    id: string,
  ): Promise<MachineRecord | undefined>;
  transitionMachine(
    id: string,
    toStatus: MachineStatus,
    fields?: TerminateMachineFields,
  ): Promise<MachineRecord>;
  insertAgentExecution(input: InsertAgentExecutionInput): Promise<AgentExecutionRecord>;
  insertAgentExecutionIfAbsent(
    input: InsertAgentExecutionInput & { id: string },
  ): Promise<AgentExecutionRecord | undefined>;
  issueEnrollmentToken(input: EnrollmentTokenRecord): Promise<boolean>;
  startCliAuthorization(
    input: StartCliAuthorizationInput,
  ): Promise<CliAuthorizationRecord | undefined>;
  inspectCliAuthorization(userCodeVerifier: string): Promise<CliAuthorizationRecord | undefined>;
  decideCliAuthorization(
    input: CliAuthorizationDecisionInput,
  ): Promise<"approved" | "denied" | "unavailable" | "forbidden">;
  pollCliAuthorization(input: {
    deviceVerifier: string;
    credential: { id: string; prefix: string; verifier: string };
  }): Promise<CliAuthorizationPollResult>;
  enrollDaemon(input: EnrollDaemonInput): Promise<DaemonWriteResult>;
  findDaemonBySlugForOrganization(
    organizationId: string,
    slug: string,
  ): Promise<DaemonRecord | undefined>;
  findDaemonById(id: string): Promise<DaemonRecord | undefined>;
  findDaemonForOrganization(organizationId: string, id: string): Promise<DaemonRecord | undefined>;
  listDaemonsForOrganization(organizationId: string): Promise<DaemonRecord[]>;
  renameDaemonForOrganization(
    organizationId: string,
    id: string,
    slug: string,
  ): Promise<DaemonWriteResult>;
  touchDaemon(id: string): Promise<void>;
  setDaemonPresence(id: string, presence: "offline" | "connected"): Promise<void>;
  setDaemonPermissions(id: string, permissions: string[]): Promise<DaemonRecord | undefined>;
  revokeDaemon(id: string): Promise<boolean>;
  attachAgentToExecution(
    executionId: string,
    daemonId: string,
    agentId: string,
  ): Promise<AgentExecutionRecord>;
  setAgentExecutionIdleDeadline(
    executionId: string,
    idleDeadlineAt: Date | null,
    observedAt: Date,
    processedAt: Date,
  ): Promise<AgentExecutionRecord>;
  limitAgentExecutionDeadline(executionId: string, deadlineAt: Date): Promise<void>;
  prepareAgentExecutionForDispatch(
    executionId: string,
    daemonId: string,
    machineId: string,
    completionTokenHash: string,
  ): Promise<AgentExecutionRecord>;
  findAgentExecutionById(id: string): Promise<AgentExecutionRecord | undefined>;
  findAgentExecutionForOrganization(
    organizationId: string,
    id: string,
  ): Promise<AgentExecutionRecord | undefined>;
  findAgentExecutionForProject(
    projectId: string,
    id: string,
  ): Promise<AgentExecutionRecord | undefined>;
  beginAgentExecutionOutput(
    executionId: string,
    outputType: string,
    maxOutputs: number | undefined,
    startedAt: Date,
  ): Promise<AgentExecutionOutputAttempt | undefined>;
  completeAgentExecutionOutput(
    executionId: string,
    attemptId: string,
    completedAt: Date,
  ): Promise<AgentExecutionRecord | undefined>;
  failAgentExecutionOutput(
    executionId: string,
    attemptId: string,
    failedAt: Date,
  ): Promise<boolean>;
  transitionAgentExecution(
    id: string,
    toStatus: AgentExecutionStatus,
    fields?: TransitionAgentExecutionFields,
  ): Promise<TransitionAgentExecutionResult>;
  setAgentExecutionReactionState(
    executionId: string,
    reactionState: JsonValue | null,
  ): Promise<AgentExecutionRecord>;
  findRunningAgentExecutionsForMachine(machineId: string): Promise<AgentExecutionRecord[]>;
  findPendingAgentExecutions(): Promise<AgentExecutionRecord[]>;
  findPendingHubActions(
    daemonId?: string,
    scope?: PendingHubActionScope,
  ): Promise<AgentExecutionRecord[]>;
  markAgentExecutionHubActionReady(
    executionId: string,
    observedAt?: Date,
  ): Promise<AgentExecutionRecord | undefined>;
  recordAgentExecutionHubAcknowledgement(
    executionId: string,
    acknowledgement: AgentExecutionHubAcknowledgementInput,
  ): Promise<AgentExecutionRecord | undefined>;
  completeHubAction(executionId: string, action: HubAction): Promise<boolean>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  restoreProject(organizationId: string, projectId: string): Promise<ProjectRecord>;
  getOrganizationEntitlements(
    organizationId: string,
  ): Promise<OrganizationEntitlementsRecord | undefined>;
  stampOrganizationEntitlements(
    input: StampOrganizationEntitlementsInput,
  ): Promise<OrganizationEntitlementsRecord>;
  overrideOrganizationEntitlements(
    input: OverrideOrganizationEntitlementsInput,
  ): Promise<OrganizationEntitlementsRecord>;
  /** Removes one hand-set override under the row lock and writes an `override` audit row. */
  clearOrganizationEntitlementsOverride(
    input: ClearOrganizationEntitlementsOverrideInput,
  ): Promise<OrganizationEntitlementsRecord>;
  listEntitlementChanges(organizationId: string, limit: number): Promise<EntitlementChangeRecord[]>;
  /**
   * The organizations stamped from `planId` whose stamp predates the plan's current template —
   * `plan_version` differs from `templateHash`. Stripe carries no version counter, so a content
   * hash mismatch is what "off template" means. The catalog sync re-stamps exactly this list.
   */
  listOrganizationsOffPlanTemplate(planId: string, templateHash: string): Promise<string[]>;
  /**
   * Every organization, for the instance-operator picker. Not a membership read — the operator
   * acts on organizations it does not belong to, so the caller must gate this on the operator
   * flag before invoking it.
   */
  listOrganizationsForOperator(): Promise<OperatorOrganizationRecord[]>;
  /**
   * One organization by slug, without any membership check. The operator resolution path; gate on
   * the operator flag at the caller. Undefined when no organization has that slug.
   */
  findOrganizationForOperator(slug: string): Promise<OperatorOrganizationRecord | undefined>;
  findOrganizationSlugById(organizationId: string): Promise<string | undefined>;
  /**
   * Single atomic conditional upsert: increments `used` by `amount` and returns the new
   * row, unless doing so would exceed `limit` (when non-null), in which case it returns
   * `undefined` and leaves usage unchanged. Never read-then-write — see the plan.
   */
  consumeOrganizationUsage(
    input: ConsumeOrganizationUsageInput,
  ): Promise<OrganizationUsageRecord | undefined>;
  getOrganizationUsage(
    organizationId: string,
    meter: string,
    periodStart: Date,
  ): Promise<OrganizationUsageRecord | undefined>;
  /** Upserts the plan and replaces its price set. `src/billing/` is the only caller. */
  syncBillingPlan(input: SyncBillingPlanInput): Promise<BillingPlanRecord>;
  /**
   * Deactivates every synced plan whose id is not in `activeIds` — the sync applies its catalog as
   * one reconciled snapshot, so a product that lost its `paseo_plan` tag or was deleted stops being
   * active and selectable rather than lingering. `src/billing/` only.
   */
  deactivateBillingPlansExcept(activeIds: readonly string[]): Promise<void>;
  /** All synced plans (active and inactive) with their prices. Empty when never synced. */
  listBillingPlans(): Promise<BillingPlanRecord[]>;
  /**
   * Atomically upserts the organization's Stripe subscription mirror and, when `stamp` is set,
   * re-stamps its entitlements in the same transaction. `src/billing/` only — the sole convergent
   * writer the subscription webhook drives.
   */
  reconcileOrganizationBilling(
    input: ReconcileOrganizationBillingInput,
  ): Promise<OrganizationBillingCustomerRecord>;
  /** The organization's current subscription mirror, or undefined when it never subscribed. */
  getOrganizationBillingCustomer(
    organizationId: string,
  ): Promise<OrganizationBillingCustomerRecord | undefined>;
  /**
   * Runs `fn` while holding a named advisory lock that serializes across processes, so a
   * per-organization critical section (re-read external state, then write) cannot interleave with
   * another instance handling the same organization. Released even if `fn` throws.
   */
  withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  listPendingProjectTriggerMigrations(): Promise<PendingProjectTriggerMigration[]>;
  migrateProjectTriggers(input: MigrateProjectTriggersInput): Promise<OrganizationTriggerRecord[]>;
  listOrganizationTriggers(organizationId: string): Promise<OrganizationTriggerRecord[]>;
  listOrganizationTriggerPage(
    organizationId: string,
    request: TriggerListRequest,
  ): Promise<TriggerListPage>;
  findOrganizationTrigger(
    organizationId: string,
    triggerId: string,
  ): Promise<OrganizationTriggerRecord | undefined>;
  hasOrganizationTriggerEvent(organizationId: string, event: string): Promise<boolean>;
  findOrganizationTriggerRevision(
    triggerId: string,
    revisionId: string,
  ): Promise<OrganizationTriggerRevisionRecord | undefined>;
  findOrganizationTriggerMigrationRevision(
    triggerId: string,
  ): Promise<OrganizationTriggerRevisionRecord | undefined>;
  saveOrganizationTrigger(input: SaveOrganizationTriggerInput): Promise<OrganizationTriggerRecord>;
  listProjectsForOrganization(organizationId: string): Promise<ProjectRecord[]>;
  findProjectForOrganization(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectRecord | undefined>;
  findProjectById(projectId: string): Promise<ProjectRecord | undefined>;
  findProjectBySlugForOrganization(
    organizationId: string,
    slug: string,
  ): Promise<ProjectRecord | undefined>;
  resolveTenantRouteAccess(
    userId: string,
    organizationSlug: string,
    projectSlug?: string,
  ): Promise<TenantRouteAccess | undefined>;
  archiveProject(organizationId: string, projectId: string, userId: string): Promise<ProjectRecord>;
  updateProjectSlug(
    organizationId: string,
    projectId: string,
    slug: string,
    userId: string,
  ): Promise<ProjectRecord>;
  insertProjectConfigurationRevision(
    input: InsertProjectConfigurationRevisionInput,
  ): Promise<ProjectConfigurationRevisionRecord>;
  activateProjectConfigurationRevision(
    projectId: string,
    revisionId: string,
    routes?: readonly ProjectTriggerRoute[],
  ): Promise<ProjectConfigurationRevisionRecord>;
  findProjectConfigurationRollbackTarget(
    projectId: string,
  ): Promise<ProjectConfigurationRevisionRecord | undefined>;
  rollbackProjectConfiguration(
    projectId: string,
    targetRevisionId: string,
    routes: readonly ProjectTriggerRoute[],
  ): Promise<ProjectConfigurationRevisionRecord>;
  findActiveProjectConfiguration(
    projectId: string,
  ): Promise<ProjectConfigurationRevisionRecord | undefined>;
  findProjectConfigurationRevision(
    projectId: string,
    revisionId: string,
  ): Promise<ProjectConfigurationRevisionRecord | undefined>;
  switchProjectConfigurationToManual(
    input: SwitchProjectConfigurationToManualInput,
  ): Promise<ProjectConfigurationRevisionRecord>;
  setProjectGitHubConfigurationSource(
    input: SetProjectGitHubConfigurationSourceInput,
  ): Promise<void>;
  recordConfigurationSyncAttempt(
    input: RecordConfigurationSyncAttemptInput,
  ): Promise<ConfigurationSyncAttemptRecord>;
  projectConfigurationReadModel(projectId: string): Promise<ProjectConfigurationReadModel>;
  getHomeChecklistCompletedAt(organizationId: string): Promise<Date | null>;
  completeHomeChecklist(organizationId: string): Promise<Date>;
  organizationConnectionUsage(organizationId: string): Promise<OrganizationConnectionUsage>;
  listGitHubRepositories(organizationId: string): Promise<GitHubRepositoryRecord[]>;
  findGitHubRepositoryForOrganization(
    organizationId: string,
    fullName: string,
  ): Promise<GitHubRepositoryRecord | undefined>;
  findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined>;
  listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]>;
  listUnroutedProviderEventsForOrganization(
    organizationId: string,
  ): Promise<ProviderEventReceiptSummary[]>;
  /** Newest first, every run the organization's triggers started at or after `since`. */
  listOrganizationRunsSince(
    organizationId: string,
    since: Date,
    limit: number,
  ): Promise<OrganizationRunRecord[]>;
  /**
   * Events received at or after `since` that were dropped because no trigger listens for them
   * (`no_project_route`, `no_trigger_for_source`), counted per provider. A filter that declined
   * an event is a trigger listening, so those drops are not counted.
   */
  countUnroutedProviderEventsSince(
    organizationId: string,
    since: Date,
  ): Promise<UnroutedProviderEventCount[]>;
  isOrganizationMember(userId: string, organizationId: string): Promise<boolean>;
  startConnectionAttempt(input: StartConnectionAttemptInput): Promise<void>;
  findConnectionAttemptConfiguration(
    stateVerifier: string,
  ): Promise<ConnectionAttemptConfigurationSnapshot | undefined>;
  readConnectionAttempt(input: ReadConnectionAttemptInput): Promise<ConnectionAttemptRecord>;
  consumeConnectionAttempt(input: ReadConnectionAttemptInput): Promise<void>;
  advanceGitHubConnectionAttempt(input: AdvanceGitHubConnectionAttemptInput): Promise<void>;
  bindGitHubConnection(input: BindGitHubConnectionInput): Promise<void>;
  bindDiscordConnection(input: BindDiscordConnectionInput): Promise<void>;
  bindSlackConnection(input: BindSlackConnectionInput): Promise<void>;
  completeSlackProviderApplication(input: CompleteSlackProviderApplicationInput): Promise<void>;
  bindLinearConnection(input: BindLinearConnectionInput): Promise<void>;
  completeLinearProviderApplication(input: CompleteLinearProviderApplicationInput): Promise<void>;
  updateLinearConnectionTokens(input: UpdateLinearConnectionTokensInput): Promise<void>;
  /**
   * Runs a Linear refresh decision under the same transaction-scoped external-connection lock
   * used by OAuth rebind. The connection re-read and any token update use that transaction, so a
   * stale refresh cannot overwrite a concurrent reauthorization or consume a rotating token twice.
   */
  withLinearConnectionRefresh<T>(
    linearOrganizationId: string,
    operation: LinearConnectionRefreshOperation<T>,
  ): Promise<T>;
  disconnectConnection(
    provider: ConnectionProvider,
    connectionId: string,
    access: ConnectionStartAuthority,
  ): Promise<DisconnectConnectionResult>;
  findGitHubConnection(installationId: number): Promise<GitHubConnectionRecord | undefined>;
  findDiscordConnection(guildId: string): Promise<DiscordConnectionRecord | undefined>;
  findSlackConnection(teamId: string): Promise<SlackConnectionRecord | undefined>;
  findLinearConnection(linearOrganizationId: string): Promise<LinearConnectionRecord | undefined>;
  findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined>;
  findLinearConnectionForOrganization(
    organizationId: string,
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined>;
  findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined>;
  removeDiscordConnection(guildId: string): Promise<void>;
  close(): Promise<void>;
}
