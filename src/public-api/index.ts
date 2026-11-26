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
import { stopCleanupNotes, stopCoalescedNote, type StopRunResult } from "../triggers/run-stop.js";
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

interface ApiRequest {
  request: Request;
  requestId: string;
  options: ApiExecutionOptions;
}

interface ApiRuntime {
  composition: PublicApiComposition;
  operations: PublicOperations | null;
}

interface SignedWebhookRoute {
  trigger: string;
  keyId: string;
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
  const segment = match?.[1];
  if (match === null || segment === undefined) return undefined;
  try {
    const trigger = decodeURIComponent(segment);
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
      { request, requestId, options: execution },
      { composition, operations },
      operationId,
    );
    if (log !== undefined) {
      logWebhookResponse(logger, log, response, {
        durationMs: Math.max(0, now() - startedAt),
        webhookOptions,
      });
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
  context: ApiRequest,
  runtime: ApiRuntime,
  operationId?: PublicOperationId,
): Promise<Response> {
  const { request, requestId, options } = context;
  if (options.log !== undefined) return routeWebhook(context, runtime, options.log);
  if (operationId !== undefined) return executeSafely(operationId, context, runtime);
  const pathname = new URL(request.url).pathname;
  const routes = publicOperationManifest.filter(
    (route) => operationPathMatch(route, pathname) !== undefined,
  );
  if (routes.length === 0) {
    return problem(requestId, {
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "No canonical API route matches this path.",
    });
  }
  const route = routes.find(
    (candidate) => candidate.method.toUpperCase() === request.method.toUpperCase(),
  );
  if (route === undefined) {
    return problem(requestId, {
      status: 405,
      code: "method_not_allowed",
      title: "Method not allowed",
      detail: "Use one of the methods listed in the Allow response header.",
      headers: { Allow: routes.map(({ method }) => method.toUpperCase()).join(", ") },
    });
  }
  return executeSafely(route.id, context, runtime);
}

function routeWebhook(
  context: ApiRequest,
  runtime: ApiRuntime,
  log: WebhookRequestLog,
): Response | Promise<Response> {
  const { request, requestId, options } = context;
  if (request.method.toUpperCase() !== "POST") {
    return problem(requestId, {
      status: 405,
      code: "method_not_allowed",
      title: "Method not allowed",
      detail: "Use POST.",
      headers: { Allow: "POST" },
    });
  }
  if (log.trigger === null) {
    return problem(requestId, {
      status: 404,
      code: "trigger_not_found",
      title: "Trigger not found",
      detail: "No matching webhook trigger exists.",
    });
  }
  const { hook } = options;
  if (hook?.keyId !== undefined) {
    return executeSafely("receiveGitHubWebhook", context, runtime, {
      keyId: hook.keyId,
      trigger: hook.trigger,
    });
  }
  return executeSafely("receiveWebhook", context, runtime);
}

function logWebhookResponse(
  logger: Pick<Logger, "info" | "warn">,
  log: WebhookRequestLog,
  response: Response,
  { durationMs, webhookOptions }: { durationMs: number; webhookOptions: WebhookOptions },
): void {
  const metadata = responseMetadata.get(response);
  const code = metadata?.code ?? null;
  const limit = webhookLogLimit(response.status, code, log, webhookOptions);
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
  if (isWebhookWarning(response.status)) logger.warn(fields);
  else logger.info(fields);
}

function webhookLogLimit(
  status: number,
  code: string | null,
  log: WebhookRequestLog,
  options: WebhookOptions,
): string | undefined {
  if (status === 413) return log.bytes > options.maxBytes ? "maxBytes" : "messageBytes";
  if (status === 429) return code === "trigger_busy" ? "maxActiveRuns" : "ratePerMinute";
  return undefined;
}

function isWebhookWarning(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401;
}

function signedFailureCategory(status: number): string {
  if (status === 401) return "auth_rejected";
  if (status === 503) return "unavailable";
  if (status === 400 || status === 413 || status === 415) return "representation";
  return "dispatch";
}

async function executeSafely(
  id: PublicOperationId,
  context: ApiRequest,
  { composition, operations }: ApiRuntime,
  signedRoute?: SignedWebhookRoute,
): Promise<Response> {
  const { requestId } = context;
  try {
    if (composition.status === "unavailable" || operations === null) {
      return problem(requestId, {
        status: 503,
        code: "infrastructure_unavailable",
        title: "Service unavailable",
        detail: "Public API authentication or storage is currently unavailable.",
      });
    }
    if (signedRoute !== undefined) {
      return await executeSignedWebhook(context, operations, signedRoute, composition.webhookKeys);
    }
    if (id === "receiveGitHubWebhook") {
      throw new TypeError("Cannot read properties of undefined (reading 'keyId')");
    }
    return await execute(id, context, composition.authenticator, operations);
  } catch (error) {
    return operationFailure(id, context, error);
  }
}

function operationFailure(
  id: PublicOperationId,
  { requestId, options }: ApiRequest,
  error: unknown,
): Response {
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
  return problem(requestId, {
    status: 500,
    code: "internal_error",
    title: "Internal server error",
    detail: "The operation failed unexpectedly. Contact the Hub operator with the request ID.",
  });
}

async function execute(
  id: PublicOperationId,
  context: ApiRequest,
  authenticator: OperationAuthenticator,
  operations: PublicOperations,
): Promise<Response> {
  const { request, requestId } = context;
  const definition = publicOperation(id);
  const scope = definition.scope;
  let authorization;
  try {
    authorization = await authenticator.authorize(request, scope);
  } catch (error) {
    if (!isDatabaseUnavailableError(error)) throw error;
    return problem(requestId, {
      status: 503,
      code: "authentication_unavailable",
      title: "Authentication unavailable",
      detail: "Bearer-credential authentication is currently unavailable. Retry the request later.",
    });
  }
  if (authorization.status === "unauthorized") {
    return problem(requestId, {
      status: 401,
      code: "unauthorized",
      title: "Authentication required",
      detail:
        "Provide an active Paseo organization credential in the Authorization: Bearer header.",
    });
  }
  if (authorization.status === "forbidden") {
    return problem(requestId, {
      status: 403,
      code: "insufficient_scope",
      title: "Insufficient scope",
      detail: `This operation requires the ${scope} scope.`,
    });
  }
  const { access } = authorization;
  if (definition.webhook) return executeBearerWebhook(context, operations, access);
  return executeAuthorized(context, operations, { id, definition, access });
}

async function executeBearerWebhook(
  context: ApiRequest,
  operations: PublicOperations,
  access: PublicAuthorization,
): Promise<Response> {
  const { request, requestId, options } = context;
  if (options.log !== undefined) options.log.keyId = access.credentialId;
  if (access.kind !== "apiKey" || !access.actor) {
    return problem(requestId, {
      status: 403,
      code: "key_actor_required",
      title: "Bound actor required",
      detail: "Use an API key with a bound actor.",
    });
  }
  const parsed = await readWebhook(request, requestId, options);
  if (parsed instanceof Response) return parsed;
  return deliverWebhook(context, operations, access, { input: parsed });
}

async function executeAuthorized(
  context: ApiRequest,
  operations: PublicOperations,
  {
    id,
    definition,
    access,
  }: {
    id: PublicOperationId;
    definition: PublicOperationDefinition;
    access: PublicAuthorization;
  },
): Promise<Response> {
  const { request, requestId, options } = context;
  let input: unknown;
  if (definition.pathSchema !== undefined) {
    const parsed = definition.pathSchema.safeParse(
      operationPathMatch(definition, new URL(request.url).pathname),
    );
    if (!parsed.success)
      return problem(requestId, {
        status: 400,
        code: "invalid_request",
        title: "Invalid run ID",
        detail: "Use a UUID for the run ID.",
      });
    input = parsed.data;
  }
  if (definition.requestSchema !== undefined) {
    const parsedBody = await readJson(
      request,
      id === "dispatchManualRun" ? options.webhookOptions.maxBytes : undefined,
    );
    if (!parsedBody.success) return invalidOperationBody(requestId, parsedBody.tooLarge);
    const parsed = definition.requestSchema.safeParse(parsedBody.value);
    if (!parsed.success) {
      return validationProblem(requestId, parsed.error.issues);
    }
    input = parsed.data;
  }
  const result = await definition.invoke(operations, access, input);
  return mapOperationResult(definition.resultMapping, requestId, result);
}

function invalidOperationBody(requestId: string, tooLarge: boolean | undefined): Response {
  if (tooLarge) {
    return problem(requestId, {
      status: 413,
      code: "payload_too_large",
      title: "Payload too large",
      detail: "The request body exceeds the byte limit.",
    });
  }
  return problem(requestId, {
    status: 400,
    code: "invalid_json",
    title: "Invalid JSON",
    detail: "Send a JSON request body using Content-Type: application/json.",
  });
}

type OperationResponse = (requestId: string, result: PublicOperationResult) => Response;

function mapOperationResult(
  mapping: PublicOperationDefinition["resultMapping"],
  requestId: string,
  result: PublicOperationResult,
): Response {
  const respond = lookupOperationStatus(operationResponses, mapping);
  if (respond === undefined) return unhandledResult(mapping);
  return respond(requestId, result);
}

function checkedResponse<T extends PublicOperationResult>(
  accepts: (result: PublicOperationResult) => result is T,
  respond: (requestId: string, result: T) => Response,
  error: string,
): OperationResponse {
  return (requestId, result) => {
    if (!accepts(result)) throw new Error(error);
    return respond(requestId, result);
  };
}

const operationResponses = {
  "run-stop": stopRunResponse,
  triggers: checkedResponse(
    isTriggersResult,
    triggersResponse,
    "invalid triggers operation result",
  ),
  "trigger-validation": checkedResponse(
    isTriggerValidationResult,
    triggerValidationResponse,
    "invalid trigger validation result",
  ),
  "trigger-installation": checkedResponse(
    isTriggerInstallationResult,
    triggerInstallationResponse,
    "invalid trigger installation result",
  ),
  projects: checkedResponse(
    isProjectsResult,
    projectsResponse,
    "invalid projects operation result",
  ),
  "configuration-resources": checkedResponse(
    isConfigurationResourcesResult,
    configurationResourcesResponse,
    "invalid configuration resources operation result",
  ),
  "setup-resources": checkedResponse(
    isSetupResourcesResult,
    setupResourcesResponse,
    "invalid setup resources operation result",
  ),
  validation: checkedResponse(
    isValidationResult,
    validationResponse,
    "invalid validation operation result",
  ),
  configuration: checkedResponse(
    isInstallationResult,
    installationResponse,
    "invalid configuration operation result",
  ),
  "manual-run": checkedResponse(
    isManualRunResult,
    manualRunResponse,
    "invalid manual-run operation result",
  ),
  webhook: checkedResponse(isWebhookResult, webhookResponse, "invalid webhook operation result"),
  "enrollment-token": checkedResponse(
    isEnrollmentResult,
    enrollmentResponse,
    "invalid enrollment operation result",
  ),
} satisfies Record<PublicOperationDefinition["resultMapping"], OperationResponse>;

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
      return problem(requestId, {
        status: 422,
        code: "invalid_trigger",
        title: "Invalid trigger",
        detail: "Correct the self-contained trigger YAML.",
        issues: result.issues,
      });
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
      return problem(requestId, {
        status: 422,
        code: "invalid_trigger",
        title: "Invalid trigger",
        detail: "Correct the self-contained trigger YAML and submit it again.",
        issues: result.issues,
      });
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
      return problem(requestId, {
        status: 404,
        code: "project_not_found",
        title: "Project not found",
        detail: "No active project with that slug exists in the credential's organization.",
      });
    case "invalid_bundle":
      return problem(requestId, {
        status: 422,
        code: "invalid_configuration_bundle",
        title: "Invalid configuration bundle",
        detail: "Correct the canonical Hub bundle files.",
        issues: result.issues,
      });
    case "invalid_configuration":
      return problem(requestId, {
        status: 422,
        code: "invalid_configuration",
        title: "Invalid configuration",
        detail: "See issues for configuration errors.",
        issues: result.issues,
      });
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

async function executeSignedWebhook(
  context: ApiRequest,
  operations: PublicOperations,
  route: SignedWebhookRoute,
  keys: OrganizationApiKeys | undefined,
): Promise<Response> {
  const { request, requestId, options } = context;
  if (options.log !== undefined) {
    options.log.authenticationMode = "hmac";
    options.log.signatureProfile = "github_sha256";
  }
  const proof = await authenticateSignedWebhook(context, route.keyId, keys);
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
    return problem(requestId, {
      status: 400,
      code: "invalid_request",
      title: "Invalid request",
      detail: "Idempotency-Key must match the signed body's delivery key when supplied.",
    });
  }
  return deliverWebhook(context, operations, access, {
    input: {
      ...payload,
      trigger: route.trigger,
      deliveryKey,
      githubSignature: { targetTriggerId: access.targetTriggerId, bodyDigest },
    },
    signingKeys: proof.keys,
  });
}

