import { randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import type {
  DatabaseRuntime,
  QueryHandle,
  QueryRow,
  QueryResult,
  TransactionHandle,
} from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import { withApiKeySerialization } from "../db/api-key-serialization.js";
import {
  type retireSigningSecretSchema,
  type rotateSigningSecretSchema,
  type WebhookSigningSummary,
} from "./api-key-contract.js";
import {
  deriveSigningSecret,
  readWebhookSigningSettings,
  verifyGitHubSignature,
  type WebhookSigningSettings,
} from "./webhook-signatures.js";
import type { OperationAuthorization } from "./api-keys.js";

interface SigningKey extends QueryRow {
  id: string;
  organization_id: string;
  webhook_target_trigger_id: string;
  actor: string;
  allowed_triggers: [string];
}

interface VersionRow extends QueryRow {
  slot: "current" | "previous";
  version_id: string;
  master_key_id: string;
  salt: string;
  accept_until: Date | null;
  eligible: boolean;
}

export type WebhookSigner = OperationAuthorization & { targetTriggerId: string };
export type SigningAvailability = "enabled" | "disabled" | "unavailable";
export type SigningVerification =
  | { status: "unauthorized" }
  | { status: "authorized"; signer: WebhookSigner; matchedSlot: "current" | "previous" };

export interface RevealedSigningSecret {
  signingSecret: string;
  authentication: WebhookSigningSummary;
}

export class SigningRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const keyColumns = "id, organization_id, webhook_target_trigger_id, actor, allowed_triggers";
const signedKey =
  "webhook_auth_mode = 'hmac' and webhook_signature_profile = 'github_sha256' and revoked_at is null";

const secretColumns = `secret.slot, secret.version_id, secret.master_key_id, secret.salt, secret.accept_until,
  (secret.accept_until is null or secret.accept_until > clock_timestamp()) as eligible`;
const secretJoin = `left join organization_webhook_secrets secret on secret.api_key_id = keys.id
  and secret.organization_id = keys.organization_id`;

export class WebhookSecretStore {
  private healthy = true;

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly locks: Locks,
    private readonly settings: WebhookSigningSettings = readWebhookSigningSettings({}),
  ) {}

  availability(organizationId?: string): SigningAvailability {
    if (
      !this.settings.enabled ||
      !this.settings.githubEnabled ||
      this.settings.organizationIds.size === 0 ||
      (organizationId !== undefined && !this.settings.organizationIds.has(organizationId))
    ) {
      return "disabled";
    }
    return this.healthy ? "enabled" : "unavailable";
  }

  requireAvailable(organizationId: string): void {
    const state = this.availability(organizationId);
    if (state === "disabled")
      throw new SigningRequestError(403, "signature_authentication_disabled");
    if (state === "unavailable") throw unavailable();
  }

  async checkReadiness(): Promise<void> {
    if (this.availability() === "disabled") return;
    let after: string | null = null;
    while (true) {
      const result: QueryResult<SigningKey & Partial<VersionRow>> = await this.database.query(
        `with keys as (
           select ${keyColumns} from organization_api_keys
           where ${signedKey} and organization_id = any($1::text[])
             and ($2::uuid is null or id > $2) order by id limit 100
         )
         select keys.*, ${secretColumns} from keys ${secretJoin} order by keys.id`,
        [[...this.settings.organizationIds], after],
      );
      const batch = new Map<string, { key: SigningKey; slots: VersionRow[] }>();
      for (const key of result.rows) {
        let entry = batch.get(key.id);
        if (entry === undefined) {
          entry = { key, slots: [] };
          batch.set(key.id, entry);
        }
        if (hasVersion(key)) entry.slots.push(key);
      }
      for (const { key, slots } of batch.values()) this.secrets(key, slots);
      const last = result.rows.at(-1);
      if (last === undefined || batch.size < 100) return;
      after = last.id;
    }
  }

  async findSigner(id: string): Promise<WebhookSigner | undefined> {
    const key = await this.findKey(this.database, id);
    return key === undefined ? undefined : signer(key);
  }

  async verify(id: string, signature: Buffer, bytes: Uint8Array): Promise<SigningVerification> {
    const result = await this.database.query<SigningKey & Partial<VersionRow>>(
      `select keys.id, keys.organization_id, keys.webhook_target_trigger_id, keys.actor,
              keys.allowed_triggers, ${secretColumns}
       from organization_api_keys keys ${secretJoin}
       where keys.id = $1 and keys.organization_id = any($2::text[]) and ${signedKey}`,
      [id, [...this.settings.organizationIds]],
    );
    const key = result.rows[0];
    if (key === undefined || this.availability(key.organization_id) === "disabled") {
      return { status: "unauthorized" };
    }
    this.requireAvailable(key.organization_id);
    const [current, previous] = this.secrets(key, result.rows.filter(hasVersion));
    const matchedSlot = verifyGitHubSignature(signature, bytes, current, previous);
    return matchedSlot === undefined
      ? { status: "unauthorized" }
      : { status: "authorized", signer: signer(key), matchedSlot };
  }

  async createCurrent(
    transaction: TransactionHandle,
    organizationId: string,
    id: string,
    targetTriggerId: string,
  ): Promise<RevealedSigningSecret> {
    this.requireAvailable(organizationId);
    const masterKeyId = this.settings.activeKeyId;
    const master = masterKeyId === undefined ? undefined : this.settings.keyring.get(masterKeyId);
    if (masterKeyId === undefined || master === undefined) throw unavailable();
    const versionId = randomUUID();
    const salt = randomBytes(32).toString("base64url");
    const signingSecret = deriveSigningSecret(
      master,
      masterKeyId,
      salt,
      organizationId,
      id,
      versionId,
    );
    await transaction.query(
      `insert into organization_webhook_secrets
         (organization_id, api_key_id, slot, version_id, master_key_id, salt)
       values ($1, $2, 'current', $3, $4, $5)`,
      [organizationId, id, versionId, masterKeyId, salt],
    );
    return {
      signingSecret,
      authentication: {
        mode: "hmac",
        profile: "github_sha256",
        targetTriggerId,
        currentVersionId: versionId,
        previousVersionId: null,
        previousAcceptUntil: null,
      },
    };
  }

  rotate(
    transaction: TransactionHandle,
    organizationId: string,
    input: z.infer<typeof rotateSigningSecretSchema>,
  ): Promise<RevealedSigningSecret> {
    return this.change(transaction, organizationId, input.id, async (key, slots) => {
      const current = slots.find(({ slot }) => slot === "current");
      const previous = slots.find(({ slot, eligible }) => slot === "previous" && eligible);
      if (current?.version_id !== input.expectedCurrentVersionId) throw staleVersion();
      if (previous !== undefined) throw new SigningRequestError(409, "rotation_in_progress");
      await transaction.query(
        `delete from organization_webhook_secrets
         where api_key_id = $1 and (slot = 'previous' or $2::integer = 0)`,
        [key.id, input.overlapSeconds],
      );
      const moved = await transaction.query<Pick<VersionRow, "accept_until">>(
        `update organization_webhook_secrets
         set slot = 'previous', accept_until = clock_timestamp() + $2::integer * interval '1 second'
         where api_key_id = $1 and slot = 'current' returning accept_until`,
        [key.id, input.overlapSeconds],
      );
      const result = await this.createCurrent(
        transaction,
        organizationId,
        key.id,
        key.webhook_target_trigger_id,
      );
      const deadline = moved.rows[0]?.accept_until;
      if (deadline != null) {
        result.authentication.previousVersionId = current.version_id;
        result.authentication.previousAcceptUntil = deadline.toISOString();
      }
      return result;
    });
  }

  retire(
    transaction: TransactionHandle,
    organizationId: string,
    input: z.infer<typeof retireSigningSecretSchema>,
  ): Promise<void> {
    return this.change(transaction, organizationId, input.id, async (key) => {
      const result = await transaction.query(
        `delete from organization_webhook_secrets
         where api_key_id = $1 and slot = 'previous' and version_id = $2`,
        [key.id, input.expectedPreviousVersionId],
      );
      if (result.rowCount !== 1) throw staleVersion();
    });
  }

  private async change<T>(
    transaction: TransactionHandle,
    organizationId: string,
    id: string,
    operation: (key: SigningKey, slots: VersionRow[]) => Promise<T>,
  ): Promise<T> {
    this.requireAvailable(organizationId);
    return withApiKeySerialization(id, async () => {
      await this.locks.withTxLock(transaction, id);
      const result = await transaction.query<SigningKey>(
        `select ${keyColumns} from organization_api_keys
         where id = $1 and organization_id = $2 and ${signedKey} for update`,
        [id, organizationId],
      );
      const key = result.rows[0];
      if (key === undefined) throw new SigningRequestError(404, "api_key_unavailable");
      return operation(key, await versions(transaction, key.id));
    });
  }

  private async findKey(database: QueryHandle, id: string): Promise<SigningKey | undefined> {
    const result = await database.query<SigningKey>(
      `select ${keyColumns} from organization_api_keys
       where id = $1 and organization_id = any($2::text[]) and ${signedKey}`,
      [id, [...this.settings.organizationIds]],
    );
    return result.rows[0];
  }

  private secrets(key: SigningKey, slots: VersionRow[]): [string, string?] {
    try {
      const current = slots.find(({ slot }) => slot === "current");
      if (current === undefined) throw unavailable();
      const previous = slots.find(({ slot, eligible }) => slot === "previous" && eligible);
      const derive = (version: VersionRow) => {
        const master = this.settings.keyring.get(version.master_key_id);
        if (master === undefined) throw unavailable();
        return deriveSigningSecret(
          master,
          version.master_key_id,
          version.salt,
          key.organization_id,
          key.id,
          version.version_id,
        );
      };
      return previous === undefined ? [derive(current)] : [derive(current), derive(previous)];
    } catch {
      this.healthy = false;
      throw unavailable();
    }
  }
}

async function versions(database: QueryHandle, id: string): Promise<VersionRow[]> {
  const rows = await database.query<VersionRow>(
    `select slot, version_id, master_key_id, salt, accept_until,
            (accept_until is null or accept_until > clock_timestamp()) as eligible
     from organization_webhook_secrets where api_key_id = $1`,
    [id],
  );
  return rows.rows;
}

function hasVersion(row: SigningKey & Partial<VersionRow>): row is SigningKey & VersionRow {
  return row.slot === "current" || row.slot === "previous";
}

function signer(key: SigningKey): WebhookSigner {
  return {
    kind: "apiKey",
    credentialId: key.id,
    organizationId: key.organization_id,
    scopes: ["events:send"],
    actor: key.actor,
    allowedTriggers: key.allowed_triggers,
    targetTriggerId: key.webhook_target_trigger_id,
  };
}

function unavailable(): SigningRequestError {
  return new SigningRequestError(503, "authentication_unavailable");
}

function staleVersion(): SigningRequestError {
  return new SigningRequestError(409, "signing_version_changed");
}
