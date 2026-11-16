import { z } from "zod";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import { isScriptStep } from "../../config/compiler.js";
import { type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import {
  formatInvocationRejection,
  matchesInputFilters,
  parseInvocation,
  parseStructuredInvocation,
  type InvocationInputDefinitions,
  type InvocationParseResult,
  type InvocationRejection,
} from "../invocation.js";

export const ManualRunPayloadSchema = z.object({
  expectedVersionId: z.string().uuid().optional(),
  trigger: z.string().min(1),
  actor: z.string().min(1),
  input: z.unknown(),
  data: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(["manual.run", "webhook.received"]).optional(),
  publicDeliveryKey: z.string().min(1).optional(),
  authenticatedBy: z
    .object({
      kind: z.enum(["api-key", "cli-credential"]),
      credentialId: z.string().min(1),
      boundActor: z.string().nullable().optional(),
    })
    .optional(),
});

export type ManualRunPayload = z.infer<typeof ManualRunPayloadSchema>;

const MAX_MANUAL_CONTEXT_BYTES = 64 * 1024;

interface TruncatedManualValue {
  truncated: true;
  bytes: number;
}
export interface ManualMergeData {
  manual: {
    actor: string;
    input: string | TruncatedManualValue;
    data?: Readonly<Record<string, unknown>> | TruncatedManualValue | undefined;
    source: "manual.run" | "webhook.received";
    trigger: string;
    delivery_id: string;
    expected_version_id?: string;
  };
}
export interface ManualRunContext {
  provider: "manual";
  deliveryId: string;
  event: ManualMergeData;
}
export interface ManualRunOutputContext {
  provider: "manual";
  actor: string;
}

export type ManualRunRejectionCode =
  | "configuration_not_found"
  | "expected_configuration_not_current"
  | "trigger_not_found"
  | "actor_forbidden"
  | "key_actor_required";

export class ManualRunRejected extends Error {
  constructor(readonly code: ManualRunRejectionCode) {
    super(`manual run rejected: ${code}`);
    this.name = "ManualRunRejected";
  }
}

export function parseManualInvocation(
  payload: ManualRunPayload,
  definitions: InvocationInputDefinitions,
): InvocationParseResult {
  const data = isObjectInput(payload.input) ? payload.input : payload.data;
  let prompt = typeof payload.input === "string" ? payload.input : "";
  if (isObjectInput(payload.input) && Object.hasOwn(payload.input, "message")) {
    if (typeof payload.input["message"] !== "string") {
      const rejection: InvocationRejection = {
        code: "invalid_type",
        inputName: "message",
        expectedType: "string",
      };
      return {
        status: "rejected",
        prompt,
        inputs: Object.freeze({}),
        reason: formatInvocationRejection(rejection),
        rejection,
      };
    }
    prompt = payload.input["message"];
  }
  return data === undefined
    ? parseInvocation(prompt, definitions)
    : parseStructuredInvocation(prompt, data, definitions);
}

function isObjectInput(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function contextBytes(context: ManualRunContext): number {
  return Math.max(
    Buffer.byteLength(JSON.stringify(context)),
    Buffer.byteLength(JSON.stringify(context.event, null, 2)),
  );
}

function boundManualContext(context: ManualRunContext): void {
  if (contextBytes(context) <= MAX_MANUAL_CONTEXT_BYTES) return;
  const manual = context.event.manual;
  if (manual.data !== undefined) {
    manual.data = {
      truncated: true,
      bytes: Buffer.byteLength(JSON.stringify(manual.data)),
    };
  }
  if (contextBytes(context) <= MAX_MANUAL_CONTEXT_BYTES) return;
  manual.input = {
    truncated: true,
    bytes: Buffer.byteLength(JSON.stringify(manual.input)),
  };
  if (contextBytes(context) > MAX_MANUAL_CONTEXT_BYTES) {
    throw new Error("manual context metadata exceeds the context size limit");
  }
}

export function createManualRunProvider(
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore,
): TriggerProvider<"manual", ManualRunContext, ManualRunOutputContext> {
  return {
    name: "manual",
    eventNames: ["manual.run", "webhook.received"],
    async match(external) {
      const store = configurationStoreForProject(external.projectId);
      const payload = ManualRunPayloadSchema.parse(external.payload);
      const stored = await store.getRevision(external.configurationRevisionId);
      if (!stored) {
        throw new ManualRunRejected("configuration_not_found");
      }
      if (
        payload.expectedVersionId !== undefined &&
        stored.revision.id !== payload.expectedVersionId
      ) {
        throw new ManualRunRejected("expected_configuration_not_current");
      }
      const trigger = stored.configuration.triggers.find(
        (candidate) => candidate.name === payload.trigger && candidate.on === "manual.run",
      );
      if (!trigger) throw new ManualRunRejected("trigger_not_found");
      if (
        trigger.steps.some(isScriptStep) &&
        (payload.authenticatedBy?.kind !== "api-key" ||
          payload.authenticatedBy.boundActor !== payload.actor)
      ) {
        throw new ManualRunRejected("key_actor_required");
      }
      if (
        !trigger.filters?.from_users?.includes("*") &&
        !trigger.filters?.from_users?.includes(payload.actor)
      )
        throw new ManualRunRejected("actor_forbidden");
      const invocation = parseManualInvocation(payload, trigger.inputs);
      const triggerContext = createManualRunContext(
        payload,
        external.source,
        external.deliveryId,
        invocation.prompt,
      );
      const outputContext: ManualRunOutputContext = { provider: "manual", actor: payload.actor };
      if (invocation.status === "rejected") {
        return [
          {
            triggerName: trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          },
        ];
      }
      if (!matchesInputFilters(invocation.inputs, trigger.filters?.inputs))
        return "trigger_filters_rejected";
      const match: TriggerProviderMatch<ManualRunContext, ManualRunOutputContext> = {
        conversation: null,
        triggerName: trigger.name,
        triggerContext,
        outputContext,
        configurationRevisionId: stored.revision.id,
        hubConfig: stored.configuration,
        invocation,
      };
      return [match];
    },
    async materializeContext({ triggerContext }) {
      return triggerContext.event;
    },
  };
}

function createManualRunContext(
  payload: ManualRunPayload,
  source: string,
  deliveryId: string,
  prompt: string,
): ManualRunContext {
  const data = isObjectInput(payload.input) ? payload.input : payload.data;
  const context: ManualRunContext = {
    provider: "manual",
    deliveryId: payload.publicDeliveryKey ?? deliveryId,
    event: {
      manual: {
        actor: payload.actor,
        input: prompt,
        ...(data === undefined ? {} : { data }),
        source: payload.source ?? (source === "webhook.received" ? source : "manual.run"),
        trigger: payload.trigger,
        delivery_id: payload.publicDeliveryKey ?? deliveryId,
        ...(payload.expectedVersionId === undefined
          ? {}
          : { expected_version_id: payload.expectedVersionId }),
      },
    },
  };
  boundManualContext(context);
  return context;
}