async function authenticateSignedWebhook(
  { request, requestId, options }: ApiRequest,
  keyId: string,
  configuredKeys: OrganizationApiKeys | undefined,
): Promise<{ access: WebhookSigner; bytes: Uint8Array; keys: OrganizationApiKeys } | Response> {
  const signature = signedRequestSignature(request);
  if (signature === undefined) return signedUnauthorized(requestId);

  const keys = availableSigningKeys(configuredKeys, requestId);
  if (keys instanceof Response) return keys;

  try {
    if ((await keys.signing.findSigner(keyId)) === undefined) return signedUnauthorized(requestId);
    if (!hasSignedWebhookMediaType(request)) {
      return problem(requestId, {
        status: 415,
        code: "unsupported_media_type",
        title: "Unsupported media type",
        detail: "Use identity-encoded application/json with UTF-8.",
      });
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
    return signedAuthenticationFailure(requestId, error);
  }
}

function availableSigningKeys(
  keys: OrganizationApiKeys | undefined,
  requestId: string,
): OrganizationApiKeys | Response {
  const state = keys?.signing.availability();
  if (keys === undefined || state === "disabled") return signedUnauthorized(requestId);
  if (state === "unavailable") return signedUnavailable(requestId);

  return keys;
}

function signedAuthenticationFailure(requestId: string, error: unknown): Response {
  if (error instanceof SigningRequestError || isDatabaseUnavailableError(error)) {
    return signedUnavailable(requestId);
  }
  throw error;
}

function signedRequestSignature(request: Request): Buffer | undefined {
  const signature = parseGitHubSignature(request.headers.get("x-hub-signature-256"));
  if (
    signature === undefined ||
    request.headers.has("authorization") ||
    request.headers.has("x-paseo-signature")
  )
    return undefined;
  return signature;
}

function hasSignedWebhookMediaType(request: Request): boolean {
  return (
    webhookMediaType(request.headers.get("content-type")) === "application/json" &&
    [null, "identity"].includes(request.headers.get("content-encoding")?.toLowerCase() ?? null)
  );
}

function signedUnauthorized(requestId: string): Response {
  const response = problem(requestId, {
    status: 401,
    code: "unauthorized",
    title: "Authentication required",
    detail: "Provide a valid GitHub SHA-256 signature for this signer.",
  });
  response.headers.delete("www-authenticate");
  return response;
}

function signedUnavailable(requestId: string): Response {
  return problem(requestId, {
    status: 503,
    code: "authentication_unavailable",
    title: "Authentication unavailable",
    detail: "Webhook signature authentication is currently unavailable. Retry the request later.",
  });
}

async function deliverWebhook(
  { requestId, options }: ApiRequest,
  operations: PublicOperations,
  access: PublicAuthorization,
  { input, signingKeys }: { input: ReceiveWebhookInput; signingKeys?: OrganizationApiKeys },
): Promise<Response> {
  const bucket = options.limiter.take(access.credentialId);
  if (!bucket.allowed) {
    return problem(requestId, {
      status: 429,
      code: "rate_limited",
      title: "Rate limited",
      detail: "The API key has exceeded its webhook rate limit.",
      headers: { "Retry-After": String(bucket.retryAfter) },
    });
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
    return problem(requestId, {
      status: 415,
      code: "unsupported_media_type",
      title: "Unsupported media type",
      detail: "Use application/json or text/plain with UTF-8.",
    });
  }
  const bytes = await readWebhookBytes(request, requestId, options);
  if (bytes instanceof Response) return bytes;
  const text = decodeWebhookText(bytes, requestId);
  if (text instanceof Response) return text;
  const payload = parseWebhookPayload(text, type, requestId);
  if (payload instanceof Response) return payload;
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !/^[\x20-\x7e]{1,200}$/u.test(idempotencyKey)) {
    return problem(requestId, {
      status: 400,
      code: "invalid_request",
      title: "Invalid request",
      detail: "Idempotency-Key must contain 1 to 200 printable ASCII characters.",
    });
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
    return problem(requestId, {
      status: 413,
      code: "payload_too_large",
      title: "Payload too large",
      detail: "The request body exceeds the byte limit.",
    });
  }
  return bytes;
}

