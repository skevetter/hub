import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { logger as defaultLogger } from "../logger.js";
import { DEFAULT_WEBHOOK_OPTIONS, type WebhookOptions } from "../webhook-config.js";
import { WebhookRateLimiter } from "./rate-limit.js";
import type { OrganizationApiKeys } from "../auth/api-keys.js";
import { githubBodyDigest, parseGitHubSignature } from "../auth/webhook-signatures.js";
import { SigningRequestError, type WebhookSigner } from "../auth/webhook-secret-store.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { CANCELED_RUN_NOTE, type StopRunResult } from "../triggers/run-stop.js";
import { reportFailure } from "../failures/index.js";
import { readBoundedRequestBody } from "../http/request-body.js";
import { hasPostgresText, isPostgresJson } from "../http/json-storage.js";
import type {
  DispatchManualRunResult,
  ReceiveWebhookInput,
  ReceiveWebhookResult,
  InstallConfigurationResult,
  InstallTriggerResult,
  IssueEnrollmentTokenResult,
  ListProjectsResult,
  ListTriggersResult,
  ListConfigurationResourcesResult,
  ListSetupResourcesResult,
  PublicAuthorization,
  PublicOperations,
  ValidateConfigurationResult,
  ValidateTriggerResult,
} from "../public-operations/index.js";
import {
  DispatchedManualRunSchema,
  ReceivedWebhookSchema,
  EnrollmentTokenSchema,
  InstalledConfigurationSchema,
  InstalledTriggerSchema,
  ProjectListSchema,
  TriggerListSchema,
  ConfigurationResourcesSchema,
  SetupResourcesSchema,
  ValidatedConfigurationSchema,
  ValidatedTriggerSchema,
  StoppedRunSchema,
} from "./contracts.js";
import { publicOpenApiDocument } from "./openapi.js";
import {
  publicOperation,
  operationPathMatch,
  publicOperationManifest,
  type PublicOperationId,
  type PublicOperationDefinition,
} from "./operation-manifest.js";
import { problem as problemResponse, requestIdentifier } from "./problem.js";

export type { PublicOperationId } from "./operation-manifest.js";

type PublicOperationResult =
  | ValidateTriggerResult
  | InstallTriggerResult
  | ListTriggersResult
  | ListProjectsResult
  | ListConfigurationResourcesResult
  | ListSetupResourcesResult
  | ValidateConfigurationResult
  | InstallConfigurationResult
  | DispatchManualRunResult
  | ReceiveWebhookResult
  | IssueEnrollmentTokenResult
  | StopRunResult;

export interface PublicApi {
  handle(request: Request): Promise<Response>;
  handleOperation(id: PublicOperationId, request: Request): Promise<Response>;
  openapi(): Response;
}

export type PublicApiComposition =
  | {
      status: "enabled";
      authenticator: OperationAuthenticator;
      webhookKeys?: OrganizationApiKeys | undefined;
    }
  | { status: "unavailable" };

export interface PublicApiOptions {
  webhookOptions?: WebhookOptions | undefined;
  logger?: Pick<Logger, "info" | "warn">;
  now?: () => number;
}

interface WebhookRequestLog {
  keyId: string | null;
  trigger: string | null;
  bytes: number;
  deliveryKeyHash: string | null;
  authenticationMode?: "hmac";
  signatureProfile?: "github_sha256";
  matchedSlot?: "current" | "previous";
}

interface ApiExecutionOptions {
  webhookOptions: WebhookOptions;
  limiter: WebhookRateLimiter;
  log: WebhookRequestLog | undefined;
  hook: WebhookRoute | undefined;
}

interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

const responseMetadata = new WeakMap<
  Response,
  { code: string | null; duplicate: boolean | null }
>();

interface WebhookRoute {
  trigger: string;
  keyId?: string;
}

function webhookRoute(pathname: string): WebhookRoute | undefined {
  const match =
    /^\/api\/v1\/hooks\/([^/]+)(?:\/signers\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}))?$/u.exec(
      pathname,
    );
  if (match === null) return undefined;
  try {
    const trigger = decodeURIComponent(match[1]!);
    if (!/^[a-z][a-z0-9_-]*$/u.test(trigger)) return undefined;
    return { trigger, ...(match[2] === undefined ? {} : { keyId: match[2] }) };
  } catch {
    return undefined;
  }
}

