import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const dummySecret = "paseo_whsec_" + randomBytes(32).toString("base64url");

export interface WebhookSigningSettings {
  readonly enabled: boolean;
  readonly githubEnabled: boolean;
  readonly organizationIds: ReadonlySet<string>;
  readonly keyring: ReadonlyMap<string, Buffer>;
  readonly activeKeyId: string | undefined;
}

export function readWebhookSigningSettings(
  env: Readonly<Record<string, string | undefined>>,
): WebhookSigningSettings {
  const enabled = flag(env, "PASEO_HUB_WEBHOOK_HMAC_ENABLED");
  const githubEnabled = flag(env, "PASEO_HUB_WEBHOOK_GITHUB_SIGNATURES_ENABLED");
  if (githubEnabled && !enabled) {
    throw new Error(
      "PASEO_HUB_WEBHOOK_GITHUB_SIGNATURES_ENABLED requires PASEO_HUB_WEBHOOK_HMAC_ENABLED.",
    );
  }

  const organizationsName = "PASEO_HUB_WEBHOOK_HMAC_ORGANIZATION_IDS";
  const organizations = parseSetting(env[organizationsName], organizationsName, []);
  if (
    !Array.isArray(organizations) ||
    !organizations.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(id)) ||
    new Set(organizations).size !== organizations.length
  ) {
    throw new Error(`${organizationsName} must be a JSON array of distinct organization ids.`);
  }

  const ringName = "PASEO_HUB_WEBHOOK_HMAC_KEYRING";
  const ring = parseSetting(env[ringName], ringName, {});
  if (ring === null || typeof ring !== "object" || Array.isArray(ring)) {
    throw new Error(`${ringName} must be a JSON object.`);
  }
  const keyring = new Map<string, Buffer>();
  const entries = Object.entries(ring);
  if (entries.length > 2) throw new Error(`${ringName} supports at most two online keys.`);
  for (const [id, value] of entries) {
    const key = typeof value === "string" ? Buffer.from(value, "base64") : null;
    if (!KEY_ID.test(id) || key?.length !== 32 || key.toString("base64") !== value) {
      throw new Error(`${ringName} requires key ids and canonical base64 32-byte keys.`);
    }
    keyring.set(id, key);
  }
  const activeKeyId = env["PASEO_HUB_WEBHOOK_HMAC_ACTIVE_KEY_ID"];
  if (
    (activeKeyId !== undefined && !keyring.has(activeKeyId)) ||
    (enabled && activeKeyId === undefined)
  ) {
    throw new Error("PASEO_HUB_WEBHOOK_HMAC_ACTIVE_KEY_ID must select a configured key.");
  }
  return {
    enabled,
    githubEnabled,
    organizationIds: new Set<string>(organizations),
    keyring,
    activeKeyId,
  };
}

function flag(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false.`);
}

function parseSetting(value: string | undefined, name: string, fallback: unknown): unknown {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

export function deriveSigningSecret(
  master: Buffer,
  masterKeyId: string,
  salt: string,
  organizationId: string,
  apiKeyId: string,
  versionId: string,
): string {
  const decoded = Buffer.from(salt, "base64url");
  if (master.length !== 32 || decoded.length !== 32 || decoded.toString("base64url") !== salt) {
    throw new Error("Invalid webhook signing material");
  }
  const info = JSON.stringify([
    "paseo.webhook.secret",
    1,
    masterKeyId,
    organizationId,
    apiKeyId,
    versionId,
  ]);
  const bytes = new Uint8Array(hkdfSync("sha256", master, decoded, info, 32));
  try {
    return "paseo_whsec_" + Buffer.from(bytes.buffer).toString("base64url");
  } finally {
    bytes.fill(0);
  }
}

export function parseGitHubSignature(header: string | null): Buffer | undefined {
  if (header?.length !== 71 || !/^sha256=[0-9a-f]{64}$/u.test(header)) return undefined;
  return Buffer.from(header.slice(7), "hex");
}

export function verifyGitHubSignature(
  signature: Buffer,
  bytes: Uint8Array,
  current: string,
  previous?: string,
): "current" | "previous" | undefined {
  if (signature.length !== 32) return undefined;
  const currentMatches = timingSafeEqual(
    createHmac("sha256", current).update(bytes).digest(),
    signature,
  );
  const previousMatches = timingSafeEqual(
    createHmac("sha256", previous ?? dummySecret)
      .update(bytes)
      .digest(),
    signature,
  );
  if (currentMatches) return "current";
  if (previous !== undefined && previousMatches) return "previous";
  return undefined;
}

export function githubBodyDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
