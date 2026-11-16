import type { ApiKeyScope } from "../auth/api-key-contract.js";
import type {
  DispatchManualRunResult,
  ReceiveWebhookResult,
  InstallConfigurationResult,
  InstallTriggerResult,
  IssueEnrollmentTokenResult,
  ListConfigurationResourcesResult,
  ListSetupResourcesResult,
  ListProjectsResult,
  ListTriggersResult,
  PublicOperations,
  ValidateConfigurationResult,
  ValidateTriggerResult,
} from "../public-operations/index.js";
import {
  DispatchManualRunRequestSchema,
  DispatchedManualRunSchema,
  ReceivedWebhookSchema,
  ReceiveWebhookInputSchema,
  EnrollmentTokenSchema,
  InstallConfigurationRequestSchema,
  InstalledConfigurationSchema,
  InstalledTriggerSchema,
  ProjectListSchema,
  TriggerListSchema,
  ConfigurationResourcesSchema,
  SetupResourcesSchema,
  ValidatedConfigurationSchema,
  TriggerYamlRequestSchema,
  ValidatedTriggerSchema,
} from "./contracts.js";

export type PublicOperationId =
  | "listTriggers"
  | "validateTrigger"
  | "installTrigger"
  | "listProjects"
  | "listConfigurationResources"
  | "listSetupResources"
  | "validateConfiguration"
  | "installConfiguration"
  | "dispatchManualRun"
  | "receiveWebhook"
  | "issueEnrollmentToken";

export interface PublicOperationDefinition {
  id: PublicOperationId;
  method: "get" | "post";
  path: string;
  scope: ApiKeyScope;
  requestSchema?:
    | typeof InstallConfigurationRequestSchema
    | typeof DispatchManualRunRequestSchema
    | typeof TriggerYamlRequestSchema;
  successSchema:
    | typeof InstalledTriggerSchema
    | typeof ValidatedTriggerSchema
    | typeof InstalledConfigurationSchema
    | typeof ValidatedConfigurationSchema
    | typeof ProjectListSchema
    | typeof TriggerListSchema
    | typeof ConfigurationResourcesSchema
    | typeof SetupResourcesSchema
    | typeof DispatchedManualRunSchema
    | typeof EnrollmentTokenSchema
    | typeof ReceivedWebhookSchema;
  successStatus: 200 | 201 | 202;
  webhook?: boolean;
  resultMapping:
    | "trigger-validation"
    | "triggers"
    | "trigger-installation"
    | "projects"
    | "configuration-resources"
    | "setup-resources"
    | "validation"
    | "configuration"
    | "manual-run"
    | "webhook"
    | "enrollment-token";
  summary: string;
  description: string;
  tag: "Triggers" | "Projects" | "Configurations" | "Runs" | "Daemons" | "Webhooks";
  responses: Readonly<Record<number, string>>;
  invoke(
    operations: PublicOperations,
    authorization: Parameters<PublicOperations["issueEnrollmentToken"]>[0],
    input: unknown,
  ): Promise<
    | ListProjectsResult
    | ListTriggersResult
    | ValidateTriggerResult
    | InstallTriggerResult
    | ListConfigurationResourcesResult
    | ListSetupResourcesResult
    | ValidateConfigurationResult
    | InstallConfigurationResult
    | DispatchManualRunResult
    | ReceiveWebhookResult
    | IssueEnrollmentTokenResult
  >;
}