export function createPublicApi(
  composition: PublicApiComposition,
  operations: PublicOperations | null,
  options: PublicApiOptions = {},
): PublicApi {
  if (composition.status === "enabled" && operations === null) {
    throw new Error("enabled public API requires application operations");
  }
  const webhookOptions = options.webhookOptions ?? DEFAULT_WEBHOOK_OPTIONS;
  const now = options.now ?? (() => performance.now());
  const limiter = new WebhookRateLimiter(webhookOptions, now);
  const logger = options.logger ?? defaultLogger;
  async function handle(request: Request, operationId?: PublicOperationId): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const isHook =
      pathname === "/api/v1/hooks" ||
      pathname.startsWith("/api/v1/hooks/") ||
      operationId === "receiveWebhook" ||
      operationId === "receiveGitHubWebhook";
    const startedAt = now();
    const requestId = requestIdentifier(request);
    const hook = webhookRoute(pathname);
    const log: WebhookRequestLog | undefined = isHook
      ? { keyId: null, trigger: hook?.trigger ?? null, bytes: 0, deliveryKeyHash: null }
      : undefined;
    const execution = { webhookOptions, limiter, log, hook };
    const response = await routeRequest(
      request,
      requestId,
      composition,
      operations,
      execution,
      operationId,
    );
    if (log !== undefined) {
      logWebhookResponse(logger, log, response, Math.max(0, now() - startedAt), webhookOptions);
    }
    return response;
  }
  return {
    handle,
    handleOperation: (id, request) => handle(request, id),
    openapi() {
      return Response.json(publicOpenApiDocument, {
        headers: { "cache-control": "public, max-age=300" },
      });
    },
  };
}

async function routeRequest(
  request: Request,
  requestId: string,
  composition: PublicApiComposition,
  operations: PublicOperations | null,
  options: ApiExecutionOptions,
  operationId?: PublicOperationId,
): Promise<Response> {
  if (options.log !== undefined) {
    if (request.method.toUpperCase() !== "POST") {
      return problem(
        requestId,
        405,
        "method_not_allowed",
        "Method not allowed",
        "Use POST.",
        undefined,
        { Allow: "POST" },
      );
    }
    if (options.log.trigger === null) {
      return problem(
        requestId,
        404,
        "trigger_not_found",
        "Trigger not found",
        "No matching webhook trigger exists.",
      );
    }
    const id = options.hook?.keyId === undefined ? "receiveWebhook" : "receiveGitHubWebhook";
    return executeSafely(id, request, requestId, composition, operations, options);
  }
  if (operationId !== undefined) {
    return executeSafely(operationId, request, requestId, composition, operations, options);
  }
  const pathname = new URL(request.url).pathname;
  const routes = publicOperationManifest.filter(
    (route) => operationPathMatch(route, pathname) !== undefined,
  );
  if (routes.length === 0) {
    return problem(
      requestId,
      404,
      "not_found",
      "Not found",
      "No canonical API route matches this path.",
    );
  }
  const route = routes.find(
    (candidate) => candidate.method.toUpperCase() === request.method.toUpperCase(),
  );
  if (route === undefined) {
    return problem(
      requestId,
      405,
      "method_not_allowed",
      "Method not allowed",
      "Use one of the methods listed in the Allow response header.",
      undefined,
      { Allow: routes.map(({ method }) => method.toUpperCase()).join(", ") },
    );
  }
  return executeSafely(route.id, request, requestId, composition, operations, options);
}

function logWebhookResponse(
  logger: Pick<Logger, "info" | "warn">,
  log: WebhookRequestLog,
  response: Response,
  durationMs: number,
  options: WebhookOptions,
): void {
  const metadata = responseMetadata.get(response);
  const code = metadata?.code ?? null;
  let limit: string | undefined;
  if (response.status === 413) {
    limit = log.bytes > options.maxBytes ? "maxBytes" : "messageBytes";
  } else if (response.status === 429) {
    limit = code === "trigger_busy" ? "maxActiveRuns" : "ratePerMinute";
  }
  const fields = {
    operation: "webhook.received",
    ...log,
    ...(log.authenticationMode === "hmac" && response.status >= 400
      ? { failureCategory: signedFailureCategory(response.status) }
      : {}),
    status: response.status,
    code,
    durationMs,
    duplicate: metadata?.duplicate ?? null,
    ...(limit === undefined ? {} : { limit }),
  };
  if (response.status >= 400 && response.status < 500 && response.status !== 401)
    logger.warn(fields);
  else logger.info(fields);
}

function signedFailureCategory(status: number): string {
  if (status === 401) return "auth_rejected";
  if (status === 503) return "unavailable";
  if (status === 400 || status === 413 || status === 415) return "representation";
  return "dispatch";
}

