import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  DatabaseRuntime,
  QueryHandle,
  QueryRow,
  TransactionHandle,
} from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import {
  apiKeyCreateSchema,
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
  authentication?: WebhookSigningSummary;
}

export interface CreatedApiKey {
  summary: ApiKeySummary;
  secret: string;
}

export interface OperationAuthorization {
  user?: { id: string; role: import("../db/types.js").TenantRouteAccess["membership"]["role"] };
  kind: "apiKey" | "cliCredential";
  credentialId: string;
  organizationId: string;
  scopes: readonly import("./operation-auth.js").OperationScope[];
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
  webhook_auth_mode: "hmac" | null;
  webhook_target_trigger_id: string | null;
  current_version_id?: string | null;
  previous_version_id?: string | null;
  previous_accept_until?: Date | null;
}

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
    requiredScope: import("./operation-auth.js").OperationScope,
  ): Promise<boolean> {
    if (access.kind !== "apiKey") return false;
    const result = await this.pool.query(
      `select 1 from organization_api_keys
       where id = $1 and organization_id = $2 and revoked_at is null
         and webhook_auth_mode is null and $3 = any(scopes)`,
      [access.credentialId, access.organizationId, requiredScope],
    );
    return result.rowCount === 1;
  }

  async create(
    organizationId: string,
    createdByUserId: string,
    name: string,
    scopes: readonly ApiKeyScope[],
    client: QueryHandle = this.pool,
    identity: ApiKeyIdentityOptions = {},
  ): Promise<CreatedApiKey> {
    const input = apiKeyCreateSchema.parse({ ...identity, name, scopes: [...new Set(scopes)] });
    const created = await this.insertKey(client, organizationId, createdByUserId, input);
    return { summary: summary(created.row), secret: created.secret };
  }

  async createSigned(
    client: TransactionHandle,
    organizationId: string,
    createdByUserId: string,
    input: ReturnType<typeof apiKeyCreateSchema.parse>,
    authentication: WebhookSigningAuthentication,
  ) {
    this.signing.requireAvailable(organizationId);
    const targets = await client.query<{ name: string }>(
      `select trigger.name
       from organization_triggers trigger
       join projects project on project.id = trigger.runtime_project_id
         and project.organization_id = trigger.organization_id and project.status = 'active'
       join project_configuration_revisions revision
         on revision.id = project.active_configuration_revision_id
       where trigger.id = $1 and trigger.organization_id = $2 and trigger.enabled
         and revision.source_evidence->>'triggerId' = trigger.id::text
         and revision.normalized_configuration->'triggers' @>
           jsonb_build_array(jsonb_build_object('name', trigger.name, 'on', 'manual.run'))
       for share of trigger, project`,
      [authentication.targetTriggerId, organizationId],
    );
    const name = targets.rows[0]?.name;
    if (name === undefined) throw new SigningRequestError(404, "trigger_not_found");
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
              keys.created_at, keys.last_used_at, keys.revoked_at, keys.webhook_auth_mode,
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
  ): Promise<boolean> {
    return withApiKeySerialization(id, async () => {
      if (transactionClient !== undefined) {
        return revokeWithClient(this.locks, transactionClient, organizationId, id);
      }
      return this.pool.transaction((client) =>
        revokeWithClient(this.locks, client, organizationId, id),
      );
    });
  }

  async authorize(
    request: Request,
    requiredScope: import("./operation-auth.js").OperationScope,
  ): Promise<OperationAuthorizationResult> {
    const token = bearerToken(request.headers.get("authorization"));
    const parsed = token === undefined ? undefined : parseApiKey(token);
    if (parsed === undefined) return { status: "unauthorized" };

    const result = await this.pool.query<ApiKeyRow>(
      `select id, organization_id, name, prefix, verifier, scopes,
              actor, allowed_triggers, created_at, last_used_at, revoked_at
       from organization_api_keys
       where prefix = $1 and webhook_auth_mode is null`,
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

async function revokeWithClient(
  locks: Locks,
  client: TransactionHandle,
  organizationId: string,
  id: string,
): Promise<boolean> {
  await locks.withTxLock(client, id);
  const result = await client.query(
    `update organization_api_keys
     set revoked_at = coalesce(revoked_at, now())
     where id = $1 and organization_id = $2
     returning id`,
    [id, organizationId],
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
