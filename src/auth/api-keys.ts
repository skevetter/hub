import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  DatabaseRuntime,
  QueryHandle,
  QueryRow,
  TransactionHandle,
} from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import type { TenantRouteAccess } from "../db/types.js";
import type { OperationScope } from "./operation-auth.js";
import {
  apiKeyActorSchema,
  apiKeyCreateSchema,
  defaultApiKeyActor,
  triggerWebhookKeyRotateSchema,
  type TriggerWebhookKeyCreate,
  apiKeyScopesSchema,
  type ApiKeyIdentityOptions,
  type ApiKeyScope,
  type WebhookSigningAuthentication,
  type WebhookSigningSummary,
} from "./api-key-contract.js";
import { withApiKeySerialization } from "../db/api-key-serialization.js";

import { SigningRequestError, WebhookSecretStore } from "./webhook-secret-store.js";
import type { WebhookSigningSettings } from "./webhook-signatures.js";

const API_KEY_PREFIX = "paseo_pk_";
const API_KEY_PREFIX_LENGTH = 12;
const API_KEY_SECRET_BYTES = 32;

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: readonly ApiKeyScope[];
  actor: string | null;
  allowedTriggers: readonly string[] | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  authentication?: WebhookSigningSummary;
}

export interface CreatedApiKey {
  summary: ApiKeySummary;
  secret: string;
}

export interface CreatedTriggerWebhookKey extends CreatedApiKey {
  actorAllowedByTrigger: boolean;
}

export interface OperationAuthorization {
  user?: { id: string; role: TenantRouteAccess["membership"]["role"] };
  kind: "apiKey" | "cliCredential";
  credentialId: string;
  organizationId: string;
  scopes: readonly OperationScope[];
  actor?: string | null;
  allowedTriggers?: readonly string[] | null;
}

export type OperationAuthorizationResult =
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "authorized"; access: OperationAuthorization };

interface ApiKeyRow extends QueryRow {
  id: string;
  organization_id: string;
  name: string;
  prefix: string;
  verifier: string;
  scopes: string[];
  actor: string | null;
  allowed_triggers: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
  webhook_auth_mode: "hmac" | null;
  webhook_target_trigger_id: string | null;
  current_version_id?: string | null;
  previous_version_id?: string | null;
  previous_accept_until?: Date | null;
}

interface WebhookTarget extends QueryRow {
  name: string;
  from_users: string[] | null;
}

const triggerKeyScope = "webhook_auth_mode is null and scopes = ARRAY['events:send']::text[]";

export class OrganizationApiKeys {
  readonly signing: WebhookSecretStore;

  constructor(
    private readonly pool: DatabaseRuntime,
    private readonly locks: Locks,
    settings?: WebhookSigningSettings,
  ) {
    this.signing = new WebhookSecretStore(pool, locks, settings);
  }

  async reauthorize(
    access: OperationAuthorization,
    requiredScope: OperationScope,
  ): Promise<boolean> {
    if (access.kind !== "apiKey") return false;
    const result = await this.pool.query(
      `select 1 from organization_api_keys
       where id = $1 and organization_id = $2 and revoked_at is null
         and (expires_at is null or expires_at > now())
         and webhook_auth_mode is null and $3 = any(scopes)`,
      [access.credentialId, access.organizationId, requiredScope],
    );
    return result.rowCount === 1;
  }

  create(
    organizationId: string,
    createdByUserId: string,
    name: string,
    scopes: readonly ApiKeyScope[],
  ): Promise<CreatedApiKey> {
    return this.createWith({ organizationId, createdByUserId, name, scopes });
  }

  async createWith(options: {
    organizationId: string;
    createdByUserId: string;
    name: string;
    scopes: readonly ApiKeyScope[];
    client?: QueryHandle;
    identity?: ApiKeyIdentityOptions;
  }): Promise<CreatedApiKey> {
    const { organizationId, createdByUserId, name, scopes } = options;
    const input = apiKeyCreateSchema.parse({
      ...options.identity,
      name,
      scopes: [...new Set(scopes)],
    });
    const client = options.client ?? this.pool;
    const created = await this.insertKey(client, organizationId, createdByUserId, input);
    return { summary: summary(created.row), secret: created.secret };
  }

