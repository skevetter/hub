import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OrganizationApiKeys } from "../auth/api-keys.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { DatabaseUnavailableError } from "../db/errors.js";
import { embeddedLocks } from "../db/runtime/locks/index.js";
import type { PublicAuthorization, PublicOperations } from "../public-operations/index.js";
import { DEFAULT_WEBHOOK_OPTIONS } from "../webhook-config.js";
import { createPublicApi, publicOperationManifest, type PublicOperationId } from "./index.js";

type Results = {
  [K in keyof PublicOperations]-?: readonly Awaited<ReturnType<NonNullable<PublicOperations[K]>>>[];
};

const id = "84af3583-23ff-4fcc-9838-ed3262499be2";
const otherId = "f83dc934-02a0-4849-8de7-699110be24ed";
const access = {
  kind: "apiKey",
  credentialId: id,
  organizationId: "organization-1",
  actor: "sender",
  scopes: ["events:send"],
} as const satisfies PublicAuthorization;
const unavailable = { status: "infrastructure_unavailable" } as const;
const issues = [{ path: ["input"], message: "Invalid input." }];
const invalidTrigger = { status: "invalid_trigger", issues } as const;
const missingProject = { status: "project_not_found" } as const;
const invalidBundle = { status: "invalid_bundle", issues } as const;
const invalidConfiguration = { status: "invalid_configuration", issues } as const;
const invalidInput = { status: "invalid_input", issues } as const;
const configuredTriggerName = "deploy";
const dispatched = {
  status: "dispatched",
  configuredTriggerName,
  deliveryKey: "fixture",
  providerEventReceiptId: id,
  triggerRunId: otherId,
  workflowStatus: "running",
} as const;

const results: Results = {
  listTriggers: [{ status: "listed", triggers: [] }, unavailable],
  validateTrigger: [
    { status: "valid", name: configuredTriggerName, valid: true },
    invalidTrigger,
    unavailable,
  ],
  installTrigger: [
    {
      status: "installed",
      name: configuredTriggerName,
      triggerId: id,
      revisionId: otherId,
      version: 1,
      active: true,
    },
    invalidTrigger,
    unavailable,
  ],
  listProjects: [
    { status: "listed", projects: [{ id, name: "Project", slug: "project" }] },
    unavailable,
  ],
  listConfigurationResources: [
    { status: "listed", daemons: [], github: [], discord: [], slack: [], linear: [] },
    unavailable,
  ],
  listSetupResources: [{ status: "listed", github: [], discord: [], slack: [] }, unavailable],
  validateConfiguration: [
    { status: "valid", projectSlug: "project", valid: true },
    { status: "valid", projectSlug: "project", valid: true, wouldCreateProject: true },
    missingProject,
    invalidBundle,
    invalidConfiguration,
    unavailable,
  ],
  installConfiguration: [
    { status: "installed", projectSlug: "project", versionId: id, version: 1, active: true },
    missingProject,
    invalidBundle,
    { ...invalidConfiguration, versionId: id },
    unavailable,
  ],
  dispatchManualRun: [
    dispatched,
    missingProject,
    { status: "actor_forbidden" },
    { status: "key_actor_required" },
    { status: "daemon_offline" },
    { status: "expected_configuration_not_current" },
    { status: "configuration_not_found" },
    { status: "trigger_not_found" },
    invalidInput,
    { status: "dispatch_conflict" },
    unavailable,
  ],
  receiveWebhook: [
    { ...dispatched, duplicate: false },
    { ...dispatched, duplicate: true },
    { status: "filtered", duplicate: false },
    { status: "filtered", duplicate: true },
    invalidInput,
    { status: "trigger_not_found" },
    { status: "actor_forbidden" },
    { status: "key_actor_required" },
    { status: "trigger_busy" },
    { status: "dispatch_conflict" },
    unavailable,
  ],
  stopRun: [
    { status: "stopped", runId: id, cleanupState: "waiting_for_daemon", runStatus: "canceled" },
    {
      status: "stopped",
      runId: id,
      cleanupState: "confirmed",
      runStatus: "canceled",
      coalesced: true,
    },
    { status: "forbidden" },
    { status: "run_not_found" },
    { status: "conflict", otherAttachedRunCount: 1 },
    unavailable,
  ],
  issueEnrollmentToken: [
    { status: "issued", token: "a".repeat(43), expiresAt: new Date("2026-08-06T18:10:00Z") },
    { status: "credential_revoked" },
    unavailable,
  ],
};

