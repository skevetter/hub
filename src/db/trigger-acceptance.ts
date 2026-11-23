import { isExactSyncReceipt } from "../run-payload-retention/auxiliary-receipt-proof.js";
import {
  UNSUPPORTED_LINEAR_RATE_LIMITED,
  readUnsupportedLinearBudget,
  recordUnsupportedLinearAdmission,
  unsupportedLinearWindow,
} from "./unsupported-linear.js";
import type { Locks } from "./runtime/locks/index.js";
import { and, eq, getTableColumns, isNull, or, lte, sql, isNotNull } from "drizzle-orm";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import { ManualRunRejected } from "../triggers/manual/provider.js";
import type { DatabaseRuntime, DrizzleHandle, TransactionHandle } from "./runtime/index.js";
import * as schema from "./schema.js";
import { ConnectionRepository, replaceGitHubRepositories } from "./connections.js";
import {
  markedProviderReplay,
  preRoutingDropEvidence,
  requireManualReceiptReplayBinding,
} from "./receipt-replay.js";
import type {
  BoundWebhookTrigger,
  AcceptDiscordEventInput,
  AcceptGitHubEventInput,
  AcceptLinearEventInput,
  AcceptSlackEventInput,
  GitHubInstallationSyncOwner,
  GitHubInstallationSyncClaim,
  GitHubLifecycleReceiptClaimInput,
  GitHubInstallationSyncResult,
  ManualEventPersistence,
  ManualReceiptReplayTarget,
  PersistManualEventInput,
  ProviderEventAcceptance,
  ProviderEventEvidence,
  ProviderEventReplayMetadata,
  ProviderEventRouteSnapshot,
  ReceiptPreRoutingDrop,
} from "./types.js";

type HubDatabase = DrizzleHandle;
type HubTransaction = DrizzleHandle;

const GITHUB_LIFECYCLE = "github_lifecycle";

