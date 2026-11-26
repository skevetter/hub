import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OrganizationApiKeys } from "../auth/api-keys.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { SigningRequestError } from "../auth/webhook-secret-store.js";
import { DatabaseUnavailableError } from "../db/errors.js";
import { embeddedLocks } from "../db/runtime/locks/index.js";
import type { PublicAuthorization, PublicOperations } from "../public-operations/index.js";
import { DEFAULT_WEBHOOK_OPTIONS } from "../webhook-config.js";
import {
  createPublicApi,
  publicOperationManifest,
  type PublicApiComposition,
  type PublicOperationId,
} from "./index.js";

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
const oversizeBody = "a".repeat(DEFAULT_WEBHOOK_OPTIONS.maxBytes + 1);
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
type Auth = "valid" | "invalid" | "missing" | "wrong-scope" | "unavailable" | "no-actor";
type SigningFault =
  | "missing-keys"
  | "disabled"
  | "unknown-signer"
  | "verify-signing-error"
  | "verify-database-error"
  | "mark-used-signing-error"
  | "mark-used-database-error";
type Operation = keyof PublicOperations;
interface Case {
  name: string;
  route: Route;
  auth: Auth;
  body?: string | Uint8Array<ArrayBuffer>;
  resultIndex?: number;
  path?: string;
  rate?: boolean;
  method?: "PUT";
  contentType?: string;
  extraHeaders?: Record<string, string>;
  handleOperation?: true;
  compositionUnavailable?: true;
  operationError?: Error;
  invalidDuplicate?: true;
  signing?: SigningFault;
}

function operation(operationId: PublicOperationId): Operation {
  return operationId === "receiveGitHubWebhook" ? "receiveWebhook" : operationId;
}

