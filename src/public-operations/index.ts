import { randomBytes } from "node:crypto";
import { configurationValidationIssues } from "../configuration/validation-errors.js";
import { ConfigurationActivationValidationError } from "../configuration/store.js";
import { compileHubBundle, HubBundleError } from "../config/bundle.js";
import type { DaemonClock } from "../daemons/index.js";
import { ENROLLMENT_LIFETIME_MS } from "../daemons/registration.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { isReservedManualActor, ManualRunRejected } from "../triggers/manual/provider.js";
import type {
  DomainIssue,
  DispatchManualRunResult,
  InstallConfigurationInput,
  PublicOperationCapabilities,
  PublicOperationRepository,
  PublicOperations,
  PublicAuthorization,
} from "./types.js";
import type { DeploymentProjectResolution } from "../project-deployments/index.js";
import { TriggerDocumentError } from "../triggers/configuration/index.js";
import { DEFAULT_WEBHOOK_OPTIONS, type WebhookOptions } from "../webhook-config.js";
import { receiveWebhook as dispatchWebhook } from "./webhook.js";
import { publicManualIdentity } from "./manual-replay.js";
import { createManualRunDispatcher, type DispatchResolvedManualRun } from "./manual-dispatch.js";

export type * from "./types.js";

export function createPublicOperations(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  clock: DaemonClock = { nowDate: () => new Date() },
  webhookOptions: Pick<WebhookOptions, "maxActiveRuns"> = DEFAULT_WEBHOOK_OPTIONS,
): PublicOperations & { dispatchResolvedManualRun: DispatchResolvedManualRun } {
  const dispatchResolvedManualRun = createManualRunDispatcher(repository, capabilities);
  const context: OperationContext = {
    repository,
    capabilities,
    clock,
    webhookOptions,
    dispatchResolvedManualRun,
  };
  return {
    dispatchResolvedManualRun,
    listTriggers: listTriggers.bind(undefined, context),
    validateTrigger: validateTrigger.bind(undefined, context),
    installTrigger: installTrigger.bind(undefined, context),
    listProjects: listProjects.bind(undefined, context),
    listConfigurationResources: listConfigurationResources.bind(undefined, context),
    listSetupResources: listSetupResources.bind(undefined, context),
    validateConfiguration: validateConfiguration.bind(undefined, context),
    installConfiguration: installConfiguration.bind(undefined, context),
    stopRun: stopRun.bind(undefined, context),
    dispatchManualRun: dispatchManualRun.bind(undefined, context),
    receiveWebhook: receiveWebhook.bind(undefined, context),
    issueEnrollmentToken: issueEnrollmentToken.bind(undefined, context),
  };
}

interface OperationContext {
  repository: PublicOperationRepository;
  capabilities: PublicOperationCapabilities;
  clock: DaemonClock;
  webhookOptions: Pick<WebhookOptions, "maxActiveRuns">;
  dispatchResolvedManualRun: DispatchResolvedManualRun;
}

type Operation<Name extends keyof PublicOperations> = NonNullable<PublicOperations[Name]>;