export class ProviderEventAcceptanceRepository {
  private readonly database: HubDatabase;
  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
    private readonly connections: ConnectionRepository,
    private readonly unsupportedLinearReceiptsPerHour: number,
  ) {
    this.database = runtime.drizzle();
  }

  acceptGitHub(input: AcceptGitHubEventInput): Promise<ProviderEventAcceptance> {
    return this.acceptProvider("github", input.installationId, input.repositoryId, input);
  }

  acceptDiscord(input: AcceptDiscordEventInput): Promise<ProviderEventAcceptance> {
    return this.acceptProvider("discord", input.guildId, input.guildId, input);
  }

  acceptSlack(input: AcceptSlackEventInput): Promise<ProviderEventAcceptance> {
    return this.acceptProvider("slack", input.teamId, input.teamId, input);
  }

  acceptLinear(input: AcceptLinearEventInput): Promise<ProviderEventAcceptance> {
    return this.acceptProvider("linear", input.linearOrganizationId, input.projectId, input);
  }

  async findMarkedLinearReceipt(
    linearOrganizationId: string,
    deliveryId: string,
    signatureHash: string,
  ): Promise<boolean> {
    const connection = await findLinearReceiptConnection(this.database, linearOrganizationId);
    if (connection === undefined) return false;
    const receipts = schema.providerEventReceipts;
    const [receipt] = await this.database
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(
          receiptIdentity({ deliveryId, signatureHash }, connection.organizationId),
          eq(receipts.provider, "linear"),
          isNotNull(receipts.payloadExpiryState),
        ),
      )
      .limit(1);
    return receipt !== undefined;
  }

  private async acceptProvider(
    provider: "github" | "slack" | "discord" | "linear",
    externalId: number | string,
    resourceId: number | string | undefined,
    input: ProviderEventEvidence,
  ): Promise<ProviderEventAcceptance> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      const connection =
        provider === "linear" && input.dropReason === "unsupported_event"
          ? await findLinearReceiptConnection(transaction, String(externalId))
          : await findConnection(transaction, provider, externalId);
      if (connection === undefined) {
        return { status: "dropped", receiptId: input.deliveryId, reason: `${provider}_unbound` };
      }

      if (provider === "linear" && input.dropReason === "unsupported_event") {
        return this.acceptUnsupportedLinear(runtimeTransaction, connection, input);
      }

      const existing = await findReceipt(transaction, input, connection.organizationId);
      if (existing !== undefined) return replayProviderReceipt(existing);

      const dropReason =
        input.dropReason ??
        ((provider === "github" && "status" in connection && connection.status === "suspended") ||
        (provider === "linear" && linearConnectionUnavailable(connection, input.receivedAt))
          ? "configuration_unavailable"
          : undefined);
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: connection.organizationId,
        provider,
        connectionId: connection.id,
        resourceId: resourceId === undefined ? null : String(resourceId),
        input: dropReason === undefined ? input : { ...input, dropReason },
        preRoutingDrop: preRoutingDropEvidence(dropReason),
      });
      if (!receipt.inserted) {
        return replayProviderReceipt(receipt.existing);
      }
      if (dropReason !== undefined) {
        return { status: "dropped", receiptId: receipt.id, reason: dropReason };
      }

      const routes = await transaction
        .select({
          projectId: schema.projectTriggerRoutes.projectId,
          revisionId: schema.projectTriggerRoutes.configurationRevisionId,
          connectionId: schema.projectTriggerRoutes.connectionId,
          resourceId: schema.projectTriggerRoutes.resourceId,
        })
        .from(schema.projectTriggerRoutes)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.projectTriggerRoutes.projectId),
            eq(schema.projects.organizationId, connection.organizationId),
            eq(schema.projects.status, "active"),
            eq(
              schema.projects.activeConfigurationRevisionId,
              schema.projectTriggerRoutes.configurationRevisionId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.projectTriggerRoutes.organizationId, connection.organizationId),
            eq(schema.projectTriggerRoutes.provider, provider),
            eq(schema.projectTriggerRoutes.connectionId, connection.id),
            or(
              isNull(schema.projectTriggerRoutes.resourceId),
              eq(
                schema.projectTriggerRoutes.resourceId,
                resourceId === undefined ? "" : String(resourceId),
              ),
            ),
          ),
        );

      const selectedRoutes = selectFirstRoutePerProject(routes);
      if (selectedRoutes.length === 0) {
        const reason = "no_project_route";
        await transaction
          .update(schema.providerEventReceipts)
          .set({ droppedReason: reason, preRoutingDrop: reason })
          .where(writableReceipt(receipt.id, connection.organizationId));
        return { status: "dropped", receiptId: receipt.id, reason };
      }

      const acceptedRoutes: ProviderEventRouteSnapshot[] = selectedRoutes.map((route) => ({
        projectId: route.projectId,
        configurationRevisionId: route.revisionId,
        connectionId: route.connectionId,
        resourceId: route.resourceId,
      }));
      await transaction
        .update(schema.providerEventReceipts)
        .set({ acceptedRoutes })
        .where(writableReceipt(receipt.id, connection.organizationId));

      return {
        status: "accepted",
        events: acceptedRoutes.map((route) => ({
          providerEventReceiptId: receipt.id,
          organizationId: connection.organizationId,
          projectId: route.projectId,
          configurationRevisionId: route.configurationRevisionId,
          deliveryId: input.deliveryId,
          source: input.source,
          payload: input.payload,
          receivedAt: input.receivedAt,
          connectionId: route.connectionId,
          resourceId: route.resourceId,
        })),
        receiptId: receipt.id,
      };
    });
  }

  private async acceptUnsupportedLinear(
    runtimeTransaction: TransactionHandle,
    { organizationId, id: connectionId }: { organizationId: string; id: string },
    input: ProviderEventEvidence,
  ): Promise<ProviderEventAcceptance> {
    await this.locks.withTxLock(
      runtimeTransaction,
      JSON.stringify(["unsupported-linear", organizationId]),
    );
    const transaction = runtimeTransaction.drizzle();
    const existing = await findReceipt(transaction, input, organizationId);
    if (existing !== undefined) return replayProviderReceipt(existing);

    const previous = await readUnsupportedLinearBudget(runtimeTransaction, organizationId);
    const window = unsupportedLinearWindow(input.receivedAt, previous);
    if (window.written >= this.unsupportedLinearReceiptsPerHour) {
      return {
        status: "dropped",
        receiptId: input.deliveryId,
        reason: UNSUPPORTED_LINEAR_RATE_LIMITED,
      };
    }
    const receipt = await claimProviderReceipt(transaction, {
      organizationId,
      provider: "linear",
      connectionId,
      resourceId: null,
      input,
      preRoutingDrop: "unsupported_event",
    });
    if (!receipt.inserted) return replayProviderReceipt(receipt.existing);
    await recordUnsupportedLinearAdmission(runtimeTransaction, organizationId, window, previous);
    return { status: "dropped", receiptId: receipt.id, reason: "unsupported_event" };
  }

  persistManual(input: PersistManualEventInput): Promise<ManualEventPersistence> {
    return this.database.transaction(async (transaction) => {
      const binding = input.boundWebhookTrigger;
      const projectQuery = manualProject(transaction, input);
      const boundRevision =
        binding === undefined
          ? undefined
          : await lockBoundWebhookTarget(transaction, input, binding);
      const existing = await findReceipt(transaction, input, input.organizationId);
      if (existing !== undefined) return replayManualReceipt(transaction, input, existing);
      const activeRevision = boundRevision ?? (await projectQuery)[0]?.configurationRevisionId;
      if (activeRevision == null) throw new ManualRunRejected("configuration_not_found");
      const route: ProviderEventRouteSnapshot = {
        projectId: input.projectId,
        configurationRevisionId: activeRevision,
        connectionId: input.connectionId ?? null,
        resourceId: input.resourceId ?? null,
      };
      const receipt = await claimProviderReceipt(transaction, {
        organizationId: input.organizationId,
        provider: "manual",
        connectionId: null,
        resourceId: null,
        input,
      });
      if (!receipt.inserted) {
        return replayManualReceipt(transaction, input, receipt.existing);
      }
      await transaction
        .update(schema.providerEventReceipts)
        .set({ acceptedRoutes: [route], startedByUserId: input.startedByUserId })
        .where(writableReceipt(receipt.id, input.organizationId));
      return {
        status: "accepted",
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
    });
  }

  authorizeSignedReceiptReplay(
    input: ManualReceiptReplayTarget & { organizationId: string; receiptId: string },
  ): Promise<void> {
    return this.database.transaction(async (transaction) => {
      if (input.boundWebhookTrigger === undefined)
        throw new ManualRunRejected("configuration_not_found");
      await lockBoundWebhookTarget(transaction, input, input.boundWebhookTrigger);
      const receipts = schema.providerEventReceipts;
      const [receipt] = await transaction
        .select({
          id: receipts.id,
          provider: receipts.provider,
          source: receipts.source,
          droppedReason: receipts.droppedReason,
          payloadExpiryState: receipts.payloadExpiryState,
          manualReplayBinding: receipts.manualReplayBinding,
        })
        .from(receipts)
        .where(
          and(eq(receipts.id, input.receiptId), eq(receipts.organizationId, input.organizationId)),
        )
        .for("share");
      if (receipt?.payloadExpiryState == null)
        throw new ManualRunRejected("configuration_not_found");
      await validateMarkedManualReceipt(transaction, input, receipt);
    });
  }

  claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubInstallationSyncClaim> {
    return this.database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select()
        .from(schema.githubConnections)
        .where(
          and(
            eq(schema.githubConnections.installationId, input.installationId),
            eq(schema.githubConnections.providerApplicationId, input.providerApplicationId),
          ),
        );
      const [receipt] = await transaction
        .insert(schema.githubInstallationSyncs)
        .values({
          ...input,
          kind: "webhook",
          connectionId: connection?.id ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (receipt === undefined) {
        const [existing] = await transaction
          .select({ id: schema.githubInstallationSyncs.id })
          .from(schema.githubInstallationSyncs)
          .where(
            or(
              eq(schema.githubInstallationSyncs.deliveryId, input.deliveryId),
              eq(schema.githubInstallationSyncs.signatureHash, input.signatureHash),
            ),
          );
        if (existing === undefined) throw new Error("GitHub lifecycle receipt unavailable");
        return { status: "duplicate", installationSyncId: existing.id };
      }
      if (connection !== undefined) await auditGitHubLifecycle(transaction, receipt, connection);
      return {
        status: "claimed",
        installationSyncId: receipt.id,
        installationId: input.installationId,
      };
    });
  }

  applyGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    claim: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
    result: GitHubInstallationSyncResult,
  ): Promise<void> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      await this.locks.withTxLock(
        runtimeTransaction,
        JSON.stringify(["provider-application", "github"]),
      );
      const transaction = runtimeTransaction.drizzle();
      if (!(await githubSyncOwnerActive(transaction, owner))) return;
      const [receipt] = await transaction
        .select()
        .from(schema.githubInstallationSyncs)
        .where(
          and(
            eq(schema.githubInstallationSyncs.id, claim.installationSyncId),
            isNotNull(schema.githubInstallationSyncs.retryAt),
            isNull(schema.githubInstallationSyncs.payloadExpiredAt),
          ),
        )
        .for("update");
      if (
        receipt === undefined ||
        (receipt.providerApplicationId !== null &&
          receipt.providerApplicationId !== owner.providerApplicationId)
      )
        return;
      const [connection] = await transaction
        .select()
        .from(schema.githubConnections)
        .where(
          and(
            eq(schema.githubConnections.installationId, receipt.installationId),
            receipt.connectionId === null
              ? undefined
              : eq(schema.githubConnections.id, receipt.connectionId),
          ),
        )
        .for("update");
      if (
        connection !== undefined &&
        connection.providerApplicationId !== owner.providerApplicationId
      )
        return;
      if (connection === undefined) {
        if (receipt.connectionId !== null) {
          await settleGitHubSync(transaction, receipt, owner, receipt.connectionId);
        } else if (receipt.kind === "webhook" && result.status === "absent") {
          const copies = schema.providerEventReceipts;
          const [copy] = await transaction
            .select({ id: copies.id })
            .from(copies)
            .where(
              or(
                receipt.deliveryId === null ? undefined : eq(copies.deliveryId, receipt.deliveryId),
                receipt.signatureHash === null
                  ? undefined
                  : eq(copies.signatureHash, receipt.signatureHash),
              ),
            )
            .limit(1);
          await settleGitHubSync(transaction, receipt, owner, null, {
            kind: copy === undefined ? "none" : "unproven",
          });
        }
        return;
      }

      const auditLink = await auditGitHubLifecycle(transaction, receipt, connection);
      if (result.status === "absent") {
        if (result.removeBinding) {
          await this.connections.removeGitHubByInstallationInTransaction(
            transaction,
            receipt.installationId,
          );
        }
      } else {
        await transaction
          .update(schema.githubConnections)
          .set({
            accountId: result.identity.accountId,
            accountLogin: result.identity.accountLogin,
            accountType: result.identity.accountType,
            status: result.identity.status,
            suspendedAt: result.identity.status === "suspended" ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(schema.githubConnections.id, connection.id));
        await replaceGitHubRepositories(
          transaction,
          connection.organizationId,
          connection.id,
          result.repositories,
        );
      }
      await settleGitHubSync(transaction, receipt, owner, connection.id, auditLink);
    });
  }

  async pendingGitHubInstallationSyncs(
    owner: GitHubInstallationSyncOwner,
    selected?: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
  ) {
    if (!(await githubSyncOwnerActive(this.database, owner))) return [];
    const rows = await this.database
      .select({
        installationSyncId: schema.githubInstallationSyncs.id,
        installationId: schema.githubInstallationSyncs.installationId,
        source: schema.githubInstallationSyncs.source,
        kind: schema.githubInstallationSyncs.kind,
      })
      .from(schema.githubInstallationSyncs)
      .leftJoin(
        schema.githubConnections,
        eq(schema.githubConnections.installationId, schema.githubInstallationSyncs.installationId),
      )
      .where(
        and(
          selected === undefined
            ? undefined
            : and(
                eq(schema.githubInstallationSyncs.id, selected.installationSyncId),
                eq(schema.githubInstallationSyncs.installationId, selected.installationId),
              ),
          lte(schema.githubInstallationSyncs.retryAt, sql`statement_timestamp()`),
          isNull(schema.githubInstallationSyncs.payloadExpiredAt),
          or(
            eq(schema.githubInstallationSyncs.providerApplicationId, owner.providerApplicationId),
            and(
              eq(schema.githubInstallationSyncs.kind, "reconcile"),
              isNull(schema.githubInstallationSyncs.providerApplicationId),
              eq(schema.githubConnections.providerApplicationId, owner.providerApplicationId),
            ),
          ),
          or(
            eq(schema.githubConnections.providerApplicationId, owner.providerApplicationId),
            isNotNull(schema.githubInstallationSyncs.connectionId),
          ),
        ),
      )
      .orderBy(schema.githubInstallationSyncs.retryAt)
      .limit(20);
    return rows.map((row) => ({
      status: "claimed" as const,
      installationSyncId: row.installationSyncId,
      installationId: row.installationId,
      removeBinding: row.kind === "reconcile" || row.source === "github.installation",
    }));
  }

  async retryGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    installationSyncId: string,
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      await this.locks.withTxLock(
        runtimeTransaction,
        JSON.stringify(["provider-application", "github"]),
      );
      const transaction = runtimeTransaction.drizzle();
      if (!(await githubSyncOwnerActive(transaction, owner))) return;
      await transaction
        .update(schema.githubInstallationSyncs)
        .set({ retryAt: sql`clock_timestamp() + interval '30 seconds'` })
        .where(
          and(
            eq(schema.githubInstallationSyncs.id, installationSyncId),
            isNotNull(schema.githubInstallationSyncs.retryAt),
            isNull(schema.githubInstallationSyncs.payloadExpiredAt),
            or(
              eq(schema.githubInstallationSyncs.providerApplicationId, owner.providerApplicationId),
              and(
                eq(schema.githubInstallationSyncs.kind, "reconcile"),
                isNull(schema.githubInstallationSyncs.providerApplicationId),
                sql`exists (select 1 from github_connections connection
                   where connection.id = ${schema.githubInstallationSyncs.connectionId}
                     and connection.provider_application_id = ${owner.providerApplicationId})`,
              ),
            ),
          ),
        );
    });
  }
}

