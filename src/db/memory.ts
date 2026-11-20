import {
  EXPIRED_CURSOR_DIAGNOSTIC,
  cursorDiagnosticDisposition,
  isExactSyncReceipt,
  readSyncAuditLink,
  syncPayloadDisposition,
  type GitHubSyncPayloadEvidence,
} from "../run-payload-retention/auxiliary-receipt-proof.js";
import {
  isLifecycleReceipt,
  proveReceipt,
  type ReceiptProofBranch,
} from "../run-payload-retention/receipt-proof.js";
import type { GitHubSyncAuditLink } from "./schema.js";
import { temporaryCredentialFact } from "../agent-sessions/credentials.js";
import { sessionLock } from "../agent-sessions/index.js";
import type { AgentSessionRecord } from "../agent-sessions/types.js";
import { coversExpectedFanout, expectedFanout } from "../run-payload-retention/fanout.js";
import {
  payloadCompletion,
  reduceRejection,
  summarizePayloadAgent,
  summarizeRunPayload,
  summarizeStepPayload,
  type RunPayloadSummary,
} from "../run-payload-retention/summary.js";
import {
  isProgressUnsettled,
  type AuxiliaryPayloadCandidate,
  type AuxiliaryPayloadKind,
  type RunPayloadDisposition,
} from "../run-payload-retention/store.js";
import { readScriptStepHandle } from "../workflows/script-output.js";
import { randomUUID } from "node:crypto";
import type { AgentExecutionStatus, MachineStatus } from "./schema.js";
import { parseCompiledHubConfig, type JsonValue } from "../config/compiler.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import { ManualRunRejected } from "../triggers/manual/provider.js";
import {
  markedProviderReplay,
  preRoutingDropEvidence,
  requireManualReceiptReplayBinding,
} from "./receipt-replay.js";
import { launchedAgent } from "./mappers.js";
import type {
  AgentExecutionRecord,
  AgentExecutionOutputAttempt,
  AgentExecutionHubAcknowledgementInput,
  AgentExecutionHubAcknowledgements,
  Database,
  InsertAgentExecutionInput,
  InsertMachineInput,
  MachineRecord,
  TerminateMachineFields,
  TransitionAgentExecutionFields,
  TransitionAgentExecutionResult,
  ProviderEventReceiptRecord,
  ProviderEventReplayMetadata,
  EnrollDaemonInput,
  EnrollmentTokenRecord,
  DaemonRecord,
  CliAuthorizationRecord,
  CliAuthorizationDecisionInput,
  CliAuthorizationPollResult,
  StartCliAuthorizationInput,
  AdvanceGitHubConnectionAttemptInput,
  BindDiscordConnectionInput,
  BindGitHubConnectionInput,
  BindLinearConnectionInput,
  BindSlackConnectionInput,
  CompleteLinearProviderApplicationInput,
  CompleteSlackProviderApplicationInput,
  ConnectionStartAuthority,
  ConnectionProvider,
  ReadConnectionAttemptInput,
  StartConnectionAttemptInput,
  SwitchProjectConfigurationToManualInput,
  SetProjectGitHubConfigurationSourceInput,
  RecordConfigurationSyncAttemptInput,
  ConfigurationSyncAttemptRecord,
  AcceptDiscordEventInput,
  AcceptGitHubEventInput,
  AcceptLinearEventInput,
  AcceptSlackEventInput,
  DurableProviderEvent,
  GitHubInstallationSyncOwner,
  GitHubInstallationSyncClaim,
  GitHubLifecycleReceiptClaimInput,
  AttachmentProvider,
  AttachmentRecord,
  GitHubInstallationSyncResult,
  PersistManualEventInput,
  ManualEventPersistence,
  ManualReceiptReplayTarget,
  ProviderEventAcceptance,
  CreateProjectInput,
  InsertProjectConfigurationRevisionInput,
  InsertAttachmentInput,
  ProjectConfigurationRevisionRecord,
  ProjectRecord,
  TenantRouteAccess,
  GitHubConnectionRecord,
  GitHubConfigurationTarget,
  DiscordConnectionRecord,
  SlackConnectionRecord,
  LinearConnectionRecord,
  GitHubRepositoryRecord,
  GitHubRepositorySnapshot,
  OrganizationConnectionUsage,
  OrganizationRunRecord,
  UnroutedProviderEventCount,
  ProjectTriggerRoute,
  MigrateProjectTriggersInput,
  OrganizationTriggerRecord,
  OrganizationTriggerRevisionRecord,
  PendingProjectTriggerMigration,
  SaveOrganizationTriggerInput,
  OrganizationTriggerRoute,
  CreateAcceptedTriggerRunInput,
  CreateRejectedTriggerRunInput,
  AcceptedTriggerRunRecord,
  RejectedTriggerRunRecord,
  TriggerRunRecord,
  TriggerRunAdmission,
  WorkflowStepExecutionInput,
  WorkflowStepRunRecord,
  WorkflowWakeupRecord,
  WorkflowAgentCompletionInput,
  WorkflowScriptStepStartInput,
  WorkflowScriptStepUpdate,
  WorkflowDeadlineKind,
  WorkflowDeadlineRecovery,
  ProjectActivityRunListRecord,
  OrganizationEntitlementsRecord,
  OperatorOrganizationRecord,
  StampOrganizationEntitlementsInput,
  OverrideOrganizationEntitlementsInput,
  ClearOrganizationEntitlementsOverrideInput,
  EntitlementChangeRecord,
  OrganizationUsageRecord,
  ConsumeOrganizationUsageInput,
  BillingPlanRecord,
  SyncBillingPlanInput,
  OrganizationBillingCustomerRecord,
  ReconcileOrganizationBillingInput,
  UpdateLinearConnectionTokensInput,
  LinearConnectionRefreshOperation,
  ActivityRunPageRecord,
  ActivityRunPageRequest,
  ActivityRunScope,
} from "./types.js";
import {
  clearOverrideKey,
  entitlementOverridesSchema,
  mergeOverrides,
} from "../entitlements/catalog.js";
import { activityTimestampMicros, compareRunsNewestFirst } from "./activity-key.js";
import { toProviderEventReceiptRecordSummary } from "./mappers.js";
import {
  isProviderEventDropReasonCode,
  type ProviderEventDropReasonCode,
} from "../triggers/drop-reason.js";
import {
  isOrdinary,
  jsonbBytes,
  prepareTimelineData,
  timelineBudgetExceeded,
  timelineDedupeKey,
  timelineStepId,
} from "../run-timeline/data.js";
import { progressCooldownDecision, timelineAccountingBatchId } from "../run-timeline/store.js";
import type {
  AdmitProgressWriteInput,
  ProgressWriteAdmission,
  AppendRunTimelineEventInput,
  AppendRunTimelineEventResult,
  InsertRunProgressMessageInput,
  ProgressCredentialCooldown,
  RecordProgressCredentialCooldownInput,
  RunProgressLeaseInput,
  RunProgressMessage,
  RunTimelineEvent,
  RunTimelineState,
  UpdateRunProgressMessageInput,
} from "../run-timeline/store.js";

const OUTPUT_ATTEMPT_LEASE_MS = 5 * 60_000;

export interface MemoryDatabaseOptions {
  schedules?: import("../triggers/schedule/index.js").ScheduleStore;
  githubNotifications?: import("../triggers/github-notifications/index.js").GitHubNotificationStore;
  onInsertAgentExecution?: (execution: AgentExecutionRecord) => void;
  organizationIds?: readonly string[];
  memberships?: readonly {
    userId: string;
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    membershipId: string;
    role: "owner" | "admin" | "member";
  }[];
  now?: () => Date;
  slackConnections?: readonly SlackConnectionRecord[];
  githubConnections?: readonly GitHubConnectionRecord[];
  githubSyncOwner?: GitHubInstallationSyncOwner;
}

function usageKey(organizationId: string, meter: string, periodStart: Date): string {
  return `${organizationId}:${meter}:${periodStart.toISOString()}`;
}

/** Audit before/after snapshot carrying plan provenance, mirroring the Postgres store. */
function entitlementSnapshot(record: OrganizationEntitlementsRecord): unknown {
  return {
    granted: record.granted,
    overrides: record.overrides,
    planId: record.planId,
    planVersion: record.planVersion,
  };
}

function transitionWithTerminalRun(
  transition: TransitionAgentExecutionResult,
  run: TriggerRunRecord | undefined,
): TransitionAgentExecutionResult {
  return !transition.transitioned || run === undefined || run.status === "running"
    ? transition
    : { ...transition, terminalRun: run };
}

function laterCooldown(previous: Date | null, next: Date | null): Date | null {
  if (next === null || (previous !== null && previous >= next)) return previous;
  return new Date(next);
}

export function createMemoryDatabase(options: MemoryDatabaseOptions = {}): Database {
  return new MemoryDatabase(options);
}