const yaml = JSON.stringify({ yaml: "name: deploy" });
const bundle = JSON.stringify({
  projectSlug: "project",
  files: [{ path: ".paseo/hub.yml", content: "environments: {}\nagents: {}\n" }],
});
const webhook = '{"message":"fixture"}';
const requestBodies: Partial<Record<PublicOperationId, string>> = {
  validateTrigger: yaml,
  installTrigger: yaml,
  validateConfiguration: bundle,
  installConfiguration: bundle,
  receiveWebhook: webhook,
  receiveGitHubWebhook: webhook,
  dispatchManualRun: JSON.stringify({
    projectSlug: "project",
    trigger: "deploy",
    deliveryKey: "fixture",
    input: {},
  }),
};

type Route = (typeof publicOperationManifest)[number];
type Auth = "valid" | "invalid" | "missing" | "wrong-scope" | "unavailable";
type Operation = keyof PublicOperations;
interface Case {
  name: string;
  route: Route;
  auth: Auth;
  body?: string;
  resultIndex?: number;
  path?: string;
  rate?: boolean;
  method?: "PUT";
  contentType?: string;
}

function operation(operationId: PublicOperationId): Operation {
  return operationId === "receiveGitHubWebhook" ? "receiveWebhook" : operationId;
}

function authenticator(trace: string[]): OperationAuthenticator {
  return {
    reauthorize: () => Promise.resolve(true),
    authorize(incoming, scope) {
      trace.push(`authorize:${scope}`);
      switch (incoming.headers.get("authorization")) {
        case "Bearer valid":
          return Promise.resolve({ status: "authorized", access: { ...access, scopes: [scope] } });
        case "Bearer wrong-scope":
          return Promise.resolve({ status: "forbidden" });
        case "Bearer unavailable":
          return Promise.reject(new DatabaseUnavailableError());
        case null:
        default:
          return Promise.resolve({ status: "unauthorized" });
      }
    },
  };
}

function keys(auth: Auth, trace: string[]): OrganizationApiKeys {
  const signer = { ...access, targetTriggerId: otherId };
  function unexpectedDatabaseAccess(): never {
    throw new Error("Unexpected database access in public API replay");
  }
  const fixture = new OrganizationApiKeys(
    {
      query: unexpectedDatabaseAccess,
      transaction: unexpectedDatabaseAccess,
      drizzle: unexpectedDatabaseAccess,
      migrate: unexpectedDatabaseAccess,
      close: unexpectedDatabaseAccess,
    },
    embeddedLocks(),
  );
  fixture.signing.availability = () => (auth === "unavailable" ? "unavailable" : "enabled");
  fixture.signing.findSigner = () => {
    trace.push("findSigner");
    return Promise.resolve(signer);
  };
  fixture.signing.verify = (_key, signature) => {
    trace.push("verify");
    return Promise.resolve(
      signature.equals(Buffer.alloc(32))
        ? { status: "authorized", signer, matchedSlot: "current" }
        : { status: "unauthorized" },
    );
  };
  fixture.markUsed = () => {
    trace.push("markUsed");
    return Promise.resolve();
  };
  return fixture;
}

function headers({ auth, route, contentType = "application/json" }: Case): Headers {
  const values = new Headers({ "x-request-id": "fixture", "content-type": contentType });
  if (route.webhook === "github_sha256") {
    if (auth !== "missing") {
      const byte = auth === "invalid" || auth === "wrong-scope" ? "a" : "0";
      values.set("x-hub-signature-256", `sha256=${byte.repeat(64)}`);
    }
  } else if (auth !== "missing") {
    values.set("authorization", `Bearer ${auth}`);
    values.set("idempotency-key", "fixture");
  }
  return values;
}

function request(test: Case): Request {
  const { route, path, method = route.method.toUpperCase() } = test;
  const body = test.body ?? requestBodies[route.id];
  const target =
    path ?? route.path.replace("{id}", id).replace("{trigger}", "deploy").replace("{keyId}", id);
  return new Request(`https://hub.test${target}`, {
    method,
    headers: headers(test),
    ...(body === undefined ? {} : { body }),
  });
}