function decodeWebhookText(bytes: Uint8Array, requestId: string): string | Response {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return problem(requestId, {
      status: 400,
      code: "invalid_request",
      title: "Invalid request",
      detail: "The request body must be valid UTF-8.",
    });
  }
}

type WebhookPayload = Pick<ReceiveWebhookInput, "input" | "data">;

function parseWebhookPayload(
  text: string,
  type: "application/json" | "text/plain",
  requestId: string,
): WebhookPayload | Response {
  const payload =
    type === "application/json"
      ? parseWebhookJson(text, requestId)
      : parseWebhookText(text, requestId);
  if (payload instanceof Response) return payload;
  if (Buffer.byteLength(payload.input, "utf8") > 65_536) {
    return problem(requestId, {
      status: 413,
      code: "payload_too_large",
      title: "Payload too large",
      detail: "The prompt exceeds the 64 KiB byte limit.",
    });
  }
  return payload;
}

function parseWebhookText(text: string, requestId: string): WebhookPayload | Response {
  if (text.length === 0 || !hasPostgresText(text)) {
    return problem(requestId, {
      status: 400,
      code: "invalid_request",
      title: "Invalid request",
      detail: "Send a nonempty text body with Unicode scalar text without NUL.",
    });
  }
  return { input: text };
}