export const publicOperationManifest: readonly PublicOperationDefinition[] = [
  {
    id: "listTriggers",
    method: "get",
    path: "/api/v1/triggers",
    scope: "configuration:validate",
    successSchema: TriggerListSchema,
    successStatus: 200,
    resultMapping: "triggers",
    summary: "List triggers",
    description: "Lists active organization triggers with their deployable YAML documents.",
    tag: "Triggers",
    responses: {
      200: "The organization's active trigger documents.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listTriggers(authorization),
  },
  {
    id: "validateTrigger",
    method: "post",
    path: "/api/v1/triggers/validate",
    scope: "configuration:validate",
    requestSchema: TriggerYamlRequestSchema,
    successSchema: ValidatedTriggerSchema,
    successStatus: 200,
    resultMapping: "trigger-validation",
    summary: "Validate one trigger",
    description: "Validates one self-contained trigger against organization resources.",
    tag: "Triggers",
    responses: {
      200: "The trigger is valid.",
      400: "The JSON request is malformed.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      422: "The trigger YAML or referenced organization resource is invalid.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.validateTrigger(authorization, TriggerYamlRequestSchema.parse(input)),
  },
  {
    id: "installTrigger",
    method: "post",
    path: "/api/v1/triggers/install",
    scope: "configuration:install",
    requestSchema: TriggerYamlRequestSchema,
    successSchema: InstalledTriggerSchema,
    successStatus: 201,
    resultMapping: "trigger-installation",
    summary: "Install one trigger",
    description: "Creates or replaces an organization trigger by its YAML name.",
    tag: "Triggers",
    responses: {
      201: "The trigger revision is active.",
      400: "The JSON request is malformed.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:install.",
      422: "The trigger YAML or referenced organization resource is invalid.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.installTrigger(authorization, TriggerYamlRequestSchema.parse(input)),
  },
  {
    id: "listProjects",
    method: "get",
    path: "/api/v1/projects",
    scope: "projects:read",
    successSchema: ProjectListSchema,
    successStatus: 200,
    resultMapping: "projects",
    summary: "List projects",
    description: "Lists active projects in the authenticated organization.",
    tag: "Projects",
    responses: {
      200: "The organization's active projects.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks projects:read.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listProjects(authorization),
  },
  {
    id: "listConfigurationResources",
    method: "get",
    path: "/api/v1/configuration-resources",
    scope: "configuration:validate",
    successSchema: ConfigurationResourcesSchema,
    successStatus: 200,
    resultMapping: "configuration-resources",
    summary: "List configuration resources",
    description:
      "Lists organization daemon and provider slugs that configuration validation resolves.",
    tag: "Configurations",
    responses: {
      200: "The organization's configuration resources.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listConfigurationResources(authorization),
  },
  {
    id: "listSetupResources",
    method: "get",
    path: "/api/v1/setup-resources",
    scope: "configuration:validate",
    successSchema: SetupResourcesSchema,
    successStatus: 200,
    resultMapping: "setup-resources",
    summary: "List setup resources",
    description:
      "Lists provider-native identifiers and labels needed to author starter workflow filters.",
    tag: "Configurations",
    responses: {
      200: "The organization's setup resources.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.listSetupResources(authorization),
  },
  {
    id: "validateConfiguration",
    method: "post",
    path: "/api/v1/configurations/validate",
    scope: "configuration:validate",
    requestSchema: InstallConfigurationRequestSchema,
    successSchema: ValidatedConfigurationSchema,
    successStatus: 200,
    resultMapping: "validation",
    summary: "Validate configuration",
    description:
      "Resolves the deployment project and validates the same YAML, prompt-partial bundle, daemon, and provider resources as installation without creating a project, recording a revision, or changing active configuration.",
    tag: "Configurations",
    responses: {
      200: "The configuration is valid for the project.",
      400: "The JSON request is malformed or has invalid fields.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:validate.",
      404: "The project does not exist in the credential's organization.",
      422: "The YAML, supplied prompt partial bundle, or Hub configuration is invalid.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.validateConfiguration(
        authorization,
        InstallConfigurationRequestSchema.parse(input),
      ),
  },
  {
    id: "installConfiguration",
    method: "post",
    path: "/api/v1/configurations/install",
    scope: "configuration:install",
    requestSchema: InstallConfigurationRequestSchema,
    successSchema: InstalledConfigurationSchema,
    successStatus: 201,
    resultMapping: "configuration",
    summary: "Install and activate configuration",
    description:
      "Resolves or creates the deployment project, validates the complete canonical Hub bundle, records a configuration revision, and atomically activates it.",
    tag: "Configurations",
    responses: {
      201: "The new configuration revision is active.",
      400: "The JSON request is malformed or has invalid fields.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks configuration:install.",
      404: "The project does not exist in the credential's organization.",
      422: "The YAML, supplied prompt partial bundle, or Hub configuration is invalid.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.installConfiguration(
        authorization,
        InstallConfigurationRequestSchema.parse(input),
      ),
  },
  {
    id: "dispatchManualRun",
    method: "post",
    path: "/api/v1/manual-runs",
    scope: "runs:dispatch",
    requestSchema: DispatchManualRunRequestSchema,
    successSchema: DispatchedManualRunSchema,
    successStatus: 200,
    resultMapping: "manual-run",
    summary: "Dispatch a manual run",
    description:
      "Uses deliveryKey as caller-supplied request identity in the existing durable manual-event path.",
    tag: "Runs",
    responses: {
      200: "The durable manual event resolved to a run.",
      400: "The JSON request or trigger input is invalid.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks runs:dispatch, its actor is forbidden, or a script trigger requires a bound actor.",
      404: "The project, configuration, or manual trigger does not exist.",
      409: "The existing manual event path could not resolve a run.",
      413: "The raw request body exceeds the configured webhook byte limit.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.dispatchManualRun(authorization, DispatchManualRunRequestSchema.parse(input)),
  },
  {
    id: "receiveWebhook",
    method: "post",
    path: "/api/v1/hooks/{trigger}",
    scope: "events:send",
    webhook: true,
    successSchema: ReceivedWebhookSchema,
    successStatus: 202,
    resultMapping: "webhook",
    summary: "Receive a webhook",
    description:
      "Accepts a UTF-8 JSON object or text prompt for one enabled manual.run trigger. Requires an API key with a bound actor. Idempotency keys deduplicate without expiry. Raw bodies are capped by server configuration (256 KiB by default).",
    tag: "Webhooks",
    responses: {
      200: "A duplicate delivery, including a previously filtered delivery.",
      202: "A new delivery was dispatched or filtered.",
      400: "invalid_json or invalid_request: malformed JSON, invalid UTF-8, empty text, or invalid idempotency key.",
      401: "unauthorized: the bearer API key is missing, invalid, or revoked.",
      403: "insufficient_scope, key_actor_required, or actor_forbidden.",
      404: "trigger_not_found: no allowed, enabled manual trigger matches.",
      405: "method_not_allowed: use POST.",
      409: "dispatch_conflict: retry with the same idempotency key.",
      413: "payload_too_large: the raw body or prompt exceeds its byte limit.",
      415: "unsupported_media_type: use application/json or text/plain with UTF-8.",
      422: "invalid_body or invalid_input: invalid structure or declared trigger inputs.",
      429: "rate_limited or trigger_busy: retry after the indicated delay.",
      500: "internal_error: the operation failed unexpectedly.",
      503: "authentication_unavailable or infrastructure_unavailable.",
    },
    invoke: (operations, authorization, input) =>
      operations.receiveWebhook(authorization, ReceiveWebhookInputSchema.parse(input)),
  },
  {
    id: "issueEnrollmentToken",
    method: "post",
    path: "/api/v1/daemons/enrollment-tokens",
    scope: "daemons:enroll",
    successSchema: EnrollmentTokenSchema,
    successStatus: 201,
    resultMapping: "enrollment-token",
    summary: "Issue a daemon enrollment token",
    description: "Returns a short-lived, single-use token for enrolling one daemon.",
    tag: "Daemons",
    responses: {
      201: "A short-lived enrollment token was issued.",
      401: "The bearer credential is missing, malformed, or revoked.",
      403: "The bearer credential lacks daemons:enroll.",
      500: "The operation failed unexpectedly.",
      503: "Hub authentication or storage is unavailable.",
    },
    invoke: (operations, authorization) => operations.issueEnrollmentToken(authorization),
  },
];

export function publicOperation(id: PublicOperationId): PublicOperationDefinition {
  const definition = publicOperationManifest.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`unknown public operation: ${id}`);
  return definition;
}