function stubOperations(test: Case, trace: string[]): PublicOperations {
  function invoke<K extends Operation>(name: K) {
    return (authorization: PublicAuthorization, input?: unknown): Promise<Results[K][number]> => {
      assert.equal(name, operation(test.route.id));
      trace.push(JSON.stringify([name, authorization, input]));
      const result = results[name][test.resultIndex ?? 0];
      assert.ok(result);
      return Promise.resolve(result);
    };
  }
  return {
    listTriggers: invoke("listTriggers"),
    validateTrigger: invoke("validateTrigger"),
    installTrigger: invoke("installTrigger"),
    listProjects: invoke("listProjects"),
    listConfigurationResources: invoke("listConfigurationResources"),
    listSetupResources: invoke("listSetupResources"),
    validateConfiguration: invoke("validateConfiguration"),
    installConfiguration: invoke("installConfiguration"),
    dispatchManualRun: invoke("dispatchManualRun"),
    receiveWebhook: invoke("receiveWebhook"),
    stopRun: invoke("stopRun"),
    issueEnrollmentToken: invoke("issueEnrollmentToken"),
  };
}

function routeCases(route: Route): Case[] {
  const authModes: Auth[] = ["valid", "invalid", "missing", "wrong-scope", "unavailable"];
  const cases = authModes.map((auth): Case => ({ name: `${route.id}/${auth}`, route, auth }));
  for (const [i, result] of results[operation(route.id)].entries()) {
    cases.push({ name: `${route.id}/${result.status}/${i}`, route, auth: "valid", resultIndex: i });
  }
  if (requestBodies[route.id] !== undefined) {
    cases.push({ name: `${route.id}/malformed`, route, auth: "valid", body: "{" });
    cases.push({
      name: `${route.id}/invalid-before-validation`,
      route,
      auth: "invalid",
      body: "{",
    });
  }
  if (route.id === "stopRun") {
    cases.push({
      name: `${route.id}/cross-tenant`,
      route,
      auth: "valid",
      path: `/api/v1/runs/${otherId}/stop`,
      resultIndex: results.stopRun.findIndex(({ status }) => status === "run_not_found"),
    });
    cases.push({
      name: `${route.id}/invalid-id`,
      route,
      auth: "valid",
      path: "/api/v1/runs/invalid/stop",
    });
  }
  cases.push({ name: `${route.id}/wrong-method`, route, auth: "valid", method: "PUT" });
  if (route.webhook !== undefined) cases.push(...webhookCases(route));
  return cases;
}

function webhookCases(route: Route): Case[] {
  const base = { route, auth: "valid" } as const;
  const name = route.id;
  return [
    { ...base, name: `${name}/rate-limit`, rate: true },
    { ...base, name: `${name}/invalid-shape`, body: "[]" },
    { ...base, name: `${name}/invalid-message`, body: '{"message":0}' },
    {
      ...base,
      name: `${name}/long-message`,
      body: JSON.stringify({ message: "a".repeat(65_537) }),
    },
    { ...base, name: `${name}/text`, contentType: "text/plain", body: "plain text" },
    { ...base, name: `${name}/empty-text`, contentType: "text/plain", body: "" },
    { ...base, name: `${name}/unsupported-type`, contentType: "text/html", body: "<p>fixture</p>" },
    { ...base, name: `${name}/oversize`, body: "a".repeat(DEFAULT_WEBHOOK_OPTIONS.maxBytes + 1) },
  ];
}

async function record(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers],
    body: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}

async function replay(test: Case) {
  const trace: string[] = [];
  const api = createPublicApi(
    { status: "enabled", authenticator: authenticator(trace), webhookKeys: keys(test.auth, trace) },
    stubOperations(test, trace),
    {
      logger: {
        info: (fields: unknown) => trace.push(JSON.stringify(["info", fields])),
        warn: (fields: unknown) => trace.push(JSON.stringify(["warn", fields])),
      },
      now: () => 0,
      webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, ratePerMinute: 1, burst: 1 },
    },
  );
  const response = await record(await api.handle(request(test)));
  const repeated = test.rate === true ? await record(await api.handle(request(test))) : null;
  return { name: test.name, response, repeated, trace };
}

async function matrix() {
  const responses = [];
  for (const route of publicOperationManifest) {
    for (const test of routeCases(route)) responses.push(await replay(test));
  }
  return JSON.stringify(responses);
}

// Run with LOG_LEVEL=silent HUB_PUBLIC_API_REPLAY=1 node --import tsx <this file> for byte comparison.
if (process.env["HUB_PUBLIC_API_REPLAY"] === "1") {
  process.stdout.write(`${await matrix()}\n`);
} else {
  const { it } = await import("vitest");
  it("preserves public API response bytes and operation call order", async () => {
    assert.equal(
      createHash("sha256")
        .update(await matrix())
        .digest("hex"),
      "bea38b762546c588ad62f6e474ddb6eff705d91916fcde807e9a86c1fb12597c",
    );
  });
}