function linearConnectionUnavailable(connection: object, receivedAt: Date): boolean {
  if (!("scopes" in connection) || !isStringArray(connection.scopes)) return true;
  if (
    !("refreshToken" in connection) ||
    (connection.refreshToken !== null && typeof connection.refreshToken !== "string")
  ) {
    return true;
  }
  if (
    !("accessTokenExpiresAt" in connection) ||
    (connection.accessTokenExpiresAt !== null && !(connection.accessTokenExpiresAt instanceof Date))
  ) {
    return true;
  }
  return linearConnectionRequiresReauthorization(
    {
      scopes: connection.scopes,
      refreshToken: connection.refreshToken,
      accessTokenExpiresAt: connection.accessTokenExpiresAt,
    },
    receivedAt,
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function eventFromReceipt(
  receipt: typeof schema.providerEventReceipts.$inferSelect,
  route: ProviderEventRouteSnapshot,
): import("./types.js").DurableProviderEvent {
  return {
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
  };
}

interface ManualProject {
  organizationId: string;
  projectId: string;
}

function manualProject(transaction: HubTransaction, input: ManualProject) {
  return transaction
    .select({ configurationRevisionId: schema.projects.activeConfigurationRevisionId })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.organizationId, input.organizationId),
        eq(schema.projects.status, "active"),
      ),
    );
}

