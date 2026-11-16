import { createHash, randomBytes } from "node:crypto";
import { configurationValidationIssues } from "../configuration/validation-errors.js";
import { ConfigurationActivationValidationError } from "../configuration/store.js";
import { compileHubBundle, HubBundleError } from "../config/bundle.js";
import type { DaemonClock } from "../daemons/index.js";
import { DaemonDispatchFailure } from "../daemons/index.js";
import { ENROLLMENT_LIFETIME_MS } from "../daemons/registration.js";
import { isDatabaseUnavailableError } from "../db/errors.js";
import { hasPostgresText, isPostgresJson } from "../http/json-storage.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import {
  ManualRunRejected,
  parseManualInvocation,
  type ManualRunPayload,
} from "../triggers/manual/provider.js";
import type {
  DispatchManualRunInput,
  DispatchManualRunResult,
  PublicOperationCapabilities,
  PublicOperationRepository,
  PublicOperations,
  PublicAuthorization,
} from "./types.js";
import { TriggerDocumentError } from "../triggers/configuration/index.js";
import { isScriptStep } from "../config/compiler.js";
import { DEFAULT_WEBHOOK_OPTIONS, type WebhookOptions } from "../webhook-config.js";
import { receiveWebhook } from "./webhook.js";

export type * from "./types.js";

