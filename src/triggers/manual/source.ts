import { isDatabaseUnavailableError } from "../../db/errors.js";
import type { Database, DurableProviderEvent, ManualEventPersistence } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import type { TriggerDispatchOutcome, TriggerHandler, TriggerSource } from "../index.js";
import { parseManualTriggerPayload } from "./parse.js";
import type { ManualTriggerInput } from "./schema.js";
import { isAccountManualIdentity, ManualRunPayloadSchema } from "./provider.js";

const ReplayIdentitySchema = ManualRunPayloadSchema.pick({ actor: true, authenticatedBy: true });

interface ManualTriggerState {
  database: Database;
  handler: TriggerHandler | undefined;
}

const manualTriggerStates = new WeakMap<TriggerSource, ManualTriggerState>();

export function createManualTriggerSource(database: Database): TriggerSource {
  const state: ManualTriggerState = { database, handler: undefined };
  const source: TriggerSource = {
    async start(nextHandler: TriggerHandler): Promise<void> {
      state.handler = nextHandler;
    },
    async stop(): Promise<void> {
      state.handler = undefined;
    },
  };

  manualTriggerStates.set(source, state);

  return source;
}

export async function handleManualTriggerRequest(
  request: Request,
  source: TriggerSource,
  _entrypoint: "trigger" | "smoke",
): Promise<Response> {
  const state = manualTriggerStates.get(source);

  if (state === undefined) {
    throw new Error("manual trigger routes require a manual trigger source");
  }
  return handleManualRequest(request, source);
}

export async function dispatchManualTrigger(
  source: TriggerSource,
  trigger: ManualTriggerInput,
): Promise<TriggerDispatchOutcome | void> {
  const state = manualTriggerStates.get(source);
  if (state === undefined) throw new Error("manual_runtime_unavailable");
  const persisted = await state.database.persistManualEvent({
    ...trigger,
    connectionId: trigger.connectionId ?? null,
    resourceId: trigger.resourceId ?? null,
  });
  if (persisted.status === "duplicate") {
    logManualIntake(trigger, persisted.providerEventReceiptId, "duplicate");
    return { providerEventReceiptId: persisted.providerEventReceiptId, replayed: true };
  }
  if (state.handler === undefined) {
    return dropManualEvent(state.database, persisted, trigger);
  }
  logManualIntake(trigger, persisted.event.providerEventReceiptId, "accepted");
  const event =
    persisted.replayed === true
      ? withManualRetryAuthorization(persisted.event, trigger)
      : persisted.event;
  const outcome = await state.handler(event);
  return persisted.replayed === true
    ? {
        ...outcome,
        providerEventReceiptId: persisted.event.providerEventReceiptId,
        replayed: true,
      }
    : outcome;
}

async function dropManualEvent(
  database: Database,
  persisted: Extract<ManualEventPersistence, { status: "accepted" }>,
  trigger: ManualTriggerInput,
): Promise<TriggerDispatchOutcome> {
  const { providerEventReceiptId, organizationId } = persisted.event;
  const dropped = await database.markProviderEventDropped(
    providerEventReceiptId,
    "configuration_unavailable",
    organizationId,
  );
  if (!dropped) return { providerEventReceiptId, replayed: true };
  logManualIntake(trigger, providerEventReceiptId, "dropped");
  return {
    providerEventReceiptId,
    ...(persisted.replayed === true ? { replayed: true } : {}),
  };
}

function logManualIntake(
  trigger: ManualTriggerInput,
  receiptId: string,
  outcome: "duplicate" | "dropped" | "accepted",
): void {
  logger.info(
    {
      source: trigger.source,
      ...(trigger.boundWebhookTrigger === undefined ? { deliveryId: trigger.deliveryId } : {}),
      receiptId,
      outcome,
      ...(outcome === "dropped" ? { reason: "configuration_unavailable" } : {}),
    },
    "manual event intake completed",
  );
}

function withManualRetryAuthorization(event: DurableProviderEvent, request: ManualTriggerInput) {
  if (event.source !== "manual.run" && event.source !== "webhook.received") return event;
  const identity = ReplayIdentitySchema.safeParse(request.payload);
  return { ...event, manualRetryAuthorization: identity.success ? identity.data : null };
}

async function handleManualRequest(request: Request, source: TriggerSource): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch (error) {
    reportFailure(
      error,
      { operation: "manual-trigger.parse", component: "triggers", status: 400 },
      { status: 400 },
    );
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = parseManualTriggerPayload(body);

  if (typeof parsed === "string") {
    reportFailure(
      Object.assign(new Error("Manual trigger payload rejected"), { code: "invalid_request" }),
      { operation: "manual-trigger.validate", component: "triggers", status: 400 },
      { status: 400 },
    );
    return Response.json({ error: parsed }, { status: 400 });
  }

  const trigger = parsed;
  if (hasAccountManualIdentity(trigger.payload)) {
    return Response.json({ error: "actor_forbidden" }, { status: 403 });
  }

  try {
    await dispatchManualTrigger(source, trigger);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      reportFailure(
        error,
        { operation: "manual-trigger.persist", component: "triggers", status: 503 },
        { status: 503 },
      );
      return Response.json({ error: "database_unavailable" }, { status: 503 });
    }

    throw error;
  }

  return Response.json({ status: "accepted", deliveryId: trigger.deliveryId }, { status: 200 });
}

function hasAccountManualIdentity(payload: unknown): boolean {
  // A retry can resolve to a receipt with a different source than the incoming request.
  const identity = ReplayIdentitySchema.safeParse(payload);
  return identity.success && isAccountManualIdentity(identity.data);
}