async function lockBoundWebhookTarget(
  transaction: HubTransaction,
  input: ManualProject,
  binding: BoundWebhookTrigger,
): Promise<string> {
  const triggers = schema.organizationTriggers;
  const [trigger] = await transaction
    .select({ id: triggers.id })
    .from(triggers)
    .where(
      and(
        eq(triggers.id, binding.id),
        eq(triggers.name, binding.name),
        eq(triggers.organizationId, input.organizationId),
        eq(triggers.runtimeProjectId, input.projectId),
        eq(triggers.enabled, true),
      ),
    )
    .for("share");
  if (trigger === undefined) throw new ManualRunRejected("configuration_not_found");
  const [project] = await manualProject(transaction, input).for("share");
  if (project?.configurationRevisionId !== binding.configurationRevisionId) {
    throw new ManualRunRejected("configuration_not_found");
  }
  await assertBoundRevision(
    transaction,
    input.organizationId,
    input.projectId,
    binding.id,
    binding.configurationRevisionId,
  );
  return binding.configurationRevisionId;
}

async function assertBoundReceipt(
  transaction: HubTransaction,
  input: PersistManualEventInput,
  route: ProviderEventRouteSnapshot,
  triggerId: string,
): Promise<void> {
  if (route.projectId !== input.projectId) throw new ManualRunRejected("configuration_not_found");
  return assertBoundRevision(
    transaction,
    input.organizationId,
    input.projectId,
    triggerId,
    route.configurationRevisionId,
  );
}