function authenticator(trace: string[]): OperationAuthenticator {
  return {
    reauthorize: () => Promise.resolve(true),
    authorize(incoming, scope) {
      trace.push(`authorize:${scope}`);
      const authorization = incoming.headers.get("authorization");
      switch (authorization) {
        case "Bearer valid":
        case "Bearer no-actor":
          return Promise.resolve({
            status: "authorized",
            access: {
              ...access,
              scopes: [scope],
              actor: authorization === "Bearer no-actor" ? null : access.actor,
            },
          });
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

function keys({ auth, signing }: Case, trace: string[]): OrganizationApiKeys {
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
  fixture.signing.availability = () => {
    if (signing === "disabled") return "disabled";
    return auth === "unavailable" ? "unavailable" : "enabled";
  };
  fixture.signing.findSigner = () => {
    trace.push("findSigner");
    return Promise.resolve(signing === "unknown-signer" ? undefined : signer);
  };
  fixture.signing.verify = (_key, signature) => {
    trace.push("verify");
    if (signing === "verify-signing-error") return Promise.reject(signingError());
    if (signing === "verify-database-error") return Promise.reject(new DatabaseUnavailableError());
    return Promise.resolve(
      signature.equals(Buffer.alloc(32))
        ? { status: "authorized", signer, matchedSlot: "current" }
        : { status: "unauthorized" },
    );
  };
  fixture.markUsed = () => {
    trace.push("markUsed");
    if (signing === "mark-used-signing-error") return Promise.reject(signingError());
    if (signing === "mark-used-database-error")
      return Promise.reject(new DatabaseUnavailableError());
    return Promise.resolve();
  };
  return fixture;
}

function signingError(): SigningRequestError {
  return new SigningRequestError(503, "signing_unavailable");
}

function headers({
  auth,
  route,
  extraHeaders = {},
  contentType = "application/json",
}: Case): Headers {
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
  for (const [name, value] of Object.entries(extraHeaders)) values.set(name, value);
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
      if (test.operationError !== undefined) throw test.operationError;
      const result = results[name][test.resultIndex ?? 0];
      assert.ok(result);
      if (test.invalidDuplicate === true) {
        return Promise.resolve(
          Object.defineProperty({ ...result }, "duplicate", {
            enumerable: true,
            value: "not a boolean",
          }),
        );
      }
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
  cases.push(...edgeCases(route));
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
    { ...base, name: `${name}/oversize`, body: oversizeBody },
  ];
}

type EdgeCase = Omit<Case, "route" | "auth"> & {
  auth?: Auth;
};

const signedFaults: readonly SigningFault[] = [
  "missing-keys",
  "disabled",
  "unknown-signer",
  "verify-signing-error",
  "verify-database-error",
  "mark-used-signing-error",
  "mark-used-database-error",
];

const routeEdges: Partial<Record<PublicOperationId, readonly EdgeCase[]>> = {
  listProjects: [
    { name: "unknown-path", path: "/api/v1/unknown" },
    { name: "handle-operation", path: "/api/v1/unknown", handleOperation: true },
    { name: "composition-unavailable", compositionUnavailable: true },
    { name: "operation-error", operationError: new Error("Fixture operation failed") },
    { name: "operation-database-error", operationError: new DatabaseUnavailableError() },
  ],
  dispatchManualRun: [
    { name: "body-over-limit", body: oversizeBody },
    { name: "schema-invalid-json", body: "{}" },
  ],
  receiveWebhook: [
    { name: "invalid-trigger-name", path: "/api/v1/hooks/Not-a-trigger" },
    { name: "invalid-operation-result", invalidDuplicate: true },
    { name: "no-bound-actor", auth: "no-actor" },
    { name: "invalid-idempotency-key", extraHeaders: { "idempotency-key": "a".repeat(201) } },
    { name: "invalid-utf8", body: new Uint8Array([0xff]) },
    { name: "unsupported-charset", contentType: "application/json; charset=iso-8859-1" },
    {
      name: "declared-length-over-limit",
      extraHeaders: { "content-length": String(DEFAULT_WEBHOOK_OPTIONS.maxBytes + 1) },
    },
  ],
  receiveGitHubWebhook: [
    ...signedFaults.map((signing) => ({ name: signing, signing })),
    { name: "bearer-header-present", extraHeaders: { authorization: "Bearer fixture" } },
    { name: "legacy-signature-present", extraHeaders: { "x-paseo-signature": "fixture" } },
    { name: "non-identity-content-encoding", extraHeaders: { "content-encoding": "gzip" } },
    { name: "mismatched-idempotency-key", extraHeaders: { "idempotency-key": "mismatch" } },
  ],
};

function edgeCases(route: Route): Case[] {
  const cases: Case[] = [];
  for (const { name, auth = "valid", ...options } of routeEdges[route.id] ?? []) {
    cases.push({ ...options, name: `${route.id}/${name}`, route, auth });
  }
  return cases;
}

async function record(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers],
    body: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}

function replayComposition(test: Case, trace: string[]): PublicApiComposition {
  if (test.compositionUnavailable === true) return { status: "unavailable" };
  return {
    status: "enabled",
    authenticator: authenticator(trace),
    ...(test.signing === "missing-keys" ? {} : { webhookKeys: keys(test, trace) }),
  };
}

async function replay(test: Case) {
  const trace: string[] = [];
  const api = createPublicApi(replayComposition(test, trace), stubOperations(test, trace), {
    logger: {
      info: (fields: unknown) => trace.push(JSON.stringify(["info", fields])),
      warn: (fields: unknown) => trace.push(JSON.stringify(["warn", fields])),
    },
    now: () => 0,
    webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, ratePerMinute: 1, burst: 1 },
  });
  const incoming = request(test);
  const response = await record(
    await (test.handleOperation === true
      ? api.handleOperation(test.route.id, incoming)
      : api.handle(incoming)),
  );
  const repeated = test.rate === true ? await record(await api.handle(request(test))) : null;
  return { name: test.name, response, repeated, trace };
}

async function matrix() {
  const responses = [];
  for (const route of publicOperationManifest) {
    for (const test of routeCases(route)) responses.push(await replay(test));
  }
  return responses;
}

const expectedDigests: Readonly<Record<string, string>> = {
  "listTriggers/valid": "6ICXb9ZcEdNOPe9GwbVZkjslqhNoG4o4sF_Rzpw-G0I",
  "listTriggers/invalid": "C1OvRmzBLYnzD4XgpJ5MDLW_T5S9xHutBTbVNWqMhPw",
  "listTriggers/missing": "uL9TA6IzWAFG3x-HdqR--J82z0sAKGVNR8vbeBmR_NQ",
  "listTriggers/wrong-scope": "nuqm9RBpzAVAIvfhp3xPMeWjVmLe_4B24H3u1Kd5h_M",
  "listTriggers/unavailable": "ZYbRknWCYAb4wbCRsllXvAi5MzjHz33OHQRMwGzhzQ4",
  "listTriggers/listed/0": "yHC_UdpmLrim_EqoVTQ-smEPHQ7EM7bAWMOov_T0bac",
  "listTriggers/infrastructure_unavailable/1": "THLsoibtJRezQwnwG6eDDIXqZSpXvIxq1FStht90hYs",
  "listTriggers/wrong-method": "nxNcvg470BaO3IGQfEhZqVAlYlUoAp0Nid8U_F0tVzQ",
  "validateTrigger/valid": "W9LvR1v1RH6yJ3R9e1-XlcNPr-w8GBCBsMFRIIFDM9Y",
  "validateTrigger/invalid": "nr9R-vcZqrWsC61pA-erHCxQ0f_NCzcYI2iNa5Xon7Y",
  "validateTrigger/missing": "X2T8DlPJJq4R2J_lMcTYcK7yNJdurkCu1w15wjVm_T8",
  "validateTrigger/wrong-scope": "Uh9OOopcB9y9D3dY0ZzQqJGUULdJEmOM7fDcegUwh-w",
  "validateTrigger/unavailable": "p8OqNQK1keCJEMZUeuzx88TYC-0Bp1HseYSvzj-VKF8",
  "validateTrigger/valid/0": "JHOqfM2PdWLu3vDfTTlLGi_nN-Mf3Yf7kh6ujTtOqXM",
  "validateTrigger/invalid_trigger/1": "_Wv2xg-Yil_mzpEnX9O4fqTYWAxB6vmITe7dDtasT_o",
  "validateTrigger/infrastructure_unavailable/2": "OPjNa4n-EYqKvum2sg0Bek0Nt_Fddzkuukwv23uhn2U",
  "validateTrigger/malformed": "Imi-ljp9yNQkt0JHJw6kkXN-B--9G3zFX8SlR6UEwP8",
  "validateTrigger/invalid-before-validation": "8gkWCJbzJ-fqDg-r6SC6Wi3ORwTRZnY_Na8VZEFj4dU",
  "validateTrigger/wrong-method": "l-UoWewdiJ0cHCS9z5YD1jw72tFSeX9hta1sPoBYc9c",
  "installTrigger/valid": "rTmlla0DKZNWO44aF89VYj5R3nQIRQ8ZGluQskDDAes",
  "installTrigger/invalid": "T5RClFKg7IF1n3hase-qGVFBtjmUK7HaLNejUAEIMoM",
  "installTrigger/missing": "_nuNe6n8lu3_RCQ_R1PJB-K6KaEUmbKHruZhY8A5mtU",
  "installTrigger/wrong-scope": "anlCwORnbP5VyJYYK4FUoh1L6s74tse1nHHYtC4GZXA",
  "installTrigger/unavailable": "ZV4Xl_PIoZWhRcaPjNj9Gh0vmzUq1Nz6EZtocJKcgYA",
  "installTrigger/installed/0": "LvnZrOr3gC_r7GVk7nxW56sq6rjfglpv0NGgWR4Nf1E",
  "installTrigger/invalid_trigger/1": "p1G1SwIoWMcWM-XQ0X4XX1z59h-Bsy5sT2wcEH8h2qo",
  "installTrigger/infrastructure_unavailable/2": "yl6zsRoSROoP5y_vqD1Oko2_KbPN9J68unTFQjEFT3k",
  "installTrigger/malformed": "BcO4vxFIeHxRMFfFP6zXmyHwF1peXiyiPCab_Ib03eI",
  "installTrigger/invalid-before-validation": "DbQYGppPEmTyfBBQcHkZdUdHKbmvaLAEzUz3BgwYrNU",
  "installTrigger/wrong-method": "St4aa1xwSjnYzuHCceXs62uK54u_JctupHGqvIFKnQI",
  "listProjects/valid": "egBmi8rr5ywe7-206gF2BLX11Rc8LG6WXHIAj6IAIlI",
  "listProjects/invalid": "_qPzANZLB2eiboUtUBdKLSlO_1dXCMgiXpTShtUk0fk",
  "listProjects/missing": "uv1dHXPXLaiqp-shivNDv6Dw_8KySsGoTicSG7XizJ8",
  "listProjects/wrong-scope": "RKQxgIGndzV-82Swc_yKke6soaYdUlABShG1DXv4Mig",
  "listProjects/unavailable": "MVEAh1SFSV6rd_S7kNUP_KsdnmF-TDdHKYcdH5hezHE",
  "listProjects/listed/0": "QRTu7mrFCCisj_YlcuNK_2qXsl0tzrGxfUeH1iCmX_w",
  "listProjects/infrastructure_unavailable/1": "d7o6PUUTaXyO8aMs3btIeJ8bBSQF0Fnjkn_P2e71rx8",
  "listProjects/wrong-method": "pGp9tXKoOvpEv1vGf251102b-42aCJW4lVzkqofIl9M",
  "listProjects/unknown-path": "Ow1LWpZ5q9nXSx88QEESiPY_ozOsIe1AM0LoRbCcN1g",
  "listProjects/handle-operation": "oBo5_8_BHpELQjK05UKNejHkbgk5lVeMLhXiCTSE_wM",
  "listProjects/composition-unavailable": "53s1C5FsN-WXNQ23lRXNYccpHKBpCrEzcijY-7YBgyM",
  "listProjects/operation-error": "QTZAbHPn5zTvAhEeEwq6T3nii4KhpGhIOeLhjsplHAM",
  "listProjects/operation-database-error": "9vlWV0R68urxLrt03CqwTHn7INAh2nj_CR4aXE6ZVhY",
  "listConfigurationResources/valid": "PdytIq08VABL2H9Jz8zR8SI42ilkQB9HHAsPGRGfwfI",
  "listConfigurationResources/invalid": "kghy_l4JOiBpeBpgWKiwRUeRCoZz2SQXHsDdq9Gl1UM",
  "listConfigurationResources/missing": "rdUXZzwvxzrgtoiv5or5zJF4EtZV5nrbEUJihhJ1SEM",
  "listConfigurationResources/wrong-scope": "QUy1MtVasteIjYZgvAJz1cQEWAVr4FEAsDG2ERo1c2c",
  "listConfigurationResources/unavailable": "ppNqO77PAMpwv6LAQOsirHON6NmbA3Az_NoxeLtXS9o",
  "listConfigurationResources/listed/0": "LUj9zebqiEPQRiGc9CJ0LUL1QTwGL4ZSHs_CwNOG6_Q",
  "listConfigurationResources/infrastructure_unavailable/1":
    "yDiHWNKx9EDGVKrneNPK0eavTjKonul6V3_TruSvWbE",
  "listConfigurationResources/wrong-method": "e3BfnDsAt9Lvw-I-W8JfYCi9hRg-jr8Kc27PISfOZtk",
  "listSetupResources/valid": "IWpIspRgAnOV0LWbNMz7VOk5VM8TVglKaJoffSg3D30",
  "listSetupResources/invalid": "4OxX0_qYtr1kfWG88yMhJhNMgb6pXH0KVYwXMPz5kjE",
  "listSetupResources/missing": "Kda3ng7jsRrsLu-QPRbbK0_k_gPxoKsU2K4NSiHQHRQ",
  "listSetupResources/wrong-scope": "_rID5uMf13cbL0gx-s6hmLGAp1wuxxKcnTsSsC7fxdk",
  "listSetupResources/unavailable": "HPFj_i9PrhMWJpV2o7KGEYa2Mft4GOodQadHRp5RNes",
  "listSetupResources/listed/0": "X9cWWzEKqeLuzKtQyWrZKIRKTuwJv8NiNt-BJaEP7Jc",
  "listSetupResources/infrastructure_unavailable/1": "AH2qpGCsi9BJI8M_JvqC5f9lRG8zqKiiOi7LpW34XQU",
  "listSetupResources/wrong-method": "bMTHmBtgsidBlBZuCTWEiGn5iFWFUiYWFoxWF-D6v1g",
  "validateConfiguration/valid": "kiVg5Cj3q3IKFFe8fP3gG0j6YHty6lhE_w0tlA5FB9A",
  "validateConfiguration/invalid": "tqDJRZpzI7GYu5aBdd0kSdmXPv58Kg7BSucluDVoKRk",
  "validateConfiguration/missing": "ZsF7NySK6vovM4iV8VA8IIVAJCQm9MOPX8c6K6TgXhc",
  "validateConfiguration/wrong-scope": "UekLLp_WwHWq54-G-6s5qoaPfCdwhuwnIdIaVTilE5M",
  "validateConfiguration/unavailable": "r1oo_6rxr2lpRkohDaLRKLJXRZlOt8c_vW_30O3UOGc",
  "validateConfiguration/valid/0": "HLgKE_Dga9UTQzrDl7ZnSg9C25FWC_3kVrL8QFzaCbA",
  "validateConfiguration/valid/1": "Q-IQfahvXFWi8PfSyxw9GRRS9NfRMBshD-PESP_vmV8",
  "validateConfiguration/project_not_found/2": "7C8cuD1XxyQufc_ALjx3uuqUqV8AVsXwT1hfTa_Rc0E",
  "validateConfiguration/invalid_bundle/3": "e2hDrkmcduWZDjrRpqmvMzJTdzNWiioJT_KqHSMX9Bo",
  "validateConfiguration/invalid_configuration/4": "ulPuMNSp_cP26FWKMca_neCo0BPFKu2oxPPLEyU0__E",
  "validateConfiguration/infrastructure_unavailable/5":
    "Hm-QjVo7QQwZqIL96J6C-cxWA3gI5I1HIU96kc9BjKI",
  "validateConfiguration/malformed": "KTYRgrfF2DliPe3M54CZh9QxFq2GlxCW9q2PlOszL4s",
  "validateConfiguration/invalid-before-validation": "9gtGTIMcKZ1rtWgG18cjKJMwa3-QQy53xHfV27SVwE0",
  "validateConfiguration/wrong-method": "d3BzzXrThK2WuQIicG5TsrawVdo9-9egNtdzbS5ikK4",
  "installConfiguration/valid": "3qXDNn1k2ZEMErVb96hJ8_G9deSFhZoCi5C3iFYW4eU",
  "installConfiguration/invalid": "60s94CDgtgxhg45UUKMX0Ge68KHSuXjY1MIYwI4D4o0",
  "installConfiguration/missing": "YsEQV4g6YOmBUKdye-0fK20wkttTAK7FflB4VsVpCAw",
  "installConfiguration/wrong-scope": "qh8g4Pq7eVQckYtJiKVZZ-soak2wbEAswBRsSP0E244",
  "installConfiguration/unavailable": "86dYVt4xmR18hXhu2as74XbhG3ftNVOYRchOIqJZI2U",
  "installConfiguration/installed/0": "ed_BvytS4ERZmUGlXXD2DGFXei_IMn3o9ksrp8XY9z8",
  "installConfiguration/project_not_found/1": "GYo-5097HMr6HH7YiNKPwqS-BzssL06Uauy7Md14zms",
  "installConfiguration/invalid_bundle/2": "KxB5uNH4tpUd1xDQNjtQTXY8JWg1jSNbiKPoPadOFxs",
  "installConfiguration/invalid_configuration/3": "DCYuJOGP1YHAR00nX1Sq__fVyZF-Ok7Xf1DBW9jltLM",
  "installConfiguration/infrastructure_unavailable/4":
    "YKk38sbREJmA0QfEbQFmgOyfrMKEpA1CtbE6L1j_ib4",
  "installConfiguration/malformed": "Q7bWQmXgTyF3DFbSHMYsBjU_lmtcgmkJa3BH_5QLMNo",
  "installConfiguration/invalid-before-validation": "KP6G4VUyO8cgfvRV5H28hTbKX69bhNf5PLOBm30VPSk",
  "installConfiguration/wrong-method": "Bm-hB4gFQM-rW8oM0z_ooqjRKyguLjazMYuXr1-JAcM",
  "dispatchManualRun/valid": "Rc_AitGa-2I2OohEEzOWF3cUXATbGhVZiyIE6xFU_VI",
  "dispatchManualRun/invalid": "2WtzxGjtRLwxFdwV3vQjJfGd2B1xlq7-9yIXxjQSxHg",
  "dispatchManualRun/missing": "i0DQmoi9WKfGFY3f78XtYnjabF4bEwI5MWAPsKDVDfM",
  "dispatchManualRun/wrong-scope": "Gl5MTpjXR2WO2i0Rp7GQj93En6VTkCfjsEcIP0Br25M",
  "dispatchManualRun/unavailable": "km-kQeobtPD_Z4ACfeNgyeXpEJ3Mss6Sq4G8sdRUHLI",
  "dispatchManualRun/dispatched/0": "uNF5IQkoQhZmapJdhpENaHWmisBYgPMCVpk3CS2-_XE",
  "dispatchManualRun/project_not_found/1": "NA13bMt_jzolQNhJkeklDtoyhkeZYVcSaWnRbnk5bvw",
  "dispatchManualRun/actor_forbidden/2": "5P4YQNwpZIFNR_UW33JYAqaPPA2G8QFxxy3TpzCtKmc",
  "dispatchManualRun/key_actor_required/3": "jEXEDoPmL1JdEXgoHY656v3toK9pqhb8noh3n9cNZR4",
  "dispatchManualRun/daemon_offline/4": "yq_YEv8brL8qQ_LUstIr1rtNbv0sfZQdvq_B7E-g2gY",
  "dispatchManualRun/expected_configuration_not_current/5":
    "MKa1eHCF1n3gnZotfu_N1NCSq-3emm31F9AsvPIZnnY",
  "dispatchManualRun/configuration_not_found/6": "m6fKAgyNdaLLAovFK7PeL1ZidBRyxUu8iAHhvDLY-g8",
  "dispatchManualRun/trigger_not_found/7": "q2UFUe6GeFGgFkOiU3XYlH3f_Sadl9CDsFpgcHLlPUQ",
  "dispatchManualRun/invalid_input/8": "pj-lMpaPh0GgCr9sFmnTa7ctiOSMxvMDimesUxq0HBc",
  "dispatchManualRun/dispatch_conflict/9": "2BRbLRn56afVn2QF8hXmbZ8aDcbhM0McKQ0Al0D0EMo",
  "dispatchManualRun/infrastructure_unavailable/10": "2XCDjz5vLy16xl0Ai-YdL3Rao6pcIGMzjQvIXvhJX08",
  "dispatchManualRun/malformed": "yxf3FEoeEUfBlBCkXSVdjSGpkIsQPiTKsEZwyVdvnNU",
  "dispatchManualRun/invalid-before-validation": "T4aj0JCMkUSUsdRXancm_mx4YJ2mri4NSIJvqQNP-Ag",
  "dispatchManualRun/wrong-method": "IDNT1sMWjwXy6YNcGPvJnm_rBBKEMc_YdtkED41IrgU",
  "dispatchManualRun/body-over-limit": "WS7nnaeIqR0Yx5HvwBE5miJSoDY63FQX22gXQ2GCEJ0",
  "dispatchManualRun/schema-invalid-json": "0rRAemo2ZEkVyL0YcBDKtQHBOQdemWTsJ5aIpq3rvWk",
  "receiveWebhook/valid": "m530ck2-cm1YIjvrnxIZKLvu-yTW4mHuz_qAhqwYvtc",
  "receiveWebhook/invalid": "f90vSR8gaBbXcGOEDechRvY-EW4ngee4aXhLq2bMyj0",
  "receiveWebhook/missing": "5J8hncA4O-Wg75zwpHAyRH_GgBxWJ3DLxbaCi_w4OOU",
  "receiveWebhook/wrong-scope": "CWSz7qS2Om2cKhe7QnONpkqKV16OQUi9m9iaDRLIcyQ",
  "receiveWebhook/unavailable": "0Hy4e2feL_zuOQuNjU6oTOC4cqrx5clLCN2bDNAxc4Y",
  "receiveWebhook/dispatched/0": "_d5asbHk__B0D7ixzwkidIxenavG2xkiboh8uuRAWww",
  "receiveWebhook/dispatched/1": "K2jGA-bjLVvcPPWhJuJL8BZYXOFQBkpCulgR00z8b9M",
  "receiveWebhook/filtered/2": "WC89IItXwxHRmSSjF7vm8al1IcmskGXUQA2BcWXX-Jk",
  "receiveWebhook/filtered/3": "OqV0GG2Fb39hL2x0jLK1vWABh4tKilkqfFuYn5sdjHY",
  "receiveWebhook/invalid_input/4": "V_pqUxs4FMF3oG9TNpKArVywZny30NjPjba1D84c63w",
  "receiveWebhook/trigger_not_found/5": "fFKu2y57uZ9XUAcuPxdnLnzFonahXZbwfjUjBFoGTcQ",
  "receiveWebhook/actor_forbidden/6": "baofglgyWZ-nTanQ3UuIvapaTedgGpkr0Vhdovj-HrM",
  "receiveWebhook/key_actor_required/7": "j-4JvKcFT2acFV4hiSyi8C84w5b5zoSKltVOrX3YztA",
  "receiveWebhook/trigger_busy/8": "36Xu1IOlEzjemKhVzpY7LiEj_iiajlvHvXZQd3Tabww",
  "receiveWebhook/dispatch_conflict/9": "-U85CvrfsOHbbpRGZRWWsVdfGUXsMyTXrz7W_8VA1Bg",
  "receiveWebhook/infrastructure_unavailable/10": "2X4LsTN9YJCL36V7KUxEoc5vDErnb9fDyqGExLUExh4",
  "receiveWebhook/malformed": "EXYV_aQh9vxt_QOHZmb5Dtfi01IOkitKY1VTsu4-VcE",
  "receiveWebhook/invalid-before-validation": "MufmELA6KHjG-K6sET6oYEyYEgxukqO1rkyKPoicU3o",
  "receiveWebhook/wrong-method": "MXVMi_t687IN2V6LpFcQfxoweVa9offkZBvctbJHNOs",
  "receiveWebhook/rate-limit": "3NSvYjh88GIjvmQp4HSHo0WO-cSk1auSFfqQcLCbTx4",
  "receiveWebhook/invalid-shape": "9WCN6tEZ5ZsPMFnZ1qtXT3gERojIwID6cekRc4A2ccQ",
  "receiveWebhook/invalid-message": "KlaC53lHanlQipa0Hdc_xRvenGb-r1Ra3FaZG49NFhU",
  "receiveWebhook/long-message": "ruz4CpGyvGjbQOW6aWc0gx6YyGAx8wiOHzVBDOe3lSk",
  "receiveWebhook/text": "sIbAGJeHnxHPKVgKq_-itXH6GVrXrmZvueqL_1D5nr4",
  "receiveWebhook/empty-text": "x5ZauAOH-ufSfU6jHyRD3OoH63a4L8C8CqXHnYHJUiA",
  "receiveWebhook/unsupported-type": "1XQpMiI07Nbag7avAbUnLxjvs3XknRf6b0YsJ3gh1v8",
  "receiveWebhook/oversize": "ibpo752NNEGFETa1W1lXoFHNUxRc_Wc9ltxx6sbws_U",
  "receiveWebhook/invalid-trigger-name": "nk2IWzwZ53aqUCERjleqsUx4JtLYih9ctFr5gQV7a28",
  "receiveWebhook/invalid-operation-result": "ZzPXOkYaQPj3UyMw7rPDH-4JnmebP210QP0uCGler_E",
  "receiveWebhook/no-bound-actor": "z3vtmPh3MO_omATHazlZ9KWB8tu7B5nF92rK2xIxSpo",
  "receiveWebhook/invalid-idempotency-key": "A-an94BX2oeMNsZn4THg5DKGESRrm9h8rAh-fa8i3FQ",
  "receiveWebhook/invalid-utf8": "F18_STSKH8k7-RdPTraTBILSPSH8sYolszLsq7zQhqg",
  "receiveWebhook/unsupported-charset": "5CoLMcNrILIVAI-qeWt74NGd02kmGp_bz7httP4VAWQ",
  "receiveWebhook/declared-length-over-limit": "jc58z8TZdMmcICqxogvTOGHjCJMsU-Eg_msPa1SA5zM",
  "receiveGitHubWebhook/valid": "zYDV3N4cVl1wB9-wYomgeJv4jF-Wre4I4iLU2aFO8Jk",
  "receiveGitHubWebhook/invalid": "OUMvxIpCZVAWWbZu3kedQ63cTrKY-J2fiVgfCnx8P-k",
  "receiveGitHubWebhook/missing": "pWOa8ncgTMFy_vvuJdzDVeNZqmg4rC1Ftig01OMl9ls",
  "receiveGitHubWebhook/wrong-scope": "PXNkX8WciwtkxxeUvt2JKWmSGRr5gCsGRYz4f23Zu-k",
  "receiveGitHubWebhook/unavailable": "iKKct9MwMQHe6sJpbC-eh3_1cL-vlVbM_4RD18r_4vE",
  "receiveGitHubWebhook/dispatched/0": "bDS-UznpeqWUe1NAG3sdd-W6sSXUYJbwBf96CrZudwU",
  "receiveGitHubWebhook/dispatched/1": "h22HKrzUpgY5xNda5_eVTZxpSfzxHXk2xKKCkR2UI4A",
  "receiveGitHubWebhook/filtered/2": "xZvKM3xRxRTJz5y4njXPrwEEWXzs9oSo6tPA4tmijSs",
  "receiveGitHubWebhook/filtered/3": "sPQWzZH7Zerbh8zFRPNm6JGKsb7MPJIj4XQzgB_yzlU",
  "receiveGitHubWebhook/invalid_input/4": "ZG7_TKDd0cpn9_uYj9156UKtR-1qfU4zkNPSIoghvjM",
  "receiveGitHubWebhook/trigger_not_found/5": "VaQ1M2a-jgX9Kx2Wi41dh2182gSzocDibsbNrPoFfAQ",
  "receiveGitHubWebhook/actor_forbidden/6": "wiY4vN2oQyqNV8xz3pzco7gBT6YKQ10HxgoGyo8dXvs",
  "receiveGitHubWebhook/key_actor_required/7": "m3p6wam-8tX_SxKqz_oVC5s2Y7Xng5i4lAtDz-6NS0Y",
  "receiveGitHubWebhook/trigger_busy/8": "bXGOSJ2Nr2-vlITmUi5kkKh6Ua0Ot5_tqdVbDASDcIs",
  "receiveGitHubWebhook/dispatch_conflict/9": "m4szoPR9cXKIlYi2QgP8XhEh0pEPWCipZWnUwiZ0n_4",
  "receiveGitHubWebhook/infrastructure_unavailable/10":
    "6SxvQmuWVoXrxFNF-OJw85fBiZ_5Colf_Gs-fGDaBLE",
  "receiveGitHubWebhook/malformed": "sCdRHL-zDUN6pr3uuQ74tbIXClZh5iZKlT76Rosm0Ik",
  "receiveGitHubWebhook/invalid-before-validation": "f0MygnDVuHD6vKIdU8Ni_Dj5EudVrGHdFwkaaeShyU4",
  "receiveGitHubWebhook/wrong-method": "fHPHRUAyt0A6hvf6MzsjsaOirl6U_cqpIiACvJkUSYk",
  "receiveGitHubWebhook/rate-limit": "tuQoiYSkA4q6RQPp-_OrSJSBlU7kWZ7LyGF7rDHehD8",
  "receiveGitHubWebhook/invalid-shape": "HAb1nifADdUfcIyIbXIA-rDvhpF17aGcIWITata2tLY",
  "receiveGitHubWebhook/invalid-message": "0iSFHfd2DNJyR8JBX-wGYMEc4f9TGuRqhkAKaIwvrBI",
  "receiveGitHubWebhook/long-message": "YYDYyKmQrHnKC_WQGQ8byxZz39CNu40pJ6Ezt1cS-SA",
  "receiveGitHubWebhook/text": "7KsdEESFDh_QZDm2jhU1aSblAnNsPv54AiohoKtkvh4",
  "receiveGitHubWebhook/empty-text": "v9Wbla1Jpj3FESBnzK5srnOP8sfcP8yST6BEmGF-Cv4",
  "receiveGitHubWebhook/unsupported-type": "lIpge24saKzg6M0McP25om_iChkLa8cw6-TQAwAr8xI",
  "receiveGitHubWebhook/oversize": "2cnQJfKQt6EbStQ-Jep-9rzNiL3OuJ-8U3nLhVmnkRc",
  "receiveGitHubWebhook/missing-keys": "fXXwn5O6fpBweoGEIlmGpcGEm4BK__NiYU8PpjoJqhA",
  "receiveGitHubWebhook/disabled": "pnjGXU7ZtKNZ4bJV56AqJY8gVhEwQJISmcd4JbEWq70",
  "receiveGitHubWebhook/unknown-signer": "iuPAMYcPSFd6cJHRBdywI69RQWxt5qEQlnDbNl4Wpss",
  "receiveGitHubWebhook/verify-signing-error": "Gv4AfMMYdHMkwmhAJsotvONq-ULkocGicRegWUcnCO4",
  "receiveGitHubWebhook/verify-database-error": "htGBWPJh_ESkqZTYi4G4Lnl6FfOvnnJPgLw6EEJqq-E",
  "receiveGitHubWebhook/mark-used-signing-error": "D0dc8F_L4BXMEFJFUoLKKw-b6qmolwIr1yhv00Yw5U8",
  "receiveGitHubWebhook/mark-used-database-error": "S3RkiLtFSDniHP5F1dQYd4EZmT0jPZ8Zs3BYyWfMApc",
  "receiveGitHubWebhook/bearer-header-present": "X_Lt5MI4JpQaCNgMKa_RJKYSb53LiIIL350tOHanEFU",
  "receiveGitHubWebhook/legacy-signature-present": "BFVgY1RwmcSs-nWSUYKytC8HxN2oetLrNUWLYTuzo_c",
  "receiveGitHubWebhook/non-identity-content-encoding":
    "lIGXYoO88nxjgZF--P0MJSuBA7E9wQX0VFQRP6Hfgz4",
  "receiveGitHubWebhook/mismatched-idempotency-key": "8qAs3SpqCc9BxaU8TT4LCX1bUYYxDotOc4ktnvkC1iA",
  "stopRun/valid": "b5P-HoF20mK1p9yBgy5F-Z_heP3pAeDwpBG8IAlHkz4",
  "stopRun/invalid": "a1hoaglr5-7ECBqgejymG7lStT6cqeOFMO2xn6Rn5ok",
  "stopRun/missing": "GKA0kQe_L6dQ26AiPJHskbdcSpF-X9f1IfC4trYx1Aw",
  "stopRun/wrong-scope": "NmVZvBAiwVQHwhVbqXnUGfKpMMkoreqmSQztm_AEkR8",
  "stopRun/unavailable": "m9TafYBwAQjotczEHfXYEvAG2h36MsUpHBDAALvacHo",
  "stopRun/stopped/0": "RhWUI_9rUsBh6oSrYui5iouYf7wSYsx3iYt0i80oUHc",
  "stopRun/stopped/1": "tup0Os9u87D5Ahrf_7B0VmCq2Ver66P3xpcteUhN-FM",
  "stopRun/forbidden/2": "acPTvoCLb7QQS-GVymIJahFFFvk9Vk3_N4UxzIPJuUU",
  "stopRun/run_not_found/3": "Xt_5i1pyRhuy4lR-m7X0TDq3c0DvYBKt05p0bJU0AiU",
  "stopRun/conflict/4": "z87JNva4HXeJEKlMNTu8thAnAkrhgyKnLG-h8lnhQHk",
  "stopRun/infrastructure_unavailable/5": "FAi5jHRPqScxxTtaFE4slNZKY6oqnbfAvZ2nP9De1Do",
  "stopRun/cross-tenant": "lETQZ61bcz-dMEa9ce0RhlSvSBl92lMsPYytNV1Oh3Q",
  "stopRun/invalid-id": "6Eyv4gckPB-8n3fO4RWEtDLLb-2tP-_hM-_w4Xjk1To",
  "stopRun/wrong-method": "MvsD32uqIQwfQeo7YKiwd07FRQd2SWsyIk4lsTEyaVE",
  "issueEnrollmentToken/valid": "PqbVHMq3ttu6sACcHa3nk14Ak27-VZP_1O8_Q_zv89U",
  "issueEnrollmentToken/invalid": "fPMveoNaZZ4QcSTQK0ANXjlY1YQYY3u0Yp0MgOPB3J4",
  "issueEnrollmentToken/missing": "jBw5DALNbUofTfLI32QVVdo0iNEmy0T4WhnIZt_8OAk",
  "issueEnrollmentToken/wrong-scope": "Fp8VHzsYcBoYMIAOTGnZZGEe6yzSH2tz4ROz5ZkrBQU",
  "issueEnrollmentToken/unavailable": "wHeOKUpRQDRFfHdw2baRYOwB_OinEXbXUTSjdxLEYbw",
  "issueEnrollmentToken/issued/0": "L_W5Zr0fecN20l0UWw_XjQQ5tt5l-9zTpbNs8rsyC4o",
  "issueEnrollmentToken/credential_revoked/1": "kXAi8aZDpdXxLaOT07gCBO-JDCfLmrFtRlQICLoBbrg",
  "issueEnrollmentToken/infrastructure_unavailable/2":
    "VcIMqolQKl_GsG_Mqp3k6evq1RBGPgt2OEBFfTouUtE",
  "issueEnrollmentToken/wrong-method": "R2iJ7EgboHvDcdiU5vs7mzMtKq-7qD6uQnms-Lx-1uc",
};

// Run with LOG_LEVEL=silent HUB_PUBLIC_API_REPLAY=1 node --import tsx <this file> for byte comparison.
if (process.env["HUB_PUBLIC_API_REPLAY"] === "1") {
  process.stdout.write(`${JSON.stringify(await matrix())}\n`);
} else {
  const { it } = await import("vitest");
  it("preserves public API response bytes and operation call order", async () => {
    const responses = await matrix();
    assert.deepEqual(
      responses.map(({ name }) => name),
      Object.keys(expectedDigests),
    );
    for (const result of responses) {
      const digest = createHash("sha256").update(JSON.stringify(result)).digest("base64url");
      assert.equal(
        digest,
        expectedDigests[result.name],
        `Response or trace differs: ${result.name}`,
      );
    }
  });
}