  async createSigned(options: {
    client: TransactionHandle;
    organizationId: string;
    createdByUserId: string;
    input: ReturnType<typeof apiKeyCreateSchema.parse>;
    authentication: WebhookSigningAuthentication;
  }) {
    const { client, organizationId, createdByUserId, input, authentication } = options;
    this.signing.requireAvailable(organizationId);
    const { name } = await requireWebhookTarget(client, organizationId, {
      id: authentication.targetTriggerId,
    });
    if (
      input.allowedTriggers !== null &&
      (input.allowedTriggers.length !== 1 || input.allowedTriggers[0] !== name)
    ) {
      throw new SigningRequestError(400, "invalid_request");
    }
    const { row } = await this.insertKey(client, organizationId, createdByUserId, {
      ...input,
      allowedTriggers: [name],
      authentication,
    });
    const revealed = await this.signing.createCurrent(
      client,
      organizationId,
      row.id,
      authentication.targetTriggerId,
    );
    return {
      summary: { ...summary(row), authentication: revealed.authentication },
      signingSecret: revealed.signingSecret,
    };
  }

  async createTriggerWebhookKey(
    organizationId: string,
    createdByUserId: string,
    input: TriggerWebhookKeyCreate,
    transaction?: TransactionHandle,
  ): Promise<CreatedTriggerWebhookKey> {
    const create = async (client: TransactionHandle) => {
      await this.locks.withTxLock(client, `trigger-webhook:${organizationId}:${input.triggerName}`);
      const target = await requireWebhookTarget(client, organizationId, {
        name: input.triggerName,
      });
      const actor = input.actor ?? (await defaultTriggerActor(client, createdByUserId));
      return this.insertTriggerWebhookKey(client, {
        organizationId,
        createdByUserId,
        target,
        actor,
      });
    };
    return transaction === undefined ? this.pool.transaction(create) : create(transaction);
  }

  async listTriggerWebhookKeys(
    organizationId: string,
    triggerName: string,
  ): Promise<ApiKeySummary[]> {
    const result = await this.pool.query<ApiKeyRow>(
      `select id, name, prefix, scopes, actor, allowed_triggers, created_at, last_used_at,
              revoked_at, expires_at, webhook_auth_mode
       from organization_api_keys
       where organization_id = $1 and allowed_triggers = ARRAY[$2]::text[] and ${triggerKeyScope}
       order by created_at desc, id desc`,
      [organizationId, triggerName],
    );
    return result.rows.map(summary);
  }

  async rotateTriggerWebhookKey(
    organizationId: string,
    createdByUserId: string,
    keyId: string,
    options: { overlapSeconds?: number | undefined; transaction?: TransactionHandle } = {},
  ): Promise<CreatedTriggerWebhookKey> {
    const parsed = triggerWebhookKeyRotateSchema.safeParse({
      id: keyId,
      overlapSeconds: options.overlapSeconds,
    });
    if (!parsed.success) throw new SigningRequestError(400, "invalid_request");
    const rotate = async (client: TransactionHandle) => {
      await this.locks.withTxLock(client, keyId);
      const prior = await triggerKeyToRotate(client, organizationId, keyId);
      const target = await requireWebhookTarget(client, organizationId, {
        name: prior.triggerName,
      });
      const created = await this.insertTriggerWebhookKey(client, {
        organizationId,
        createdByUserId,
        target,
        actor: prior.actor,
        name: prior.name,
      });
      await client.query(
        `update organization_api_keys set expires_at = now() + $2::int * interval '1 second'
         where id = $1`,
        [keyId, parsed.data.overlapSeconds],
      );
      return created;
    };
    return options.transaction === undefined
      ? this.pool.transaction(rotate)
      : rotate(options.transaction);
  }

  async revokeTriggerWebhookKey(
    organizationId: string,
    input: { id: string; triggerName: string },
    transaction?: TransactionHandle,
  ): Promise<boolean> {
    return this.revoke(organizationId, input.id, transaction, input.triggerName);
  }

  private async insertTriggerWebhookKey(
    client: TransactionHandle,
    options: {
      organizationId: string;
      createdByUserId: string;
      target: WebhookTarget;
      actor: string;
      name?: string;
    },
  ): Promise<CreatedTriggerWebhookKey> {
    const { organizationId, createdByUserId, target, actor } = options;
    const input = apiKeyCreateSchema.safeParse({
      name: options.name ?? `webhook:${target.name}`,
      scopes: ["events:send"],
      actor,
      allowedTriggers: [target.name],
    });
    if (!input.success) throw new SigningRequestError(400, "invalid_request");
    const { row, secret } = await this.insertKey(
      client,
      organizationId,
      createdByUserId,
      input.data,
    );
    return {
      summary: summary(row),
      secret,
      actorAllowedByTrigger:
        target.from_users?.some((user) => user === "*" || user === actor) ?? false,
    };
  }