async function assertBoundRevision(
  transaction: HubTransaction,
  organizationId: string,
  projectId: string,
  triggerId: string,
  revisionId: string,
): Promise<void> {
  const revisions = schema.projectConfigurationRevisions;
  const [revision] = await transaction
    .select({ id: revisions.id })
    .from(revisions)
    .where(
      and(
        eq(revisions.id, revisionId),
        eq(revisions.projectId, projectId),
        eq(revisions.organizationId, organizationId),
        sql`${revisions.sourceEvidence}->>'triggerId' = ${triggerId}`,
      ),
    );
  if (revision === undefined) throw new ManualRunRejected("configuration_not_found");
}

async function findReceipt(
  transaction: HubTransaction,
  input: ProviderEventEvidence,
  organizationId: string,
) {
  const receipts = schema.providerEventReceipts;
  const [receipt] = await transaction
    .select({
      ...getTableColumns(receipts),
      payload: sql<unknown>`case when ${receipts.payloadExpiryState} is null then ${receipts.payload} end`,
      acceptedRoutes: sql<unknown>`case when ${receipts.payloadExpiryState} is null then ${receipts.acceptedRoutes} end`,
    })
    .from(receipts)
    .where(receiptIdentity(input, organizationId))
    .limit(1);
  return receipt;
}