class MemoryDatabase implements Database {
  async scanUnknownTemporaryCredentials(after: string | null, limit: number): Promise<string[]> {
    return [...this.agentExecutions.values()]
      .filter(
        (row) =>
          (after === null || row.id > after) &&
          row.usedTemporaryCredentials == null &&
          row.launchIntent !== null &&
          row.launchIntentExpiredAt == null,
      )
      .map(({ id }) => id)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, limit);
  }

  async backfillTemporaryCredentialFact(id: string): Promise<boolean> {
    const row = this.agentExecutions.get(id);
    if (
      row?.launchIntent == null ||
      row.usedTemporaryCredentials != null ||
      row.launchIntentExpiredAt != null
    )
      return false;
    const fact = temporaryCredentialFact(row.launchIntent);
    if (fact === null) return false;
    this.agentExecutions.set(id, { ...row, usedTemporaryCredentials: fact });
    return true;
  }

  async scanAuxiliaryPayloads(
    kind: AuxiliaryPayloadKind,
    after: string | null,
    cutoff: Date,
    limit: number,
  ): Promise<AuxiliaryPayloadCandidate[]> {
    const inPage = (id: string) => after === null || id > after;
    const page = <T extends { id: string }>(items: T[]) =>
      items.sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
    if (kind === "launchIntent") {
      return page(
        [...this.agentExecutions.values()].filter(
          (row) => row.launchIntent !== null && inPage(row.id),
        ),
      ).map((row) => this.launchIntentCandidate(row, cutoff));
    }
    if (kind === "session") {
      return page(
        [...this.agentSessions.values()].filter(
          (row) => row.optionsReducedAt == null && inPage(row.id),
        ),
      ).map((row) => this.sessionOptionsCandidate(row, cutoff));
    }
    return page(
      [...this.machines.values()].filter(
        (machine) =>
          inPage(machine.id) &&
          machine.status === "terminated" &&
          machine.terminatedAt !== null &&
          machine.terminatedAt < cutoff &&
          (machine.triggerContext != null ||
            machine.specs != null ||
            machine.shutdownReason !== null) &&
          ![...this.agentExecutions.values()].some(
            (execution) => execution.machineId === machine.id,
          ) &&
          ![...this.daemons.values()].some((daemon) => daemon.machineId === machine.id),
      ),
    ).map((machine) => ({
      id: machine.id,
      disposition: "machine_legacy",
      ageFrom: machine.terminatedAt,
    }));
  }

  async expireLaunchIntent(id: string, cutoff: Date, now: Date): Promise<boolean> {
    const execution = this.agentExecutions.get(id);
    if (execution?.launchIntent == null) return false;
    const candidate = this.launchIntentCandidate(execution, cutoff);
    if (candidate.disposition !== "eligible") return false;
    this.agentExecutions.set(id, {
      ...execution,
      launchIntent: null,
      launchIntentExpiredAt: new Date(now),
      launchRunId: candidate.runId,
      launchAgent: summarizePayloadAgent(execution.launchIntent.agent),
    });
    return true;
  }

  async reduceSessionOptions(id: string, cutoff: Date, now: Date): Promise<boolean> {
    const prior = this.agentSessions.get(id);
    if (prior === undefined || prior.optionsReducedAt != null) return false;
    const key = sessionLock(prior);
    if (this.advisoryLocks.has(key)) return false;
    return this.withAdvisoryLock(key, async () => {
      const session = this.agentSessions.get(id);
      if (
        session === undefined ||
        session.optionsReducedAt != null ||
        session.continuationKey !== prior.continuationKey ||
        !session.agentId ||
        !session.workspaceId ||
        this.sessionOptionsCandidate(session, cutoff).disposition !== "eligible"
      )
        return false;
      this.agentSessions.set(id, {
        ...session,
        agentId: session.agentId,
        workspaceId: session.workspaceId,
        optionsReducedAt: new Date(now),
        creationOptions: {
          ...summarizePayloadAgent(session.creationOptions),
          toolPolicy: session.creationOptions.toolPolicy,
        },
      });
      return true;
    });
  }

  private launchIntentCandidate(
    execution: AgentExecutionRecord,
    cutoff: Date,
  ): AuxiliaryPayloadCandidate & { runId: string | null } {
    const declared = execution.launchIntent?.triggerRunId ?? null;
    const ids = new Set(
      [...this.workflowStepRuns.values()]
        .filter(
          (step) =>
            step.id === execution.workflowStepRunId || step.agentExecutionId === execution.id,
        )
        .map((step) => step.triggerRunId),
    );
    if (declared !== null) ids.add(declared);
    const [runId = null] = ids;
    const run = runId === null ? undefined : this.triggerRuns.get(runId);
    const ageFrom = execution.completedAt ?? execution.startedAt;
    let disposition: AuxiliaryPayloadCandidate["disposition"] = "eligible";
    if (execution.hubActionAcknowledgements.finishExecutionCall?.status === "running")
      disposition = "pending_hub_action";
    else if (execution.usedTemporaryCredentials == null) disposition = "flag_unknown";
    else if (
      this.hasUnsettledExecution(execution) ||
      ids.size > 1 ||
      (execution.workflowStepRunId !== null && runId === null) ||
      (runId !== null &&
        (run?.organizationId !== execution.organizationId ||
          run.projectId !== execution.projectId ||
          run.payloadExpiryState !== "expired"))
    )
      disposition = "live_owner";
    else if (ageFrom >= cutoff) disposition = "not_old_enough";
    return { id: execution.id, ageFrom, disposition, runId };
  }

  private sessionOptionsCandidate(
    session: AgentSessionRecord,
    cutoff: Date,
  ): AuxiliaryPayloadCandidate {
    const executions = [...this.agentExecutions.values()].filter(
      (row) => row.agentSessionId === session.id,
    );
    const ageFrom =
      executions.reduce<Date | null>((latest, execution) => {
        const activity = execution.completedAt ?? execution.startedAt;
        return latest === null || activity > latest ? activity : latest;
      }, null) ??
      this.agentSessionCreatedAt.get(session.id) ??
      null;
    let disposition: AuxiliaryPayloadCandidate["disposition"] = "eligible";
    if (!session.agentId || !session.workspaceId) disposition = "unbound_session";
    else if (executions.length === 0) disposition = "unused_session";
    else if (!executions.some((execution) => execution.agentSessionAction !== null))
      disposition = "incomplete_bootstrap";
    else if (
      executions.some(
        (execution) =>
          execution.hubActionAcknowledgements.finishExecutionCall?.status === "running",
      )
    )
      disposition = "pending_hub_action";
    else if (executions.some((execution) => this.hasUnsettledExecution(execution)))
      disposition = "live_owner";
    else if (executions.some((execution) => execution.usedTemporaryCredentials == null))
      disposition = "flag_unknown";
    else if (ageFrom !== null && ageFrom >= cutoff) disposition = "not_old_enough";
    return { id: session.id, ageFrom, disposition };
  }

  private hasUnsettledExecution(execution: AgentExecutionRecord): boolean {
    return (
      execution.completedAt === null ||
      execution.status === "spawning" ||
      execution.status === "running" ||
      (execution.hubAction !== null && execution.hubActionCompletedAt === null) ||
      Object.values(execution.outputDeliveryAttempts).some(
        (attempt) => attempt.status === "pending",
      ) ||
      this.authorityRecords.has(execution.id) ||
      [...this.authorityLeases.values()].some((lease) => lease.executionId === execution.id)
    );
  }

  scanReceiptPayloads: Database["scanReceiptPayloads"] = async (
    after,
    cutoff,
    limit,
    state = "intact",
  ) => {
    const page = [...this.providerEventReceipts.values()]
      .filter(
        (receipt) =>
          (after === null || receipt.id > after) &&
          (state === "intact"
            ? receipt.payloadExpiryState == null
            : receipt.payloadExpiryState === state),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit);
    const candidates = page
      .filter(
        (receipt) =>
          !isLifecycleReceipt(receipt) ||
          ![...this.githubInstallationSyncs.values()].some(
            (sync) =>
              sync.deliveryId === receipt.deliveryId ||
              sync.signatureHash === receipt.signatureHash,
          ),
      )
      .map((receipt) => ({
        id: receipt.id,
        ageFrom: receipt.receivedAt,
        disposition: this.receiptProof(receipt, cutoff).disposition,
      }));
    return {
      candidates,
      nextCursor: page.length === limit ? (page.at(-1)?.id ?? null) : null,
    };
  };

  expireReceiptPayload: Database["expireReceiptPayload"] = async (id, cutoff, now) => {
    const receipt = this.providerEventReceipts.get(id);
    if (receipt === undefined || receipt.payloadExpiryState === "expired")
      return { status: "skipped", disposition: "changed_or_missing" };
    const proof = this.receiptProof(receipt, cutoff);
    if (proof.disposition !== "eligible" && proof.disposition !== "expiring")
      return { status: "skipped", disposition: proof.disposition };
    this.providerEventReceipts.set(id, {
      ...receipt,
      payload: {},
      acceptedRoutes: null,
      preRoutingDrop: null,
      manualReplayBinding:
        proof.disposition === "eligible" ? proof.binding : (receipt.manualReplayBinding ?? null),
      payloadExpiryState: "expired",
      payloadExpiredAt: receipt.payloadExpiredAt ?? new Date(now),
    });
    return { status: "expired" };
  };

  private receiptProof(receipt: ProviderEventReceiptRecord, cutoff: Date) {
    const branches: ReceiptProofBranch[] = [];
    for (const project of this.triggerRunIdsByProviderEventReceipt.get(receipt.id)?.values() ??
      []) {
      for (const id of project.values()) {
        const run = this.triggerRuns.get(id);
        if (run === undefined) continue;
        const work = this.runPayloadWorkDisposition(run);
        const blocker = work === "live" || work === "cleanup_blocked" ? "live_execution" : work;
        branches.push({
          ...run,
          payloadExpiryState: run.payloadExpiryState ?? null,
          payloadExpiredAt: run.payloadExpiredAt ?? null,
          blocker: blocker === "eligible" ? null : blocker,
        });
      }
    }
    const connections =
      receipt.provider === "github"
        ? this.githubConnections.values()
        : this.linearConnections.values();
    const legacyBindingValid =
      (receipt.provider === "github" || receipt.provider === "linear") &&
      [...connections].some(
        (connection) =>
          connection.id === receipt.connectionId &&
          connection.organizationId === receipt.organizationId &&
          (receipt.providerApplicationId === null ||
            connection.providerApplicationId === receipt.providerApplicationId),
      );
    return proveReceipt(
      {
        ...receipt,
        legacyBindingValid,
        hasCapability: [...this.attachments.values()].some(
          (cap) => cap.providerEventReceiptId === receipt.id,
        ),
        hasLifecycleWork:
          receipt.provider === "github" &&
          [...this.githubInstallationSyncs.values()].some(
            (sync) =>
              sync.retryAt !== null &&
              (sync.deliveryId === receipt.deliveryId ||
                sync.signatureHash === receipt.signatureHash),
          ),
      },
      branches,
      (id) => this.configurationRevisions.get(id),
      cutoff,
    );
  }

  scanGitHubSyncPayloads: Database["scanGitHubSyncPayloads"] = async (after, cutoff, limit) =>
    [...this.githubInstallationSyncs.values()]
      .filter((sync) => sync.payloadExpiredAt === null && (after === null || sync.id > after))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((sync) => ({
        id: sync.id,
        ageFrom: sync.settledAt ?? sync.receivedAt,
        disposition: this.syncDisposition(sync, cutoff),
        receiptCopyAgeFrom:
          [...this.providerEventReceipts.values()].find(
            (receipt) =>
              receipt.signatureHash === sync.signatureHash &&
              receipt.payloadExpiryState == null &&
              isLifecycleReceipt(receipt),
          )?.receivedAt ?? null,
      }));

  expireGitHubSyncPayload: Database["expireGitHubSyncPayload"] = async (id, cutoff, now) => {
    const sync = this.githubInstallationSyncs.get(id);
    if (sync === undefined || sync.payloadExpiredAt !== null)
      return { status: "skipped", disposition: "changed_or_missing" };
    const disposition = this.syncDisposition(sync, cutoff);
    if (disposition !== "eligible") return { status: "skipped", disposition };
    const link = readSyncAuditLink(sync.auditLink);
    const copy =
      link?.kind === "receipt" ? this.providerEventReceipts.get(link.receiptId) : undefined;
    if (copy !== undefined) {
      this.providerEventReceipts.set(copy.id, {
        ...copy,
        payload: {},
        acceptedRoutes: null,
        preRoutingDrop: null,
        manualReplayBinding: null,
        payloadExpiryState: "expired",
        payloadExpiredAt: new Date(now),
      });
    }
    this.githubInstallationSyncs.set(id, { ...sync, payload: {}, payloadExpiredAt: new Date(now) });
    return { status: "expired", receiptCopy: copy !== undefined };
  };

  private hasAnySyncCopy(
    sync: Pick<GitHubLifecycleReceiptClaimInput, "deliveryId" | "signatureHash">,
    checkDelivery: boolean,
  ) {
    return [...this.providerEventReceipts.values()].some(
      (receipt) =>
        receipt.signatureHash === sync.signatureHash ||
        (checkDelivery && receipt.deliveryId === sync.deliveryId),
    );
  }

  private syncDisposition(sync: MemoryGitHubSync, cutoff: Date) {
    const link = readSyncAuditLink(sync.auditLink);
    const copy =
      link?.kind === "receipt" ? this.providerEventReceipts.get(link.receiptId) : undefined;
    return syncPayloadDisposition(
      sync,
      copy === undefined
        ? undefined
        : {
            ...copy,
            hasReferences:
              this.triggerRunIdsByProviderEventReceipt.has(copy.id) ||
              [...this.attachments.values()].some((cap) => cap.providerEventReceiptId === copy.id),
          },
      this.hasAnySyncCopy(sync, link?.kind === "none"),
      cutoff,
    );
  }

  scanGitHubCursorDiagnostics: Database["scanGitHubCursorDiagnostics"] = async (
    after,
    cutoff,
    limit,
  ) => {
    const status = this.notificationStatus;
    return limit === 0 || (after !== null && after >= "notifications") || status.lastError === null
      ? []
      : [
          {
            source: "notifications",
            ageFrom: status.lastErrorAt,
            disposition: cursorDiagnosticDisposition(status, cutoff),
          },
        ];
  };

  expireGitHubCursorDiagnostic: Database["expireGitHubCursorDiagnostic"] = async (
    source,
    cutoff,
    now,
  ) => {
    const status = this.notificationStatus;
    if (source !== "notifications" || status.lastError === null)
      return { status: "skipped", disposition: "changed_or_missing" };
    const disposition = cursorDiagnosticDisposition(status, cutoff);
    if (disposition !== "eligible") return { status: "skipped", disposition };
    status.lastError = EXPIRED_CURSOR_DIAGNOSTIC;
    status.diagnosticExpiredAt = new Date(now);
    return { status: "expired" };
  };

  async scanRunPayloads(after: string | null, cutoff: Date, limit: number, countOnly: boolean) {
    return [...this.triggerRuns.values()]
      .filter(
        (run) =>
          (after === null || run.id > after) &&
          run.payloadExpiryState !== "expired" &&
          (countOnly ||
            (run.status !== "running" &&
              run.completedAt !== null &&
              (run.completedAt < cutoff || run.payloadExpiryState === "expiring"))),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((run) => ({
        id: run.id,
        disposition: this.runPayloadDisposition(run, cutoff),
        ageFrom: run.completedAt ?? run.createdAt,
      }));
  }

  async expireRunPayloadChunk(id: string, cutoff: Date, now: Date) {
    const run = this.triggerRuns.get(id);
    if (
      run === undefined ||
      run.payloadExpiryState === "expired" ||
      this.runPayloadDisposition(run, cutoff) !== "eligible"
    )
      return "skipped";
    const steps = this.listSteps(id);
    if (run.payloadExpiryState == null) {
      this.stageRunPayload(run, steps, now);
      return "expiring";
    }
    const executions = this.runPayloadExecutions(run, steps)
      .filter(
        (execution) =>
          execution.result != null ||
          execution.triggerContext != null ||
          execution.outputContext != null ||
          (execution.completedByAgentAt !== null && execution.payloadCompletion == null),
      )
      .slice(0, 50);
    if (executions.length > 0) {
      for (const execution of executions) {
        this.agentExecutions.set(execution.id, {
          ...execution,
          payloadCompletion: payloadCompletion(execution),
          result: null,
          triggerContext: null,
          outputContext: null,
        });
      }
      return "expiring";
    }
    const chunk = steps.filter((step) => step.payloadSummary == null).slice(0, 50);
    if (chunk.length > 0) {
      for (const step of chunk) {
        this.workflowStepRuns.set(step.id, {
          ...step,
          payloadSummary: summarizeStepPayload(step),
          output: null,
          failureReason: null,
          dispatchIntent: null,
        });
      }
      return "expiring";
    }
    this.triggerRuns.set(id, { ...run, payloadExpiryState: "expired" });
    return "expired";
  }

  private stageRunPayload(
    run: TriggerRunRecord,
    steps: readonly WorkflowStepRunRecord[],
    now: Date,
  ) {
    const stepCounts: RunPayloadSummary["stepCounts"] = {};
    for (const step of steps) stepCounts[step.status] = (stepCounts[step.status] ?? 0) + 1;
    const receipt = this.providerEventReceipts.get(run.providerEventReceiptId);
    if (receipt === undefined) throw new Error("run payload receipt unavailable");
    const summary = summarizeRunPayload(
      run,
      receipt,
      stepCounts,
      this.runTimelineStates.get(run.id),
      this.runProgressMessages.get(run.id),
    );
    const reduced = {
      ...run,
      payloadExpiredAt: new Date(now),
      payloadExpiryState: "expiring" as const,
      payloadSummary: summary,
      prompt: "",
      inputs: {},
      values: {},
      triggerContext: {},
      outputContext: {},
      conversation: null,
    };
    this.triggerRuns.set(
      run.id,
      reduced.outcome === "rejected"
        ? { ...reduced, rejection: reduceRejection(reduced.rejection) }
        : { ...reduced, failureReason: summary.failureCode },
    );
  }

  private runPayloadDisposition(run: TriggerRunRecord, cutoff: Date): RunPayloadDisposition {
    if (run.status === "running") return "live";
    if (run.completedAt === null) return "missing_completion";
    if (run.completedAt >= cutoff && run.payloadExpiryState !== "expiring") return "not_old_enough";
    const work = this.runPayloadWorkDisposition(run);
    if (work !== "eligible") return work;
    return this.hasUnresolvedRunFanout(run.providerEventReceiptId)
      ? "fan_out_unresolved"
      : "eligible";
  }

  private runPayloadWorkDisposition(run: TriggerRunRecord) {
    if (run.status === "running") return "live";
    const steps = this.listSteps(run.id);
    if (
      steps.some(
        (step) =>
          scriptCleanupPending(step) ||
          (step.agentExecutionId === null && readScriptStepHandle(step.output) !== undefined),
      )
    )
      return "cleanup_blocked";
    if (
      this.workflowWakeups.has(run.id) ||
      steps.some(
        (step) =>
          step.status === "running" || (step.status === "pending" && step.dispatchIntent !== null),
      ) ||
      this.runPayloadExecutions(run, steps).some(isRunExecutionUnfinished)
    )
      return "live";
    if (
      run.outcome === "accepted" &&
      (run.terminalNotificationLeaseExpiresAt !== null ||
        (run.terminalNotificationPendingAt !== null &&
          run.terminalNotificationDeliveredAt === null))
    )
      return "notification_pending";
    const message = this.runProgressMessages.get(run.id);
    if (message !== undefined && isProgressUnsettled(message)) return "reporter_pending";
    return "eligible";
  }

  private hasUnresolvedRunFanout(receiptId: string): boolean {
    const receipt = this.providerEventReceipts.get(receiptId);
    if (receipt === undefined || receipt.payloadExpiryState != null) return true;
    const expected = expectedFanout(receipt, (id) => this.configurationRevisions.get(id));
    const branches = this.triggerRunIdsByProviderEventReceipt.get(receiptId);
    const runs = [...(branches?.values() ?? [])].flatMap((project) =>
      [...project.values()].flatMap((id) => {
        const run = this.triggerRuns.get(id);
        return run === undefined ? [] : [run];
      }),
    );
    return !coversExpectedFanout(expected, runs);
  }

  private runPayloadExecutions(run: TriggerRunRecord, steps: readonly WorkflowStepRunRecord[]) {
    return [...this.agentExecutions.values()].filter((execution) => {
      if (execution.organizationId !== run.organizationId || execution.projectId !== run.projectId)
        return false;
      return (
        steps.some(
          (step) =>
            execution.workflowStepRunId === step.id || execution.id === step.agentExecutionId,
        ) ||
        (execution.workflowStepRunId === null &&
          (execution.launchRunId === run.id ||
            (execution.launchIntent?.kind === "launch_machine" &&
              execution.launchIntent.triggerRunId === run.id)))
      );
    });
  }

  // This test double has no background work. Scheduling tests use the actual embedded/PG runtime.
  get schedules(): import("../triggers/schedule/index.js").ScheduleStore {
    return (
      this.options.schedules ?? {
        async tick() {
          return 0;
        },
      }
    );
  }
  // Like schedules, polling needs real SQL; tests of it use the embedded runtime. This double
  // keeps only the status the Triggers page reads, and no cursor, so it never polls GitHub.
  get githubNotifications(): import("../triggers/github-notifications/index.js").GitHubNotificationStore {
    this.notificationStore ??= this.options.githubNotifications ?? this.memoryNotificationStore();
    return this.notificationStore;
  }
  private readonly notificationStatus = {
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    nextPollAt: null,
    diagnosticExpiredAt: null,
  } as {
    lastSuccessAt: Date | null;
    lastError: string | null;
    lastErrorAt: Date | null;
    nextPollAt: Date | null;
    diagnosticExpiredAt: Date | null;
  };

  private notificationStore:
    | import("../triggers/github-notifications/index.js").GitHubNotificationStore
    | undefined;
  private memoryNotificationStore(): import("../triggers/github-notifications/index.js").GitHubNotificationStore {
    const status = this.notificationStatus;
    return {
      exclusive: (operation) => operation(),
      async readCursor() {
        return undefined;
      },
      async saveCursor(cursor) {
        status.nextPollAt = cursor.nextPollAt;
      },
      async deliver() {
        return { started: 0, deferred: false };
      },
      async recordSuccess(now) {
        status.lastSuccessAt = now;
        status.lastError = null;
        status.diagnosticExpiredAt = null;
      },
      async recordFailure(now, message) {
        status.lastError = message;
        status.lastErrorAt = now;
        status.diagnosticExpiredAt = null;
      },
      async readStatus() {
        const { lastSuccessAt, lastError, lastErrorAt, nextPollAt } = status;
        return { lastSuccessAt, lastError, lastErrorAt, nextPollAt };
      },
      countDelivered: async (organizationId, since) =>
        [...this.providerEventReceipts.values()].filter(
          (receipt) =>
            receipt.organizationId === organizationId &&
            receipt.provider === "github_notification" &&
            receipt.receivedAt.getTime() >= since.getTime(),
        ).length,
    };
  }
  private readonly providerEventReceipts = new Map<string, ProviderEventReceiptRecord>();
  private readonly providerEventReceiptIdsByDelivery = new Map<string, string>();
  private readonly providerEventReceiptIdsBySignature = new Map<string, string>();
  private readonly machines = new Map<string, MachineRecord>();
  private readonly agentExecutions = new Map<string, AgentExecutionRecord>();
  private readonly triggerRuns = new Map<string, TriggerRunRecord>();
  private readonly runTimelineStates = new Map<string, RunTimelineState>();
  private readonly runTimelineEvents = new Map<string, RunTimelineEvent[]>();
  private readonly runTimelineDedupe = new Map<string, Map<string, number>>();
  private readonly runTimelineAccountingBatchIds = new Map<string, string[]>();
  private readonly runProgressMessages = new Map<string, RunProgressMessage>();
  private readonly triggerRunIdsByProviderEventReceipt = new Map<
    string,
    Map<string, Map<string, string>>
  >();
  private readonly workflowStepRuns = new Map<string, WorkflowStepRunRecord>();
  private readonly workflowWakeups = new Map<string, WorkflowWakeupRecord>();
  private readonly attachments = new Map<string, AttachmentRecord>();
  private readonly attachmentIdsBySource = new Map<string, string>();
  private readonly enrollmentTokens = new Map<string, EnrollmentTokenRecord>();
  private readonly cliAuthorizations = new Map<string, MemoryCliAuthorization>();
  private readonly daemons = new Map<string, DaemonRecord>();
  private readonly organizationEntitlements = new Map<string, OrganizationEntitlementsRecord>();
  private readonly entitlementChanges: EntitlementChangeRecord[] = [];
  private readonly organizationUsage = new Map<string, OrganizationUsageRecord>();
  private readonly billingPlans = new Map<string, BillingPlanRecord>();
  private readonly organizationBillingCustomers = new Map<
    string,
    OrganizationBillingCustomerRecord
  >();
  private readonly advisoryLocks = new Map<string, Promise<void>>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly configurationRevisions = new Map<string, ProjectConfigurationRevisionRecord>();
  private readonly configurationAuthorities = new Map<string, "manual" | "github">();
  private readonly githubConfigurationSources = new Map<
    string,
    {
      githubConnectionId: string;
      githubRepositoryId: number;
      githubRepositoryFullName: string;
      githubDefaultBranch: string;
      automaticDeploymentEnabled: boolean;
    }
  >();
  private readonly configurationSyncAttempts = new Map<string, ConfigurationSyncAttemptRecord[]>();
  private readonly projectTriggerRoutes = new Map<string, ProjectTriggerRoute[]>();
  private readonly organizationTriggers = new Map<string, OrganizationTriggerRecord>();
  private readonly organizationTriggerRevisions = new Map<
    string,
    OrganizationTriggerRevisionRecord
  >();
  private readonly migratedProjects = new Set<string>();
  private readonly organizationTriggerRoutes = new Map<string, OrganizationTriggerRoute[]>();
  private readonly githubRepositories = new Map<string, GitHubRepositoryRecord>();
  private readonly githubConnections = new Map<number, GitHubConnectionRecord>();
  private readonly discordConnections = new Map<string, DiscordConnectionRecord>();
  private readonly slackConnections = new Map<string, SlackConnectionRecord>();
  private readonly linearConnections = new Map<string, LinearConnectionRecord>();
  private readonly organizationIds: Set<string>;
  private readonly homeChecklistCompletions = new Map<string, Date>();

  constructor(private readonly options: MemoryDatabaseOptions = {}) {
    this.organizationIds = new Set([
      ...(options.organizationIds ?? []),
      ...(options.memberships ?? []).map(({ organizationId }) => organizationId),
    ]);
    for (const connection of options.githubConnections ?? [])
      this.githubConnections.set(connection.installationId, connection);
    for (const connection of options.slackConnections ?? []) {
      this.slackConnections.set(connection.teamId, connection);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async appendRunTimelineEvent(
    input: AppendRunTimelineEventInput,
  ): Promise<AppendRunTimelineEventResult> {
    const maxEvents = input.maxEvents ?? 500;
    if (!Number.isInteger(maxEvents) || maxEvents < 50 || maxEvents > 5000) {
      throw new RangeError("Invalid timeline event limit");
    }
    const stepId = timelineStepId(input.stepId ?? "");
    const dedupeKey = timelineDedupeKey(input.kind, stepId, input.data);
    const opened = this.openTimelineForAppend(input, dedupeKey);
    if (opened === undefined || !("eventCount" in opened)) return opened;
    const state = opened;
    const notice =
      this.runTimelineEvents.get(state.triggerRunId)?.some((row) => row.kind === "truncated") ??
      false;
    if (state.stepEndCount >= 100 || input.kind === "run_finished")
      this.refreshTimelineStepOmissions(state);
    const data = prepareTimelineData(
      input.kind,
      input.kind === "run_finished"
        ? { ...input.data, stepRowsOmitted: state.stepRowsOmitted }
        : input.data,
    );
    const bytes = jsonbBytes(data);
    if (timelineBudgetExceeded(state, input.kind, bytes, maxEvents, notice)) {
      this.dropTimelineEvent(state, input, notice);
      return { reason: "cap" };
    }
    const event: RunTimelineEvent = {
      triggerRunId: state.triggerRunId,
      organizationId: state.organizationId,
      seq: state.eventCount + 1,
      kind: input.kind,
      at: new Date(input.at),
      stepId,
      data,
    };
    this.insertTimelineEvent(state, event);
    if (dedupeKey !== undefined) {
      const dedupe = this.runTimelineDedupe.get(state.triggerRunId) ?? new Map<string, number>();
      dedupe.set(dedupeKey, event.seq);
      this.runTimelineDedupe.set(state.triggerRunId, dedupe);
    }
    if (isOrdinary(input.kind)) state.byteCount += bytes;
    if (input.kind === "step_finished") {
      state.stepEndCount += 1;
      state.stepEndBytes += bytes;
      if (state.stepEndCount >= 100) this.refreshTimelineStepOmissions(state);
    }
    if (input.kind === "run_finished") {
      state.sealedSeq = event.seq;
      state.sealedAt = new Date(input.at);
    }
    return { seq: event.seq, inserted: true };
  }

  async recordRunTimelineDrops(
    organizationId: string,
    runId: string,
    count: number,
    at: Date,
    batchId: string,
  ) {
    if (!Number.isSafeInteger(count) || count <= 0)
      throw new RangeError("Invalid timeline drop count");
    batchId = timelineAccountingBatchId(batchId);
    const run = this.triggerRuns.get(runId);
    if (!isOpenTimelineRun(run, organizationId)) return undefined;
    let state = this.runTimelineStates.get(runId);
    if (state?.expiredAt != null) return undefined;
    if (state === undefined) {
      const opened = this.openTimelineForAppend(
        {
          triggerRunId: runId,
          organizationId,
          kind: "truncated",
          at,
          data: {},
          origin: "captured",
        },
        undefined,
      );
      if (opened === undefined || !("eventCount" in opened)) return undefined;
      state = opened;
    }
    const batchIds = this.runTimelineAccountingBatchIds.get(runId) ?? [];
    if (batchIds.includes(batchId)) {
      const notice = this.runTimelineEvents.get(runId)?.find((event) => event.kind === "truncated");
      return notice === undefined
        ? { seq: state.eventCount, inserted: false }
        : { seq: state.eventCount, inserted: false, noticeSeq: notice.seq };
    }
    batchIds.push(batchId);
    if (batchIds.length > 16) batchIds.shift();
    this.runTimelineAccountingBatchIds.set(runId, batchIds);
    state.droppedCount += count;
    const notice =
      this.runTimelineEvents.get(runId)?.some((event) => event.kind === "truncated") ?? false;
    if (state.sealedSeq !== null || notice) return { seq: state.eventCount, inserted: false };
    const seq = state.eventCount + 1;
    this.insertTimelineEvent(state, {
      triggerRunId: runId,
      organizationId,
      seq,
      kind: "truncated",
      at: new Date(at),
      stepId: "",
      data: { dropped: state.droppedCount },
    });
    return { seq, inserted: true };
  }

  private openTimelineForAppend(
    input: AppendRunTimelineEventInput,
    dedupeKey: string | undefined,
  ): RunTimelineState | AppendRunTimelineEventResult {
    const run = this.triggerRuns.get(input.triggerRunId);
    if (
      run === undefined ||
      run.organizationId !== input.organizationId ||
      run.outcome !== "accepted"
    )
      return undefined;
    if (run.payloadExpiredAt != null) return { reason: "expired" };
    let state = this.runTimelineStates.get(run.id);
    if (state?.expiredAt != null) return { reason: "expired" };
    if (state?.sealedSeq != null) {
      if (isOrdinary(input.kind)) state.droppedCount += 1;
      return { reason: "sealed" };
    }
    const existingSeq =
      dedupeKey === undefined ? undefined : this.runTimelineDedupe.get(run.id)?.get(dedupeKey);
    if (existingSeq !== undefined) return { seq: existingSeq, inserted: false };
    if (input.kind === "truncated") {
      const notice = this.runTimelineEvents.get(run.id)?.find((row) => row.kind === "truncated");
      if (notice !== undefined) return { seq: notice.seq, inserted: false };
    }
    if (state === undefined) {
      state = {
        triggerRunId: run.id,
        organizationId: run.organizationId,
        eventCount: 0,
        byteCount: 0,
        stepEndCount: 0,
        stepEndBytes: 0,
        stepRowsOmitted: 0,
        droppedCount: 0,
        sealedSeq: null,
        sealedAt: null,
        origin: input.origin,
        expiredAt: null,
      };
      this.runTimelineStates.set(run.id, state);
    }
    return state;
  }

  private dropTimelineEvent(
    state: RunTimelineState,
    input: AppendRunTimelineEventInput,
    notice: boolean,
  ): void {
    if (isOrdinary(input.kind)) state.droppedCount += 1;
    else this.refreshTimelineStepOmissions(state);
    if (!notice)
      this.insertTimelineEvent(state, {
        triggerRunId: state.triggerRunId,
        organizationId: state.organizationId,
        seq: state.eventCount + 1,
        kind: "truncated",
        at: new Date(input.at),
        stepId: "",
        data: { dropped: state.droppedCount },
      });
  }

  private insertTimelineEvent(state: RunTimelineState, event: RunTimelineEvent): void {
    const events = this.runTimelineEvents.get(state.triggerRunId) ?? [];
    events.push(event);
    this.runTimelineEvents.set(state.triggerRunId, events);
    state.eventCount = event.seq;
  }

  private refreshTimelineStepOmissions(state: RunTimelineState): void {
    let terminalCount = 0;
    for (const step of this.workflowStepRuns.values()) {
      if (
        step.triggerRunId === state.triggerRunId &&
        step.status !== "pending" &&
        step.status !== "running"
      )
        terminalCount += 1;
    }
    state.stepRowsOmitted = Math.max(state.stepRowsOmitted, terminalCount - state.stepEndCount);
  }

  async listRunTimelineEvents(
    organizationId: string,
    runId: string,
    page: { afterSeq: number; limit: number },
  ): Promise<RunTimelineEvent[]> {
    const run = this.triggerRuns.get(runId);
    if (run?.organizationId !== organizationId || run.payloadExpiredAt != null) return [];
    return structuredClone(
      (this.runTimelineEvents.get(runId) ?? [])
        .filter((event) => event.organizationId === organizationId && event.seq > page.afterSeq)
        .slice(0, Math.max(0, Math.min(5110, page.limit))),
    );
  }

  async readRunTimelineState(
    organizationId: string,
    runId: string,
  ): Promise<RunTimelineState | undefined> {
    const state = this.runTimelineStates.get(runId);
    return state?.organizationId === organizationId &&
      this.triggerRuns.get(runId)?.organizationId === organizationId
      ? structuredClone(state)
      : undefined;
  }

  async findTriggerRunForOrganization(
    organizationId: string,
    runId: string,
  ): Promise<TriggerRunRecord | undefined> {
    const run = this.triggerRuns.get(runId);
    return run?.organizationId === organizationId ? structuredClone(run) : undefined;
  }

  async resolveRunForExecution(
    executionId: string,
  ): Promise<{ triggerRunId: string; organizationId: string; stepId: string } | undefined> {
    const execution = this.agentExecutions.get(executionId);
    if (execution?.workflowStepRunId === null || execution === undefined) return undefined;
    const step = this.workflowStepRuns.get(execution.workflowStepRunId);
    const run = step === undefined ? undefined : this.triggerRuns.get(step.triggerRunId);
    return run === undefined ||
      step === undefined ||
      run.organizationId !== execution.organizationId
      ? undefined
      : { triggerRunId: run.id, organizationId: run.organizationId, stepId: step.stepId };
  }

  async listUnsealedTerminalRuns(
    olderThan: Date,
    cutoff: Date,
    limit: number,
  ): Promise<AcceptedTriggerRunRecord[]> {
    return structuredClone(
      [...this.triggerRuns.values()]
        .filter((run): run is AcceptedTriggerRunRecord => {
          const state = this.runTimelineStates.get(run.id);
          return (
            run.outcome === "accepted" &&
            run.status !== "running" &&
            run.completedAt !== null &&
            run.completedAt < olderThan &&
            run.completedAt >= cutoff &&
            run.payloadExpiredAt == null &&
            state?.sealedSeq == null &&
            state?.expiredAt == null
          );
        })
        .sort(
          (left, right) =>
            left.completedAt!.getTime() - right.completedAt!.getTime() ||
            left.id.localeCompare(right.id),
        )
        .slice(0, Math.max(0, limit)),
    );
  }

  async expireRunTimelines(cutoff: Date, batch: number): Promise<number> {
    const candidates = [...this.triggerRuns.values()]
      .filter((run) => {
        if (run.status === "running" || run.completedAt === null || run.completedAt >= cutoff) {
          return false;
        }
        const state = this.runTimelineStates.get(run.id);
        const progress = this.runProgressMessages.get(run.id);
        if (
          progress !== undefined &&
          (isProgressUnsettled(progress) ||
            (progress.credentialRetryAt?.getTime() ?? 0) > Date.now() ||
            (progress.credentialRejectedUntil?.getTime() ?? 0) > Date.now())
        )
          return false;
        return (state !== undefined && state.expiredAt === null) || progress !== undefined;
      })
      .sort(
        (left, right) =>
          left.completedAt!.getTime() - right.completedAt!.getTime() ||
          left.id.localeCompare(right.id),
      )
      .slice(0, Math.min(500, Math.max(0, Math.floor(batch))));
    for (const run of candidates) {
      this.runTimelineEvents.delete(run.id);
      this.runTimelineDedupe.delete(run.id);
      this.runTimelineAccountingBatchIds.delete(run.id);
      this.runProgressMessages.delete(run.id);
      const state = this.runTimelineStates.get(run.id);
      if (state !== undefined && state.expiredAt === null) {
        state.expiredAt = new Date(cutoff);
      }
    }
    return candidates.length;
  }

  async insertRunProgressMessageIfAbsent(
    input: InsertRunProgressMessageInput,
  ): Promise<RunProgressMessage | undefined> {
    const run = this.triggerRuns.get(input.triggerRunId);
    if (
      run?.organizationId !== input.organizationId ||
      run.outcome !== "accepted" ||
      run.payloadExpiredAt != null ||
      this.runTimelineStates.get(run.id)?.expiredAt != null
    )
      return undefined;
    const existing = this.runProgressMessages.get(run.id);
    if (existing !== undefined) return structuredClone(existing);
    const message: RunProgressMessage = {
      triggerRunId: run.id,
      organizationId: run.organizationId,
      provider: input.provider,
      state: "pending",
      externalRef: null,
      version: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastRenderedHash: null,
      lastEditAt: null,
      lastRegularAttemptAt: null,
      lastRegularReservationVersion: null,
      editCount: 0,
      failedEdits: 0,
      finalFailures: 0,
      retryAt: null,
      credentialKey: null,
      credentialRetryAt: null,
      credentialRejectedUntil: null,
      settleAt: null,
      repeatFinal: false,
      visibility: null,
      visibilityCheckedAt: null,
      failure: null,
      compensationRequestedGen: 0,
      compensationDoneGen: 0,
      compensationNotBefore: null,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    };
    this.runProgressMessages.set(run.id, message);
    return structuredClone(message);
  }

  async findRunProgressMessage(
    organizationId: string,
    runId: string,
  ): Promise<RunProgressMessage | undefined> {
    const message = this.runProgressMessages.get(runId);
    return message?.organizationId === organizationId &&
      this.triggerRuns.get(runId)?.organizationId === organizationId &&
      this.triggerRuns.get(runId)?.payloadExpiredAt == null
      ? structuredClone(message)
      : undefined;
  }

  async acquireRunProgressLease(
    input: RunProgressLeaseInput,
  ): Promise<RunProgressMessage | undefined> {
    const message = this.runProgressMessages.get(input.triggerRunId);
    if (
      message?.organizationId !== input.organizationId ||
      this.triggerRuns.get(input.triggerRunId)?.organizationId !== input.organizationId ||
      this.triggerRuns.get(input.triggerRunId)?.payloadExpiredAt != null ||
      (message.leaseOwner !== null &&
        message.leaseOwner !== input.owner &&
        message.leaseExpiresAt !== null &&
        message.leaseExpiresAt > input.now)
    )
      return undefined;
    message.leaseOwner = input.owner;
    message.leaseExpiresAt = new Date(input.now.getTime() + 60_000);
    message.version += 1;
    message.updatedAt = new Date(input.now);
    return structuredClone(message);
  }

  async updateRunProgressMessage(
    input: UpdateRunProgressMessageInput,
  ): Promise<RunProgressMessage | undefined> {
    const message = this.leasedProgressMessage(input);
    if (message === undefined) return undefined;
    const keys = [
      "state",
      "externalRef",
      "lastRenderedHash",
      "lastEditAt",
      "lastRegularAttemptAt",
      "editCount",
      "failedEdits",
      "finalFailures",
      "retryAt",
      "settleAt",
      "repeatFinal",
      "visibility",
      "visibilityCheckedAt",
      "failure",
    ] as const;
    for (const key of keys) {
      if (input.patch[key] !== undefined) {
        Object.assign(message, { [key]: structuredClone(input.patch[key]) });
      }
    }
    if (input.releaseLease !== false) {
      message.leaseOwner = null;
      message.leaseExpiresAt = null;
    }
    message.updatedAt = new Date(input.now);
    return structuredClone(message);
  }

  private leasedProgressMessage(
    input: RunProgressLeaseInput & { version: number },
  ): RunProgressMessage | undefined {
    const message = this.runProgressMessages.get(input.triggerRunId);
    if (
      message?.organizationId !== input.organizationId ||
      this.triggerRuns.get(input.triggerRunId)?.organizationId !== input.organizationId ||
      this.triggerRuns.get(input.triggerRunId)?.payloadExpiredAt != null ||
      message.leaseOwner !== input.owner ||
      message.version !== input.version ||
      message.leaseExpiresAt === null ||
      message.leaseExpiresAt <= input.now
    )
      return undefined;
    return message;
  }

  async admitProgressWrite(input: AdmitProgressWriteInput): Promise<ProgressWriteAdmission> {
    const message = this.leasedProgressMessage(input);
    if (message?.state !== input.state) return { status: "lease_lost" };
    const cooldown = progressCooldownDecision(
      this.progressCredentialCooldown(input.key),
      input.now,
    );
    if (cooldown !== undefined) return cooldown;
    if (input.reservation === "create") {
      message.state = "creating";
      message.externalRef = structuredClone(input.createReference ?? null);
      message.updatedAt = new Date(input.now);
    }
    if (
      input.reservation === "regular" &&
      message.lastRegularReservationVersion !== input.version
    ) {
      message.lastRegularReservationVersion = input.version;
      message.editCount += 1;
      message.lastRegularAttemptAt = new Date(input.now);
      message.updatedAt = new Date(input.now);
    }
    return { status: "admitted" };
  }

  async readProgressCredentialCooldown(key: string): Promise<ProgressCredentialCooldown> {
    return structuredClone(this.progressCredentialCooldown(key));
  }

  private progressCredentialCooldown(key: string): ProgressCredentialCooldown {
    let retryAt: Date | null = null;
    let rejectedUntil: Date | null = null;
    for (const row of this.runProgressMessages.values()) {
      if (row.credentialKey !== key) continue;
      retryAt = laterCooldown(retryAt, row.credentialRetryAt);
      rejectedUntil = laterCooldown(rejectedUntil, row.credentialRejectedUntil);
    }
    return { retryAt, rejectedUntil };
  }

  async recordProgressCredentialCooldown(
    input: RecordProgressCredentialCooldownInput,
  ): Promise<void> {
    const row = this.runProgressMessages.get(input.triggerRunId);
    if (
      row?.organizationId !== input.organizationId ||
      this.triggerRuns.get(input.triggerRunId)?.payloadExpiredAt != null
    )
      return;
    const sameCredential = row.credentialKey === input.key;
    row.credentialKey = input.key;
    row.credentialRetryAt = laterCooldown(
      sameCredential ? row.credentialRetryAt : null,
      input.retryAt,
    );
    row.credentialRejectedUntil = laterCooldown(
      sameCredential ? row.credentialRejectedUntil : null,
      input.rejectedUntil,
    );
  }

  async listOpenRunProgressMessages(
    afterRunId: string | null,
    limit: number,
  ): Promise<RunProgressMessage[]> {
    return structuredClone(
      [...this.runProgressMessages.values()]
        .filter(
          (row) =>
            (afterRunId === null || row.triggerRunId > afterRunId) &&
            this.triggerRuns.get(row.triggerRunId)?.payloadExpiredAt == null &&
            (["pending", "active"].includes(row.state) || row.settleAt !== null),
        )
        .sort((left, right) => left.triggerRunId.localeCompare(right.triggerRunId))
        .slice(0, limit),
    );
  }

  async listRunProgressMessagesToFinish(
    now: Date,
    limit: number,
    settleThrough = now,
  ): Promise<RunProgressMessage[]> {
    return structuredClone(
      [...this.runProgressMessages.values()]
        .filter((message) => {
          const run = this.triggerRuns.get(message.triggerRunId);
          if (
            run === undefined ||
            run.organizationId !== message.organizationId ||
            run.outcome !== "accepted" ||
            run.payloadExpiredAt != null
          )
            return false;
          const terminal = run.status !== "running";
          if (this.progressMessageNeedsSettle(message, settleThrough)) return true;
          if (this.progressMessageNeedsRepair(message, now)) return true;
          if (message.retryAt !== null && message.retryAt > now) return false;
          if (message.state === "active" && terminal) return true;
          if (message.state !== "pending") return false;
          if (
            terminal ||
            (this.runTimelineEvents.get(run.id) ?? []).some((event) => event.kind === "run_started")
          )
            return true;
          for (const step of this.workflowStepRuns.values()) {
            if (step.triggerRunId === run.id && step.startedAt !== null) return true;
          }
          return false;
        })
        .sort(
          (left, right) =>
            left.updatedAt.getTime() - right.updatedAt.getTime() ||
            left.triggerRunId.localeCompare(right.triggerRunId),
        )
        .slice(0, Math.max(0, limit)),
    );
  }

  private progressMessageNeedsSettle(message: RunProgressMessage, through: Date): boolean {
    return (
      message.state === "finished" &&
      message.settleAt !== null &&
      message.settleAt <= through &&
      (message.retryAt === null || message.retryAt <= through)
    );
  }

  private progressMessageNeedsRepair(message: RunProgressMessage, now: Date): boolean {
    const expiredLease =
      message.leaseOwner !== null &&
      message.leaseExpiresAt !== null &&
      message.leaseExpiresAt <= now;
    if (message.state === "creating") return message.leaseOwner === null || expiredLease;
    if (message.state === "active" && expiredLease) return true;
    return (
      (message.state === "active" || message.state === "finished") &&
      (message.retryAt === null || message.retryAt <= now) &&
      message.compensationRequestedGen > message.compensationDoneGen &&
      (message.compensationNotBefore === null || message.compensationNotBefore <= now)
    );
  }

  async requestCompensation(
    organizationId: string,
    runId: string,
    notBefore?: Date,
  ): Promise<number | undefined> {
    const message = this.runProgressMessages.get(runId);
    if (
      message?.organizationId !== organizationId ||
      this.triggerRuns.get(runId)?.organizationId !== organizationId ||
      this.triggerRuns.get(runId)?.payloadExpiredAt != null
    )
      return undefined;
    const pending = message.compensationRequestedGen > message.compensationDoneGen;
    message.compensationRequestedGen += 1;
    message.compensationNotBefore =
      notBefore === undefined || (pending && message.compensationNotBefore === null)
        ? null
        : new Date(
            pending && message.compensationNotBefore !== null
              ? Math.min(message.compensationNotBefore.getTime(), notBefore.getTime())
              : notBefore,
          );
    return message.compensationRequestedGen;
  }

  async completeCompensation(
    organizationId: string,
    runId: string,
    observedGen: number,
  ): Promise<void> {
    if (!Number.isInteger(observedGen) || observedGen < 0) {
      throw new RangeError("compensation generation must be a nonnegative integer");
    }
    const message = this.runProgressMessages.get(runId);
    if (
      message?.organizationId !== organizationId ||
      this.triggerRuns.get(runId)?.organizationId !== organizationId ||
      this.triggerRuns.get(runId)?.payloadExpiredAt != null
    )
      return;
    message.compensationDoneGen = Math.max(
      message.compensationDoneGen,
      Math.min(message.compensationRequestedGen, observedGen),
    );
  }

  private pendingTerminalNotification(
    run: AcceptedTriggerRunRecord,
    terminalAt: Date,
  ): AcceptedTriggerRunRecord {
    return {
      ...run,
      terminalNotificationPendingAt: run.terminalNotificationPendingAt ?? terminalAt,
      terminalNotificationLeaseExpiresAt: null,
    };
  }

  createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
  ): Promise<{ run: AcceptedTriggerRunRecord; created: boolean }>;
  createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
    replay: "acknowledge",
  ): Promise<TriggerRunAdmission<AcceptedTriggerRunRecord>>;
  async createAcceptedTriggerRun(
    input: CreateAcceptedTriggerRunInput,
    replay?: "acknowledge",
  ): Promise<TriggerRunAdmission<AcceptedTriggerRunRecord>> {
    const projectRuns =
      this.triggerRunIdsByProviderEventReceipt.get(input.providerEventReceiptId) ??
      new Map<string, Map<string, string>>();
    const triggerRuns = projectRuns.get(input.projectId) ?? new Map<string, string>();
    const existingId = triggerRuns.get(input.configuredTriggerName);
    const marked = this.checkReceiptAdmission(input, existingId, replay);
    if (marked !== undefined) return marked;
    if (existingId !== undefined) {
      const existing = this.triggerRuns.get(existingId);
      if (existing === undefined)
        throw new Error(`trigger run index points at missing row: ${existingId}`);
      if (existing.outcome !== "accepted") throw new Error("trigger branch outcome conflict");
      return { run: existing, created: false };
    }
    const now = input.createdAt ?? this.options.now?.() ?? new Date();
    const run: AcceptedTriggerRunRecord = {
      conversation: structuredClone(input.conversation ?? null),
      id: input.id ?? randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      configurationRevisionId: input.configurationRevisionId,
      providerEventReceiptId: input.providerEventReceiptId,
      configuredTriggerName: input.configuredTriggerName,
      outcome: "accepted",
      status: "running",
      prompt: input.prompt,
      inputs: freezeEvidence(input.inputs),
      values: freezeEvidence(input.values ?? {}),
      triggerContext: freezeEvidence(input.triggerContext),
      outputContext: freezeEvidence(input.outputContext),
      deadlineAt: input.deadlineAt,
      deadlineKind: null,
      failureReason: null,
      reactionState: null,
      terminalNotificationPendingAt: null,
      terminalNotificationDeliveredAt: null,
      terminalNotificationLeaseExpiresAt: null,
      createdAt: now,
      completedAt: null,
    };
    this.triggerRuns.set(run.id, run);
    triggerRuns.set(input.configuredTriggerName, run.id);
    projectRuns.set(input.projectId, triggerRuns);
    this.triggerRunIdsByProviderEventReceipt.set(input.providerEventReceiptId, projectRuns);
    for (const [ordinal, stepId] of input.stepIds.entries()) {
      const step: WorkflowStepRunRecord = {
        id: randomUUID(),
        triggerRunId: run.id,
        stepId,
        ordinal,
        status: "pending",
        agentExecutionId: null,
        output: null,
        failureReason: null,
        deadlineKind: null,
        deadlineAt: null,
        idleDeadlineAt: null,
        startedAt: null,
        completedAt: null,
        dispatchIntent: null,
      };
      this.workflowStepRuns.set(step.id, step);
    }
    this.workflowWakeups.set(run.id, {
      triggerRunId: run.id,
      availableAt: now,
      leaseExpiresAt: null,
      leasedBeforeClaim: false,
    });
    return { run, created: true };
  }

  createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
  ): Promise<{ run: RejectedTriggerRunRecord; created: boolean }>;
  createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
    replay: "acknowledge",
  ): Promise<TriggerRunAdmission<RejectedTriggerRunRecord>>;
  async createRejectedTriggerRun(
    input: CreateRejectedTriggerRunInput,
    replay?: "acknowledge",
  ): Promise<TriggerRunAdmission<RejectedTriggerRunRecord>> {
    const projectRuns =
      this.triggerRunIdsByProviderEventReceipt.get(input.providerEventReceiptId) ??
      new Map<string, Map<string, string>>();
    const triggerRuns = projectRuns.get(input.projectId) ?? new Map<string, string>();
    const existingId = triggerRuns.get(input.configuredTriggerName);
    const marked = this.checkReceiptAdmission(input, existingId, replay);
    if (marked !== undefined) return marked;
    if (existingId !== undefined) {
      const existing = this.triggerRuns.get(existingId);
      if (existing === undefined)
        throw new Error(`trigger run index points at missing row: ${existingId}`);
      if (existing.outcome !== "rejected") throw new Error("trigger branch outcome conflict");
      return { run: existing, created: false };
    }
    const now = input.createdAt ?? this.options.now?.() ?? new Date();
    const run: RejectedTriggerRunRecord = {
      conversation: null,
      id: input.id ?? randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      configurationRevisionId: input.configurationRevisionId,
      providerEventReceiptId: input.providerEventReceiptId,
      configuredTriggerName: input.configuredTriggerName,
      outcome: "rejected",
      status: "rejected",
      prompt: input.prompt,
      inputs: freezeEvidence(input.inputs),
      values: freezeEvidence(input.values ?? {}),
      triggerContext: freezeEvidence(input.triggerContext),
      outputContext: freezeEvidence(input.outputContext),
      rejection: freezeEvidence(input.rejection),
      createdAt: now,
      completedAt: now,
    };
    this.triggerRuns.set(run.id, run);
    triggerRuns.set(input.configuredTriggerName, run.id);
    projectRuns.set(input.projectId, triggerRuns);
    this.triggerRunIdsByProviderEventReceipt.set(input.providerEventReceiptId, projectRuns);
    return { run, created: true };
  }

  private checkReceiptAdmission(
    input: CreateAcceptedTriggerRunInput | CreateRejectedTriggerRunInput,
    runId: string | undefined,
    replay: "acknowledge" | undefined,
  ) {
    const receipt = this.providerEventReceipts.get(input.providerEventReceiptId);
    if (receipt !== undefined && receipt.organizationId !== input.organizationId)
      throw new Error("provider event receipt unavailable");
    if (receipt?.payloadExpiryState == null) return undefined;
    if (replay === "acknowledge") {
      const run = runId === undefined ? undefined : this.triggerRuns.get(runId);
      return {
        created: false,
        receiptReplay: true,
        runId: run?.organizationId === input.organizationId ? run.id : undefined,
      } as const;
    }
    if (runId === undefined) throw new Error("marked receipt has no matching trigger branch");
    return undefined;
  }

  async findTriggerRunById(id: string) {
    return this.triggerRuns.get(id);
  }

  async findTriggerRunForReceipt(
    organizationId: string,
    projectId: string,
    providerEventReceiptId: string,
    triggerName: string,
  ) {
    const id = this.triggerRunIdsByProviderEventReceipt
      .get(providerEventReceiptId)
      ?.get(projectId)
      ?.get(triggerName);
    const run = id === undefined ? undefined : this.triggerRuns.get(id);
    return run?.organizationId === organizationId ? run : undefined;
  }

  async findTriggerRunsByProviderEventReceiptId(providerEventReceiptId: string) {
    const projectRuns = this.triggerRunIdsByProviderEventReceipt.get(providerEventReceiptId);
    const ids =
      projectRuns === undefined
        ? []
        : Array.from(projectRuns.values()).flatMap((triggerRuns) =>
            Array.from(triggerRuns.values()),
          );
    return ids
      .map((id) => this.triggerRuns.get(id))
      .filter((run): run is TriggerRunRecord => run !== undefined)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.configuredTriggerName.localeCompare(right.configuredTriggerName),
      );
  }

  async listTriggerRunsForProject(projectId: string, limit: number) {
    return [...this.triggerRuns.values()]
      .filter((run) => run.projectId === projectId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          left.configuredTriggerName.localeCompare(right.configuredTriggerName),
      )
      .slice(0, limit);
  }

  async countActiveTriggerRuns(organizationId: string, projectId: string, triggerName: string) {
    let count = 0;
    for (const run of this.triggerRuns.values()) {
      if (
        run.organizationId === organizationId &&
        run.projectId === projectId &&
        run.configuredTriggerName === triggerName &&
        run.status === "running"
      )
        count += 1;
    }
    return count;
  }

  async findWorkflowStepRunById(id: string) {
    const step = this.workflowStepRuns.get(id);
    return step === undefined ? undefined : this.projectStepPayload(step);
  }

  private projectStepPayload(step: WorkflowStepRunRecord): WorkflowStepRunRecord {
    if (this.triggerRuns.get(step.triggerRunId)?.payloadExpiredAt == null) return step;
    return {
      ...step,
      output: null,
      dispatchIntent: null,
      failureReason: step.payloadSummary?.failureCode ?? null,
    };
  }

  private projectExecutionPayload(execution: AgentExecutionRecord): AgentExecutionRecord {
    if (!this.executionPayloadExpired(execution)) return execution;
    return { ...execution, result: null, triggerContext: null, outputContext: null };
  }

  private executionPayloadExpired(execution: AgentExecutionRecord): boolean {
    const step =
      execution.workflowStepRunId === null
        ? [...this.workflowStepRuns.values()].find(
            (candidate) => candidate.agentExecutionId === execution.id,
          )
        : this.workflowStepRuns.get(execution.workflowStepRunId);
    const runId =
      step?.triggerRunId ?? execution.launchRunId ?? execution.launchIntent?.triggerRunId;
    if (runId == null) return false;
    const run = this.triggerRuns.get(runId);
    return (
      run?.organizationId === execution.organizationId &&
      run.projectId === execution.projectId &&
      run.payloadExpiredAt != null
    );
  }

  async findWorkflowStepRunByTriggerRun(triggerRunId: string) {
    return (await this.listWorkflowStepRunsForTriggerRun(triggerRunId))[0];
  }

  async listWorkflowStepRunsForTriggerRun(triggerRunId: string) {
    return this.listSteps(triggerRunId).map((step) => this.projectStepPayload(step));
  }

  async findAgentExecutionByWorkflowStepRunId(stepRunId: string) {
    const execution = [...this.agentExecutions.values()].find(
      (candidate) => candidate.workflowStepRunId === stepRunId,
    );
    return execution === undefined ? undefined : this.projectExecutionPayload(execution);
  }

  async releaseWorkflowWakeup(triggerRunId: string, now: Date, claimedLease: Date, retryAt?: Date) {
    const wakeup = this.workflowWakeups.get(triggerRunId);
    if (wakeup?.leaseExpiresAt?.getTime() !== claimedLease.getTime()) return;
    wakeup.leaseExpiresAt = now;
    if (retryAt !== undefined) wakeup.availableAt = retryAt;
  }

  async claimWorkflowWakeup(now: Date, leaseMs: number, excludedRunIds: readonly string[] = []) {
    const candidate = Array.from(this.workflowWakeups.values())
      .filter(
        (wakeup) =>
          !excludedRunIds.includes(wakeup.triggerRunId) &&
          wakeup.availableAt <= now &&
          (wakeup.leaseExpiresAt === null || wakeup.leaseExpiresAt <= now),
      )
      .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())[0];
    if (candidate === undefined) return undefined;
    const claimed = {
      ...candidate,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      leasedBeforeClaim: candidate.leaseExpiresAt !== null,
    };
    this.workflowWakeups.set(candidate.triggerRunId, claimed);
    return claimed;
  }

  async wakeWorkflowRun(triggerRunId: string, availableAt: Date) {
    if (this.triggerRuns.get(triggerRunId)?.payloadExpiredAt != null) return;
    const current = this.workflowWakeups.get(triggerRunId);
    this.workflowWakeups.set(triggerRunId, {
      triggerRunId,
      availableAt:
        current === undefined || current.availableAt > availableAt
          ? availableAt
          : current.availableAt,
      leaseExpiresAt: null,
      leasedBeforeClaim: false,
    });
  }

  async deleteWorkflowWakeup(triggerRunId: string) {
    this.workflowWakeups.delete(triggerRunId);
  }

  async createWorkflowStepExecution(input: WorkflowStepExecutionInput) {
    let step = (await this.listWorkflowStepRunsForTriggerRun(input.triggerRunId)).find(
      (candidate) => candidate.stepId === input.stepId && candidate.ordinal === input.ordinal,
    );
    if (step === undefined) {
      throw new Error("workflow step run not found");
    }
    if (step.agentExecutionId !== null) {
      return {
        stepRun: step,
        execution: await this.findAgentExecutionById(step.agentExecutionId),
        created: false,
      };
    }
    const run = this.triggerRuns.get(input.triggerRunId);
    const startedAt = input.execution.startedAt;
    if (run === undefined || run.outcome !== "accepted" || run.status !== "running") {
      return { stepRun: step, execution: undefined, created: false };
    }
    if (run.deadlineAt <= startedAt) {
      this.timeoutWorkflowRun(run.id, startedAt);
      return {
        stepRun: this.workflowStepRuns.get(step.id) ?? step,
        execution: undefined,
        created: false,
      };
    }
    // Reserve one meter unit before creating the execution, so a denied reservation creates
    // nothing — the in-memory single-threaded model gives the same atomicity the Postgres
    // transaction does. A replay hits the `agentExecutionId !== null` branch above and never
    // reaches here, so it cannot double-consume.
    if (input.reservation !== undefined) {
      const reserved = await this.consumeOrganizationUsage({
        organizationId: input.execution.organizationId,
        meter: input.reservation.meter,
        periodStart: input.reservation.periodStart,
        amount: 1,
        limit: input.reservation.limit,
      });
      if (reserved === undefined) {
        if (input.reservation.limit === null) {
          throw new Error("unreachable: an unlimited meter reservation cannot be denied");
        }
        const usage = await this.getOrganizationUsage(
          input.execution.organizationId,
          input.reservation.meter,
          input.reservation.periodStart,
        );
        return {
          stepRun: step,
          execution: undefined,
          created: false,
          reservationDenied: {
            meter: input.reservation.meter,
            limit: input.reservation.limit,
            current: usage?.used ?? 0,
          },
        };
      }
    }
    const deadlineAt = new Date(
      Math.min(input.execution.deadlineAt.getTime(), run.deadlineAt.getTime()),
    );
    const idleDeadlineAt = new Date(
      Math.min(input.execution.idleDeadlineAt.getTime(), deadlineAt.getTime()),
    );
    const execution = await this.insertAgentExecution({
      ...input.execution,
      id: input.executionId,
      startedAt,
      deadlineAt,
      idleDeadlineAt,
      workflowStepRunId: step.id,
    });
    step = {
      ...step,
      status: "running",
      agentExecutionId: execution.id,
      deadlineAt: execution.deadlineAt,
      idleDeadlineAt: execution.idleDeadlineAt,
      dispatchIntent: input.execution.launchIntent ?? step.dispatchIntent,
      startedAt: execution.startedAt,
    };
    this.workflowStepRuns.set(step.id, step);
    return { stepRun: step, execution, created: true };
  }

  async linkWorkflowStepRunExecution(
    stepRunId: string,
    executionId: string,
    dispatchIntent?: LaunchMachineIntent,
  ) {
    const step = this.workflowStepRuns.get(stepRunId);
    if (step === undefined) throw new Error(`workflow step run not found: ${stepRunId}`);
    if (step.agentExecutionId !== null && step.agentExecutionId !== executionId) {
      throw new Error(`workflow step run already linked: ${stepRunId}`);
    }
    if (step.agentExecutionId === executionId) return step;
    const execution = this.agentExecutions.get(executionId);
    if (execution === undefined) throw new Error(`agent execution not found: ${executionId}`);
    if (this.triggerRuns.get(step.triggerRunId)?.payloadExpiredAt != null)
      return this.projectStepPayload(step);
    if (execution.launchIntentExpiredAt != null)
      throw new Error("agent execution launch intent expired");
    const updated = {
      ...step,
      status:
        step.status === "succeeded" || step.status === "failed" || step.status === "timed_out"
          ? step.status
          : ("running" as const),
      agentExecutionId: executionId,
      startedAt: step.startedAt ?? execution.startedAt,
      ...(dispatchIntent === undefined ? {} : { dispatchIntent }),
    };
    this.workflowStepRuns.set(stepRunId, updated);
    return updated;
  }

  async completeWorkflowStep(
    executionId: string,
    status: "succeeded" | "failed" | "timed_out",
    result: unknown,
    failureReason?: string,
  ) {
    const execution = await this.findAgentExecutionById(executionId);
    if (execution === undefined || execution.workflowStepRunId === null) return undefined;
    await this.completeWorkflowAgentExecution({
      executionId,
      executionStatus: execution.status === "succeeded" ? "succeeded" : "failed",
      stepStatus: status,
      result,
      stepOutput: result,
      ...(failureReason === undefined ? {} : { failureReason }),
    });
    const step = this.workflowStepRuns.get(execution.workflowStepRunId);
    return step === undefined
      ? undefined
      : { stepRun: step, run: this.triggerRuns.get(step.triggerRunId)! };
  }

  async completeWorkflowAgentExecution(input: WorkflowAgentCompletionInput) {
    const execution = this.readAgentExecution(input.executionId);
    if (this.executionPayloadExpired(execution))
      return { execution: this.projectExecutionPayload(execution), transitioned: false };
    if (execution.workflowStepRunId === null) {
      return this.transitionAgentExecution(execution.id, input.executionStatus, {
        ...executionTransitionFields(input),
      });
    }
    const step = this.workflowStepRuns.get(execution.workflowStepRunId);
    if (step === undefined)
      throw new Error(`workflow step run not found: ${execution.workflowStepRunId}`);
    const run = this.triggerRuns.get(step.triggerRunId);
    if (run === undefined) throw new Error(`workflow trigger run not found: ${step.triggerRunId}`);
    if (run.outcome !== "accepted") throw new Error("rejected trigger run has no workflow step");

    const observedAt = input.observedAt ?? this.now();
    if (execution.status === "spawning" || execution.status === "running") {
      const deadlineKind = workflowDeadlineKind(execution, step, run, observedAt);
      if (deadlineKind === "whole_run") {
        this.timeoutWorkflowRun(run.id, observedAt);
        const terminalRun = this.triggerRuns.get(run.id);
        return transitionWithTerminalRun(
          {
            execution: this.readAgentExecution(execution.id),
            transitioned: true,
            deadlineKind,
          },
          terminalRun,
        );
      }
      if (deadlineKind !== undefined) {
        const timedOut = this.timeoutWorkflowStep(execution.id, deadlineKind, observedAt);
        const terminalRun = this.triggerRuns.get(run.id);
        return transitionWithTerminalRun(timedOut, terminalRun);
      }
    }

    const transitioned =
      execution.status === "spawning" || execution.status === "running"
        ? await this.transitionAgentExecution(
            execution.id,
            input.executionStatus,
            executionTransitionFields(input),
          )
        : { execution, transitioned: false };
    if (transitioned.transitioned || isTerminalAgentExecutionStatus(execution.status)) {
      this.finishWorkflowStep(step, run, input);
    }
    const terminalRun = this.triggerRuns.get(run.id);
    return transitionWithTerminalRun(transitioned, terminalRun);
  }

  private finishWorkflowStep(
    step: WorkflowStepRunRecord,
    run: TriggerRunRecord,
    input: WorkflowAgentCompletionInput,
  ): void {
    if (step.status === "succeeded" || step.status === "failed" || step.status === "timed_out") {
      return;
    }
    if (run.outcome !== "accepted") throw new Error("rejected trigger run has no workflow step");
    const now = this.options.now?.() ?? new Date();
    const updatedStep: WorkflowStepRunRecord = {
      ...step,
      status: input.stepStatus,
      output: freezeEvidence(input.stepOutput !== undefined ? input.stepOutput : input.result),
      failureReason: input.failureReason ?? null,
      deadlineKind: input.deadlineKind ?? step.deadlineKind,
      completedAt: now,
    };
    this.workflowStepRuns.set(step.id, updatedStep);
    if (input.stepStatus === "succeeded") {
      if (run.status === "running") {
        this.workflowWakeups.set(run.id, {
          triggerRunId: run.id,
          availableAt: now,
          leaseExpiresAt: null,
          leasedBeforeClaim: false,
        });
      }
      return;
    }
    if (run.status === "running") {
      let runStatus: TriggerRunRecord["status"] = input.stepStatus;
      if (input.deadlineKind === "whole_run") {
        runStatus = "timed_out";
      } else if (input.deadlineKind !== undefined) {
        runStatus = "failed";
      }
      this.triggerRuns.set(run.id, {
        ...this.pendingTerminalNotification(run, now),
        status: runStatus,
        deadlineKind: input.deadlineKind ?? run.deadlineKind,
        failureReason: input.failureReason ?? null,
        completedAt: now,
      });
    }
    this.workflowWakeups.delete(run.id);
  }

  private timeoutWorkflowStep(
    executionId: string,
    deadlineKind: Exclude<WorkflowDeadlineKind, "whole_run">,
    now: Date,
  ): TransitionAgentExecutionResult {
    const execution = this.readAgentExecution(executionId);
    if (isTerminalAgentExecutionStatus(execution.status)) {
      return { execution, transitioned: false };
    }
    const failureReason = deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout";
    let hubAction: "interrupt" | "archive" | null = null;
    if (execution.daemonId !== null) {
      hubAction = execution.launchIntent?.autoArchive === true ? "archive" : "interrupt";
    }
    const updatedExecution: AgentExecutionRecord = {
      ...execution,
      status: "failed",
      completedAt: now,
      result: { status: "failed", reason: failureReason },
      idleDeadlineAt: null,
      hubAction,
      hubActionCompletedAt: hubAction === null ? null : null,
      hubActionReadyAt: null,
      hubActionAcknowledgements: emptyHubActionAcknowledgements(),
    };
    this.agentExecutions.set(execution.id, updatedExecution);
    const step =
      execution.workflowStepRunId === null
        ? undefined
        : this.workflowStepRuns.get(execution.workflowStepRunId);
    if (
      step === undefined ||
      step.status === "succeeded" ||
      step.status === "failed" ||
      step.status === "timed_out"
    ) {
      return { execution: updatedExecution, transitioned: true, deadlineKind };
    }
    const run = this.triggerRuns.get(step.triggerRunId);
    if (run === undefined || run.outcome !== "accepted") {
      return { execution: updatedExecution, transitioned: true, deadlineKind };
    }
    this.workflowStepRuns.set(step.id, {
      ...step,
      status: "timed_out",
      failureReason,
      deadlineKind,
      completedAt: now,
    });
    if (run.status === "running") {
      this.triggerRuns.set(run.id, {
        ...this.pendingTerminalNotification(run, now),
        status: "failed",
        deadlineKind,
        failureReason,
        completedAt: now,
      });
    }
    this.workflowWakeups.delete(run.id);
    return { execution: updatedExecution, transitioned: true, deadlineKind };
  }

  private timeoutWorkflowRun(
    triggerRunId: string,
    now: Date,
  ): WorkflowDeadlineRecovery | undefined {
    const run = this.triggerRuns.get(triggerRunId);
    if (run === undefined || run.outcome !== "accepted" || run.status !== "running") {
      return undefined;
    }
    const executionIds: string[] = [];
    for (const step of this.workflowStepRuns.values()) {
      if (step.triggerRunId !== triggerRunId) continue;
      if (step.agentExecutionId !== null) {
        const execution = this.agentExecutions.get(step.agentExecutionId);
        if (
          execution !== undefined &&
          (execution.status === "spawning" || execution.status === "running")
        ) {
          let hubAction: AgentExecutionRecord["hubAction"] = null;
          if (execution.daemonId !== null) {
            hubAction = execution.launchIntent?.autoArchive === true ? "archive" : "interrupt";
          }
          const updatedExecution: AgentExecutionRecord = {
            ...execution,
            status: "failed",
            completedAt: now,
            result: { status: "failed", reason: "whole_run_timeout" },
            idleDeadlineAt: null,
            hubAction,
            hubActionCompletedAt: null,
            hubActionReadyAt: null,
            hubActionAcknowledgements: emptyHubActionAcknowledgements(),
          };
          this.agentExecutions.set(execution.id, updatedExecution);
          executionIds.push(execution.id);
        }
      }
      if (step.status === "pending" || step.status === "running") {
        this.workflowStepRuns.set(step.id, {
          ...step,
          status: "timed_out",
          failureReason: "whole_run_timeout",
          deadlineKind: "whole_run",
          completedAt: now,
        });
      }
    }
    const updatedRun: AcceptedTriggerRunRecord = {
      ...this.pendingTerminalNotification(run, now),
      status: "timed_out",
      deadlineKind: "whole_run",
      failureReason: "whole_run_timeout",
      completedAt: now,
    };
    this.triggerRuns.set(run.id, updatedRun);
    this.workflowWakeups.delete(run.id);
    return { triggerRunId: run.id, executionIds };
  }

  async recoverWorkflowDeadlines(now: Date): Promise<readonly WorkflowDeadlineRecovery[]> {
    const recoveries: WorkflowDeadlineRecovery[] = [];
    for (const run of this.triggerRuns.values()) {
      if (run.outcome !== "accepted" || run.status !== "running") continue;
      if (run.deadlineAt <= now) {
        const recovery = this.timeoutWorkflowRun(run.id, now);
        if (recovery !== undefined) recoveries.push(recovery);
        continue;
      }
      const steps = await this.listWorkflowStepRunsForTriggerRun(run.id);
      for (const step of steps) {
        if (step.status !== "running") continue;
        const execution =
          step.agentExecutionId === null
            ? undefined
            : this.agentExecutions.get(step.agentExecutionId);
        if (execution !== undefined && isTerminalAgentExecutionStatus(execution.status)) continue;
        const deadlineKind = workflowDeadlineKind(execution, step, run, now);
        if (deadlineKind === undefined || deadlineKind === "whole_run") continue;
        if (execution !== undefined) {
          const recovery = this.timeoutWorkflowStep(execution.id, deadlineKind, now);
          recoveries.push({ triggerRunId: run.id, executionIds: [recovery.execution.id] });
        } else {
          this.workflowStepRuns.set(step.id, {
            ...step,
            status: "timed_out",
            failureReason: deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout",
            deadlineKind,
            completedAt: now,
          });
          this.triggerRuns.set(run.id, {
            ...this.pendingTerminalNotification(run, now),
            status: "failed",
            deadlineKind,
            failureReason: deadlineKind === "step_idle" ? "step_idle_timeout" : "step_hard_timeout",
            completedAt: now,
          });
          this.workflowWakeups.delete(run.id);
          recoveries.push({ triggerRunId: run.id, executionIds: [] });
        }
      }
    }
    return recoveries;
  }

  async markWorkflowStepSkipped(triggerRunId: string, stepId: string, reason: string) {
    const run = this.triggerRuns.get(triggerRunId);
    if (run?.outcome !== "accepted" || run.payloadExpiredAt != null) return undefined;
    const step = this.listSteps(triggerRunId).find((candidate) => candidate.stepId === stepId);
    if (step === undefined) return undefined;
    if (step.status !== "pending") return { stepRun: step, run };
    const now = this.options.now?.() ?? new Date();
    const updatedStep = {
      ...step,
      status: "skipped" as const,
      failureReason: reason,
      completedAt: now,
    };
    this.workflowStepRuns.set(step.id, updatedStep);
    this.workflowWakeups.set(run.id, {
      triggerRunId: run.id,
      availableAt: now,
      leaseExpiresAt: null,
      leasedBeforeClaim: false,
    });
    return { stepRun: updatedStep, run };
  }

  async startWorkflowScriptStep(input: WorkflowScriptStepStartInput) {
    const step = this.workflowStepRuns.get(input.stepRunId);
    if (step === undefined) return undefined;
    const run = this.triggerRuns.get(step.triggerRunId);
    if (step.status !== "pending" || run?.outcome !== "accepted" || run.status !== "running") {
      return { stepRun: step, started: false };
    }
    const started: WorkflowStepRunRecord = {
      ...step,
      status: "running",
      startedAt: input.startedAt,
      deadlineAt: input.deadlineAt,
      output: input.output ?? null,
    };
    this.workflowStepRuns.set(step.id, started);
    return { stepRun: started, started: true };
  }

  async updateWorkflowScriptStep(stepRunId: string, update: WorkflowScriptStepUpdate) {
    const step = this.workflowStepRuns.get(stepRunId);
    if (step === undefined || step.status !== "running") return step;
    const finished = update.status !== "running";
    const updated: WorkflowStepRunRecord = {
      ...step,
      status: update.status,
      output: update.output,
      failureReason: update.failureReason ?? null,
      completedAt: finished ? update.at : null,
    };
    this.workflowStepRuns.set(step.id, updated);
    if (finished && this.triggerRuns.get(step.triggerRunId)?.status === "running") {
      await this.wakeWorkflowRun(step.triggerRunId, update.at);
    }
    return updated;
  }

  async setWorkflowScriptStepOutput(stepRunId: string, output: unknown) {
    const step = this.workflowStepRuns.get(stepRunId);
    if (
      step === undefined ||
      step.agentExecutionId !== null ||
      this.triggerRuns.get(step.triggerRunId)?.payloadExpiredAt != null
    )
      return undefined;
    const updated: WorkflowStepRunRecord = { ...step, output };
    this.workflowStepRuns.set(step.id, updated);
    return updated;
  }

  async listWorkflowScriptStepsPendingCleanup() {
    return [...this.workflowStepRuns.values()].filter(
      (step) =>
        this.triggerRuns.get(step.triggerRunId)?.payloadExpiredAt == null &&
        scriptCleanupPending(step),
    );
  }

  async succeedTriggerRun(triggerRunId: string) {
    const run = this.triggerRuns.get(triggerRunId);
    if (run === undefined || run.outcome !== "accepted") return undefined;
    if (run.status !== "running") return { run, transitioned: false };
    const now = this.options.now?.() ?? new Date();
    const updated = {
      ...this.pendingTerminalNotification(run, now),
      status: "succeeded" as const,
      completedAt: now,
    };
    this.triggerRuns.set(run.id, updated);
    this.workflowWakeups.delete(run.id);
    return { run: updated, transitioned: true };
  }

  async failWorkflowRun(
    triggerRunId: string,
    status: "failed" | "timed_out",
    failureReason: string,
    stepId?: string,
  ) {
    const run = this.triggerRuns.get(triggerRunId);
    const steps = await this.listWorkflowStepRunsForTriggerRun(triggerRunId);
    const step =
      (stepId === undefined
        ? steps.find(
            (candidate) => candidate.status === "pending" || candidate.status === "running",
          )
        : steps.find((candidate) => candidate.stepId === stepId)) ?? steps[0];
    if (run === undefined || step === undefined) return undefined;
    if (run.status !== "running") return { stepRun: step, run, transitioned: false };
    const now = this.options.now?.() ?? new Date();
    const updatedStep =
      step.status === "pending" || step.status === "running"
        ? { ...step, status, failureReason, completedAt: now }
        : step;
    if (run.outcome !== "accepted") throw new Error("rejected trigger run has no workflow step");
    const updatedRun: AcceptedTriggerRunRecord = {
      ...this.pendingTerminalNotification(run, now),
      status,
      failureReason,
      completedAt: now,
    };
    this.workflowStepRuns.set(step.id, updatedStep);
    this.triggerRuns.set(run.id, updatedRun);
    this.workflowWakeups.delete(run.id);
    return { stepRun: updatedStep, run: updatedRun, transitioned: true };
  }

  async recoverWorkflowWakeups(now: Date, excludedRunIds: readonly string[] = []) {
    for (const run of this.triggerRuns.values()) {
      if (run.status !== "running" || run.payloadExpiredAt != null || run.deadlineAt <= now)
        continue;
      if (excludedRunIds.includes(run.id)) continue;
      const wakeup = this.workflowWakeups.get(run.id);
      const steps = await this.listWorkflowStepRunsForTriggerRun(run.id);
      const execution = (
        await Promise.all(
          steps.map(async (step) =>
            step.agentExecutionId === null
              ? undefined
              : this.findAgentExecutionById(step.agentExecutionId),
          ),
        )
      ).find(
        (candidate) =>
          candidate !== undefined &&
          (candidate.status === "spawning" || candidate.status === "running"),
      );
      const current = this.triggerRuns.get(run.id);
      if (
        current?.status === "running" &&
        current.payloadExpiredAt == null &&
        wakeup === undefined &&
        execution === undefined &&
        !this.workflowWakeups.has(run.id)
      ) {
        this.workflowWakeups.set(run.id, {
          triggerRunId: run.id,
          availableAt: now,
          leaseExpiresAt: null,
          leasedBeforeClaim: false,
        });
      }
    }
  }

  async claimPendingWorkflowRunTerminalNotification(now: Date, leaseMs: number) {
    const candidate = Array.from(this.triggerRuns.values())
      .filter(
        (run): run is AcceptedTriggerRunRecord =>
          run.outcome === "accepted" &&
          run.status !== "running" &&
          run.payloadExpiredAt == null &&
          run.terminalNotificationPendingAt !== null &&
          run.terminalNotificationDeliveredAt === null &&
          (run.terminalNotificationLeaseExpiresAt === null ||
            run.terminalNotificationLeaseExpiresAt <= now),
      )
      .sort((left, right) => {
        const time =
          left.terminalNotificationPendingAt!.getTime() -
          right.terminalNotificationPendingAt!.getTime();
        return time === 0 ? left.id.localeCompare(right.id) : time;
      })[0];
    if (candidate === undefined) return undefined;
    const updated = {
      ...candidate,
      terminalNotificationGeneration: (candidate.terminalNotificationGeneration ?? 0) + 1,
      terminalNotificationLeaseExpiresAt: new Date(now.getTime() + leaseMs),
    };
    this.triggerRuns.set(updated.id, updated);
    return updated;
  }

  async ownsWorkflowRunTerminalNotification(triggerRunId: string, generation: number, now: Date) {
    const run = this.triggerRuns.get(triggerRunId);
    return (
      run?.outcome === "accepted" &&
      run.payloadExpiredAt == null &&
      run.terminalNotificationGeneration === generation &&
      run.terminalNotificationDeliveredAt === null &&
      run.terminalNotificationLeaseExpiresAt !== null &&
      run.terminalNotificationLeaseExpiresAt > now
    );
  }

  async markWorkflowRunTerminalNotificationDelivered(
    triggerRunId: string,
    generation: number,
    deliveredAt: Date,
    reactionState: JsonValue | null,
  ) {
    const run = this.triggerRuns.get(triggerRunId);
    if (
      run === undefined ||
      run.outcome !== "accepted" ||
      run.payloadExpiredAt != null ||
      run.terminalNotificationGeneration !== generation ||
      run.terminalNotificationLeaseExpiresAt === null ||
      run.terminalNotificationPendingAt === null ||
      run.terminalNotificationDeliveredAt !== null
    ) {
      return;
    }
    this.triggerRuns.set(run.id, {
      ...run,
      reactionState,
      terminalNotificationDeliveredAt: deliveredAt,
      terminalNotificationLeaseExpiresAt: null,
    });
  }

  async setWorkflowRunReactionState(triggerRunId: string, reactionState: JsonValue | null) {
    const run = this.triggerRuns.get(triggerRunId);
    if (run === undefined || run.outcome !== "accepted" || run.payloadExpiredAt != null)
      return undefined;
    const updated = { ...run, reactionState };
    this.triggerRuns.set(run.id, updated);
    return updated;
  }

  async markProviderEventDropped(
    providerEventReceiptId: string,
    reason: ProviderEventDropReasonCode,
    organizationId?: string,
  ): Promise<boolean> {
    const receipt = this.providerEventReceipts.get(providerEventReceiptId);
    if (
      receipt === undefined ||
      (organizationId !== undefined && receipt.organizationId !== organizationId)
    )
      throw new Error(`provider event receipt not found: ${providerEventReceiptId}`);
    if (receipt.payloadExpiryState != null) return false;
    this.providerEventReceipts.set(providerEventReceiptId, {
      ...receipt,
      droppedReason: receipt.droppedReason ?? reason,
    });
    return true;
  }

  async acceptGitHubEvent(input: AcceptGitHubEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findGitHubConnection(input.installationId);
    const reason = githubDropReason(input, binding);
    return this.acceptMemoryEvent(
      input,
      binding?.organizationId,
      binding?.id,
      input.repositoryId === undefined ? null : String(input.repositoryId),
      reason,
    );
  }

  async acceptDiscordEvent(input: AcceptDiscordEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findDiscordConnection(input.guildId);
    const reason = discordDropReason(input, binding);
    return this.acceptMemoryEvent(
      input,
      binding?.organizationId,
      binding?.id,
      input.guildId,
      reason,
    );
  }

  async acceptSlackEvent(input: AcceptSlackEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findSlackConnection(input.teamId);
    const reason = slackDropReason(input, binding);
    return this.acceptMemoryEvent(
      input,
      binding?.organizationId,
      binding?.id,
      input.teamId,
      reason,
    );
  }

  async acceptLinearEvent(input: AcceptLinearEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findLinearConnection(input.linearOrganizationId);
    const reason = linearDropReason(input, binding);
    return this.acceptMemoryEvent(
      input,
      binding?.organizationId,
      binding?.id,
      input.projectId ?? null,
      reason,
    );
  }

  async findMarkedLinearReceipt(
    linearOrganizationId: string,
    deliveryId: string,
    signatureHash: string,
  ) {
    const connection = await this.findLinearConnection(linearOrganizationId);
    if (connection === undefined) return false;
    const id = this.findReceiptId(connection.organizationId, deliveryId, signatureHash);
    const receipt = id === undefined ? undefined : this.providerEventReceipts.get(id);
    return receipt?.provider === "linear" && receipt.payloadExpiryState != null;
  }

  async persistManualEvent(input: PersistManualEventInput): Promise<ManualEventPersistence> {
    this.assertBoundWebhookTarget(input);
    const existing = this.findReceiptId(
      input.organizationId,
      input.deliveryId,
      input.signatureHash,
    );
    if (existing !== undefined) {
      const receipt = this.providerEventReceipts.get(existing);
      if (receipt?.payloadExpiryState != null) {
        if (input.publicTriggerName !== undefined || input.boundWebhookTrigger !== undefined)
          this.validateMarkedManualReceipt(input, receipt);
        return {
          status: "duplicate",
          providerEventReceiptId: receipt.id,
          replayed: true,
          payloadExpiryState: receipt.payloadExpiryState,
        };
      }
      const route = receipt?.acceptedRoutes?.[0];
      if (receipt === undefined || route === undefined) {
        return {
          status: "duplicate" as const,
          providerEventReceiptId: existing,
          replayed: true,
        };
      }
      this.assertBoundWebhookReceipt(input, route);
      return {
        status: "accepted" as const,
        replayed: true,
        event: {
          providerEventReceiptId: receipt.id,
          organizationId: receipt.organizationId,
          projectId: route.projectId,
          configurationRevisionId: route.configurationRevisionId,
          deliveryId: receipt.deliveryId,
          source: receipt.source,
          payload: receipt.payload,
          receivedAt: receipt.receivedAt,
          connectionId: route.connectionId,
          resourceId: route.resourceId,
        },
      };
    }
    const project = this.projects.get(input.projectId);
    if (
      project?.organizationId !== input.organizationId ||
      project.status !== "active" ||
      project.activeConfigurationRevisionId === null
    ) {
      throw new ManualRunRejected("configuration_not_found");
    }
    const receipt = this.insertProviderEventReceipt({
      organizationId: input.organizationId,
      provider: "manual",
      connectionId: input.connectionId ?? null,
      resourceId: input.resourceId ?? null,
      input,
    });
    const route = {
      projectId: input.projectId,
      configurationRevisionId: project.activeConfigurationRevisionId,
      connectionId: input.connectionId ?? null,
      resourceId: input.resourceId ?? null,
    };
    this.providerEventReceipts.set(receipt.id, { ...receipt, acceptedRoutes: [route] });
    return {
      status: "accepted" as const,
      event: {
        providerEventReceiptId: receipt.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        configurationRevisionId: route.configurationRevisionId,
        deliveryId: input.deliveryId,
        source: input.source,
        payload: input.payload,
        receivedAt: input.receivedAt,
        connectionId: input.connectionId ?? null,
        resourceId: input.resourceId ?? null,
      },
    };
  }

  async authorizeSignedReceiptReplay(
    input: ManualReceiptReplayTarget & { organizationId: string; receiptId: string },
  ) {
    if (input.boundWebhookTrigger === undefined)
      throw new ManualRunRejected("configuration_not_found");
    this.assertBoundWebhookTarget(input);
    const receipt = this.providerEventReceipts.get(input.receiptId);
    if (receipt?.organizationId !== input.organizationId || receipt.payloadExpiryState == null)
      throw new ManualRunRejected("configuration_not_found");
    this.validateMarkedManualReceipt(input, receipt);
  }

  private validateMarkedManualReceipt(
    input: ManualReceiptReplayTarget & { organizationId: string },
    receipt: ProviderEventReceiptRecord,
  ) {
    const binding = requireManualReceiptReplayBinding(receipt, input);
    if (binding.triggerId !== null) {
      const revision = this.configurationRevisions.get(binding.configurationRevisionId);
      if (
        revision?.organizationId !== input.organizationId ||
        revision.projectId !== binding.projectId ||
        !hasBoundWebhookEvidence(revision.sourceEvidence, binding.triggerId)
      )
        throw new ManualRunRejected("configuration_not_found");
    }
  }

  private assertBoundWebhookTarget(
    input: Pick<PersistManualEventInput, "organizationId" | "projectId" | "boundWebhookTrigger">,
  ): void {
    const binding = input.boundWebhookTrigger;
    if (binding !== undefined) {
      const trigger = this.organizationTriggers.get(binding.id);
      const project = this.projects.get(input.projectId);
      if (
        trigger?.organizationId !== input.organizationId ||
        !trigger.enabled ||
        trigger.name !== binding.name ||
        trigger.runtimeProjectId !== input.projectId ||
        project?.organizationId !== input.organizationId ||
        project.status !== "active" ||
        project.activeConfigurationRevisionId !== binding.configurationRevisionId ||
        !hasBoundWebhookEvidence(
          this.configurationRevisions.get(binding.configurationRevisionId)?.sourceEvidence,
          binding.id,
        )
      ) {
        throw new ManualRunRejected("configuration_not_found");
      }
    }
  }

  private assertBoundWebhookReceipt(
    input: PersistManualEventInput,
    route: NonNullable<ProviderEventReceiptRecord["acceptedRoutes"]>[number],
  ): void {
    const binding = input.boundWebhookTrigger;
    if (binding !== undefined) {
      const pinned = this.configurationRevisions.get(route.configurationRevisionId);
      if (
        route.projectId !== input.projectId ||
        pinned?.organizationId !== input.organizationId ||
        pinned.projectId !== input.projectId ||
        !hasBoundWebhookEvidence(pinned.sourceEvidence, binding.id)
      ) {
        throw new ManualRunRejected("configuration_not_found");
      }
    }
  }

  private readonly githubInstallationSyncs = new Map<string, MemoryGitHubSync>();
  private readonly githubSyncs = new Map<number, Promise<unknown>>();

  async synchronizeGitHubInstallation<T>(
    installationId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.githubSyncs.get(installationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.githubSyncs.set(installationId, next);
    try {
      return await next;
    } finally {
      if (this.githubSyncs.get(installationId) === next) this.githubSyncs.delete(installationId);
    }
  }

  pendingGitHubInstallationSyncs: Database["pendingGitHubInstallationSyncs"] = async (
    owner,
    selected,
  ) => {
    if (!this.githubSyncOwnerActive(owner)) return [];
    const receipts =
      selected === undefined
        ? [...this.githubInstallationSyncs.values()]
        : [this.githubInstallationSyncs.get(selected.installationSyncId)];
    const now = new Date();
    return receipts
      .filter(
        (receipt): receipt is MemoryGitHubSync =>
          receipt !== undefined &&
          (selected === undefined || receipt.installationId === selected.installationId) &&
          receipt.providerApplicationId === owner.providerApplicationId &&
          receipt.payloadExpiredAt === null &&
          receipt.retryAt !== null &&
          receipt.retryAt <= now &&
          (receipt.connectionId !== null ||
            this.githubConnections.get(receipt.installationId)?.providerApplicationId ===
              owner.providerApplicationId),
      )
      .map((receipt) => ({
        status: "claimed" as const,
        installationSyncId: receipt.id,
        installationId: receipt.installationId,
        removeBinding: receipt.source === "github.installation",
      }));
  };

  async claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubInstallationSyncClaim> {
    const existing = [...this.githubInstallationSyncs.entries()].find(
      ([, receipt]) =>
        receipt.deliveryId === input.deliveryId || receipt.signatureHash === input.signatureHash,
    );
    if (existing !== undefined) return { status: "duplicate", installationSyncId: existing[0] };
    const connection = this.githubConnections.get(input.installationId);
    const bound =
      connection?.providerApplicationId === input.providerApplicationId ? connection : undefined;
    const id = randomUUID();
    const sync = {
      ...input,
      id,
      connectionId: bound?.id ?? null,
      retryAt: new Date(),
      settledAt: null,
      auditLink: null,
      payloadExpiredAt: null,
    };
    if (bound !== undefined) this.auditMemorySync(sync, bound);
    this.githubInstallationSyncs.set(id, sync);
    return { status: "claimed", installationSyncId: id, installationId: input.installationId };
  }

  async applyGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    claim: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
    result: GitHubInstallationSyncResult,
  ): Promise<void> {
    if (!this.githubSyncOwnerActive(owner)) return;
    const receipt = this.githubInstallationSyncs.get(claim.installationSyncId);
    if (
      receipt === undefined ||
      receipt.retryAt === null ||
      receipt.payloadExpiredAt !== null ||
      receipt.providerApplicationId !== owner.providerApplicationId
    )
      return;
    const connection = this.githubConnections.get(receipt.installationId);
    const bound =
      receipt.connectionId === null || receipt.connectionId === connection?.id
        ? connection
        : undefined;
    if (bound !== undefined && bound.providerApplicationId !== owner.providerApplicationId) return;
    if (bound === undefined) {
      if (receipt.connectionId !== null) receipt.retryAt = null;
      else if (result.status === "absent")
        this.settleMemorySync(receipt, {
          kind: this.hasAnySyncCopy(receipt, true) ? "unproven" : "none",
        });
      return;
    }
    const auditLink = this.auditMemorySync(receipt, bound);
    receipt.connectionId = bound.id;
    if (result.status === "present") {
      this.githubConnections.set(receipt.installationId, { ...bound, ...result.identity });
      this.replaceGitHubRepositorySnapshot(bound, result.repositories);
      this.settleMemorySync(receipt, auditLink);
      return;
    }
    if (result.removeBinding) this.removeMemorySyncConnection(bound);
    this.settleMemorySync(receipt, auditLink);
  }

  private auditMemorySync(
    sync: MemoryGitHubSync,
    connection: GitHubConnectionRecord,
  ): GitHubSyncAuditLink {
    const id = this.findReceiptId(connection.organizationId, sync.deliveryId, sync.signatureHash);
    const receipt =
      id === undefined
        ? this.insertProviderEventReceipt({
            organizationId: connection.organizationId,
            provider: "github",
            connectionId: connection.id,
            resourceId: null,
            input: { ...sync, dropReason: "github_lifecycle" },
          })
        : this.providerEventReceipts.get(id);
    return receipt !== undefined &&
      isExactSyncReceipt(
        { ...sync, connectionId: connection.id },
        receipt,
        connection.organizationId,
      )
      ? { kind: "receipt", receiptId: receipt.id, organizationId: receipt.organizationId }
      : { kind: "unproven" };
  }

  private settleMemorySync(sync: MemoryGitHubSync, auditLink: GitHubSyncAuditLink) {
    sync.retryAt = null;
    sync.settledAt = this.now();
    sync.auditLink = auditLink;
  }

  private githubSyncOwnerActive(owner: GitHubInstallationSyncOwner): boolean {
    const active = this.options.githubSyncOwner;
    return (
      active?.providerApplicationId === owner.providerApplicationId &&
      active.configurationVersion === owner.configurationVersion
    );
  }

  private removeMemorySyncConnection(connection: GitHubConnectionRecord) {
    this.githubConnections.delete(connection.installationId);
    for (const [key, repository] of this.githubRepositories) {
      if (repository.connectionId === connection.id) this.githubRepositories.delete(key);
    }
    for (const [projectId, source] of this.githubConfigurationSources) {
      if (source.githubConnectionId !== connection.id) continue;
      this.configurationAuthorities.set(projectId, "manual");
      this.githubConfigurationSources.delete(projectId);
    }
    for (const [projectId, attempts] of this.configurationSyncAttempts) {
      this.configurationSyncAttempts.set(
        projectId,
        attempts.map((attempt) =>
          attempt.githubConnectionId === connection.id
            ? Object.assign({}, attempt, { githubConnectionId: null })
            : attempt,
        ),
      );
    }
    for (const [projectId, routes] of this.projectTriggerRoutes) {
      this.projectTriggerRoutes.set(
        projectId,
        routes.filter((route) => route.connectionId !== connection.id),
      );
    }
  }

  private replaceGitHubRepositorySnapshot(
    connection: GitHubConnectionRecord,
    repositories: GitHubRepositorySnapshot,
  ): void {
    for (const [key, repository] of this.githubRepositories) {
      if (
        repository.connectionId === connection.id &&
        !repositories.some((item) => item.repositoryId === repository.repositoryId)
      )
        this.githubRepositories.delete(key);
    }
    this.upsertGitHubRepositories(connection.organizationId, connection.id, repositories);
  }

  retryGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    installationSyncId: string,
  ): Promise<void> {
    const receipt = this.githubInstallationSyncs.get(installationSyncId);
    if (
      this.githubSyncOwnerActive(owner) &&
      receipt?.providerApplicationId === owner.providerApplicationId &&
      receipt.retryAt !== null &&
      receipt.payloadExpiredAt === null
    )
      receipt.retryAt = new Date(Date.now() + 30_000);
    return Promise.resolve();
  }

  async findProviderEventReceiptByDeliveryId(
    deliveryId: string,
    organizationId?: string,
  ): Promise<ProviderEventReceiptRecord | undefined> {
    const id = this.providerEventReceiptIdsByDelivery.get(
      organizationId === undefined ? deliveryId : `${organizationId}:${deliveryId}`,
    );
    return id === undefined ? undefined : this.findProviderEventReceiptById(id);
  }

  async findProviderEventReceiptById(
    id: string,
    projection?: "metadata",
  ): Promise<ProviderEventReceiptRecord | undefined> {
    const receipt = this.providerEventReceipts.get(id);
    if (receipt === undefined) return undefined;
    return receipt.payloadExpiryState != null || projection === "metadata"
      ? { ...receipt, payload: null, acceptedRoutes: null }
      : receipt;
  }

  async findProviderEventReplayMetadata(
    organizationId: string,
    key: { id: string } | { deliveryId: string },
  ): Promise<ProviderEventReplayMetadata | undefined> {
    const id = "id" in key ? key.id : this.findReceiptId(organizationId, key.deliveryId, null);
    const receipt = id === undefined ? undefined : this.providerEventReceipts.get(id);
    if (receipt?.organizationId !== organizationId) return undefined;
    const {
      provider,
      source,
      droppedReason,
      payloadExpiryState = null,
      manualReplayBinding = null,
    } = receipt;
    return {
      id: receipt.id,
      provider,
      source,
      droppedReason,
      payloadExpiryState,
      manualReplayBinding,
    };
  }

  async insertAttachment(input: InsertAttachmentInput): Promise<AttachmentRecord> {
    const receipt = this.providerEventReceipts.get(input.providerEventReceiptId);
    if (
      receipt !== undefined &&
      (receipt.organizationId !== input.organizationId || receipt.payloadExpiryState != null)
    )
      throw new Error("attachment receipt unavailable");
    const sourceKey = attachmentSourceKey(
      input.providerEventReceiptId,
      input.provider,
      input.sourceId,
    );
    const existingId = this.attachmentIdsBySource.get(sourceKey);
    if (existingId !== undefined) return this.readAttachment(existingId);
    const attachment: AttachmentRecord = {
      id: randomUUID(),
      providerEventReceiptId: input.providerEventReceiptId,
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      provider: input.provider,
      sourceId: input.sourceId,
      locator: input.locator,
      filename: input.filename,
      contentType: input.contentType ?? null,
      byteSize: input.byteSize ?? null,
      createdAt: new Date(),
    };
    this.attachments.set(attachment.id, attachment);
    this.attachmentIdsBySource.set(sourceKey, attachment.id);
    return attachment;
  }

  async findAttachmentBySource(
    providerEventReceiptId: string,
    provider: AttachmentProvider,
    sourceId: string,
  ): Promise<AttachmentRecord | undefined> {
    if (this.providerEventReceipts.get(providerEventReceiptId)?.payloadExpiryState != null)
      return undefined;
    const id = this.attachmentIdsBySource.get(
      attachmentSourceKey(providerEventReceiptId, provider, sourceId),
    );
    return id === undefined ? undefined : this.attachments.get(id);
  }

  async findAttachmentForExecution(
    executionId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | undefined> {
    const execution = this.agentExecutions.get(executionId);
    const attachment = this.attachments.get(attachmentId);
    if (execution === undefined || attachment === undefined) return undefined;
    if (execution.status !== "spawning" && execution.status !== "running") return undefined;
    if (
      this.providerEventReceipts.get(attachment.providerEventReceiptId)?.payloadExpiryState != null
    )
      return undefined;
    const stepRun =
      execution.workflowStepRunId === null
        ? undefined
        : this.workflowStepRuns.get(execution.workflowStepRunId);
    const triggerRun =
      stepRun === undefined ? undefined : this.triggerRuns.get(stepRun.triggerRunId);
    return execution.organizationId === attachment.organizationId &&
      triggerRun?.providerEventReceiptId === attachment.providerEventReceiptId
      ? attachment
      : undefined;
  }

  async insertMachine(input: InsertMachineInput): Promise<MachineRecord> {
    this.organizationIds.add(input.orgId);
    const machine: MachineRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      source: input.source,
      status: input.status ?? "spawning",
      startedAt: new Date(),
      terminatedAt: null,
      shutdownReason: null,
      triggerName: input.triggerName ?? null,
      triggerContext: input.triggerContext ?? null,
      specs: input.specs ?? null,
    };

    this.machines.set(machine.id, machine);
    return machine;
  }

  async findMachineById(id: string): Promise<MachineRecord | undefined> {
    return this.machines.get(id);
  }

  async findMachineForOrganization(
    organizationId: string,
    id: string,
  ): Promise<MachineRecord | undefined> {
    const machine = this.machines.get(id);
    return machine?.orgId === organizationId ? machine : undefined;
  }

  async transitionMachine(
    id: string,
    toStatus: MachineStatus,
    fields?: TerminateMachineFields,
  ): Promise<MachineRecord> {
    const machine = this.readMachine(id);
    const updated: MachineRecord = {
      ...machine,
      status: toStatus,
      terminatedAt: toStatus === "terminated" ? new Date() : machine.terminatedAt,
      shutdownReason: fields?.reason ?? machine.shutdownReason,
    };

    this.machines.set(id, updated);
    return updated;
  }

  async insertAgentExecution(input: InsertAgentExecutionInput): Promise<AgentExecutionRecord> {
    if (input.machineId !== null && !this.machines.has(input.machineId)) {
      throw new Error(`machine not found: ${input.machineId}`);
    }

    const status = input.status ?? "spawning";
    const completedAt = status === "failed" ? this.now() : null;
    const deadlineAt = input.deadlineAt ?? null;
    const idleDeadlineAt = capIdleDeadline(input.idleDeadlineAt, deadlineAt);

    const execution: AgentExecutionRecord = {
      agentSessionId: null,
      agentSessionAction: null,
      id: input.id ?? randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      machineId: input.machineId,
      status,
      startedAt: input.startedAt ?? this.now(),
      completedAt,
      completedByAgentAt: null,
      deadlineAt,
      idleDeadlineAt,
      result: input.result ?? null,
      triggerContext: input.triggerContext,
      outputContext: input.outputContext,
      reactionState: input.reactionState ?? null,
      configurationRevisionId: input.configurationRevisionId,
      completionTokenHash: input.completionTokenHash ?? null,
      replyClaimedAt: null,
      replyClaimCount: 0,
      outputEmissions: {},
      outputDeliveryAttempts: {},
      launchIntent: input.launchIntent ?? null,
      usedTemporaryCredentials: temporaryCredentialFact(input.launchIntent ?? null),
      launchIntentExpiredAt: null,
      launchRunId: null,
      launchAgent: null,
      daemonId: input.daemonId ?? null,
      daemonAgentId: null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      hubAction: null,
      hubActionCompletedAt: null,
      hubActionReadyAt: null,
      hubActionAcknowledgements: emptyHubActionAcknowledgements(),
    };

    if (this.executionPayloadExpired(execution))
      throw new Error("agent execution insert returned no row");
    this.agentExecutions.set(execution.id, execution);
    this.options.onInsertAgentExecution?.(execution);
    return execution;
  }

  async insertAgentExecutionIfAbsent(
    input: InsertAgentExecutionInput & { id: string },
  ): Promise<AgentExecutionRecord | undefined> {
    if (this.agentExecutions.has(input.id)) return undefined;
    const stepId = input.workflowStepRunId;
    const runId =
      stepId == null
        ? input.launchIntent?.triggerRunId
        : this.workflowStepRuns.get(stepId)?.triggerRunId;
    if (runId !== undefined) {
      const run = this.triggerRuns.get(runId);
      if (
        run?.organizationId === input.organizationId &&
        run.projectId === input.projectId &&
        run.payloadExpiredAt != null
      )
        return undefined;
    }
    return this.insertAgentExecution(input);
  }

  async issueEnrollmentToken(input: EnrollmentTokenRecord): Promise<boolean> {
    this.enrollmentTokens.set(input.verifier, input);
    return true;
  }
  async startCliAuthorization(
    input: StartCliAuthorizationInput,
  ): Promise<CliAuthorizationRecord | undefined> {
    const now = this.options.now?.() ?? new Date();
    const active = Array.from(this.cliAuthorizations.values()).filter(
      (authorization) =>
        (authorization.status === "pending" || authorization.status === "approved") &&
        authorization.expiresAt > now,
    );
    const fingerprintCount = active.filter(
      (authorization) => authorization.fingerprintVerifier === input.fingerprintVerifier,
    ).length;
    if (fingerprintCount >= input.perFingerprintLimit || active.length >= input.globalLimit) {
      return undefined;
    }
    const authorization: MemoryCliAuthorization = {
      id: input.id,
      deviceVerifier: input.deviceVerifier,
      userCodeVerifier: input.userCodeVerifier,
      fingerprintVerifier: input.fingerprintVerifier,
      status: "pending",
      pollIntervalSeconds: input.pollIntervalSeconds,
      nextPollAt: now,
      approvedOrganizationId: null,
      approvedByUserId: null,
      credential: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.lifetimeSeconds * 1_000),
    };
    this.cliAuthorizations.set(input.deviceVerifier, authorization);
    return authorization;
  }
  async inspectCliAuthorization(userCodeVerifier: string) {
    const now = this.options.now?.() ?? new Date();
    const authorization = Array.from(this.cliAuthorizations.values()).find(
      (candidate) => candidate.userCodeVerifier === userCodeVerifier,
    );
    if (authorization !== undefined && authorization.expiresAt <= now) {
      authorization.status = "expired";
    }
    if (authorization === undefined || authorization.status !== "pending") {
      return undefined;
    }
    return authorization;
  }
  async decideCliAuthorization(
    input: CliAuthorizationDecisionInput,
  ): Promise<"approved" | "denied" | "unavailable" | "forbidden"> {
    const now = this.options.now?.() ?? new Date();
    const authorization = Array.from(this.cliAuthorizations.values()).find(
      (candidate) => candidate.userCodeVerifier === input.userCodeVerifier,
    );
    if (authorization !== undefined && authorization.expiresAt <= now) {
      authorization.status = "expired";
    }
    if (authorization === undefined || authorization.status !== "pending") {
      return "unavailable";
    }
    const status = input.decision === "approve" ? "approved" : "denied";
    authorization.status = status;
    if (input.decision === "approve") {
      authorization.approvedOrganizationId = input.access.organizationId;
      authorization.approvedByUserId = input.access.userId;
    }
    return status;
  }
  async pollCliAuthorization(input: {
    deviceVerifier: string;
    credential: { id: string; prefix: string; verifier: string };
  }): Promise<CliAuthorizationPollResult> {
    const now = this.options.now?.() ?? new Date();
    const authorization = this.cliAuthorizations.get(input.deviceVerifier);
    if (authorization !== undefined && authorization.expiresAt <= now) {
      authorization.status = "expired";
    }
    if (authorization === undefined || authorization.status === "expired") {
      return {
        status: "expired",
        intervalSeconds: authorization?.pollIntervalSeconds ?? 5,
      };
    }
    if (authorization.status === "denied" || authorization.status === "disclosed") {
      return {
        status: authorization.status,
        intervalSeconds: authorization.pollIntervalSeconds,
      };
    }
    if (authorization.nextPollAt > now) {
      authorization.pollIntervalSeconds += 5;
      authorization.nextPollAt = new Date(
        now.getTime() + authorization.pollIntervalSeconds * 1_000,
      );
      return {
        status: "slow_down",
        intervalSeconds: authorization.pollIntervalSeconds,
      };
    }
    authorization.nextPollAt = new Date(now.getTime() + authorization.pollIntervalSeconds * 1_000);
    if (authorization.status === "approved") {
      authorization.credential = input.credential;
      authorization.status = "disclosed";
      return {
        status: "authorized",
        intervalSeconds: authorization.pollIntervalSeconds,
        organizationId: authorization.approvedOrganizationId!,
      };
    }
    return {
      status: authorization.status,
      intervalSeconds: authorization.pollIntervalSeconds,
    };
  }
  async enrollDaemon(input: EnrollDaemonInput) {
    const replay = Array.from(this.daemons.values()).find((daemon) => daemon.id === input.daemonId);
    if (replay) return replay;
    const token = this.enrollmentTokens.get(input.tokenVerifier);
    if (!token || token.consumedAt || token.expiresAt <= input.now) return undefined;
    const suggestedSlug = input.suggestedSlug ?? `daemon-${input.daemonId.slice(0, 8)}`;
    const suggestedSlugTaken = Array.from(this.daemons.values()).some(
      (daemon) =>
        daemon.slug === suggestedSlug &&
        this.machines.get(daemon.machineId)?.orgId === token.organizationId,
    );
    const slug = suggestedSlugTaken
      ? `${suggestedSlug}-${input.daemonId.slice(0, 8)}`
      : suggestedSlug;
    const slugTaken = Array.from(this.daemons.values()).some(
      (daemon) =>
        daemon.slug === slug && this.machines.get(daemon.machineId)?.orgId === token.organizationId,
    );
    if (slugTaken) return { status: "slug_conflict" as const, slug };
    this.enrollmentTokens.set(input.tokenVerifier, {
      ...token,
      consumedAt: input.now,
    });
    const machine = await this.insertMachine({
      orgId: token.organizationId,
      source: { kind: "daemon", daemonId: input.daemonId },
      status: "alive",
    });
    const daemon: DaemonRecord = {
      id: input.daemonId,
      slug,
      machineId: machine.id,
      serverId: input.serverId,
      daemonPublicKey: input.daemonPublicKey,
      credentialVerifier: input.credentialVerifier,
      permissions: input.permissions,
      registeredByApiKeyId: token.issuedByApiKeyId ?? null,
      registeredByCliCredentialId: token.issuedByCliCredentialId ?? null,
      status: "active",
      presence: "offline",
      connectedAt: null,
      disconnectedAt: null,
      lastSeenAt: input.now,
      createdAt: input.now,
    };
    this.daemons.set(daemon.id, daemon);
    return daemon;
  }
  async findDaemonBySlugForOrganization(organizationId: string, slug: string) {
    return Array.from(this.daemons.values()).find(
      (daemon) =>
        daemon.slug === slug && this.machines.get(daemon.machineId)?.orgId === organizationId,
    );
  }
  async findDaemonById(id: string) {
    return this.daemons.get(id);
  }
  async findDaemonForOrganization(organizationId: string, id: string) {
    const daemon = this.daemons.get(id);
    const machine = daemon === undefined ? undefined : this.machines.get(daemon.machineId);
    return machine?.orgId === organizationId ? daemon : undefined;
  }
  async listDaemonsForOrganization(organizationId: string) {
    return Array.from(this.daemons.values())
      .filter((daemon) => this.machines.get(daemon.machineId)?.orgId === organizationId)
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }
  async renameDaemonForOrganization(organizationId: string, id: string, slug: string) {
    const daemon = await this.findDaemonForOrganization(organizationId, id);
    if (daemon === undefined) return undefined;
    const slugTaken = Array.from(this.daemons.values()).some(
      (candidate) =>
        candidate.id !== id &&
        candidate.slug === slug &&
        this.machines.get(candidate.machineId)?.orgId === organizationId,
    );
    if (slugTaken) return { status: "slug_conflict" as const, slug };
    const renamed = { ...daemon, slug };
    this.daemons.set(id, renamed);
    return renamed;
  }
  async touchDaemon(id: string) {
    const value = this.daemons.get(id);
    if (value) this.daemons.set(id, { ...value, lastSeenAt: new Date() });
  }
  async setDaemonPresence(id: string, presence: "offline" | "connected") {
    const value = this.daemons.get(id);
    if (!value) return;
    this.daemons.set(id, {
      ...value,
      presence,
      connectedAt: presence === "connected" ? new Date() : value.connectedAt,
      disconnectedAt: presence === "offline" ? new Date() : value.disconnectedAt,
    });
  }
  async setDaemonPermissions(id: string, permissions: string[]) {
    const value = this.daemons.get(id);
    if (!value) return undefined;
    const updated = { ...value, permissions: [...permissions] };
    this.daemons.set(id, updated);
    return updated;
  }
  async revokeDaemon(id: string) {
    const value = this.daemons.get(id);
    if (!value || value.status === "revoked") return false;
    this.daemons.set(id, { ...value, status: "revoked" });
    return true;
  }
  async attachAgentToExecution(executionId: string, daemonId: string, agentId: string) {
    const value = this.readAgentExecution(executionId);
    const updated = { ...value, daemonId: daemonId, daemonAgentId: agentId };
    this.agentExecutions.set(executionId, updated);
    return this.projectExecutionPayload(updated);
  }

  async limitAgentExecutionDeadline(executionId: string, deadlineAt: Date) {
    const execution = this.readAgentExecution(executionId);
    if (isTerminalAgentExecutionStatus(execution.status)) return;
    const boundedDeadline = new Date(
      Math.min(deadlineAt.getTime(), execution.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY),
    );
    const idleDeadlineAt = capIdleDeadline(execution.idleDeadlineAt, boundedDeadline);
    this.agentExecutions.set(executionId, {
      ...execution,
      deadlineAt: boundedDeadline,
      idleDeadlineAt,
    });
    if (execution.workflowStepRunId !== null) {
      const step = this.workflowStepRuns.get(execution.workflowStepRunId);
      if (step !== undefined)
        this.workflowStepRuns.set(step.id, {
          ...step,
          deadlineAt: boundedDeadline,
          idleDeadlineAt,
        });
    }
  }

  async setAgentExecutionIdleDeadline(
    executionId: string,
    idleDeadlineAt: Date | null,
    observedAt: Date,
    processedAt: Date,
  ) {
    const execution = this.readAgentExecution(executionId);
    if (isTerminalAgentExecutionStatus(execution.status))
      return this.projectExecutionPayload(execution);
    if (
      (execution.deadlineAt !== null && execution.deadlineAt.getTime() <= processedAt.getTime()) ||
      (execution.idleDeadlineAt !== null &&
        execution.idleDeadlineAt.getTime() <= observedAt.getTime())
    ) {
      return this.projectExecutionPayload(execution);
    }
    if (execution.workflowStepRunId !== null) {
      const step = this.workflowStepRuns.get(execution.workflowStepRunId);
      const run = step === undefined ? undefined : this.triggerRuns.get(step.triggerRunId);
      if (
        step === undefined ||
        step.status !== "running" ||
        run === undefined ||
        run.status !== "running" ||
        run.deadlineAt.getTime() <= processedAt.getTime()
      ) {
        return this.projectExecutionPayload(execution);
      }
    }
    const boundedIdleDeadlineAt = capIdleDeadline(idleDeadlineAt, execution.deadlineAt);
    const updated = { ...execution, idleDeadlineAt: boundedIdleDeadlineAt };
    this.agentExecutions.set(executionId, updated);
    if (execution.workflowStepRunId !== null) {
      const step = this.workflowStepRuns.get(execution.workflowStepRunId);
      if (step !== undefined) {
        this.workflowStepRuns.set(step.id, { ...step, idleDeadlineAt: boundedIdleDeadlineAt });
      }
    }
    return updated;
  }

  async prepareAgentExecutionForDispatch(
    executionId: string,
    daemonId: string,
    machineId: string,
    completionTokenHash: string,
  ) {
    const execution = this.readAgentExecution(executionId);
    if (isTerminalAgentExecutionStatus(execution.status))
      return this.projectExecutionPayload(execution);
    const updated = {
      ...execution,
      daemonId,
      machineId,
      completionTokenHash: execution.completionTokenHash ?? completionTokenHash,
    };
    this.agentExecutions.set(executionId, updated);
    return updated;
  }

  async findAgentExecutionById(id: string): Promise<AgentExecutionRecord | undefined> {
    const execution = this.agentExecutions.get(id);
    return execution === undefined ? undefined : this.projectExecutionPayload(execution);
  }

  async setAgentExecutionReactionState(
    executionId: string,
    reactionState: JsonValue | null,
  ): Promise<AgentExecutionRecord> {
    const execution = this.readAgentExecution(executionId);
    if (this.executionPayloadExpired(execution)) return this.projectExecutionPayload(execution);
    const updated = { ...execution, reactionState };
    this.agentExecutions.set(executionId, updated);
    return updated;
  }
  async findAgentExecutionForOrganization(
    organizationId: string,
    id: string,
  ): Promise<AgentExecutionRecord | undefined> {
    const execution = this.agentExecutions.get(id);
    if (execution === undefined) return undefined;
    const machine =
      execution.machineId === null ? undefined : this.machines.get(execution.machineId);
    return machine?.orgId === organizationId || execution.organizationId === organizationId
      ? this.projectExecutionPayload(execution)
      : undefined;
  }
  async findAgentExecutionForProject(projectId: string, id: string) {
    const execution = this.agentExecutions.get(id);
    return execution?.projectId === projectId ? this.projectExecutionPayload(execution) : undefined;
  }
  async updateTriggerRunValues(triggerRunId: string, values: unknown): Promise<TriggerRunRecord> {
    const run = this.triggerRuns.get(triggerRunId);
    if (run === undefined) throw new Error(`trigger run not found: ${triggerRunId}`);
    if (run.payloadExpiredAt != null) return run;
    const updated = { ...run, values: freezeEvidence(values) } as TriggerRunRecord;
    this.triggerRuns.set(triggerRunId, updated);
    return updated;
  }

  async listProjectActivityRuns(
    projectId: string,
    limit: number,
  ): Promise<ProjectActivityRunListRecord[]> {
    return (await this.listTriggerRunsForProject(projectId, limit)).flatMap((run) => {
      const record = this.activityListRecord(run);
      return record === undefined ? [] : [record];
    });
  }

  private activityListRecord(run: TriggerRunRecord): ProjectActivityRunListRecord | undefined {
    const receipt = this.providerEventReceipts.get(run.providerEventReceiptId);
    if (receipt === undefined) return undefined;
    const payload =
      run.payloadExpiredAt == null && receipt.payloadExpiryState == null ? receipt.payload : null;
    const actor =
      receipt.source === "webhook.received" &&
      payload !== null &&
      typeof payload === "object" &&
      "actor" in payload &&
      typeof payload.actor === "string"
        ? payload.actor
        : undefined;
    return {
      run,
      receipt: toProviderEventReceiptRecordSummary(receipt),
      ...(actor === undefined ? {} : { webhookActor: actor }),
    };
  }

  async listOrganizationActivityPage(
    organizationId: string,
    scopes: readonly ActivityRunScope[],
    request: ActivityRunPageRequest,
  ): Promise<ActivityRunPageRecord> {
    const records = [...this.triggerRuns.values()]
      .filter(
        (run) =>
          run.organizationId === organizationId &&
          scopes.some(
            ({ projectId, triggerName }) =>
              projectId === run.projectId &&
              (triggerName === undefined || triggerName === run.configuredTriggerName),
          ),
      )
      .flatMap((run) => this.activityListRecord(run) ?? [])
      .sort((left, right) => compareRunsNewestFirst(runOrder(left.run), runOrder(right.run)));
    const bound = request.position;
    const boundMicros =
      bound === undefined ? undefined : activityTimestampMicros(bound.key.createdAt);
    const inRange = records.filter(({ run }) => {
      if (bound === undefined || boundMicros === undefined) return true;
      const order = compareRunsNewestFirst(runOrder(run), {
        micros: boundMicros,
        id: bound.key.id,
      });
      return bound.direction === "before" ? order > 0 : order < 0;
    });
    const page =
      bound?.direction === "after"
        ? inRange.slice(Math.max(0, inRange.length - request.limit))
        : inRange.slice(0, request.limit);
    const first = page[0]?.run;
    const last = page.at(-1)?.run;
    const key = (run: { createdAt: Date; id: string }) => ({
      createdAt: run.createdAt.toISOString(),
      id: run.id,
    });
    return {
      records: page,
      older:
        last !== undefined &&
        records.some(({ run }) => compareRunsNewestFirst(runOrder(run), runOrder(last)) > 0)
          ? key(last)
          : null,
      newer:
        first !== undefined &&
        records.some(({ run }) => compareRunsNewestFirst(runOrder(run), runOrder(first)) < 0)
          ? key(first)
          : null,
    };
  }

  async findProjectActivityRun(projectId: string, runId: string) {
    const run = this.triggerRuns.get(runId);
    if (run === undefined || run.projectId !== projectId) return undefined;
    const receipt = this.providerEventReceipts.get(run.providerEventReceiptId);
    if (receipt === undefined) return undefined;
    return {
      run,
      receipt:
        run.payloadExpiredAt == null && receipt.payloadExpiryState == null
          ? receipt
          : { ...receipt, payload: null, acceptedRoutes: null },
      steps: await this.listWorkflowStepRunsForTriggerRun(run.id),
    };
  }

  async findOrganizationActivityRun(organizationId: string, runId: string) {
    const run = this.triggerRuns.get(runId);
    if (run === undefined || run.organizationId !== organizationId) return undefined;
    const receipt = this.providerEventReceipts.get(run.providerEventReceiptId);
    if (receipt === undefined || receipt.organizationId !== organizationId) return undefined;
    return {
      run,
      receipt:
        run.payloadExpiredAt == null && receipt.payloadExpiryState == null
          ? receipt
          : { ...receipt, payload: null, acceptedRoutes: null },
      steps: await this.listWorkflowStepRunsForTriggerRun(run.id),
    };
  }

  private listSteps(triggerRunId: string): WorkflowStepRunRecord[] {
    return [...this.workflowStepRuns.values()]
      .filter((step) => step.triggerRunId === triggerRunId)
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  async beginAgentExecutionOutput(
    executionId: string,
    outputType: string,
    maxOutputs: number | undefined,
    startedAt: Date,
  ): Promise<AgentExecutionOutputAttempt | undefined> {
    const execution = this.agentExecutions.get(executionId);
    if (
      execution === undefined ||
      (maxOutputs !== undefined && maxOutputs < 1) ||
      (execution.status !== "spawning" && execution.status !== "running")
    ) {
      return undefined;
    }
    const activeAttempts = Object.values(execution.outputDeliveryAttempts).filter(
      (attempt) =>
        attempt.outputType === outputType &&
        attempt.status === "pending" &&
        attempt.leaseExpiresAt > startedAt,
    ).length;
    if (
      maxOutputs !== undefined &&
      (execution.outputEmissions[outputType] ?? 0) + activeAttempts >= maxOutputs
    ) {
      return undefined;
    }
    const attempt: AgentExecutionOutputAttempt = {
      id: randomUUID(),
      outputType,
      status: "pending",
      startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + OUTPUT_ATTEMPT_LEASE_MS),
      completedAt: null,
    };
    this.agentExecutions.set(executionId, {
      ...execution,
      outputDeliveryAttempts: {
        ...execution.outputDeliveryAttempts,
        [attempt.id]: attempt,
      },
    });
    return attempt;
  }

  async completeAgentExecutionOutput(
    executionId: string,
    attemptId: string,
    completedAt: Date,
  ): Promise<AgentExecutionRecord | undefined> {
    const execution = this.agentExecutions.get(executionId);
    if (execution === undefined) return undefined;
    const attempt = execution.outputDeliveryAttempts[attemptId];
    if (attempt === undefined) return undefined;
    if (attempt.status === "succeeded") return this.projectExecutionPayload(execution);
    if (attempt.status !== "pending" || attempt.leaseExpiresAt <= completedAt) {
      if (attempt.status === "pending" && attempt.leaseExpiresAt <= completedAt) {
        this.agentExecutions.set(executionId, {
          ...execution,
          outputDeliveryAttempts: {
            ...execution.outputDeliveryAttempts,
            [attemptId]: { ...attempt, status: "failed", completedAt: null },
          },
        });
      }
      return undefined;
    }
    const count = execution.outputEmissions[attempt.outputType] ?? 0;
    const updated: AgentExecutionRecord = {
      ...execution,
      outputEmissions: { ...execution.outputEmissions, [attempt.outputType]: count + 1 },
      outputDeliveryAttempts: {
        ...execution.outputDeliveryAttempts,
        [attemptId]: { ...attempt, status: "succeeded", completedAt },
      },
    };
    this.agentExecutions.set(executionId, updated);
    return this.projectExecutionPayload(updated);
  }

  async failAgentExecutionOutput(
    executionId: string,
    attemptId: string,
    _failedAt: Date,
  ): Promise<boolean> {
    const execution = this.agentExecutions.get(executionId);
    const attempt = execution?.outputDeliveryAttempts[attemptId];
    if (execution === undefined || attempt === undefined || attempt.status !== "pending") {
      return false;
    }
    this.agentExecutions.set(executionId, {
      ...execution,
      outputDeliveryAttempts: {
        ...execution.outputDeliveryAttempts,
        [attemptId]: { ...attempt, status: "failed", completedAt: null },
      },
    });
    return true;
  }

  async transitionAgentExecution(
    id: string,
    toStatus: AgentExecutionStatus,
    fields: TransitionAgentExecutionFields = {},
  ): Promise<TransitionAgentExecutionResult> {
    const execution = this.readAgentExecution(id);
    if (isTerminalAgentExecutionStatus(execution.status)) {
      return { execution: this.projectExecutionPayload(execution), transitioned: false };
    }
    if (fields.deadlineCondition !== undefined) {
      const current =
        fields.deadlineCondition.kind === "hard" ? execution.deadlineAt : execution.idleDeadlineAt;
      if (
        current?.getTime() !== fields.deadlineCondition.deadlineAt.getTime() ||
        current.getTime() > fields.deadlineCondition.observedAt.getTime()
      ) {
        return { execution, transitioned: false };
      }
    }

    let hubActionCompletedAt = execution.hubActionCompletedAt;
    let hubActionReadyAt = execution.hubActionReadyAt;
    if (fields.hubAction !== undefined) {
      hubActionCompletedAt = fields.hubAction === null ? this.now() : null;
      hubActionReadyAt = null;
    }
    const updated: AgentExecutionRecord = {
      ...execution,
      status: toStatus,
      completedAt: isTerminalAgentExecutionStatus(toStatus) ? this.now() : execution.completedAt,
      completedByAgentAt:
        fields.completedByAgent === true && toStatus === "succeeded"
          ? this.now()
          : execution.completedByAgentAt,
      result: fields.result !== undefined ? fields.result : execution.result,
      idleDeadlineAt: isTerminalAgentExecutionStatus(toStatus) ? null : execution.idleDeadlineAt,
      hubAction: fields.hubAction === undefined ? execution.hubAction : fields.hubAction,
      hubActionCompletedAt,
      hubActionReadyAt,
    };

    this.agentExecutions.set(id, updated);
    return { execution: updated, transitioned: true };
  }

  async findRunningAgentExecutionsForMachine(machineId: string): Promise<AgentExecutionRecord[]> {
    return Array.from(this.agentExecutions.values()).filter(
      (execution) =>
        execution.machineId === machineId &&
        (execution.status === "spawning" || execution.status === "running"),
    );
  }

  async findPendingAgentExecutions(): Promise<AgentExecutionRecord[]> {
    return Array.from(this.agentExecutions.values()).filter(
      (execution) => execution.status === "spawning" || execution.status === "running",
    );
  }

  async findPendingHubActions(daemonId?: string): Promise<AgentExecutionRecord[]> {
    return Array.from(this.agentExecutions.values()).filter(
      (execution) =>
        execution.hubAction !== null &&
        execution.hubActionCompletedAt === null &&
        (daemonId === undefined || execution.daemonId === daemonId),
    );
  }

  async markAgentExecutionHubActionReady(
    executionId: string,
    observedAt = this.now(),
  ): Promise<AgentExecutionRecord | undefined> {
    const execution = this.agentExecutions.get(executionId);
    if (
      execution === undefined ||
      execution.status !== "succeeded" ||
      execution.completedByAgentAt === null ||
      execution.hubAction !== "archive" ||
      execution.hubActionCompletedAt !== null ||
      execution.hubActionReadyAt !== null ||
      execution.hubActionAcknowledgements.terminalAt === null ||
      execution.hubActionAcknowledgements.idleAt === null ||
      execution.hubActionAcknowledgements.finishExecutionCall === null ||
      execution.hubActionAcknowledgements.finishExecutionCall.status !== "completed"
    ) {
      return undefined;
    }
    const updated = { ...execution, hubActionReadyAt: observedAt };
    this.agentExecutions.set(executionId, updated);
    return updated;
  }

  async recordAgentExecutionHubAcknowledgement(
    executionId: string,
    acknowledgement: AgentExecutionHubAcknowledgementInput,
  ): Promise<AgentExecutionRecord | undefined> {
    const execution = this.agentExecutions.get(executionId);
    if (execution === undefined) return undefined;
    if (acknowledgement.kind === "finish_execution" && execution.launchIntentExpiredAt != null)
      return undefined;
    const current = execution.hubActionAcknowledgements;
    const updatedAcknowledgements: AgentExecutionHubAcknowledgements = {
      terminalAt: current.terminalAt,
      idleAt: current.idleAt,
      finishExecutionCall: current.finishExecutionCall,
    };
    if (acknowledgement.kind === "terminal") {
      if (
        updatedAcknowledgements.terminalAt === null ||
        acknowledgement.observedAt.getTime() > updatedAcknowledgements.terminalAt.getTime()
      ) {
        updatedAcknowledgements.terminalAt = acknowledgement.observedAt;
      }
    } else if (acknowledgement.kind === "idle") {
      if (
        updatedAcknowledgements.idleAt === null ||
        acknowledgement.observedAt.getTime() > updatedAcknowledgements.idleAt.getTime()
      ) {
        updatedAcknowledgements.idleAt = acknowledgement.observedAt;
      }
    } else {
      const previous = updatedAcknowledgements.finishExecutionCall;
      if (
        previous === undefined ||
        previous === null ||
        (previous.status !== "completed" &&
          (acknowledgement.status === "completed" ||
            acknowledgement.observedAt.getTime() > previous.observedAt.getTime()))
      ) {
        updatedAcknowledgements.finishExecutionCall = {
          callId: acknowledgement.callId ?? null,
          status: acknowledgement.status,
          observedAt: acknowledgement.observedAt,
        };
      }
    }
    const updated = { ...execution, hubActionAcknowledgements: updatedAcknowledgements };
    this.agentExecutions.set(executionId, updated);
    return this.projectExecutionPayload(updated);
  }

  async completeHubAction(executionId: string, action: "interrupt" | "archive"): Promise<boolean> {
    const execution = this.readAgentExecution(executionId);
    if (execution.hubAction !== action || execution.hubActionCompletedAt !== null) return false;
    this.agentExecutions.set(executionId, {
      ...execution,
      hubActionCompletedAt: new Date(),
    });
    return true;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    if (
      Array.from(this.projects.values()).some(
        (project) => project.organizationId === input.organizationId && project.slug === input.slug,
      )
    ) {
      throw new Error("project slug already exists");
    }
    const now = new Date();
    const project: ProjectRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      slug: input.slug,
      status: "active",
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      activeConfigurationRevisionId: null,
    };
    this.organizationIds.add(input.organizationId);
    this.projects.set(project.id, project);
    this.configurationAuthorities.set(project.id, "manual");
    return project;
  }

  async restoreProject(organizationId: string, projectId: string): Promise<ProjectRecord> {
    const project = this.projects.get(projectId);
    if (project === undefined || project.organizationId !== organizationId) {
      throw new Error("project not found");
    }
    const restored: ProjectRecord = {
      ...project,
      status: "active",
      archivedAt: null,
      updatedAt: new Date(),
    };
    this.projects.set(projectId, restored);
    return restored;
  }

  async getOrganizationEntitlements(
    organizationId: string,
  ): Promise<OrganizationEntitlementsRecord | undefined> {
    return this.organizationEntitlements.get(organizationId);
  }

  async stampOrganizationEntitlements(
    input: StampOrganizationEntitlementsInput,
  ): Promise<OrganizationEntitlementsRecord> {
    const existing = this.organizationEntitlements.get(input.organizationId);
    // Idempotent: an identical granted template and plan provenance is a no-op — no timestamp
    // bump, no duplicate audit row — mirroring the Postgres conditional stamp.
    if (
      existing !== undefined &&
      existing.planId === input.planId &&
      existing.planVersion === input.planVersion &&
      JSON.stringify(existing.granted) === JSON.stringify(input.granted)
    ) {
      return existing;
    }
    const now = this.now();
    const record: OrganizationEntitlementsRecord = {
      organizationId: input.organizationId,
      granted: input.granted,
      overrides: existing?.overrides ?? {},
      planId: input.planId,
      planVersion: input.planVersion,
      stampedAt: now,
      updatedAt: now,
    };
    this.organizationEntitlements.set(input.organizationId, record);
    this.recordEntitlementChange({
      organizationId: input.organizationId,
      actor: input.actor,
      source: input.source,
      before: existing === undefined ? null : entitlementSnapshot(existing),
      after: entitlementSnapshot(record),
      reason: input.reason,
    });
    return record;
  }

  async overrideOrganizationEntitlements(
    input: OverrideOrganizationEntitlementsInput,
  ): Promise<OrganizationEntitlementsRecord> {
    const existing = this.organizationEntitlements.get(input.organizationId);
    if (existing === undefined) {
      throw new Error(`organization has no entitlements record: ${input.organizationId}`);
    }
    // Merge the patch against the current row, mirroring the Postgres locked-row merge. No await
    // between read and write, so concurrent overrides cannot interleave and lose keys.
    const overrides = mergeOverrides(
      entitlementOverridesSchema.parse(existing.overrides),
      input.patch,
    );
    const record: OrganizationEntitlementsRecord = {
      ...existing,
      overrides,
      updatedAt: this.now(),
    };
    this.organizationEntitlements.set(input.organizationId, record);
    this.recordEntitlementChange({
      organizationId: input.organizationId,
      actor: input.actor,
      source: "override",
      before: entitlementSnapshot(existing),
      after: entitlementSnapshot(record),
      reason: input.reason,
    });
    return record;
  }

  async clearOrganizationEntitlementsOverride(
    input: ClearOrganizationEntitlementsOverrideInput,
  ): Promise<OrganizationEntitlementsRecord> {
    const existing = this.organizationEntitlements.get(input.organizationId);
    if (existing === undefined) {
      throw new Error(`organization has no entitlements record: ${input.organizationId}`);
    }
    // Drop the key from the current row, mirroring the Postgres locked-row clear. No await
    // between read and write, so a concurrent override cannot interleave.
    const overrides = clearOverrideKey(
      entitlementOverridesSchema.parse(existing.overrides),
      input.key,
    );
    const record: OrganizationEntitlementsRecord = {
      ...existing,
      overrides,
      updatedAt: this.now(),
    };
    this.organizationEntitlements.set(input.organizationId, record);
    this.recordEntitlementChange({
      organizationId: input.organizationId,
      actor: input.actor,
      source: "override",
      before: entitlementSnapshot(existing),
      after: entitlementSnapshot(record),
      reason: input.reason,
    });
    return record;
  }

  async listEntitlementChanges(
    organizationId: string,
    limit: number,
  ): Promise<EntitlementChangeRecord[]> {
    return this.entitlementChanges
      .filter((change) => change.organizationId === organizationId)
      .slice(-limit)
      .toReversed();
  }

  private recordEntitlementChange(
    input: Omit<EntitlementChangeRecord, "id" | "actorName" | "createdAt">,
  ): void {
    this.entitlementChanges.push({
      ...input,
      id: randomUUID(),
      actorName: null,
      createdAt: this.now(),
    });
  }

  async consumeOrganizationUsage(
    input: ConsumeOrganizationUsageInput,
  ): Promise<OrganizationUsageRecord | undefined> {
    // No `await` between read and write, so this is as atomic as the single-statement
    // Postgres upsert it mirrors: nothing can interleave on Node's single thread.
    const key = usageKey(input.organizationId, input.meter, input.periodStart);
    const existing = this.organizationUsage.get(key);
    const used = (existing?.used ?? 0) + input.amount;
    if (input.limit !== null && used > input.limit) return undefined;
    const record: OrganizationUsageRecord = {
      organizationId: input.organizationId,
      meter: input.meter,
      periodStart: input.periodStart,
      used,
    };
    this.organizationUsage.set(key, record);
    return record;
  }

  async getOrganizationUsage(
    organizationId: string,
    meter: string,
    periodStart: Date,
  ): Promise<OrganizationUsageRecord | undefined> {
    return this.organizationUsage.get(usageKey(organizationId, meter, periodStart));
  }

  async syncBillingPlan(input: SyncBillingPlanInput): Promise<BillingPlanRecord> {
    const record: BillingPlanRecord = {
      id: input.id,
      slug: input.slug,
      name: input.name,
      template: input.template,
      templateHash: input.templateHash,
      marketing: input.marketing,
      active: input.active,
      syncedAt: this.now(),
      prices: input.prices.map((price) => ({ ...price, planId: input.id })),
    };
    this.billingPlans.set(input.id, record);
    return record;
  }

  async deactivateBillingPlansExcept(activeIds: readonly string[]): Promise<void> {
    const keep = new Set(activeIds);
    for (const [id, plan] of this.billingPlans) {
      if (!keep.has(id) && plan.active) this.billingPlans.set(id, { ...plan, active: false });
    }
  }

  async listBillingPlans(): Promise<BillingPlanRecord[]> {
    return Array.from(this.billingPlans.values());
  }

  async reconcileOrganizationBilling(
    input: ReconcileOrganizationBillingInput,
  ): Promise<OrganizationBillingCustomerRecord> {
    const record: OrganizationBillingCustomerRecord = {
      organizationId: input.organizationId,
      stripeCustomerId: input.stripeCustomerId,
      updatedAt: this.now(),
    };
    this.organizationBillingCustomers.set(input.organizationId, record);
    // No await between the two writes, so on Node's single thread the mirror and the stamp land
    // together — the in-memory stand-in for the Postgres transaction that couples them.
    if (input.stamp !== undefined) {
      await this.stampOrganizationEntitlements({
        organizationId: input.organizationId,
        ...input.stamp,
      });
    }
    return record;
  }

  private readonly authorityRecords = new Map<
    string,
    import("../execution-authority/index.js").ExecutionAuthorityRecord
  >();
  private readonly authorityLeases = new Map<
    string,
    import("../execution-authority/index.js").ExecutionCredentialLease
  >();
  readonly executionAuthority: import("../execution-authority/index.js").ExecutionAuthorityStore = {
    executions: async () => [...this.authorityRecords.keys()],
    read: async (id) => structuredClone(this.authorityRecords.get(id)),
    commit: async (record) => {
      if (!this.authorityRecords.has(record.executionId))
        this.authorityRecords.set(record.executionId, structuredClone(record));
      return structuredClone(this.authorityRecords.get(record.executionId)!);
    },
    remove: async (id) => {
      this.authorityRecords.delete(id);
    },
    leases: async (executionId) =>
      structuredClone(
        [...this.authorityLeases.values()].filter(
          (lease) => executionId === undefined || lease.executionId === executionId,
        ),
      ),
    saveLease: async (lease) => {
      this.authorityLeases.set(lease.id, structuredClone(lease));
    },
    removeLease: async (id) => {
      this.authorityLeases.delete(id);
    },
  };

  private readonly agentSessions = new Map<
    string,
    import("../agent-sessions/index.js").AgentSessionRecord
  >();
  private readonly agentSessionCreatedAt = new Map<string, Date>();
  async findAgentSession(id: string) {
    return structuredClone(this.agentSessions.get(id));
  }
  async findAgentSessionByKey(projectId: string, key: string) {
    return structuredClone(
      [...this.agentSessions.values()].find(
        (session) => session.projectId === projectId && session.continuationKey === key,
      ),
    );
  }
  async saveAgentSession(
    session: import("../agent-sessions/index.js").AgentSessionRecord,
  ): Promise<void> {
    const current = this.agentSessions.get(session.id);
    if (current === undefined) this.agentSessionCreatedAt.set(session.id, new Date());
    if (current?.optionsReducedAt != null) {
      if (session.continuationKey === null) {
        this.agentSessions.set(session.id, { ...current, continuationKey: null });
      }
      return;
    }
    this.agentSessions.set(session.id, structuredClone(session));
  }
  async attachExecutionToSession(
    executionId: string,
    sessionId: string,
    action?: import("../agent-sessions/index.js").AgentSessionAction,
  ): Promise<void> {
    const execution = this.agentExecutions.get(executionId);
    const session = this.agentSessions.get(sessionId);
    if (
      !execution ||
      !session ||
      execution.launchIntentExpiredAt != null ||
      execution.projectId !== session.projectId ||
      execution.organizationId !== session.organizationId ||
      (execution.agentSessionId !== null && execution.agentSessionId !== sessionId)
    ) {
      throw new Error("Agent session does not belong to this execution");
    }
    this.agentExecutions.set(executionId, {
      ...execution,
      agentSessionId: sessionId,
      agentSessionAction: execution.agentSessionAction ?? action ?? null,
    });
  }
  async listAgentSessionExecutions(sessionId: string): Promise<AgentExecutionRecord[]> {
    return [...this.agentExecutions.values()]
      .filter((execution) => execution.agentSessionId === sessionId)
      .sort(
        (left, right) =>
          left.startedAt.getTime() - right.startedAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((execution) => this.projectExecutionPayload(execution));
  }

  async withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Node runs one callback at a time, so a per-key promise chain is a faithful in-memory
    // stand-in for the Postgres advisory lock: same-key sections run strictly in sequence.
    const previous = this.advisoryLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const held = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    this.advisoryLocks.set(key, held);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.advisoryLocks.get(key) === held) this.advisoryLocks.delete(key);
    }
  }

  async getOrganizationBillingCustomer(
    organizationId: string,
  ): Promise<OrganizationBillingCustomerRecord | undefined> {
    return this.organizationBillingCustomers.get(organizationId);
  }

  async listProjectsForOrganization(organizationId: string) {
    const runtimeProjects = new Set(
      Array.from(this.organizationTriggers.values()).map(
        ({ runtimeProjectId }) => runtimeProjectId,
      ),
    );
    return Array.from(this.projects.values()).filter(
      (project) =>
        project.organizationId === organizationId &&
        project.status === "active" &&
        !runtimeProjects.has(project.id),
    );
  }

  async listPendingProjectTriggerMigrations(): Promise<PendingProjectTriggerMigration[]> {
    const runtimeProjects = new Set(
      Array.from(this.organizationTriggers.values()).map(
        ({ runtimeProjectId }) => runtimeProjectId,
      ),
    );
    return Array.from(this.projects.values()).flatMap((project) => {
      if (
        project.status !== "active" ||
        project.activeConfigurationRevisionId === null ||
        this.migratedProjects.has(project.id) ||
        runtimeProjects.has(project.id)
      ) {
        return [];
      }
      const revision = this.configurationRevisions.get(project.activeConfigurationRevisionId);
      return revision === undefined ? [] : [{ project, revision }];
    });
  }

  async migrateProjectTriggers(
    input: MigrateProjectTriggersInput,
  ): Promise<OrganizationTriggerRecord[]> {
    if (this.migratedProjects.has(input.projectId)) return [];
    const project = this.projects.get(input.projectId);
    if (
      project === undefined ||
      project.organizationId !== input.organizationId ||
      project.activeConfigurationRevisionId !== input.configurationRevisionId
    ) {
      throw new Error("project configuration changed during trigger migration");
    }
    const compiledCandidates = input.triggers.map((candidate) => {
      if (candidate.format !== "single_run" && candidate.format !== "legacy_multistep") {
        throw new Error("invalid organization trigger format");
      }
      return parseCompiledHubConfig(candidate.normalizedConfiguration);
    });
    const legacyRoutes = this.projectTriggerRoutes.get(input.projectId) ?? [];
    const candidateRoutes = input.triggers.map((candidate, index) => {
      const configuredEventName = compiledCandidates[index]!.triggers[0]?.on;
      if (configuredEventName === undefined) {
        throw new Error(`migrated trigger ${candidate.name} has no configured event`);
      }
      return legacyRoutes
        .filter((route) => route.triggerName === candidate.name)
        .map(
          (route): OrganizationTriggerRoute => ({
            provider: route.provider,
            connectionId: route.connectionId,
            resourceId: route.resourceId,
            configuredEventName,
          }),
        );
    });
    if (
      candidateRoutes.reduce((total, routes) => total + routes.length, 0) !== legacyRoutes.length
    ) {
      throw new Error("project trigger routes do not match migrated triggers");
    }
    const created: OrganizationTriggerRecord[] = [];
    for (const [index, candidate] of input.triggers.entries()) {
      const name = this.availableMigratedTriggerName(
        input.organizationId,
        input.projectSlug,
        candidate.name,
      );
      const now = this.now();
      const triggerId = randomUUID();
      const revisionId = randomUUID();
      const runtimeProjectId = this.createTriggerRuntimeProject({
        organizationId: input.organizationId,
        name: candidate.name,
        createdByUserId: null,
      });
      const trigger: OrganizationTriggerRecord = {
        id: triggerId,
        organizationId: input.organizationId,
        name,
        enabled: candidate.enabled,
        format: candidate.format,
        runtimeProjectId,
        activeRevisionId: revisionId,
        createdAt: now,
        updatedAt: now,
      };
      const revision: OrganizationTriggerRevisionRecord = {
        id: revisionId,
        triggerId,
        organizationId: input.organizationId,
        version: 1,
        yaml: candidate.yaml,
        normalizedConfiguration: candidate.normalizedConfiguration,
        contentHash: candidate.contentHash,
        sourceKind: "project_migration",
        sourceEvidence: candidate.sourceEvidence,
        createdByUserId: null,
        createdAt: now,
      };
      this.organizationTriggers.set(trigger.id, trigger);
      this.organizationTriggerRevisions.set(revision.id, revision);
      const routes = candidateRoutes[index]!;
      this.organizationTriggerRoutes.set(trigger.id, routes);
      const runtimeRevision = await this.insertProjectConfigurationRevision({
        projectId: runtimeProjectId,
        sourceKind: "manual",
        sourceEvidence: { kind: "organization_trigger_adapter", triggerId },
        rawYaml: candidate.yaml,
        normalizedConfiguration: candidate.normalizedConfiguration,
        contentHash: candidate.contentHash,
      });
      const configuration = compiledCandidates[index]!;
      await this.activateProjectConfigurationRevision(
        runtimeProjectId,
        runtimeRevision.id,
        routes.map((route) => ({
          provider: route.provider,
          connectionId: route.connectionId,
          resourceId: route.resourceId,
          triggerName:
            configuration.triggers.find(({ on }) => on === route.configuredEventName)?.name ??
            configuration.triggers[0]?.name ??
            candidate.name,
        })),
      );
      created.push(trigger);
    }
    this.projectTriggerRoutes.delete(input.projectId);
    this.projects.set(input.projectId, {
      ...project,
      status: "archived",
      activeConfigurationRevisionId: null,
      archivedAt: this.now(),
      updatedAt: this.now(),
    });
    this.migratedProjects.add(input.projectId);
    return created;
  }

  async listOrganizationTriggers(organizationId: string): Promise<OrganizationTriggerRecord[]> {
    return Array.from(this.organizationTriggers.values()).filter(
      (trigger) => trigger.organizationId === organizationId,
    );
  }

  async findOrganizationTriggerRevision(
    triggerId: string,
    revisionId: string,
  ): Promise<OrganizationTriggerRevisionRecord | undefined> {
    const revision = this.organizationTriggerRevisions.get(revisionId);
    return revision?.triggerId === triggerId ? revision : undefined;
  }

  async findOrganizationTriggerMigrationRevision(
    triggerId: string,
  ): Promise<OrganizationTriggerRevisionRecord | undefined> {
    return Array.from(this.organizationTriggerRevisions.values())
      .filter(
        (revision) =>
          revision.triggerId === triggerId && revision.sourceKind === "project_migration",
      )
      .sort((left, right) => left.version - right.version)[0];
  }

  async saveOrganizationTrigger(
    input: SaveOrganizationTriggerInput,
  ): Promise<OrganizationTriggerRecord> {
    const existing =
      input.triggerId === undefined ? undefined : this.organizationTriggers.get(input.triggerId);
    if (existing !== undefined && existing.organizationId !== input.organizationId) {
      throw new Error("organization trigger not found");
    }
    if (
      Array.from(this.organizationTriggers.values()).some(
        (trigger) =>
          trigger.organizationId === input.organizationId &&
          trigger.name === input.name &&
          trigger.id !== input.triggerId,
      )
    ) {
      throw new Error("trigger name already exists");
    }
    const now = this.now();
    const triggerId = existing?.id ?? randomUUID();
    const runtimeProjectId =
      existing?.runtimeProjectId ??
      this.createTriggerRuntimeProject({
        organizationId: input.organizationId,
        name: input.name,
        createdByUserId: input.createdByUserId,
      });
    const revisionId = randomUUID();
    const version =
      Math.max(
        0,
        ...Array.from(this.organizationTriggerRevisions.values())
          .filter((revision) => revision.triggerId === triggerId)
          .map((revision) => revision.version),
      ) + 1;
    const revision: OrganizationTriggerRevisionRecord = {
      id: revisionId,
      triggerId,
      organizationId: input.organizationId,
      version,
      yaml: input.yaml,
      normalizedConfiguration: input.normalizedConfiguration,
      contentHash: input.contentHash,
      sourceKind: input.sourceKind,
      sourceEvidence: input.sourceEvidence,
      createdByUserId: input.createdByUserId,
      createdAt: now,
    };
    const trigger: OrganizationTriggerRecord = {
      id: triggerId,
      organizationId: input.organizationId,
      name: input.name,
      enabled: input.enabled,
      format: input.format,
      runtimeProjectId,
      activeRevisionId: revisionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.organizationTriggerRevisions.set(revision.id, revision);
    this.organizationTriggers.set(trigger.id, trigger);
    this.organizationTriggerRoutes.set(trigger.id, [...input.routes]);
    const runtimeRevision = await this.insertProjectConfigurationRevision({
      projectId: runtimeProjectId,
      sourceKind: input.sourceKind,
      sourceEvidence: { kind: "organization_trigger_adapter", triggerId },
      rawYaml: input.yaml,
      normalizedConfiguration: input.normalizedConfiguration,
      contentHash: input.contentHash,
      createdByUserId: input.createdByUserId,
    });
    const configuration = parseCompiledHubConfig(input.normalizedConfiguration);
    await this.activateProjectConfigurationRevision(
      runtimeProjectId,
      runtimeRevision.id,
      input.routes.map((route) => ({
        provider: route.provider,
        connectionId: route.connectionId,
        resourceId: route.resourceId,
        triggerName:
          configuration.triggers.find(({ on }) => on === route.configuredEventName)?.name ??
          configuration.triggers[0]?.name ??
          input.name,
      })),
    );
    return trigger;
  }

  private createTriggerRuntimeProject(input: {
    organizationId: string;
    name: string;
    createdByUserId: string | null;
  }): string {
    const id = randomUUID();
    const now = this.now();
    this.projects.set(id, {
      id,
      organizationId: input.organizationId,
      name: `Trigger runtime: ${input.name}`,
      slug: `trigger-${id.slice(0, 8)}`,
      status: "active",
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      activeConfigurationRevisionId: null,
    });
    this.configurationAuthorities.set(id, "manual");
    return id;
  }

  private availableMigratedTriggerName(
    organizationId: string,
    projectSlug: string,
    requestedName: string,
  ): string {
    const occupied = new Set(
      Array.from(this.organizationTriggers.values())
        .filter((trigger) => trigger.organizationId === organizationId)
        .map((trigger) => trigger.name),
    );
    if (!occupied.has(requestedName)) return requestedName;
    const base = `${projectSlug}-${requestedName}`;
    if (!occupied.has(base)) return base;
    let suffix = 2;
    while (occupied.has(`${base}-${String(suffix)}`)) suffix += 1;
    return `${base}-${String(suffix)}`;
  }

  async findProjectForOrganization(organizationId: string, projectId: string) {
    const project = this.projects.get(projectId);
    return project?.organizationId === organizationId ? project : undefined;
  }

  async findProjectById(projectId: string) {
    return this.projects.get(projectId);
  }

  async findProjectBySlugForOrganization(organizationId: string, slug: string) {
    return Array.from(this.projects.values()).find(
      (project) => project.organizationId === organizationId && project.slug === slug,
    );
  }

  async listOrganizationsOffPlanTemplate(planId: string, templateHash: string): Promise<string[]> {
    return [...this.organizationEntitlements.values()]
      .filter((row) => row.planId === planId && row.planVersion !== templateHash)
      .map((row) => row.organizationId);
  }

  async listOrganizationsForOperator(): Promise<OperatorOrganizationRecord[]> {
    return this.operatorOrganizations();
  }

  async findOrganizationForOperator(slug: string): Promise<OperatorOrganizationRecord | undefined> {
    return this.operatorOrganizations().find((organization) => organization.slug === slug);
  }

  async findOrganizationSlugById(organizationId: string): Promise<string | undefined> {
    return this.operatorOrganizations().find((organization) => organization.id === organizationId)
      ?.slug;
  }

  /** Distinct organizations derived from the membership fixtures — the in-memory store models
   * organizations only through those, so the operator picker reads the same source. */
  private operatorOrganizations(): OperatorOrganizationRecord[] {
    const seen = new Map<string, OperatorOrganizationRecord>();
    for (const membership of this.options.memberships ?? []) {
      seen.set(membership.organizationId, {
        id: membership.organizationId,
        name: membership.organizationName,
        slug: membership.organizationSlug,
      });
    }
    return Array.from(seen.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  async resolveTenantRouteAccess(
    userId: string,
    organizationSlug: string,
    projectSlug?: string,
  ): Promise<TenantRouteAccess | undefined> {
    const membership = this.options.memberships?.find(
      (candidate) => candidate.userId === userId && candidate.organizationSlug === organizationSlug,
    );
    if (membership === undefined) return undefined;
    const project =
      projectSlug === undefined
        ? undefined
        : Array.from(this.projects.values()).find(
            (candidate) =>
              candidate.organizationId === membership.organizationId &&
              candidate.slug === projectSlug &&
              candidate.status === "active",
          );
    if (projectSlug !== undefined && project === undefined) return undefined;
    return {
      organization: {
        id: membership.organizationId,
        name: membership.organizationName,
        slug: membership.organizationSlug,
      },
      membership: { id: membership.membershipId, role: membership.role },
      ...(project === undefined ? {} : { project }),
    };
  }

  async archiveProject(organizationId: string, projectId: string, _userId: string) {
    const project = await this.findProjectForOrganization(organizationId, projectId);
    if (project === undefined) throw new Error("project access denied");
    const now = new Date();
    const archived: ProjectRecord = {
      ...project,
      status: "archived",
      archivedAt: now,
      updatedAt: now,
      activeConfigurationRevisionId: null,
    };
    this.projects.set(projectId, archived);
    return archived;
  }

  async updateProjectSlug(
    organizationId: string,
    projectId: string,
    slug: string,
    _userId: string,
  ) {
    const project = await this.findProjectForOrganization(organizationId, projectId);
    if (project === undefined) throw new Error("project access denied");
    const updated = { ...project, slug, updatedAt: new Date() };
    this.projects.set(projectId, updated);
    return updated;
  }

  async insertProjectConfigurationRevision(
    input: InsertProjectConfigurationRevisionInput,
  ): Promise<ProjectConfigurationRevisionRecord> {
    const project = this.projects.get(input.projectId);
    if (project?.status !== "active") throw new Error("project not found");
    const version =
      Math.max(
        0,
        ...Array.from(this.configurationRevisions.values())
          .filter((revision) => revision.projectId === input.projectId)
          .map((revision) => revision.version),
      ) + 1;
    const now = new Date();
    const revision: ProjectConfigurationRevisionRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      organizationId: project.organizationId,
      version,
      sourceKind: input.sourceKind,
      sourceEvidence: input.sourceEvidence,
      rawYaml: input.rawYaml ?? null,
      normalizedConfiguration: input.normalizedConfiguration,
      validationErrors: input.validationErrors ?? null,
      contentHash: input.contentHash,
      createdByUserId: input.createdByUserId ?? null,
      receivedAt: now,
      createdAt: now,
      validatedAt: input.validationErrors === undefined ? now : null,
    };
    this.configurationRevisions.set(revision.id, revision);
    return revision;
  }

  async activateProjectConfigurationRevision(
    projectId: string,
    revisionId: string,
    routes?: readonly ProjectTriggerRoute[],
  ) {
    const project = this.projects.get(projectId);
    const revision = this.configurationRevisions.get(revisionId);
    if (project?.status !== "active" || revision?.projectId !== projectId)
      throw new Error("configuration revision not found");
    if (revision.validationErrors !== null) throw new Error("invalid configuration revision");
    this.projectTriggerRoutes.set(projectId, [
      ...(routes ?? this.projectTriggerRoutes.get(projectId) ?? []),
    ]);
    this.projects.set(projectId, {
      ...project,
      activeConfigurationRevisionId: revisionId,
      updatedAt: new Date(),
    });
    return revision;
  }

  async findProjectConfigurationRollbackTarget(projectId: string) {
    const active = await this.findActiveProjectConfiguration(projectId);
    return Array.from(this.configurationRevisions.values())
      .filter(
        (revision) =>
          revision.projectId === projectId &&
          revision.validationErrors === null &&
          active !== undefined &&
          revision.version < active.version,
      )
      .sort((left, right) => right.version - left.version)[0];
  }

  async rollbackProjectConfiguration(
    projectId: string,
    targetRevisionId: string,
    routes: readonly ProjectTriggerRoute[],
  ) {
    const target = await this.findProjectConfigurationRollbackTarget(projectId);
    if (target?.id !== targetRevisionId) throw new Error("configuration rollback target changed");
    return this.activateProjectConfigurationRevision(projectId, targetRevisionId, routes);
  }

  async findActiveProjectConfiguration(projectId: string) {
    const revisionId = this.projects.get(projectId)?.activeConfigurationRevisionId;
    return revisionId === null || revisionId === undefined
      ? undefined
      : this.configurationRevisions.get(revisionId);
  }

  async findProjectConfigurationRevision(projectId: string, revisionId: string) {
    const revision = this.configurationRevisions.get(revisionId);
    return revision?.projectId === projectId ? revision : undefined;
  }

  async switchProjectConfigurationToManual(input: SwitchProjectConfigurationToManualInput) {
    const revision = await this.insertProjectConfigurationRevision({
      projectId: input.projectId,
      sourceKind: "manual",
      sourceEvidence: {
        kind: "authority-switch",
        formattingPreserved: true,
        bundle: input.bundle,
      },
      rawYaml: input.rawYaml,
      normalizedConfiguration: input.normalizedConfiguration,
      contentHash: input.contentHash,
      createdByUserId: input.userId,
    });
    this.configurationAuthorities.set(input.projectId, "manual");
    this.githubConfigurationSources.delete(input.projectId);
    return this.activateProjectConfigurationRevision(input.projectId, revision.id, input.routes);
  }

  async setProjectGitHubConfigurationSource(
    input: SetProjectGitHubConfigurationSourceInput,
  ): Promise<void> {
    const project = this.projects.get(input.projectId);
    if (project?.status !== "active") throw new Error("project access denied");
    this.configurationAuthorities.set(input.projectId, "github");
    this.githubConfigurationSources.set(input.projectId, {
      githubConnectionId: input.githubConnectionId,
      githubRepositoryId: input.githubRepositoryId,
      githubRepositoryFullName: input.githubRepositoryFullName,
      githubDefaultBranch: input.githubDefaultBranch,
      automaticDeploymentEnabled: input.automaticDeploymentEnabled,
    });
  }

  async recordConfigurationSyncAttempt(
    input: RecordConfigurationSyncAttemptInput,
  ): Promise<ConfigurationSyncAttemptRecord> {
    const attempt: ConfigurationSyncAttemptRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      githubConnectionId: input.githubConnectionId,
      githubRepositoryId: input.githubRepositoryId,
      webhookDeliveryId: input.webhookDeliveryId,
      commitSha: input.commitSha,
      outcome: input.outcome,
      evidence: structuredClone(input.evidence),
      createdAt: this.options.now?.() ?? new Date(),
    };
    const attempts = this.configurationSyncAttempts.get(input.projectId) ?? [];
    attempts.push(attempt);
    this.configurationSyncAttempts.set(input.projectId, attempts);
    return attempt;
  }

  async projectConfigurationReadModel(projectId: string) {
    const authority = this.configurationAuthorities.get(projectId);
    if (authority === undefined) throw new Error("configuration authority not found");
    return {
      authority,
      activeRevision: (await this.findActiveProjectConfiguration(projectId)) ?? null,
      lastSyncAttempt: this.configurationSyncAttempts.get(projectId)?.at(-1) ?? null,
      sourceState:
        authority === "manual"
          ? ({ kind: "manual", formattingPreserved: false } as const)
          : ({
              kind: "github",
              githubConnectionId:
                this.githubConfigurationSources.get(projectId)?.githubConnectionId ?? "unavailable",
              githubRepositoryId:
                this.githubConfigurationSources.get(projectId)?.githubRepositoryId ?? 0,
              githubRepositoryFullName:
                this.githubConfigurationSources.get(projectId)?.githubRepositoryFullName ??
                "unavailable",
              githubDefaultBranch:
                this.githubConfigurationSources.get(projectId)?.githubDefaultBranch ?? "main",
              automaticDeploymentEnabled:
                this.githubConfigurationSources.get(projectId)?.automaticDeploymentEnabled ?? false,
            } as const),
    };
  }

  async getHomeChecklistCompletedAt(organizationId: string): Promise<Date | null> {
    return this.homeChecklistCompletions.get(organizationId) ?? null;
  }

  async completeHomeChecklist(organizationId: string): Promise<Date> {
    if (!this.organizationIds.has(organizationId)) throw new Error("organization is unavailable");
    const completedAt = this.homeChecklistCompletions.get(organizationId) ?? this.now();
    this.homeChecklistCompletions.set(organizationId, completedAt);
    return completedAt;
  }

  async organizationConnectionUsage(organizationId: string): Promise<OrganizationConnectionUsage> {
    return {
      github: Array.from(this.githubConnections.values()).filter(
        (connection) => connection.organizationId === organizationId,
      ),
      discord: Array.from(this.discordConnections.values()).filter(
        (connection) => connection.organizationId === organizationId,
      ),
      slack: Array.from(this.slackConnections.values()).filter(
        (connection) => connection.organizationId === organizationId,
      ),
      linear: Array.from(this.linearConnections.values()).filter(
        (connection) => connection.organizationId === organizationId,
      ),
    };
  }

  async listGitHubRepositories(organizationId: string) {
    return Array.from(this.githubRepositories.values()).filter(
      (repository) => repository.organizationId === organizationId,
    );
  }

  async findGitHubRepositoryForOrganization(organizationId: string, fullName: string) {
    const rows = Array.from(this.githubRepositories.values()).filter(
      (repository) =>
        repository.organizationId === organizationId && repository.fullName === fullName,
    );
    if (rows.length > 1) throw new Error("github repository resource is ambiguous");
    return rows[0];
  }

  private upsertGitHubRepositories(
    organizationId: string,
    connectionId: string,
    repositories: Array<
      Pick<GitHubRepositoryRecord, "repositoryId" | "fullName" | "defaultBranch">
    >,
  ) {
    for (const repository of repositories) {
      const id =
        this.githubRepositories.get(`${connectionId}:${repository.repositoryId}`)?.id ??
        randomUUID();
      this.githubRepositories.set(`${connectionId}:${repository.repositoryId}`, {
        id,
        organizationId,
        connectionId,
        ...repository,
      });
    }
  }

  async findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined> {
    const source = this.githubConfigurationSources.get(projectId);
    if (
      source === undefined ||
      (repositoryId !== undefined && source.githubRepositoryId !== repositoryId)
    ) {
      return undefined;
    }
    const repository = Array.from(this.githubRepositories.values()).find(
      (candidate) =>
        candidate.connectionId === source.githubConnectionId &&
        candidate.repositoryId === source.githubRepositoryId,
    );
    const connection = Array.from(this.githubConnections.values()).find(
      (candidate) => candidate.id === source.githubConnectionId,
    );
    return repository === undefined || connection === undefined
      ? undefined
      : {
          ...repository,
          projectId,
          installationId: connection.installationId,
          automaticDeploymentEnabled: source.automaticDeploymentEnabled,
        };
  }

  async listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]> {
    return Array.from(this.githubConfigurationSources.entries()).flatMap(([projectId, source]) => {
      const project = this.projects.get(projectId);
      if (
        project?.organizationId !== organizationId ||
        project.status !== "active" ||
        source.githubConnectionId !== connectionId ||
        source.githubRepositoryId !== repositoryId
      ) {
        return [];
      }
      const repository = Array.from(this.githubRepositories.values()).find(
        (candidate) =>
          candidate.connectionId === source.githubConnectionId &&
          candidate.repositoryId === source.githubRepositoryId,
      );
      const connection = Array.from(this.githubConnections.values()).find(
        (candidate) => candidate.id === source.githubConnectionId,
      );
      return repository === undefined || connection === undefined
        ? []
        : [
            {
              ...repository,
              projectId,
              installationId: connection.installationId,
              automaticDeploymentEnabled: source.automaticDeploymentEnabled,
            },
          ];
    });
  }

  async listUnroutedProviderEventsForOrganization(organizationId: string) {
    const routedReceiptIds = new Set(
      [...this.triggerRuns.values()].map((run) => run.providerEventReceiptId),
    );
    return [...this.providerEventReceipts.values()]
      .filter(
        (receipt) =>
          receipt.organizationId === organizationId &&
          receipt.droppedReason !== null &&
          isProviderEventDropReasonCode(receipt.droppedReason) &&
          !routedReceiptIds.has(receipt.id),
      )
      .sort(
        (left, right) =>
          right.receivedAt.getTime() - left.receivedAt.getTime() || right.id.localeCompare(left.id),
      )
      .slice(0, 50)
      .map(toProviderEventReceiptRecordSummary);
  }

  async listOrganizationRunsSince(
    organizationId: string,
    since: Date,
    limit: number,
  ): Promise<OrganizationRunRecord[]> {
    return [...this.triggerRuns.values()]
      .filter((run) => run.organizationId === organizationId && run.createdAt >= since)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .flatMap((run) => {
        const receipt = this.providerEventReceipts.get(run.providerEventReceiptId);
        if (receipt === undefined) return [];
        const step = this.listSteps(run.id).find(
          (candidate) => candidate.agentExecutionId !== null,
        );
        const execution =
          step?.agentExecutionId == null
            ? undefined
            : this.agentExecutions.get(step.agentExecutionId);
        const trigger = Array.from(this.organizationTriggers.values()).find(
          ({ runtimeProjectId }) => runtimeProjectId === run.projectId,
        );
        return [
          {
            id: run.id,
            triggerName: trigger?.name ?? run.configuredTriggerName,
            provider: receipt.provider,
            source: receipt.source,
            status: run.status,
            receivedAt: receipt.receivedAt,
            agent:
              run.payloadExpiredAt == null
                ? launchedAgent(execution?.launchIntent?.agent)
                : (launchedAgent(step?.payloadSummary) ?? launchedAgent(execution?.launchAgent)),
            payloadExpiredAt: run.payloadExpiredAt?.toISOString() ?? null,
          },
        ];
      });
  }

  async countUnroutedProviderEventsSince(
    organizationId: string,
    since: Date,
  ): Promise<UnroutedProviderEventCount[]> {
    const routedReceiptIds = new Set(
      [...this.triggerRuns.values()].map((run) => run.providerEventReceiptId),
    );
    const counts = new Map<ProviderEventReceiptRecord["provider"], number>();
    for (const receipt of this.providerEventReceipts.values()) {
      if (
        receipt.organizationId !== organizationId ||
        receipt.receivedAt < since ||
        routedReceiptIds.has(receipt.id) ||
        (receipt.droppedReason !== "no_project_route" &&
          receipt.droppedReason !== "no_trigger_for_source")
      ) {
        continue;
      }
      counts.set(receipt.provider, (counts.get(receipt.provider) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort(
        (left, right) => right.count - left.count || left.provider.localeCompare(right.provider),
      );
  }

  async isOrganizationMember(): Promise<boolean> {
    return false;
  }

  startConnectionAttempt(_input: StartConnectionAttemptInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  findConnectionAttemptConfiguration() {
    return Promise.resolve(undefined);
  }

  readConnectionAttempt(_input: ReadConnectionAttemptInput) {
    return connectionPersistenceUnavailable();
  }

  consumeConnectionAttempt(_input: ReadConnectionAttemptInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  advanceGitHubConnectionAttempt(_input: AdvanceGitHubConnectionAttemptInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  bindGitHubConnection(_input: BindGitHubConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  bindDiscordConnection(_input: BindDiscordConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  bindSlackConnection(_input: BindSlackConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  completeSlackProviderApplication(_input: CompleteSlackProviderApplicationInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  bindLinearConnection(_input: BindLinearConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  completeLinearProviderApplication(_input: CompleteLinearProviderApplicationInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  updateLinearConnectionTokens(_input: UpdateLinearConnectionTokensInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }

  withLinearConnectionRefresh<T>(
    linearOrganizationId: string,
    operation: LinearConnectionRefreshOperation<T>,
  ): Promise<T> {
    return this.withAdvisoryLock(
      JSON.stringify(["paseo-connection", "linear", "external", linearOrganizationId]),
      async () => {
        const connection = this.linearConnections.get(linearOrganizationId);
        return operation(connection, async (input) => {
          const current = this.linearConnections.get(linearOrganizationId);
          if (current === undefined) throw new Error("Linear connection unavailable");
          this.linearConnections.set(linearOrganizationId, { ...current, ...input });
        });
      },
    );
  }

  disconnectConnection(
    _provider: ConnectionProvider,
    _connectionId: string,
    _access: ConnectionStartAuthority,
  ) {
    return connectionPersistenceUnavailable();
  }

  findGitHubConnection(_installationId: number): Promise<GitHubConnectionRecord | undefined> {
    return Promise.resolve(this.githubConnections.get(_installationId));
  }

  findDiscordConnection(_guildId: string): Promise<DiscordConnectionRecord | undefined> {
    return Promise.resolve(this.discordConnections.get(_guildId));
  }

  findSlackConnection(_teamId: string): Promise<SlackConnectionRecord | undefined> {
    return Promise.resolve(this.slackConnections.get(_teamId));
  }

  findLinearConnection(_linearOrganizationId: string): Promise<LinearConnectionRecord | undefined> {
    return Promise.resolve(this.linearConnections.get(_linearOrganizationId));
  }

  findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined> {
    const connection = this.slackConnections.get(teamId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }

  findLinearConnectionForOrganization(
    organizationId: string,
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined> {
    const connection = this.linearConnections.get(linearOrganizationId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }

  findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined> {
    const connection = this.discordConnections.get(guildId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }

  removeDiscordConnection(): Promise<void> {
    return Promise.resolve();
  }

  async close(): Promise<void> {}

  private readAttachment(id: string): AttachmentRecord {
    const attachment = this.attachments.get(id);
    if (attachment === undefined) throw new Error(`attachment not found: ${id}`);
    return attachment;
  }

  private async acceptMemoryEvent(
    input:
      | AcceptGitHubEventInput
      | AcceptDiscordEventInput
      | AcceptSlackEventInput
      | AcceptLinearEventInput,
    organizationId: string | undefined,
    connectionId: string | undefined,
    resourceId: string | null,
    reason: string | undefined,
  ): Promise<ProviderEventAcceptance> {
    const receiptId = this.findReceiptId(organizationId, input.deliveryId, input.signatureHash);
    if (receiptId !== undefined) {
      const receipt = this.providerEventReceipts.get(receiptId);
      if (receipt === undefined) throw new Error("provider receipt unavailable");
      const marked = markedProviderReplay(receipt);
      if (marked !== undefined) return marked;
      if (receipt.droppedReason !== null) {
        return { status: "dropped", receiptId, reason: receipt.droppedReason };
      }
      if (receipt.acceptedRoutes === null) return { status: "duplicate", receiptId };
      return {
        status: "accepted",
        receiptId,
        events: receipt.acceptedRoutes.map((route) => ({
          providerEventReceiptId: receipt.id,
          organizationId: receipt.organizationId,
          projectId: route.projectId,
          configurationRevisionId: route.configurationRevisionId,
          deliveryId: receipt.deliveryId,
          source: receipt.source,
          payload: receipt.payload,
          receivedAt: receipt.receivedAt,
          connectionId: route.connectionId,
          resourceId: route.resourceId,
        })),
      };
    }
    if (organizationId === undefined || connectionId === undefined) {
      return {
        status: "dropped",
        receiptId: input.deliveryId,
        reason: reason ?? "provider_unbound",
      };
    }
    const receipt = this.insertProviderEventReceipt({
      organizationId,
      provider: providerForInput(input),
      connectionId,
      resourceId,
      input,
    });
    if (reason !== undefined) {
      this.providerEventReceipts.set(receipt.id, {
        ...receipt,
        droppedReason: reason,
        preRoutingDrop: preRoutingDropEvidence(reason),
      });
      return {
        status: "dropped",
        receiptId: receipt.id,
        reason,
      };
    }
    const provider = providerForInput(input);
    const routes = Array.from(this.projectTriggerRoutes.entries()).flatMap(
      ([projectId, candidates]) => {
        const project = this.projects.get(projectId);
        return project?.organizationId === organizationId &&
          project.status === "active" &&
          project.activeConfigurationRevisionId !== null
          ? candidates
              .filter(
                (route) =>
                  route.provider === provider &&
                  route.connectionId === connectionId &&
                  (route.resourceId === null || route.resourceId === resourceId),
              )
              .map((route) => Object.assign({}, route, { projectId }))
          : [];
      },
    );
    if (routes.length === 0) {
      this.providerEventReceipts.set(receipt.id, {
        ...receipt,
        droppedReason: "no_project_route",
        preRoutingDrop: "no_project_route",
      });
      return { status: "dropped", receiptId: receipt.id, reason: "no_project_route" };
    }
    const projectRoutes = new Map<string, (typeof routes)[number]>();
    for (const route of routes) {
      if (!projectRoutes.has(route.projectId)) projectRoutes.set(route.projectId, route);
    }

    const events: DurableProviderEvent[] = [...projectRoutes.values()].map((route) => ({
      providerEventReceiptId: receipt.id,
      organizationId,
      projectId: route.projectId,
      configurationRevisionId: this.projects.get(route.projectId)!.activeConfigurationRevisionId!,
      deliveryId: input.deliveryId,
      source: input.source,
      payload: input.payload,
      receivedAt: input.receivedAt,
      connectionId,
      resourceId: route.resourceId,
    }));
    const acceptedRoutes = events.map((event) => ({
      projectId: event.projectId,
      configurationRevisionId: event.configurationRevisionId,
      connectionId: event.connectionId,
      resourceId: event.resourceId,
    }));
    this.providerEventReceipts.set(receipt.id, { ...receipt, acceptedRoutes });
    return { status: "accepted", events, receiptId: receipt.id };
  }

  private findReceiptId(
    organizationId: string | undefined,
    deliveryId: string,
    signatureHash: string | null | undefined,
  ): string | undefined {
    if (organizationId === undefined) return undefined;
    const bySignature =
      signatureHash == null
        ? undefined
        : this.providerEventReceiptIdsBySignature.get(signatureHash);
    if (
      bySignature !== undefined &&
      this.providerEventReceipts.get(bySignature)?.organizationId === organizationId
    )
      return bySignature;
    return this.providerEventReceiptIdsByDelivery.get(
      triggerDeliveryKey(organizationId, deliveryId),
    );
  }

  private insertProviderEventReceipt(input: {
    organizationId: string;
    provider: ProviderEventReceiptRecord["provider"];
    connectionId: string | null;
    resourceId: string | null;
    input: {
      deliveryId: string;
      signatureHash?: string | null;
      providerApplicationId?: string | null;
      providerConfigurationVersion?: number | null;
      source: string;
      repo?: string | null;
      payload: unknown;
      receivedAt: Date;
      dropReason?: string;
    };
  }): ProviderEventReceiptRecord {
    const signature = input.input.signatureHash;
    if (signature != null && this.providerEventReceiptIdsBySignature.has(signature))
      throw new Error("provider receipt unavailable");
    const receipt: ProviderEventReceiptRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      provider: input.provider,
      connectionId: input.connectionId,
      resourceId: input.resourceId,
      deliveryId: input.input.deliveryId,
      signatureHash: input.input.signatureHash ?? null,
      providerApplicationId: input.input.providerApplicationId ?? null,
      providerConfigurationVersion: input.input.providerConfigurationVersion ?? null,
      source: input.input.source,
      repo: input.input.repo ?? null,
      payload: input.input.payload,
      receivedAt: input.input.receivedAt,
      droppedReason: input.input.dropReason ?? null,
      acceptedRoutes: null,
      payloadExpiryState: null,
      payloadExpiredAt: null,
      preRoutingDrop: null,
      manualReplayBinding: null,
    };
    this.providerEventReceipts.set(receipt.id, receipt);
    this.providerEventReceiptIdsByDelivery.set(
      triggerDeliveryKey(receipt.organizationId, receipt.deliveryId),
      receipt.id,
    );
    if (receipt.signatureHash !== null) {
      this.providerEventReceiptIdsBySignature.set(receipt.signatureHash, receipt.id);
    }
    return receipt;
  }

  private readMachine(id: string): MachineRecord {
    const machine = this.machines.get(id);

    if (machine === undefined) {
      throw new Error(`machine not found: ${id}`);
    }

    return machine;
  }

  private readAgentExecution(id: string): AgentExecutionRecord {
    const execution = this.agentExecutions.get(id);

    if (execution === undefined) {
      throw new Error(`agent execution not found: ${id}`);
    }

    return execution;
  }
}

function emptyHubActionAcknowledgements(): AgentExecutionHubAcknowledgements {
  return { terminalAt: null, idleAt: null, finishExecutionCall: null };
}

function connectionPersistenceUnavailable(): never {
  throw new Error("connection persistence requires PostgreSQL");
}

function providerForInput(
  input:
    | AcceptGitHubEventInput
    | AcceptDiscordEventInput
    | AcceptSlackEventInput
    | AcceptLinearEventInput,
): "github" | "discord" | "slack" | "linear" {
  if ("installationId" in input) return "github";
  if ("guildId" in input) return "discord";
  return "teamId" in input ? "slack" : "linear";
}

function githubDropReason(
  input: AcceptGitHubEventInput,
  binding: GitHubConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "github_unbound";
  if (binding.status === "suspended") return "configuration_unavailable";
  return undefined;
}

function discordDropReason(
  input: AcceptDiscordEventInput,
  binding: DiscordConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "discord_unbound";
  return undefined;
}

function slackDropReason(
  input: AcceptSlackEventInput,
  binding: SlackConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "slack_unbound";
  return undefined;
}

function linearDropReason(
  input: AcceptLinearEventInput,
  binding: LinearConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "linear_unbound";
  if (linearConnectionRequiresReauthorization(binding, input.receivedAt)) {
    return "configuration_unavailable";
  }
  return undefined;
}

type MemoryGitHubSync = GitHubLifecycleReceiptClaimInput &
  Pick<
    GitHubSyncPayloadEvidence,
    "id" | "connectionId" | "retryAt" | "settledAt" | "payloadExpiredAt"
  > & { auditLink: GitHubSyncAuditLink | null };

interface MemoryCliAuthorization extends CliAuthorizationRecord {
  deviceVerifier: string;
  userCodeVerifier: string;
  fingerprintVerifier: string;
  nextPollAt: Date;
  credential: { id: string; prefix: string; verifier: string } | null;
}

function workflowDeadlineKind(
  execution: AgentExecutionRecord | undefined,
  step: WorkflowStepRunRecord,
  run: AcceptedTriggerRunRecord,
  observedAt: Date,
): WorkflowDeadlineKind | undefined {
  if (run.status === "running" && run.deadlineAt <= observedAt) return "whole_run";
  const hardDeadline = execution?.deadlineAt ?? step.deadlineAt;
  const idleDeadline = execution?.idleDeadlineAt ?? step.idleDeadlineAt;
  if (hardDeadline !== null && hardDeadline !== undefined && hardDeadline <= observedAt) {
    if (
      idleDeadline !== null &&
      idleDeadline !== undefined &&
      idleDeadline <= observedAt &&
      idleDeadline < hardDeadline
    ) {
      return "step_idle";
    }
    return "step_hard";
  }
  if (idleDeadline !== null && idleDeadline !== undefined && idleDeadline <= observedAt) {
    return "step_idle";
  }
  return undefined;
}

function capIdleDeadline(
  idleDeadlineAt: Date | null | undefined,
  deadlineAt: Date | null,
): Date | null {
  if (idleDeadlineAt === null || idleDeadlineAt === undefined || deadlineAt === null) {
    return idleDeadlineAt ?? null;
  }
  return new Date(Math.min(idleDeadlineAt.getTime(), deadlineAt.getTime()));
}

function isTerminalAgentExecutionStatus(status: AgentExecutionStatus): boolean {
  return status === "succeeded" || status === "failed";
}

function triggerDeliveryKey(organizationId: string, deliveryId: string): string {
  return `${organizationId}:${deliveryId}`;
}

function freezeEvidence<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeEvidence(child);
  return Object.freeze(value);
}

function attachmentSourceKey(
  providerEventReceiptId: string,
  provider: AttachmentProvider,
  sourceId: string,
): string {
  return `${providerEventReceiptId}:${provider}:${sourceId}`;
}

function hasBoundWebhookEvidence(evidence: unknown, id: string): boolean {
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    "triggerId" in evidence &&
    evidence.triggerId === id
  );
}

function scriptCleanupPending(step: WorkflowStepRunRecord): boolean {
  const output = step.output;
  return (
    (step.status === "succeeded" || step.status === "failed" || step.status === "timed_out") &&
    step.agentExecutionId === null &&
    output !== null &&
    typeof output === "object" &&
    (("daemon_id" in output && output.daemon_id != null) || "cleanup" in output)
  );
}

function isOpenTimelineRun(run: TriggerRunRecord | undefined, organizationId: string): boolean {
  return (
    run?.organizationId === organizationId &&
    run.outcome === "accepted" &&
    run.payloadExpiredAt == null
  );
}

function executionTransitionFields(
  input: WorkflowAgentCompletionInput,
): TransitionAgentExecutionFields {
  return {
    result: input.result,
    ...(input.completedByAgent === undefined ? {} : { completedByAgent: input.completedByAgent }),
    ...(input.deadlineCondition === undefined
      ? {}
      : { deadlineCondition: input.deadlineCondition }),
    ...(input.hubAction === undefined ? {} : { hubAction: input.hubAction }),
  };
}

function isRunExecutionUnfinished(execution: AgentExecutionRecord): boolean {
  return (
    !isTerminalAgentExecutionStatus(execution.status) ||
    execution.completedAt === null ||
    (execution.hubAction !== null && execution.hubActionCompletedAt === null) ||
    Object.values(execution.outputDeliveryAttempts).some((attempt) => attempt.status === "pending")
  );
}

function runOrder(run: { createdAt: Date; id: string }) {
  return { micros: BigInt(run.createdAt.getTime()) * 1000n, id: run.id };
}