function parseWebhookJson(text: string, requestId: string): WebhookPayload | Response {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return problem(requestId, {
      status: 400,
      code: "invalid_json",
      title: "Invalid JSON",
      detail: "Send a valid JSON object.",
    });
  }
  if (!isWebhookObject(value)) {
    return problem(requestId, {
      status: 422,
      code: "invalid_body",
      title: "Invalid body",
      detail:
        "Send a JSON object with Unicode scalar strings and keys without NUL, finite numbers, maximum depth 20, and at most 1000 keys per object.",
    });
  }
  const message = value["message"];
  if (message !== undefined && typeof message !== "string") {
    return problem(requestId, {
      status: 422,
      code: "invalid_input",
      title: "Invalid trigger input",
      detail: "message must be a string.",
      issues: [{ path: ["message"], message: "Expected a string." }],
    });
  }
  return { input: message ?? "", data: value };
}

const webhookResultStatus: Record<
  Exclude<PublicOperationResult["status"], "dispatched">,
  boolean
> = {
  actor_forbidden: true,
  configuration_not_found: false,
  conflict: false,
  credential_revoked: false,
  daemon_offline: false,
  dispatch_conflict: true,
  expected_configuration_not_current: false,
  filtered: true,
  forbidden: false,
  infrastructure_unavailable: true,
  installed: false,
  invalid_bundle: false,
  invalid_configuration: false,
  invalid_input: true,
  invalid_trigger: false,
  issued: false,
  key_actor_required: true,
  listed: false,
  project_not_found: false,
  run_not_found: false,
  stopped: false,
  trigger_busy: true,
  trigger_not_found: true,
  valid: false,
};