function receiptIdentity(
  input: Pick<ProviderEventEvidence, "deliveryId" | "signatureHash">,
  organizationId: string,
) {
  const receipts = schema.providerEventReceipts;
  const delivery = eq(receipts.deliveryId, input.deliveryId);
  return and(
    eq(receipts.organizationId, organizationId),
    input.signatureHash == null
      ? delivery
      : or(delivery, eq(receipts.signatureHash, input.signatureHash)),
  );
}

function writableReceipt(id: string, organizationId: string) {
  const receipts = schema.providerEventReceipts;
  return and(
    eq(receipts.id, id),
    eq(receipts.organizationId, organizationId),
    isNull(receipts.payloadExpiryState),
  );
}

async function replayManualReceipt(
  transaction: HubTransaction,
  input: PersistManualEventInput,
  receipt: typeof schema.providerEventReceipts.$inferSelect,
): Promise<ManualEventPersistence> {
  const duplicate = {
    status: "duplicate",
    providerEventReceiptId: receipt.id,
    replayed: true,
  } as const;
  if (receipt.payloadExpiryState !== null) {
    if (input.publicTriggerName !== undefined || input.boundWebhookTrigger !== undefined)
      await validateMarkedManualReceipt(transaction, input, receipt);
    return { ...duplicate, payloadExpiryState: receipt.payloadExpiryState };
  }
  const route = parseAcceptedRoutes(receipt.acceptedRoutes)?.[0];
  if (route === undefined) return duplicate;
  if (input.boundWebhookTrigger !== undefined)
    await assertBoundReceipt(transaction, input, route, input.boundWebhookTrigger.id);
  return { status: "accepted", replayed: true, event: eventFromReceipt(receipt, route) };
}