async function executeSafely(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  composition: PublicApiComposition,
  operations: PublicOperations | null,
  options: ApiExecutionOptions,
): Promise<Response> {
  try {
    if (composition.status === "unavailable" || operations === null) {
      return problem(
        requestId,
        503,
        "infrastructure_unavailable",
        "Service unavailable",
        "Public API authentication or storage is currently unavailable.",
      );
    }
    if (id === "receiveGitHubWebhook") {
      return await executeSignedWebhook(
        request,
        requestId,
        operations,
        options,
        options.hook!.keyId!,
        composition.webhookKeys,
      );
    }
    return await execute(id, request, requestId, composition.authenticator, operations, options);
  } catch (error) {
    reportFailure(
      options.hook?.keyId === undefined ? error : new Error("Signed webhook operation failed"),
      {
        operation: `public-api.${id}`,
        component: "public-api",
        requestId,
        status: isDatabaseUnavailableError(error) ? 503 : 500,
      },
      { status: isDatabaseUnavailableError(error) ? 503 : 500 },
    );
    if (isDatabaseUnavailableError(error)) return infrastructureProblem(requestId);
    return problem(
      requestId,
      500,
      "internal_error",
      "Internal server error",
      "The operation failed unexpectedly. Contact the Hub operator with the request ID.",
    );
  }
}

async function execute(
  id: PublicOperationId,
  request: Request,
  requestId: string,
  authenticator: OperationAuthenticator,
  operations: PublicOperations,
  options: ApiExecutionOptions,
): Promise<Response> {
  const definition = publicOperation(id);
  const scope = definition.scope;
  let authorization;
  try {
    authorization = await authenticator.authorize(request, scope);
  } catch (error) {
    if (!isDatabaseUnavailableError(error)) throw error;
    return problem(
      requestId,
      503,
      "authentication_unavailable",
      "Authentication unavailable",
      "Bearer-credential authentication is currently unavailable. Retry the request later.",
    );
  }
  if (authorization.status === "unauthorized") {
    return problem(
      requestId,
      401,
      "unauthorized",
      "Authentication required",
      "Provide an active Paseo organization credential in the Authorization: Bearer header.",
    );
  }
  if (authorization.status === "forbidden") {
    return problem(
      requestId,
      403,
      "insufficient_scope",
      "Insufficient scope",
      `This operation requires the ${scope} scope.`,
    );
  }
  const access: PublicAuthorization = authorization.access;
  if (definition.webhook) {
    if (options.log !== undefined) options.log.keyId = access.credentialId;
    if (access.kind !== "apiKey" || !access.actor) {
      return problem(
        requestId,
        403,
        "key_actor_required",
        "Bound actor required",
        "Use an API key with a bound actor.",
      );
    }
    const parsed = await readWebhook(request, requestId, options);
    if (parsed instanceof Response) return parsed;
    return deliverWebhook(requestId, operations, options, access, parsed);
  }
  let input: unknown;
  if (definition.pathSchema !== undefined) {
    const parsed = definition.pathSchema.safeParse(
      operationPathMatch(definition, new URL(request.url).pathname),
    );
    if (!parsed.success)
      return problem(
        requestId,
        400,
        "invalid_request",
        "Invalid run ID",
        "Use a UUID for the run ID.",
      );
    input = parsed.data;
  }
  if (definition.requestSchema !== undefined) {
    const parsedBody = await readJson(
      request,
      id === "dispatchManualRun" ? options.webhookOptions.maxBytes : undefined,
    );
    if (!parsedBody.success && parsedBody.tooLarge) {
      return problem(
        requestId,
        413,
        "payload_too_large",
        "Payload too large",
        "The request body exceeds the byte limit.",
      );
    }
    if (!parsedBody.success) {
      return problem(
        requestId,
        400,
        "invalid_json",
        "Invalid JSON",
        "Send a JSON request body using Content-Type: application/json.",
      );
    }
    const parsed = definition.requestSchema.safeParse(parsedBody.value);
    if (!parsed.success) {
      return validationProblem(requestId, parsed.error.issues);
    }
    input = parsed.data;
  }
  const result = await definition.invoke(operations, access, input);
  return mapOperationResult(definition.resultMapping, requestId, result);
}

function mapOperationResult(
  mapping: PublicOperationDefinition["resultMapping"],
  requestId: string,
  result: PublicOperationResult,
) {
  if (mapping === "run-stop") return stopRunResponse(requestId, result);
  if (mapping === "triggers") {
    if (!isTriggersResult(result)) throw new Error("invalid triggers operation result");
    return triggersResponse(requestId, result);
  }
  return operationResponse(mapping, requestId, result);
}

function checkedWebhookResponse(requestId: string, result: PublicOperationResult): Response {
  if (!isWebhookResult(result)) throw new Error("invalid webhook operation result");
  return webhookResponse(requestId, result);
}