function isWebhookResult(result: PublicOperationResult): result is ReceiveWebhookResult {
  const { status } = result;
  if (status === "dispatched") {
    return "duplicate" in result && typeof result.duplicate === "boolean";
  }
  return lookupOperationStatus(webhookResultStatus, status) === true;
}

function lookupOperationStatus<T>(statuses: Readonly<Record<string, T>>, status: unknown) {
  if (typeof status !== "string" || !Object.hasOwn(statuses, status)) return undefined;
  return statuses[status];
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
  const { status } = result;
  if (status === "dispatched") {
    return success(requestId, result.duplicate ? 200 : 202, ReceivedWebhookSchema, {
      deliveryKey: result.deliveryKey,
      providerEventReceiptId: result.providerEventReceiptId,
      triggerRunId: result.triggerRunId,
      configuredTriggerName: result.configuredTriggerName,
      workflowStatus: result.workflowStatus,
      duplicate: result.duplicate,
    });
  }
  if (status === "filtered") {
    return success(requestId, result.duplicate ? 200 : 202, ReceivedWebhookSchema, result);
  }
  if (status === "invalid_input") {
    return problem(requestId, {
      status: 422,
      code: "invalid_input",
      title: "Invalid trigger input",
      detail: "The submitted input does not match the trigger's declared inputs.",
      issues: result.issues,
    });
  }
  return webhookProblem(requestId, status, result, signed);
}