async function validateMarkedManualReceipt(
  transaction: HubTransaction,
  input: ManualReceiptReplayTarget & ManualProject,
  receipt: ProviderEventReplayMetadata,
): Promise<void> {
  const binding = requireManualReceiptReplayBinding(receipt, input);
  if (binding.triggerId !== null) {
    await assertBoundRevision(
      transaction,
      input.organizationId,
      binding.projectId,
      binding.triggerId,
      binding.configurationRevisionId,
    );
  }
}

function replayProviderReceipt(
  receipt: typeof schema.providerEventReceipts.$inferSelect,
): ProviderEventAcceptance {
  const marked = markedProviderReplay(receipt);
  if (marked !== undefined) return marked;
  if (receipt.droppedReason !== null) {
    return { status: "dropped", receiptId: receipt.id, reason: receipt.droppedReason };
  }
  const routes = parseAcceptedRoutes(receipt.acceptedRoutes);
  if (routes === null) return { status: "duplicate", receiptId: receipt.id };
  return {
    status: "accepted",
    receiptId: receipt.id,
    events: routes.map((route) => ({
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

function parseAcceptedRoutes(value: unknown): ProviderEventRouteSnapshot[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error("invalid accepted provider routes");
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("invalid accepted provider route");
    const projectId = candidate["projectId"];
    const configurationRevisionId = candidate["configurationRevisionId"];
    const connectionId = candidate["connectionId"];
    const resourceId = candidate["resourceId"];
    if (
      typeof projectId !== "string" ||
      typeof configurationRevisionId !== "string" ||
      (connectionId !== null && typeof connectionId !== "string") ||
      (resourceId !== null && typeof resourceId !== "string")
    ) {
      throw new Error("invalid accepted provider route");
    }
    return { projectId, configurationRevisionId, connectionId, resourceId };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectFirstRoutePerProject<Route extends { projectId: string }>(
  routes: readonly Route[],
): Route[] {
  const selected = new Map<string, Route>();
  for (const route of routes) {
    if (!selected.has(route.projectId)) selected.set(route.projectId, route);
  }
  return [...selected.values()];
}

async function findLinearReceiptConnection(database: DrizzleHandle, workspaceId: string) {
  const [row] = await database
    .select({
      id: schema.linearConnections.id,
      organizationId: schema.linearConnections.organizationId,
    })
    .from(schema.linearConnections)
    .where(eq(schema.linearConnections.linearOrganizationId, workspaceId))
    .limit(1);
  return row;
}

async function findConnection(
  transaction: HubTransaction,
  provider: "github" | "slack" | "discord" | "linear",
  externalId: number | string,
) {
  if (provider === "github") {
    const [row] = await transaction
      .select({
        id: schema.githubConnections.id,
        organizationId: schema.githubConnections.organizationId,
        status: schema.githubConnections.status,
      })
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.installationId, Number(externalId)))
      .limit(1);
    return row;
  }
  if (provider === "slack") {
    const [row] = await transaction
      .select({
        id: schema.slackConnections.id,
        organizationId: schema.slackConnections.organizationId,
      })
      .from(schema.slackConnections)
      .where(eq(schema.slackConnections.teamId, String(externalId)))
      .limit(1);
    return row;
  }
  if (provider === "linear") {
    const [row] = await transaction
      .select({
        id: schema.linearConnections.id,
        organizationId: schema.linearConnections.organizationId,
        scopes: schema.linearConnections.scopes,
        refreshToken: schema.linearConnections.refreshToken,
        accessTokenExpiresAt: schema.linearConnections.accessTokenExpiresAt,
      })
      .from(schema.linearConnections)
      .where(eq(schema.linearConnections.linearOrganizationId, String(externalId)))
      .limit(1);
    return row;
  }
  const [row] = await transaction
    .select({
      id: schema.discordConnections.id,
      organizationId: schema.discordConnections.organizationId,
    })
    .from(schema.discordConnections)
    .where(eq(schema.discordConnections.guildId, String(externalId)))
    .limit(1);
  return row;
}

async function claimProviderReceipt(
  transaction: HubTransaction,
  input: {
    organizationId: string;
    provider: "github" | "slack" | "discord" | "linear" | "manual";
    connectionId: string | null;
    resourceId: string | null;
    input: ProviderEventEvidence;
    preRoutingDrop?: ReceiptPreRoutingDrop | null;
  },
): Promise<
  | { id: string; inserted: true }
  | { id: string; inserted: false; existing: typeof schema.providerEventReceipts.$inferSelect }
> {
  const [receipt] = await transaction
    .insert(schema.providerEventReceipts)
    .values({
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
      preRoutingDrop: input.preRoutingDrop ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.providerEventReceipts.id });
  if (receipt !== undefined) return { id: receipt.id, inserted: true };

  const existing = await findReceipt(transaction, input.input, input.organizationId);
  if (existing === undefined) throw new Error("provider receipt unavailable");
  return { id: existing.id, inserted: false, existing };
}

async function auditGitHubLifecycle(
  transaction: HubTransaction,
  receipt: typeof schema.githubInstallationSyncs.$inferSelect,
  connection: typeof schema.githubConnections.$inferSelect,
): Promise<schema.GitHubSyncAuditLink | undefined> {
  if (receipt.kind === "reconcile") return undefined;
  if (
    receipt.deliveryId === null ||
    receipt.signatureHash === null ||
    receipt.source === null ||
    receipt.providerApplicationId === null
  )
    throw new Error("GitHub webhook receipt evidence unavailable");
  const audit = await claimProviderReceipt(transaction, {
    organizationId: connection.organizationId,
    provider: "github",
    connectionId: connection.id,
    resourceId: null,
    input: {
      providerApplicationId: receipt.providerApplicationId,
      deliveryId: receipt.deliveryId,
      signatureHash: receipt.signatureHash,
      source: receipt.source,
      payload: receipt.payload,
      receivedAt: receipt.receivedAt,
      dropReason: GITHUB_LIFECYCLE,
    },
  });
  if (audit.inserted)
    return { kind: "receipt", receiptId: audit.id, organizationId: connection.organizationId };

  const copies = schema.providerEventReceipts;
  const [copy] = await transaction
    .select({
      id: copies.id,
      organizationId: copies.organizationId,
      provider: copies.provider,
      source: copies.source,
      connectionId: copies.connectionId,
      resourceId: copies.resourceId,
      providerApplicationId: copies.providerApplicationId,
      deliveryId: copies.deliveryId,
      signatureHash: copies.signatureHash,
      receivedAt: copies.receivedAt,
      droppedReason: copies.droppedReason,
      acceptedRoutes: copies.acceptedRoutes,
      payloadExpiryState: copies.payloadExpiryState,
    })
    .from(copies)
    .where(and(eq(copies.id, audit.id), eq(copies.organizationId, connection.organizationId)))
    .for("share");
  return copy !== undefined &&
    isExactSyncReceipt({ ...receipt, connectionId: connection.id }, copy, connection.organizationId)
    ? { kind: "receipt", receiptId: copy.id, organizationId: copy.organizationId }
    : { kind: "unproven" };
}

async function settleGitHubSync(
  transaction: HubTransaction,
  sync: typeof schema.githubInstallationSyncs.$inferSelect,
  owner: GitHubInstallationSyncOwner,
  connectionId: string | null,
  auditLink?: schema.GitHubSyncAuditLink,
) {
  const syncs = schema.githubInstallationSyncs;
  await transaction
    .update(syncs)
    .set({
      retryAt: null,
      connectionId,
      providerApplicationId: owner.providerApplicationId,
      ...(auditLink === undefined ? {} : { settledAt: sql`clock_timestamp()`, auditLink }),
    })
    .where(and(eq(syncs.id, sync.id), isNotNull(syncs.retryAt), isNull(syncs.payloadExpiredAt)));
}

async function githubSyncOwnerActive(
  database: DrizzleHandle,
  owner: GitHubInstallationSyncOwner,
): Promise<boolean> {
  const [activation] = await database
    .select({ provider: schema.runtimeProviderActivations.provider })
    .from(schema.runtimeProviderActivations)
    .where(
      and(
        eq(schema.runtimeProviderActivations.provider, "github"),
        eq(schema.runtimeProviderActivations.providerApplicationId, owner.providerApplicationId),
        eq(schema.runtimeProviderActivations.configurationVersion, owner.configurationVersion),
      ),
    );
  return activation !== undefined;
}