export function createPublicOperations(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  clock: DaemonClock = { nowDate: () => new Date() },
  webhookOptions: Pick<WebhookOptions, "maxActiveRuns"> = DEFAULT_WEBHOOK_OPTIONS,
): PublicOperations {
  return {
    async listTriggers(authorization) {
      try {
        return {
          status: "listed",
          triggers: await triggerCapability(capabilities, authorization.organizationId).list(),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async validateTrigger(authorization, input) {
      try {
        const trigger = await triggerCapability(
          capabilities,
          authorization.organizationId,
        ).validate(input.yaml);
        return { status: "valid", name: trigger.name, valid: true };
      } catch (error) {
        if (error instanceof TriggerDocumentError) {
          return { status: "invalid_trigger", issues: error.issues };
        }
        return storageUnavailableOrThrow(error);
      }
    },
    async installTrigger(authorization, input) {
      try {
        const installed = await triggerCapability(
          capabilities,
          authorization.organizationId,
        ).install({
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
    },
    async listProjects(authorization) {
      try {
        return {
          status: "listed",
          projects: await repository.listActiveProjects(authorization.organizationId),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async listConfigurationResources(authorization) {
      try {
        return {
          status: "listed",
          ...(await repository.listConfigurationResources(authorization.organizationId)),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async listSetupResources(authorization) {
      try {
        return {
          status: "listed",
          ...(await repository.listSetupResources(authorization.organizationId)),
        };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async validateConfiguration(authorization, input) {
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
        const projectSlug =
          target.status === "would_create" ? target.projectSlug : target.project.slug;
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
    },
    async installConfiguration(authorization, input) {
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
    },
    async dispatchManualRun(authorization, input) {
      try {
        const project = await repository.resolveManualRunProject(
          authorization.organizationId,
          input.trigger,
          input.projectSlug,
        );
        if (project === undefined) return { status: "project_not_found" };
        if (project.status === "disabled") return { status: "trigger_not_found" };
        let result: DispatchManualRunResult;
        try {
          result = await dispatchManualRun(
            repository,
            capabilities,
            authorization,
            project.id,
            input,
            internalDeliveryId(authorization.organizationId, project.id, input.deliveryKey),
          );
        } catch (error) {
          if (error instanceof ManualRunRejected) result = { status: error.code };
          else if (
            error instanceof DaemonDispatchFailure &&
            error.reason === "daemon_unreachable"
          ) {
            result = { status: "daemon_offline" };
          } else throw error;
        }
        return result;
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
    async receiveWebhook(authorization, input) {
      try {
        return await receiveWebhook(
          repository,
          capabilities,
          authorization,
          input,
          webhookOptions.maxActiveRuns,
        );
      } catch (error) {
        if (error instanceof ManualRunRejected) {
          if (error.code === "actor_forbidden" || error.code === "key_actor_required") {
            return { status: error.code };
          }
          return { status: "trigger_not_found" };
        }
        return storageUnavailableOrThrow(error);
      }
    },
    async issueEnrollmentToken(authorization) {
      try {
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(clock.nowDate().getTime() + ENROLLMENT_LIFETIME_MS);
        const outcome = await repository.issueEnrollmentToken(authorization, { token, expiresAt });
        return outcome === "issued" ? { status: "issued", token, expiresAt } : { status: outcome };
      } catch (error) {
        return storageUnavailableOrThrow(error);
      }
    },
  };
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
):
  | { status: "resolved"; actor: string }
  | Extract<DispatchManualRunResult, { status: "actor_forbidden" | "invalid_input" }> {
  if (authorization.actor != null && claimed !== undefined && claimed !== authorization.actor) {
    return { status: "actor_forbidden" };
  }
  const actor = authorization.actor ?? claimed;
  if (actor === undefined)
    return {
      status: "invalid_input",
      issues: [{ path: ["actor"], message: "An actor is required for an unbound credential." }],
    };
  return { status: "resolved", actor };
}

async function prepareManualRun(
  capabilities: PublicOperationCapabilities,
  authorization: PublicAuthorization,
  projectId: string,
  input: DispatchManualRunInput,
): Promise<DispatchManualRunResult | { status: "prepared"; payload: ManualRunPayload }> {
  const identity = resolveManualActor(authorization, input.actor);
  if (identity.status !== "resolved") return identity;
  const actor = identity.actor;
  const stored = await capabilities.configurationForProject(projectId).getActive();
  if (stored === undefined) return { status: "configuration_not_found" };
  if (input.expectedVersionId !== undefined && input.expectedVersionId !== stored.revision.id) {
    return { status: "expected_configuration_not_current" };
  }
  const trigger = stored.configuration.triggers.find(
    (candidate) => candidate.name === input.trigger && candidate.on === "manual.run",
  );
  if (trigger === undefined) return { status: "trigger_not_found" };
  if (
    trigger.steps.some(isScriptStep) &&
    (authorization.kind !== "apiKey" || authorization.actor == null)
  ) {
    return { status: "key_actor_required" };
  }
  if (
    !trigger.filters?.from_users?.includes("*") &&
    !trigger.filters?.from_users?.includes(actor)
  ) {
    return { status: "actor_forbidden" };
  }
  const payload: ManualRunPayload = {
    ...(input.expectedVersionId === undefined
      ? {}
      : { expectedVersionId: input.expectedVersionId }),
    trigger: input.trigger,
    actor,
    input: input.input,
    publicDeliveryKey: input.deliveryKey,
  };
  const inputIssue = validateManualInput(input.input);
  if (inputIssue !== undefined) return { status: "invalid_input", issues: [inputIssue] };
  const invocation = parseManualInvocation(payload, trigger.inputs);
  if (invocation.status === "rejected") {
    return {
      status: "invalid_input",
      issues: [
        {
          path: ["input", invocation.rejection.inputName],
          message: formatInvocationRejection(invocation.rejection),
        },
      ],
    };
  }
  return { status: "prepared", payload };
}

async function dispatchManualRun(
  repository: PublicOperationRepository,
  capabilities: PublicOperationCapabilities,
  authorization: PublicAuthorization,
  projectId: string,
  input: DispatchManualRunInput,
  deliveryId: string,
): Promise<DispatchManualRunResult> {
  const prepared = await prepareManualRun(capabilities, authorization, projectId, input);
  if (prepared.status !== "prepared") return prepared;
  const outcome = await capabilities.dispatchManualEvent({
    organizationId: authorization.organizationId,
    projectId,
    source: "manual.run",
    deliveryId,
    receivedAt: new Date(),
    payload: {
      ...prepared.payload,
      authenticatedBy: {
        kind: authorization.kind === "apiKey" ? "api-key" : "cli-credential",
        credentialId: authorization.credentialId,
        boundActor: authorization.kind === "apiKey" ? (authorization.actor ?? null) : null,
      },
    },
  });
  const providerEventReceiptId = outcome?.providerEventReceiptId;
  if (providerEventReceiptId === undefined) return { status: "dispatch_conflict" };
  const run = await repository.findManualRun(providerEventReceiptId, input.trigger);
  if (run === undefined) return { status: "dispatch_conflict" };
  if (run.outcome === "rejected") {
    return {
      status: "invalid_input",
      providerEventReceiptId,
      triggerRunId: run.id,
      configuredTriggerName: run.configuredTriggerName,
      issues: [{ path: ["input"], message: formatInvocationRejection(run.rejection) }],
    };
  }
  return {
    status: "dispatched",
    deliveryKey: input.deliveryKey,
    providerEventReceiptId,
    triggerRunId: run.id,
    configuredTriggerName: run.configuredTriggerName,
    workflowStatus: run.status,
  };
}

function validateManualInput(input: unknown) {
  const storable = typeof input === "string" ? hasPostgresText(input) : isPostgresJson(input);
  if (!storable) {
    return { path: ["input"], message: "Input contains unsupported JSON or Unicode text." };
  }
  let message: unknown;
  if (typeof input === "string") message = input;
  else if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    message = Object.hasOwn(input, "message") && "message" in input ? input.message : "";
  }
  if (typeof message !== "string") {
    return {
      path: ["input", "message"],
      message: "Input must be text or an object with a string message.",
    };
  }
  if (Buffer.byteLength(message, "utf8") > 65_536) {
    return { path: ["input", "message"], message: "Message exceeds 65536 UTF-8 bytes." };
  }
  return undefined;
}

async function resolveConfigurationDeployment(
  repository: PublicOperationRepository,
  organizationId: string,
  input: {
    projectSlug?: string | undefined;
    files: readonly { path: string; content: string }[];
  },
  dryRun: boolean,
): Promise<
  | {
      success: true;
      files: readonly { path: string; content: string }[];
      target:
        | {
            status: "resolved";
            project: { id: string; slug: string };
            created: boolean;
          }
        | { status: "would_create"; projectSlug: string };
    }
  | {
      success: false;
      result:
        | { status: "project_not_found" }
        | {
            status: "invalid_bundle";
            issues: readonly { path: readonly (string | number)[]; message: string }[];
          };
    }
> {
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

function internalDeliveryId(
  organizationId: string,
  projectId: string,
  deliveryKey: string,
): string {
  return `public-manual-${createHash("sha256")
    .update([organizationId, projectId, deliveryKey].map((part) => JSON.stringify(part)).join(":"))
    .digest("base64url")}`;
}

function storageUnavailableOrThrow(error: unknown): { status: "infrastructure_unavailable" } {
  if (isDatabaseUnavailableError(error)) return { status: "infrastructure_unavailable" };
  throw error;
}