async function listTriggers(
  { capabilities }: OperationContext,
  authorization: PublicAuthorization,
): ReturnType<Operation<"listTriggers">> {
  try {
    return {
      status: "listed",
      triggers: await triggerCapability(capabilities, authorization.organizationId).list(),
    };
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function validateTrigger(
  { capabilities }: OperationContext,
  authorization: PublicAuthorization,
  input: Parameters<Operation<"validateTrigger">>[1],
): ReturnType<Operation<"validateTrigger">> {
  try {
    const trigger = await triggerCapability(capabilities, authorization.organizationId).validate(
      input.yaml,
    );
    return { status: "valid", name: trigger.name, valid: true };
  } catch (error) {
    if (error instanceof TriggerDocumentError) {
      return { status: "invalid_trigger", issues: error.issues };
    }
    return storageUnavailableOrThrow(error);
  }
}

async function installTrigger(
  { capabilities }: OperationContext,
  authorization: PublicAuthorization,
  input: Parameters<Operation<"installTrigger">>[1],
): ReturnType<Operation<"installTrigger">> {
  try {
    const installed = await triggerCapability(capabilities, authorization.organizationId).install({
      yaml: input.yaml,
      credentialId: authorization.credentialId,
      credentialKind: authorization.kind,
    });
    return { status: "installed", ...installed, active: true };
  } catch (error) {
    if (error instanceof TriggerDocumentError) {
      return { status: "invalid_trigger", issues: error.issues };
    }
    return storageUnavailableOrThrow(error);
  }
}

async function listProjects(
  { repository }: OperationContext,
  authorization: PublicAuthorization,
): ReturnType<Operation<"listProjects">> {
  try {
    return {
      status: "listed",
      projects: await repository.listActiveProjects(authorization.organizationId),
    };
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function listConfigurationResources(
  { repository }: OperationContext,
  authorization: PublicAuthorization,
): ReturnType<Operation<"listConfigurationResources">> {
  try {
    return {
      status: "listed",
      ...(await repository.listConfigurationResources(authorization.organizationId)),
    };
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function listSetupResources(
  { repository }: OperationContext,
  authorization: PublicAuthorization,
): ReturnType<Operation<"listSetupResources">> {
  try {
    return {
      status: "listed",
      ...(await repository.listSetupResources(authorization.organizationId)),
    };
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function validateConfiguration(
  { repository, capabilities }: OperationContext,
  authorization: PublicAuthorization,
  input: Parameters<Operation<"validateConfiguration">>[1],
): ReturnType<Operation<"validateConfiguration">> {
  try {
    const resolved = await resolveConfigurationDeployment(
      repository,
      authorization.organizationId,
      input,
      true,
    );
    if (!resolved.success) return resolved.result;
    const { target } = resolved;
    const result =
      target.status === "would_create"
        ? await capabilities.validateBundleForOrganization(
            authorization.organizationId,
            resolved.files,
          )
        : await capabilities
            .configurationForProject(target.project.id)
            .validateBundle(resolved.files);
    const projectSlug = target.status === "would_create" ? target.projectSlug : target.project.slug;
    return result.valid
      ? {
          status: "valid",
          projectSlug,
          valid: true,
          ...(target.status === "would_create" ? { wouldCreateProject: true as const } : {}),
        }
      : {
          status: "invalid_configuration",
          issues: configurationValidationIssues(result.validationErrors),
        };
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function installConfiguration(
  { repository, capabilities }: OperationContext,
  authorization: PublicAuthorization,
  input: Parameters<Operation<"installConfiguration">>[1],
): ReturnType<Operation<"installConfiguration">> {
  try {
    const resolved = await resolveConfigurationDeployment(
      repository,
      authorization.organizationId,
      input,
      false,
    );
    if (!resolved.success) return resolved.result;
    const { target } = resolved;
    if (target.status === "would_create") throw new Error("install project was not resolved");
    const project = target.project;
    const configuration = capabilities.configurationForProject(project.id);
    const record = await configuration.insertManualBundleRevision({
      files: resolved.files,
      userId: null,
      sourceEvidence: {
        kind: authorization.kind === "apiKey" ? "api-key" : "cli-credential",
        credentialId: authorization.credentialId,
      },
    });
    if (record.validationErrors !== null) {
      return {
        status: "invalid_configuration",
        versionId: record.id,
        issues: configurationValidationIssues(record.validationErrors),
      };
    }
    let promoted: Awaited<ReturnType<typeof configuration.activate>>;
    try {
      promoted = await configuration.activate(record.id);
    } catch (error) {
      if (!(error instanceof ConfigurationActivationValidationError)) throw error;
      return {
        status: "invalid_configuration",
        versionId: record.id,
        issues: configurationValidationIssues(error.validationErrors),
      };
    }
    return {
      status: "installed",
      projectSlug: project.slug,
      versionId: promoted.revision.id,
      version: promoted.revision.version,
      active: true,
    };
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function stopRun(
  { capabilities }: OperationContext,
  authorization: PublicAuthorization,
  runId: Parameters<Operation<"stopRun">>[1],
): ReturnType<Operation<"stopRun">> {
  if (authorization.kind !== "cliCredential" || authorization.user === undefined)
    return { status: "forbidden" };
  if (capabilities.stopRun === undefined) return { status: "infrastructure_unavailable" };
  try {
    return await capabilities.stopRun(
      {
        organizationId: authorization.organizationId,
        userId: authorization.user.id,
        role: authorization.user.role,
      },
      runId,
    );
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function dispatchManualRun(
  { repository, capabilities, dispatchResolvedManualRun }: OperationContext,
  authorization: PublicAuthorization,
  input: Parameters<Operation<"dispatchManualRun">>[1],
): ReturnType<Operation<"dispatchManualRun">> {
  const resolved = resolveManualActor(
    authorization,
    input.actor,
    capabilities.verifiedActorEmailRequired === true,
  );
  if (resolved.status !== "resolved") return resolved;
  try {
    const project = await repository.resolveManualRunProject(
      authorization.organizationId,
      input.trigger,
      input.projectSlug,
    );
    if (project === undefined) return { status: "project_not_found" };
    if (project.status === "disabled") return { status: "trigger_not_found" };
    return await dispatchResolvedManualRun({
      identity: publicManualIdentity(authorization, resolved.actor),
      projectId: project.id,
      input,
    });
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

async function receiveWebhook(
  { repository, capabilities, webhookOptions }: OperationContext,
  authorization: PublicAuthorization,
  input: Parameters<Operation<"receiveWebhook">>[1],
): ReturnType<Operation<"receiveWebhook">> {
  try {
    return await dispatchWebhook({
      repository,
      capabilities,
      authorization,
      input,
      maxActiveRuns: webhookOptions.maxActiveRuns,
    });
  } catch (error) {
    if (error instanceof ManualRunRejected) {
      if (error.code === "key_actor_required") return { status: error.code };
      return { status: "trigger_not_found" };
    }
    return storageUnavailableOrThrow(error);
  }
}

async function issueEnrollmentToken(
  { repository, clock }: OperationContext,
  authorization: PublicAuthorization,
): ReturnType<Operation<"issueEnrollmentToken">> {
  try {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(clock.nowDate().getTime() + ENROLLMENT_LIFETIME_MS);
    const outcome = await repository.issueEnrollmentToken(authorization, { token, expiresAt });
    return outcome === "issued" ? { status: "issued", token, expiresAt } : { status: outcome };
  } catch (error) {
    return storageUnavailableOrThrow(error);
  }
}

function triggerCapability(capabilities: PublicOperationCapabilities, organizationId: string) {
  if (capabilities.triggerForOrganization === undefined) {
    throw new Error("organization triggers are unavailable");
  }
  return capabilities.triggerForOrganization(organizationId);
}

function resolveManualActor(
  authorization: PublicAuthorization,
  claimed: string | undefined,
  verifiedActorEmailRequired: boolean,
):
  | { status: "resolved"; actor: string }
  | Extract<
      DispatchManualRunResult,
      { status: "actor_forbidden" | "invalid_input" | "key_actor_required" }
    > {
  if (authorization.kind === "cliCredential") {
    return resolveCliManualActor(authorization.user, claimed, verifiedActorEmailRequired);
  }
  if (claimed !== undefined && isReservedManualActor(claimed)) return { status: "actor_forbidden" };
  if (authorization.actor != null) return resolveBoundManualActor(authorization.actor, claimed);
  if (claimed !== undefined) return { status: "resolved", actor: claimed };
  return {
    status: "invalid_input",
    issues: [{ path: ["actor"], message: "An actor is required for an unbound credential." }],
  };
}

function resolveCliManualActor(
  user: PublicAuthorization["user"],
  claimed: string | undefined,
  verifiedActorEmailRequired: boolean,
) {
  const email = user?.email;
  if (!email) return { status: "key_actor_required" } as const;
  if (verifiedActorEmailRequired && user?.emailVerified !== true)
    return { status: "actor_forbidden" } as const;
  return resolveBoundManualActor(email.toLowerCase(), claimed);
}

function resolveBoundManualActor(actor: string, claimed: string | undefined) {
  if (claimed !== undefined && claimed !== actor) {
    return { status: "actor_forbidden" } as const;
  }
  return { status: "resolved", actor } as const;
}

type ConfigurationDeployment =
  | {
      success: true;
      files: InstallConfigurationInput["files"];
      target: Exclude<DeploymentProjectResolution, { status: "project_not_found" }>;
    }
  | {
      success: false;
      result:
        | { status: "project_not_found" }
        | { status: "invalid_bundle"; issues: readonly DomainIssue[] };
    };

async function resolveConfigurationDeployment(
  repository: PublicOperationRepository,
  organizationId: string,
  input: InstallConfigurationInput,
  dryRun: boolean,
): Promise<ConfigurationDeployment> {
  const explicitTarget =
    input.projectSlug === undefined
      ? undefined
      : await repository.resolveDeploymentProject({
          organizationId,
          explicitProjectSlug: input.projectSlug,
          dryRun,
        });
  if (explicitTarget?.status === "project_not_found") {
    return { success: false, result: explicitTarget };
  }

  let bundleName: string | undefined;
  try {
    const bundle = compileHubBundle(input.files);
    bundleName = bundle.name;
  } catch (error) {
    if (error instanceof HubBundleError) {
      return {
        success: false,
        result: { status: "invalid_bundle", issues: error.issues },
      };
    }
    throw error;
  }

  const target =
    explicitTarget ??
    (await repository.resolveDeploymentProject({
      organizationId,
      ...(bundleName === undefined ? {} : { bundleName }),
      dryRun,
    }));
  return target.status === "project_not_found"
    ? { success: false, result: target }
    : { success: true, files: input.files, target };
}

function storageUnavailableOrThrow(error: unknown): { status: "infrastructure_unavailable" } {
  if (isDatabaseUnavailableError(error)) return { status: "infrastructure_unavailable" };
  throw error;
}