function operationResponse(
  mapping: Exclude<PublicOperationDefinition["resultMapping"], "triggers" | "run-stop">,
  requestId: string,
  result: PublicOperationResult,
): Response {
  switch (mapping) {
    case "trigger-validation":
      if (!isTriggerValidationResult(result)) throw new Error("invalid trigger validation result");
      return triggerValidationResponse(requestId, result);
    case "trigger-installation":
      if (!isTriggerInstallationResult(result)) {
        throw new Error("invalid trigger installation result");
      }
      return triggerInstallationResponse(requestId, result);
    case "projects":
      if (!isProjectsResult(result)) throw new Error("invalid projects operation result");
      return projectsResponse(requestId, result);
    case "configuration-resources":
      if (!isConfigurationResourcesResult(result))
        throw new Error("invalid configuration resources operation result");
      return configurationResourcesResponse(requestId, result);
    case "setup-resources":
      if (!isSetupResourcesResult(result))
        throw new Error("invalid setup resources operation result");
      return setupResourcesResponse(requestId, result);
    case "validation":
      if (!isValidationResult(result)) throw new Error("invalid validation operation result");
      return validationResponse(requestId, result);
    case "configuration":
      if (!isInstallationResult(result)) throw new Error("invalid configuration operation result");
      return installationResponse(requestId, result);
    case "manual-run":
      if (!isManualRunResult(result)) throw new Error("invalid manual-run operation result");
      return manualRunResponse(requestId, result);
    case "webhook":
      return checkedWebhookResponse(requestId, result);
    case "enrollment-token":
      if (!isEnrollmentResult(result)) throw new Error("invalid enrollment operation result");
      return enrollmentResponse(requestId, result);
  }
  return assertNever(mapping);
}

function triggersResponse(requestId: string, result: ListTriggersResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, TriggerListSchema, { triggers: result.triggers })
    : infrastructureProblem(requestId);
}

