import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { OrganizationTriggerRecord } from "../db/types.js";
import { createDatabasePublicOperationRepository } from "./database-adapter.js";

const now = new Date("2026-01-01");
const trigger = {
  id: "trigger",
  name: "run",
  enabled: true,
  organizationId: "org",
  format: "single_run",
  runtimeProjectId: "runtime",
  activeRevisionId: "revision",
  createdAt: now,
  updatedAt: now,
} satisfies OrganizationTriggerRecord;

it("resolves enabled webhooks and prefers organization triggers over fallback projects", async () => {
  const database = createMemoryDatabase({ organizationIds: ["org"] });
  const project = await database.createProject({
    organizationId: "org",
    slug: "default",
    name: "Default",
    createdByUserId: null,
  });
  const trace: string[] = [];
  let enabled = true;
  database.listOrganizationTriggers = async (organizationId) => {
    trace.push(organizationId);
    return [{ ...trigger, enabled }];
  };
  const repo = createDatabasePublicOperationRepository(database);
  expect(JSON.stringify(await repo.resolveWebhookProject("org", "run"))).toBe(
    '{"id":"runtime","triggerId":"trigger"}',
  );
  expect(JSON.stringify(await repo.resolveManualRunProject("org", "run", "default"))).toBe(
    '{"status":"resolved","id":"runtime"}',
  );
  enabled = false;
  expect(await repo.resolveWebhookProject("org", "run")).toBe(undefined);
  expect(await repo.resolveManualRunProject("org", "run", "default")).toEqual({
    status: "disabled",
  });
  expect(await repo.resolveManualRunProject("org", "legacy", "default")).toEqual({
    status: "resolved",
    id: project.id,
  });
  expect(await repo.resolveManualRunProject("org", "legacy", "absent")).toBe(undefined);
  expect(trace).toEqual(Array.from({ length: 6 }, () => "org"));
});

it("stores the hashed enrollment verifier with the correct ordered issuer fields", async () => {
  const database = createMemoryDatabase();
  const writes: Parameters<typeof database.issueEnrollmentToken>[0][] = [];
  database.issueEnrollmentToken = async (input) => {
    writes.push(input);
    return writes.length === 1;
  };
  const repo = createDatabasePublicOperationRepository(database);
  const input = { token: "example", expiresAt: now };
  const scope = { organizationId: "org", credentialId: "issuer", scopes: [] };
  expect(await repo.issueEnrollmentToken({ ...scope, kind: "apiKey" }, input)).toBe("issued");
  expect(await repo.issueEnrollmentToken({ ...scope, kind: "cliCredential" }, input)).toBe(
    "credential_revoked",
  );
  const fields = ["id", "verifier", "organizationId"];
  expect(writes.map(Object.keys)).toEqual([
    [...fields, "issuedByApiKeyId", "expiresAt", "consumedAt"],
    [...fields, "issuedByCliCredentialId", "expiresAt", "consumedAt"],
  ]);
  const verifier = createHash("sha256").update(input.token).digest("base64url");
  expect(writes.map((row) => row.verifier)).toEqual([verifier, verifier]);
  expect(writes[0]?.issuedByApiKeyId).toBe("issuer");
  expect(writes[1]?.issuedByCliCredentialId).toBe("issuer");
});
