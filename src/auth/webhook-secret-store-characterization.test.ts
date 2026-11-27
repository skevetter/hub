import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebhookSecretStore } from "./webhook-secret-store.js";
import type { DatabaseRuntime, QueryRow, TransactionHandle } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";

const master = Buffer.alloc(32, 1);
const salt = Buffer.alloc(32, 2).toString("base64url");
const body = Buffer.from("fixture");
const key = {
  id: "key",
  organization_id: "org",
  webhook_target_trigger_id: "trigger",
  actor: "sender",
  allowed_triggers: ["trigger"],
  slot: "current",
  version_id: "version",
  master_key_id: "master",
  salt,
  accept_until: null,
  eligible: true,
};

function unused(): never {
  throw new Error("Unexpected database operation");
}

function store(rows: QueryRow[] = []) {
  const transaction: TransactionHandle = {
    query: unused,
    drizzle: unused,
    rollback: unused,
  };
  const database: DatabaseRuntime = {
    query: unused,
    drizzle: unused,
    close: unused,
    migrate: unused,
    transaction: unused,
  };
  const result = { rows, rowCount: rows.length };
  const query = vi.spyOn(transaction, "query").mockResolvedValue(result);
  vi.spyOn(database, "query").mockResolvedValue(result);
  const locks: Locks = {
    withLock: unused,
    withTxLock: unused,
    tryTxLock: unused,
  };
  const instance = new WebhookSecretStore(database, locks, {
    enabled: true,
    githubEnabled: true,
    organizationIds: new Set(["org"]),
    keyring: new Map([["master", master]]),
    activeKeyId: "master",
  });
  return { instance, query, transaction };
}

describe("webhook signing store derivation", () => {
  it("writes the current version with the organization and key in their original positions", async () => {
    const { instance, query, transaction } = store();
    const result = await instance.createCurrent(transaction, "org", "key", "trigger");
    expect(result.signingSecret.startsWith("paseo_whsec_")).toBe(true);
    expect(result.authentication).toEqual({
      mode: "hmac",
      profile: "github_sha256",
      targetTriggerId: "trigger",
      currentVersionId: result.authentication.currentVersionId,
      previousVersionId: null,
      previousAcceptUntil: null,
    });
    expect(query.mock.calls).toHaveLength(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toBe(`insert into organization_webhook_secrets
         (organization_id, api_key_id, slot, version_id, master_key_id, salt)
       values ($1, $2, 'current', $3, $4, $5)`);
    expect(params).toHaveLength(5);
    expect(Array.isArray(params) && params.slice(0, 4)).toEqual([
      "org",
      "key",
      result.authentication.currentVersionId,
      "master",
    ]);
    expect(Array.isArray(params) && typeof params[4]).toBe("string");
  });

  it("matches the legacy derived proof and denies a malformed proof", async () => {
    const { instance } = store([key]);
    const secret = "paseo_whsec_pIDTVUUhAkezxGDiOD-3yuvg73uwNTfDk3y0O1LMe80";
    const proof = createHmac("sha256", secret).update(body).digest();
    expect(await instance.verify("key", proof, body)).toEqual({
      status: "authorized",
      signer: {
        kind: "apiKey",
        credentialId: "key",
        organizationId: "org",
        scopes: ["events:send"],
        actor: "sender",
        allowedTriggers: ["trigger"],
        targetTriggerId: "trigger",
      },
      matchedSlot: "current",
    });
    expect(await instance.verify("key", proof.subarray(1), body)).toEqual({
      status: "unauthorized",
    });
  });
});