function triggerValidationResponse(requestId: string, result: ValidateTriggerResult): Response {
  switch (result.status) {
    case "valid":
      return success(requestId, 200, ValidatedTriggerSchema, { name: result.name, valid: true });
    case "invalid_trigger":
      return problem(
        requestId,
        422,
        "invalid_trigger",
        "Invalid trigger",
        "Correct the self-contained trigger YAML.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function triggerInstallationResponse(requestId: string, result: InstallTriggerResult): Response {
  switch (result.status) {
    case "installed":
      return success(requestId, 201, InstalledTriggerSchema, {
        triggerId: result.triggerId,
        name: result.name,
        revisionId: result.revisionId,
        version: result.version,
        active: true,
      });
    case "invalid_trigger":
      return problem(
        requestId,
        422,
        "invalid_trigger",
        "Invalid trigger",
        "Correct the self-contained trigger YAML and submit it again.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function projectsResponse(requestId: string, result: ListProjectsResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, ProjectListSchema, { projects: result.projects })
    : infrastructureProblem(requestId);
}

function configurationResourcesResponse(
  requestId: string,
  result: ListConfigurationResourcesResult,
): Response {
  return result.status === "listed"
    ? success(requestId, 200, ConfigurationResourcesSchema, {
        daemons: result.daemons,
        github: result.github,
        discord: result.discord,
        slack: result.slack,
        linear: result.linear,
      })
    : infrastructureProblem(requestId);
}

function setupResourcesResponse(requestId: string, result: ListSetupResourcesResult): Response {
  return result.status === "listed"
    ? success(requestId, 200, SetupResourcesSchema, {
        github: result.github,
        discord: result.discord,
        slack: result.slack,
      })
    : infrastructureProblem(requestId);
}

function validationResponse(requestId: string, result: ValidateConfigurationResult): Response {
  switch (result.status) {
    case "valid":
      return success(requestId, 200, ValidatedConfigurationSchema, {
        projectSlug: result.projectSlug,
        valid: true,
        ...(result.wouldCreateProject === true ? { wouldCreateProject: true } : {}),
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "invalid_bundle":
      return problem(
        requestId,
        422,
        "invalid_configuration_bundle",
        "Invalid configuration bundle",
        "Correct the canonical Hub bundle files.",
        result.issues,
      );
    case "invalid_configuration":
      return problem(
        requestId,
        422,
        "invalid_configuration",
        "Invalid configuration",
        "See issues for configuration errors.",
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

async function executeSignedWebhook(
  request: Request,
  requestId: string,
  operations: PublicOperations,
  options: ApiExecutionOptions,
  keyId: string,
  keys: OrganizationApiKeys | undefined,
): Promise<Response> {
  if (options.log !== undefined) {
    options.log.authenticationMode = "hmac";
    options.log.signatureProfile = "github_sha256";
  }
  const proof = await authenticateSignedWebhook(request, requestId, options, keyId, keys);
  if (proof instanceof Response) return proof;
  const { access, bytes } = proof;
  const text = decodeWebhookText(bytes, requestId);
  if (text instanceof Response) return text;
  const payload = parseWebhookPayload(text, "application/json", requestId);
  if (payload instanceof Response) return payload;
  const bodyDigest = githubBodyDigest(bytes);
  const deliveryKey = `github-sha256:${bodyDigest}`;
  const requestedKey = request.headers.get("idempotency-key");
  if (requestedKey !== null && requestedKey !== deliveryKey) {
    return problem(
      requestId,
      400,
      "invalid_request",
      "Invalid request",
      "Idempotency-Key must match the signed body's delivery key when supplied.",
    );
  }
  return deliverWebhook(
    requestId,
    operations,
    options,
    access,
    {
      ...payload,
      trigger: options.hook!.trigger,
      deliveryKey,
      githubSignature: { targetTriggerId: access.targetTriggerId, bodyDigest },
    },
    proof.keys,
  );
}

async function authenticateSignedWebhook(
  request: Request,
  requestId: string,
  options: ApiExecutionOptions,
  keyId: string,
  keys: OrganizationApiKeys | undefined,
): Promise<{ access: WebhookSigner; bytes: Uint8Array; keys: OrganizationApiKeys } | Response> {
  const signature = parseGitHubSignature(request.headers.get("x-hub-signature-256"));
  if (
    signature === undefined ||
    request.headers.has("authorization") ||
    request.headers.has("x-paseo-signature")
  )
    return signedUnauthorized(requestId);

  const state = keys?.signing.availability();
  if (keys === undefined || state === "disabled") return signedUnauthorized(requestId);
  if (state === "unavailable") return signedUnavailable(requestId);

  try {
    if ((await keys.signing.findSigner(keyId)) === undefined) return signedUnauthorized(requestId);
    if (
      webhookMediaType(request.headers.get("content-type")) !== "application/json" ||
      ![null, "identity"].includes(request.headers.get("content-encoding")?.toLowerCase() ?? null)
    ) {
      return problem(
        requestId,
        415,
        "unsupported_media_type",
        "Unsupported media type",
        "Use identity-encoded application/json with UTF-8.",
      );
    }
    const body = await readWebhookBytes(request, requestId, options);
    if (body instanceof Response) return body;
    const verified = await keys.signing.verify(keyId, signature, body);
    if (verified.status === "unauthorized") return signedUnauthorized(requestId);
    if (options.log !== undefined) {
      options.log.keyId = verified.signer.credentialId;
      options.log.matchedSlot = verified.matchedSlot;
    }
    return { access: verified.signer, bytes: body, keys };
  } catch (error) {
    if (error instanceof SigningRequestError || isDatabaseUnavailableError(error)) {
      return signedUnavailable(requestId);
    }
    throw error;
  }
}

function signedUnauthorized(requestId: string): Response {
  const response = problem(
    requestId,
    401,
    "unauthorized",
    "Authentication required",
    "Provide a valid GitHub SHA-256 signature for this signer.",
  );
  response.headers.delete("www-authenticate");
  return response;
}

function signedUnavailable(requestId: string): Response {
  return problem(
    requestId,
    503,
    "authentication_unavailable",
    "Authentication unavailable",
    "Webhook signature authentication is currently unavailable. Retry the request later.",
  );
}

async function deliverWebhook(
  requestId: string,
  operations: PublicOperations,
  options: ApiExecutionOptions,
  access: PublicAuthorization,
  input: ReceiveWebhookInput,
  signingKeys?: OrganizationApiKeys,
): Promise<Response> {
  const bucket = options.limiter.take(access.credentialId);
  if (!bucket.allowed) {
    return problem(
      requestId,
      429,
      "rate_limited",
      "Rate limited",
      "The API key has exceeded its webhook rate limit.",
      undefined,
      { "Retry-After": String(bucket.retryAfter) },
    );
  }
  if (signingKeys !== undefined) {
    try {
      await signingKeys.markUsed(access.credentialId);
    } catch (error) {
      if (isDatabaseUnavailableError(error)) return signedUnavailable(requestId);
      throw error;
    }
  }
  const operation = publicOperation(
    input.githubSignature === undefined ? "receiveWebhook" : "receiveGitHubWebhook",
  );
  const result = await operation.invoke(operations, access, input);
  if (!isWebhookResult(result)) throw new Error("invalid webhook operation result");
  if (
    input.githubSignature !== undefined &&
    (result.status === "actor_forbidden" || result.status === "key_actor_required")
  ) {
    return webhookResponse(requestId, { status: "trigger_not_found" });
  }
  return webhookResponse(requestId, result, input.githubSignature !== undefined);
}

async function readWebhook(
  request: Request,
  requestId: string,
  options: ApiExecutionOptions,
): Promise<ReceiveWebhookInput | Response> {
  const type = webhookMediaType(request.headers.get("content-type"));
  if (type === undefined) {
    return problem(
      requestId,
      415,
      "unsupported_media_type",
      "Unsupported media type",
      "Use application/json or text/plain with UTF-8.",
    );
  }
  const bytes = await readWebhookBytes(request, requestId, options);
  if (bytes instanceof Response) return bytes;
  const text = decodeWebhookText(bytes, requestId);
  if (text instanceof Response) return text;
  const payload = parseWebhookPayload(text, type, requestId);
  if (payload instanceof Response) return payload;
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !/^[\x20-\x7e]{1,200}$/u.test(idempotencyKey)) {
    return problem(
      requestId,
      400,
      "invalid_request",
      "Invalid request",
      "Idempotency-Key must contain 1 to 200 printable ASCII characters.",
    );
  }
  const deliveryKey = idempotencyKey ?? randomUUID();
  if (options.log !== undefined) {
    options.log.deliveryKeyHash = createHash("sha256")
      .update(deliveryKey)
      .digest("hex")
      .slice(0, 12);
  }
  if (options.hook === undefined) throw new Error("webhook route was not validated");
  return { trigger: options.hook.trigger, deliveryKey, ...payload };
}

function webhookMediaType(
  contentType: string | null,
): "application/json" | "text/plain" | undefined {
  const [mediaType, ...parameters] = (contentType ?? "").split(";");
  const type = mediaType?.trim().toLowerCase();
  if (type !== "application/json" && type !== "text/plain") return undefined;
  for (const parameter of parameters) {
    const [name, ...values] = parameter.split("=");
    if (name?.trim().toLowerCase() !== "charset") continue;
    if (
      values
        .join("=")
        .trim()
        .replace(/^"(.*)"$/u, "$1")
        .toLowerCase() !== "utf-8"
    )
      return undefined;
  }
  return type;
}

async function readWebhookBytes(
  request: Request,
  requestId: string,
  options: ApiExecutionOptions,
): Promise<Uint8Array | Response> {
  const declaredLength = request.headers.get("content-length");
  const declaredBytes =
    declaredLength !== null && /^\d+$/u.test(declaredLength) ? Number(declaredLength) : 0;
  const declaredTooLarge =
    Number.isSafeInteger(declaredBytes) && declaredBytes > options.webhookOptions.maxBytes;
  if (options.log !== undefined && declaredTooLarge) options.log.bytes = declaredBytes;
  let countedRequest = request;
  if (!declaredTooLarge && request.body !== null) {
    const body = request.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (options.log !== undefined) options.log.bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    );
    const init: StreamingRequestInit = { body, duplex: "half" };
    countedRequest = new Request(request, init);
  }
  const bytes = await readBoundedRequestBody(countedRequest, options.webhookOptions.maxBytes);
  if (bytes instanceof Response) {
    return problem(
      requestId,
      413,
      "payload_too_large",
      "Payload too large",
      "The request body exceeds the byte limit.",
    );
  }
  return bytes;
}

function decodeWebhookText(bytes: Uint8Array, requestId: string): string | Response {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return problem(
      requestId,
      400,
      "invalid_request",
      "Invalid request",
      "The request body must be valid UTF-8.",
    );
  }
}

function parseWebhookPayload(
  text: string,
  type: "application/json" | "text/plain",
  requestId: string,
): Pick<ReceiveWebhookInput, "input" | "data"> | Response {
  let data: Record<string, unknown> | undefined;
  let input = text;
  if (type === "application/json") {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return problem(requestId, 400, "invalid_json", "Invalid JSON", "Send a valid JSON object.");
    }
    if (!isWebhookObject(value)) {
      return problem(
        requestId,
        422,
        "invalid_body",
        "Invalid body",
        "Send a JSON object with Unicode scalar strings and keys without NUL, finite numbers, maximum depth 20, and at most 1000 keys per object.",
      );
    }
    data = value;
    const message = data["message"];
    if (message !== undefined && typeof message !== "string") {
      return problem(
        requestId,
        422,
        "invalid_input",
        "Invalid trigger input",
        "message must be a string.",
        [{ path: ["message"], message: "Expected a string." }],
      );
    }
    input = message ?? "";
  } else if (text.length === 0 || !hasPostgresText(text)) {
    return problem(
      requestId,
      400,
      "invalid_request",
      "Invalid request",
      "Send a nonempty text body with Unicode scalar text without NUL.",
    );
  }
  if (Buffer.byteLength(input, "utf8") > 65_536) {
    return problem(
      requestId,
      413,
      "payload_too_large",
      "Payload too large",
      "The prompt exceeds the 64 KiB byte limit.",
    );
  }
  return { input, ...(data === undefined ? {} : { data }) };
}

function isWebhookResult(result: PublicOperationResult): result is ReceiveWebhookResult {
  switch (result.status) {
    case "dispatched":
      return "duplicate" in result && typeof result.duplicate === "boolean";
    case "filtered":
    case "invalid_input":
    case "trigger_busy":
    case "key_actor_required":
    case "actor_forbidden":
    case "trigger_not_found":
    case "dispatch_conflict":
    case "infrastructure_unavailable":
      return true;
    default:
      return false;
  }
}

function isWebhookObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isPostgresJson(value, { maxDepth: 20, maxKeysPerObject: 1000 })
  );
}

function webhookResponse(
  requestId: string,
  result: ReceiveWebhookResult,
  signed = false,
): Response {
  switch (result.status) {
    case "dispatched":
      return success(requestId, result.duplicate ? 200 : 202, ReceivedWebhookSchema, {
        deliveryKey: result.deliveryKey,
        providerEventReceiptId: result.providerEventReceiptId,
        triggerRunId: result.triggerRunId,
        configuredTriggerName: result.configuredTriggerName,
        workflowStatus: result.workflowStatus,
        duplicate: result.duplicate,
      });
    case "filtered":
      return success(requestId, result.duplicate ? 200 : 202, ReceivedWebhookSchema, result);
    case "invalid_input":
      return problem(
        requestId,
        422,
        "invalid_input",
        "Invalid trigger input",
        "The submitted input does not match the trigger's declared inputs.",
        result.issues,
      );
    case "trigger_busy":
      return problem(
        requestId,
        429,
        "trigger_busy",
        "Trigger busy",
        "The trigger has reached its active-run limit.",
        undefined,
        { "Retry-After": "30" },
      );
    case "key_actor_required":
    case "actor_forbidden":
      return problem(
        requestId,
        403,
        result.status,
        "Actor forbidden",
        "This credential's actor cannot dispatch the trigger.",
      );
    case "trigger_not_found":
      return problem(
        requestId,
        404,
        result.status,
        "Trigger not found",
        "No allowed enabled manual trigger matches this name.",
      );
    case "dispatch_conflict":
      return problem(
        requestId,
        409,
        result.status,
        "Run not dispatched",
        signed
          ? "Retry with the exact same body and a valid GitHub signature."
          : "Retry the request with the same Idempotency-Key.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  throw new Error("invalid webhook operation result");
}

async function readJson(
  request: Request,
  maxBytes?: number,
): Promise<{ success: true; value: unknown } | { success: false; tooLarge?: boolean }> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { success: false };
  }
  try {
    if (maxBytes !== undefined) {
      const body = await readBoundedRequestBody(request, maxBytes);
      if (body instanceof Response) return { success: false, tooLarge: true };
      return {
        success: true,
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown,
      };
    }
    return { success: true, value: await request.json() };
  } catch {
    return { success: false };
  }
}

function stopRunResponse(requestId: string, result: PublicOperationResult): Response {
  switch (result.status) {
    case "stopped":
      return success(requestId, 200, StoppedRunSchema, {
        runId: result.runId,
        status: result.runStatus,
        ...(result.runStatus === "canceled" ? { note: CANCELED_RUN_NOTE } : {}),
      });
    case "forbidden":
      return problem(
        requestId,
        403,
        "forbidden",
        "Forbidden",
        "Only the person who started the run or an organization admin can stop it.",
      );
    case "run_not_found":
      return problem(
        requestId,
        404,
        "run_not_found",
        "Run not found",
        "The run does not exist in this organization.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
    default:
      throw new Error("invalid run stop result");
  }
}

function validationProblem(
  requestId: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  return problem(
    requestId,
    400,
    "invalid_request",
    "Invalid request",
    "The request body contains invalid fields.",
    issues.map((issue) => ({
      path: issue.path.flatMap((part) => (typeof part === "symbol" ? [] : [part])),
      message: issue.message,
    })),
  );
}

function installationResponse(requestId: string, result: InstallConfigurationResult): Response {
  switch (result.status) {
    case "installed":
      return success(requestId, 201, InstalledConfigurationSchema, {
        projectSlug: result.projectSlug,
        versionId: result.versionId,
        version: result.version,
        active: result.active,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "invalid_bundle":
      return problem(
        requestId,
        422,
        "invalid_configuration_bundle",
        "Invalid configuration bundle",
        "Correct the canonical Hub bundle files and submit them again.",
        result.issues,
      );
    case "invalid_configuration":
      return problem(
        requestId,
        422,
        "invalid_configuration",
        "Invalid configuration",
        `Configuration revision ${result.versionId} was recorded but not activated.`,
        result.issues,
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function manualRunResponse(requestId: string, result: DispatchManualRunResult): Response {
  switch (result.status) {
    case "dispatched":
      return success(requestId, 200, DispatchedManualRunSchema, {
        deliveryKey: result.deliveryKey,
        providerEventReceiptId: result.providerEventReceiptId,
        triggerRunId: result.triggerRunId,
        configuredTriggerName: result.configuredTriggerName,
        workflowStatus: result.workflowStatus,
      });
    case "project_not_found":
      return problem(
        requestId,
        404,
        "project_not_found",
        "Project not found",
        "No active project with that slug exists in the credential's organization.",
      );
    case "key_actor_required":
      return problem(
        requestId,
        403,
        "key_actor_required",
        "Bound actor required",
        "This trigger requires an API key with a bound actor.",
      );
    case "actor_forbidden":
      return problem(
        requestId,
        403,
        "actor_forbidden",
        "Actor forbidden",
        "The configured manual trigger does not allow this actor.",
      );
    case "configuration_not_found":
      return problem(
        requestId,
        404,
        "configuration_not_found",
        "Configuration not found",
        "The requested configuration revision is not available.",
      );
    case "trigger_not_found":
      return problem(
        requestId,
        404,
        "trigger_not_found",
        "Trigger not found",
        "The active configuration has no matching manual trigger.",
      );
    case "expected_configuration_not_current":
      return problem(
        requestId,
        409,
        "configuration_changed",
        "Configuration changed",
        "expectedVersionId is not the configuration version selected for this delivery.",
      );
    case "daemon_offline":
      return problem(
        requestId,
        409,
        "daemon_offline",
        "Daemon offline",
        "The selected daemon is not connected. Reconnect it before retrying.",
      );
    case "invalid_input":
      return problem(
        requestId,
        400,
        "invalid_input",
        "Invalid trigger input",
        "The submitted input does not match the trigger's declared inputs.",
        result.issues,
      );
    case "dispatch_conflict":
      return problem(
        requestId,
        409,
        "dispatch_conflict",
        "Run not dispatched",
        "The durable event exists but no matching run is available yet. Retry with the same deliveryKey.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function enrollmentResponse(requestId: string, result: IssueEnrollmentTokenResult): Response {
  switch (result.status) {
    case "issued":
      return success(requestId, 201, EnrollmentTokenSchema, {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    case "credential_revoked":
      return problem(
        requestId,
        401,
        "unauthorized",
        "Authentication required",
        "The organization credential was revoked before the enrollment token could be issued.",
      );
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function infrastructureProblem(requestId: string): Response {
  return problem(
    requestId,
    503,
    "infrastructure_unavailable",
    "Service unavailable",
    "The operation could not reach durable storage. Retry the request later.",
  );
}

function success(
  requestId: string,
  status: number,
  schema: { parse(value: unknown): unknown },
  value: unknown,
): Response {
  const body = schema.parse(value);
  const response = Response.json(body, { status, headers: { "x-request-id": requestId } });
  responseMetadata.set(response, {
    code: null,
    duplicate:
      typeof body === "object" && body !== null && "duplicate" in body
        ? Boolean(body.duplicate)
        : null,
  });
  return response;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled public operation result: ${String(value)}`);
}

function problem(
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
  issues?: readonly { path: readonly (string | number)[]; message: string }[],
  headers?: Readonly<Record<string, string>>,
): Response {
  const response = problemResponse(requestId, status, code, title, detail, issues, headers);
  responseMetadata.set(response, { code, duplicate: null });
  return response;
}

function isInstallationResult(result: PublicOperationResult): result is InstallConfigurationResult {
  return [
    "installed",
    "project_not_found",
    "invalid_bundle",
    "invalid_configuration",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isTriggerValidationResult(result: PublicOperationResult): result is ValidateTriggerResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "invalid_trigger" ||
    (result.status === "valid" && "name" in result)
  );
}

function isTriggerInstallationResult(
  result: PublicOperationResult,
): result is InstallTriggerResult {
  return (
    result.status === "infrastructure_unavailable" ||
    result.status === "invalid_trigger" ||
    (result.status === "installed" && "triggerId" in result)
  );
}

function isProjectsResult(result: PublicOperationResult): result is ListProjectsResult {
  return ["listed", "infrastructure_unavailable"].includes(result.status);
}

function isTriggersResult(result: PublicOperationResult): result is ListTriggersResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "triggers" in result)
  );
}

function isConfigurationResourcesResult(
  result: PublicOperationResult,
): result is ListConfigurationResourcesResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "daemons" in result)
  );
}

function isSetupResourcesResult(result: PublicOperationResult): result is ListSetupResourcesResult {
  return (
    result.status === "infrastructure_unavailable" ||
    (result.status === "listed" && "github" in result)
  );
}

function isValidationResult(result: PublicOperationResult): result is ValidateConfigurationResult {
  return [
    "valid",
    "project_not_found",
    "invalid_bundle",
    "invalid_configuration",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isManualRunResult(result: PublicOperationResult): result is DispatchManualRunResult {
  return [
    "dispatched",
    "project_not_found",
    "actor_forbidden",
    "key_actor_required",
    "daemon_offline",
    "expected_configuration_not_current",
    "configuration_not_found",
    "trigger_not_found",
    "invalid_input",
    "dispatch_conflict",
    "infrastructure_unavailable",
  ].includes(result.status);
}

function isEnrollmentResult(result: PublicOperationResult): result is IssueEnrollmentTokenResult {
  return ["issued", "credential_revoked", "infrastructure_unavailable"].includes(result.status);
}

export { publicOpenApiDocument } from "./openapi.js";
export { publicOperationManifest } from "./operation-manifest.js";
export * from "./contracts.js";