function webhookProblem(
  requestId: string,
  status: Exclude<ReceiveWebhookResult["status"], "dispatched" | "filtered" | "invalid_input">,
  result: ReceiveWebhookResult,
  signed: boolean,
): Response {
  switch (status) {
    case "trigger_busy":
      return problem(requestId, {
        status: 429,
        code: "trigger_busy",
        title: "Trigger busy",
        detail: "The trigger has reached its active-run limit.",
        headers: { "Retry-After": "30" },
      });
    case "key_actor_required":
    case "actor_forbidden":
      return problem(requestId, {
        status: 403,
        code: result.status,
        title: "Actor forbidden",
        detail: "This credential's actor cannot dispatch the trigger.",
      });
    case "trigger_not_found":
      return problem(requestId, {
        status: 404,
        code: result.status,
        title: "Trigger not found",
        detail: "No allowed enabled manual trigger matches this name.",
      });
    case "dispatch_conflict":
      return problem(requestId, {
        status: 409,
        code: result.status,
        title: "Run not dispatched",
        detail: signed
          ? "Retry with the exact same body and a valid GitHub signature."
          : "Retry the request with the same Idempotency-Key.",
      });
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

const stopRunProblemStatus: Record<
  Exclude<PublicOperationResult["status"], "stopped" | "infrastructure_unavailable">,
  403 | 404 | null
> = {
  actor_forbidden: null,
  configuration_not_found: null,
  conflict: null,
  credential_revoked: null,
  daemon_offline: null,
  dispatch_conflict: null,
  dispatched: null,
  expected_configuration_not_current: null,
  filtered: null,
  forbidden: 403,
  installed: null,
  invalid_bundle: null,
  invalid_configuration: null,
  invalid_input: null,
  invalid_trigger: null,
  issued: null,
  key_actor_required: null,
  listed: null,
  project_not_found: null,
  run_not_found: 404,
  trigger_busy: null,
  trigger_not_found: null,
  valid: null,
};

function stopRunResponse(requestId: string, result: PublicOperationResult): Response {
  const { status } = result;
  if (status === "stopped") return stoppedRunResponse(requestId, result);
  if (status === "infrastructure_unavailable") return infrastructureProblem(requestId);
  return stopRunProblem(requestId, lookupOperationStatus(stopRunProblemStatus, status));
}

function stoppedRunResponse(
  requestId: string,
  result: Extract<StopRunResult, { status: "stopped" }>,
): Response {
  let note =
    result.cleanupState === "waiting_for_daemon" ? stopCleanupNotes.waiting_for_daemon : null;
  if (result.coalesced) note = stopCoalescedNote;
  return success(requestId, 200, StoppedRunSchema, {
    runId: result.runId,
    status: result.runStatus,
    cleanupState: result.cleanupState,
    ...(note === null ? {} : { note }),
  });
}

function stopRunProblem(requestId: string, status: 403 | 404 | null | undefined): Response {
  if (status === 403) {
    return problem(requestId, {
      status: 403,
      code: "forbidden",
      title: "Forbidden",
      detail: "Only the person who started the run or an organization admin can stop it.",
    });
  }
  if (status === 404) {
    return problem(requestId, {
      status: 404,
      code: "run_not_found",
      title: "Run not found",
      detail: "The run does not exist in this organization.",
    });
  }
  throw new Error("invalid run stop result");
}

function validationProblem(
  requestId: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Response {
  return problem(requestId, {
    status: 400,
    code: "invalid_request",
    title: "Invalid request",
    detail: "The request body contains invalid fields.",
    issues: issues.map((issue) => ({
      path: issue.path.flatMap((part) => (typeof part === "symbol" ? [] : [part])),
      message: issue.message,
    })),
  });
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
      return problem(requestId, {
        status: 404,
        code: "project_not_found",
        title: "Project not found",
        detail: "No active project with that slug exists in the credential's organization.",
      });
    case "invalid_bundle":
      return problem(requestId, {
        status: 422,
        code: "invalid_configuration_bundle",
        title: "Invalid configuration bundle",
        detail: "Correct the canonical Hub bundle files and submit them again.",
        issues: result.issues,
      });
    case "invalid_configuration":
      return problem(requestId, {
        status: 422,
        code: "invalid_configuration",
        title: "Invalid configuration",
        detail: `Configuration revision ${result.versionId} was recorded but not activated.`,
        issues: result.issues,
      });
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

const manualRunProblems = {
  project_not_found: {
    status: 404,
    code: "project_not_found",
    title: "Project not found",
    detail: "No active project with that slug exists in the credential's organization.",
  },
  key_actor_required: {
    status: 403,
    code: "key_actor_required",
    title: "Bound actor required",
    detail: "This trigger requires an API key with a bound actor.",
  },
  actor_forbidden: {
    status: 403,
    code: "actor_forbidden",
    title: "Actor forbidden",
    detail: "The configured manual trigger does not allow this actor.",
  },
  configuration_not_found: {
    status: 404,
    code: "configuration_not_found",
    title: "Configuration not found",
    detail: "The requested configuration revision is not available.",
  },
  trigger_not_found: {
    status: 404,
    code: "trigger_not_found",
    title: "Trigger not found",
    detail: "The active configuration has no matching manual trigger.",
  },
  expected_configuration_not_current: {
    status: 409,
    code: "configuration_changed",
    title: "Configuration changed",
    detail: "expectedVersionId is not the configuration version selected for this delivery.",
  },
  daemon_offline: {
    status: 409,
    code: "daemon_offline",
    title: "Daemon offline",
    detail: "The selected daemon is not connected. Reconnect it before retrying.",
  },
  dispatch_conflict: {
    status: 409,
    code: "dispatch_conflict",
    title: "Run not dispatched",
    detail:
      "The durable event exists but no matching run is available yet. Retry with the same deliveryKey.",
  },
} satisfies Record<
  Exclude<
    DispatchManualRunResult["status"],
    "dispatched" | "invalid_input" | "infrastructure_unavailable"
  >,
  OperationProblem
>;

function manualRunResponse(requestId: string, result: DispatchManualRunResult): Response {
  const { status } = result;
  if (status === "dispatched") {
    return success(requestId, 200, DispatchedManualRunSchema, {
      deliveryKey: result.deliveryKey,
      providerEventReceiptId: result.providerEventReceiptId,
      triggerRunId: result.triggerRunId,
      configuredTriggerName: result.configuredTriggerName,
      workflowStatus: result.workflowStatus,
    });
  }
  if (status === "invalid_input") {
    return problem(requestId, {
      status: 400,
      code: "invalid_input",
      title: "Invalid trigger input",
      detail: "The submitted input does not match the trigger's declared inputs.",
      issues: result.issues,
    });
  }
  if (status === "infrastructure_unavailable") return infrastructureProblem(requestId);
  const rejection = lookupOperationStatus(manualRunProblems, status);
  if (rejection === undefined) return unhandledResult(result);
  return problem(requestId, rejection);
}

function enrollmentResponse(requestId: string, result: IssueEnrollmentTokenResult): Response {
  switch (result.status) {
    case "issued":
      return success(requestId, 201, EnrollmentTokenSchema, {
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    case "credential_revoked":
      return problem(requestId, {
        status: 401,
        code: "unauthorized",
        title: "Authentication required",
        detail:
          "The organization credential was revoked before the enrollment token could be issued.",
      });
    case "infrastructure_unavailable":
      return infrastructureProblem(requestId);
  }
  return assertNever(result);
}

function infrastructureProblem(requestId: string): Response {
  return problem(requestId, {
    status: 503,
    code: "infrastructure_unavailable",
    title: "Service unavailable",
    detail: "The operation could not reach durable storage. Retry the request later.",
  });
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
  return unhandledResult(value);
}

function unhandledResult(value: unknown): never {
  throw new Error(`Unhandled public operation result: ${String(value)}`);
}

interface OperationProblem {
  status: number;
  code: string;
  title: string;
  detail: string;
  issues?: readonly { path: readonly (string | number)[]; message: string }[];
  headers?: Readonly<Record<string, string>>;
}

function problem(
  requestId: string,
  { status, code, title, detail, issues, headers }: OperationProblem,
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