  private async insertKey(
    client: QueryHandle,
    organizationId: string,
    createdByUserId: string,
    input: ReturnType<typeof apiKeyCreateSchema.parse>,
  ): Promise<{ row: ApiKeyRow; secret: string }> {
    const prefix = `${API_KEY_PREFIX}${randomBytes(9).toString("base64url").slice(0, API_KEY_PREFIX_LENGTH)}`;
    const secret = `${prefix}_${randomBytes(API_KEY_SECRET_BYTES).toString("base64url")}`;
    const result = await client.query<ApiKeyRow>(
      `insert into organization_api_keys
         (id, organization_id, name, prefix, verifier, scopes, created_by_user_id,
          actor, allowed_triggers, webhook_auth_mode, webhook_signature_profile,
          webhook_target_trigger_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning *`,
      [
        randomUUID(),
        organizationId,
        input.name,
        prefix,
        hashSecret(secret),
        input.scopes,
        createdByUserId,
        input.actor,
        input.allowedTriggers,
        input.authentication?.mode ?? null,
        input.authentication?.profile ?? null,
        input.authentication?.targetTriggerId ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("API key was not created");
    return { row, secret };
  }

  async list(organizationId: string): Promise<ApiKeySummary[]> {
    const result = await this.pool.query<ApiKeyRow>(
      `select keys.id, keys.name, keys.prefix, keys.scopes, keys.actor, keys.allowed_triggers,
              keys.created_at, keys.last_used_at, keys.revoked_at, keys.expires_at, keys.webhook_auth_mode,
              keys.webhook_target_trigger_id, current.version_id as current_version_id,
              previous.version_id as previous_version_id, previous.accept_until as previous_accept_until
       from organization_api_keys keys
       left join organization_webhook_secrets current
         on current.api_key_id = keys.id and current.slot = 'current'
       left join organization_webhook_secrets previous
         on previous.api_key_id = keys.id and previous.slot = 'previous'
       where keys.organization_id = $1
       order by keys.created_at desc, keys.id desc`,
      [organizationId],
    );
    return result.rows.map(summary);
  }

  async revoke(
    organizationId: string,
    id: string,
    transactionClient?: TransactionHandle,
    triggerName?: string,
  ): Promise<boolean> {
    const revoke = (client: TransactionHandle) =>
      revokeWithClient(this.locks, client, { organizationId, id, triggerName });
    return withApiKeySerialization(id, () =>
      transactionClient === undefined ? this.pool.transaction(revoke) : revoke(transactionClient),
    );
  }

  async authorize(
    request: Request,
    requiredScope: OperationScope,
  ): Promise<OperationAuthorizationResult> {
    const token = bearerToken(request.headers.get("authorization"));
    const parsed = token === undefined ? undefined : parseApiKey(token);
    if (parsed === undefined) return { status: "unauthorized" };

    const result = await this.pool.query<ApiKeyRow>(
      `select id, organization_id, name, prefix, verifier, scopes,
              actor, allowed_triggers, created_at, last_used_at, revoked_at
       from organization_api_keys
       where prefix = $1 and webhook_auth_mode is null
         and (expires_at is null or expires_at > now())`,
      [parsed.prefix],
    );
    const row = result.rows[0];
    if (row === undefined || row.revoked_at !== null) return { status: "unauthorized" };
    if (!constantTimeSecretMatch(parsed.token, row.verifier)) return { status: "unauthorized" };
    const scopes = apiKeyScopesSchema.parse(row.scopes);
    if (requiredScope === "runs:stop" || !scopes.includes(requiredScope))
      return { status: "forbidden" };
    await this.markUsed(row.id);
    return {
      status: "authorized",
      access: {
        kind: "apiKey",
        credentialId: row.id,
        organizationId: row.organization_id,
        scopes,
        actor: row.actor,
        allowedTriggers: row.allowed_triggers,
      },
    };
  }

  async markUsed(id: string): Promise<void> {
    await this.pool.query(
      `update organization_api_keys
       set last_used_at = now()
       where id = $1 and revoked_at is null
         and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
      [id],
    );
  }
}

async function requireWebhookTarget(
  client: TransactionHandle,
  organizationId: string,
  target: { id: string } | { name: string },
): Promise<WebhookTarget> {
  const lookup = "id" in target ? "trigger.id" : "trigger.name";
  const result = await client.query<WebhookTarget>(
    `select trigger.name, definition->'filters'->'from_users' as from_users
     from organization_triggers trigger
     join projects project on project.id = trigger.runtime_project_id
       and project.organization_id = trigger.organization_id and project.status = 'active'
     join project_configuration_revisions revision
       on revision.id = project.active_configuration_revision_id
     cross join lateral jsonb_array_elements(revision.normalized_configuration->'triggers') definition
     where ${lookup} = $1 and trigger.organization_id = $2 and trigger.enabled
       and revision.source_evidence->>'triggerId' = trigger.id::text
       and definition->>'name' = trigger.name and definition->>'on' = 'manual.run'
     for share of trigger, project`,
    ["id" in target ? target.id : target.name, organizationId],
  );
  const found = result.rows[0];
  if (found === undefined) throw new SigningRequestError(404, "trigger_not_found");
  return found;
}

async function defaultTriggerActor(client: QueryHandle, userId: string): Promise<string> {
  const result = await client.query<{ name: string; email: string }>(
    `select name, email from "user" where id = $1`,
    [userId],
  );
  const user = result.rows[0];
  const actor = [user?.name, user?.email.split("@")[0]]
    .map((value) => defaultApiKeyActor(value ?? ""))
    .find((value) => apiKeyActorSchema.safeParse(value).success);
  if (actor === undefined) throw new SigningRequestError(400, "invalid_request");
  return actor;
}

async function triggerKeyToRotate(client: TransactionHandle, organizationId: string, id: string) {
  const result = await client.query<ApiKeyRow>(
    `select name, actor, allowed_triggers, revoked_at, expires_at
     from organization_api_keys
     where id = $1 and organization_id = $2 and cardinality(allowed_triggers) = 1 and ${triggerKeyScope}
     for update`,
    [id, organizationId],
  );
  const row = result.rows[0];
  const triggerName = row?.allowed_triggers?.[0];
  if (row === undefined || triggerName === undefined || row.actor === null) {
    throw new SigningRequestError(404, "api_key_unavailable");
  }
  if (row.revoked_at !== null || row.expires_at !== null) {
    throw new SigningRequestError(409, "rotation_in_progress");
  }
  return { triggerName, actor: row.actor, name: row.name };
}

async function revokeWithClient(
  locks: Locks,
  client: TransactionHandle,
  input: { organizationId: string; id: string; triggerName: string | undefined },
): Promise<boolean> {
  const { organizationId, id, triggerName } = input;
  await locks.withTxLock(client, id);
  const result = await client.query(
    `update organization_api_keys
     set revoked_at = coalesce(revoked_at, now())
     where id = $1 and organization_id = $2
       and ($3::text is null or (allowed_triggers = ARRAY[$3]::text[] and ${triggerKeyScope}))
     returning id`,
    [id, organizationId, triggerName ?? null],
  );
  if (result.rowCount !== 1) return false;
  await client.query("delete from organization_webhook_secrets where api_key_id = $1", [id]);
  await client.query(
    `update daemon_enrollment_tokens
     set expires_at = least(expires_at, now())
     where issued_by_api_key_id = $1 and organization_id = $2 and consumed_at is null`,
    [id, organizationId],
  );
  return true;
}

function summary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: apiKeyScopesSchema.parse(row.scopes),
    actor: row.actor,
    allowedTriggers: row.allowed_triggers,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    ...(row.webhook_auth_mode === "hmac" && row.webhook_target_trigger_id !== null
      ? {
          authentication: {
            mode: "hmac",
            profile: "github_sha256",
            targetTriggerId: row.webhook_target_trigger_id,
            currentVersionId: row.current_version_id ?? null,
            previousVersionId: row.previous_version_id ?? null,
            previousAcceptUntil: row.previous_accept_until?.toISOString() ?? null,
          },
        }
      : {}),
  };
}

function bearerToken(value: string | null): string | undefined {
  if (value === null || !value.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length);
  return token.length > 0 && token.length <= 200 ? token : undefined;
}

function parseApiKey(token: string): { prefix: string; token: string } | undefined {
  const match = token.match(
    new RegExp(`^(${API_KEY_PREFIX}[A-Za-z0-9_-]{${API_KEY_PREFIX_LENGTH}})_(.+)$`, "u"),
  );
  if (match === null || match[1] === undefined) return undefined;
  return { prefix: match[1], token };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function constantTimeSecretMatch(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "base64url");
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
