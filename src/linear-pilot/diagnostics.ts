import { logger, redact } from "../logger.js";
import type { LinearAgentErrorDetails } from "../providers/linear/agent.js";
import { surfaceUuid } from "../surfaces/store.js";

interface DeliveryMetadata {
  nativeSessionId?: string;
  action?: "created" | "prompted";
}

export function logPilotScopeRefusal(reason: string, metadata: DeliveryMetadata): undefined {
  if (reason === "workspace_mismatch" || reason === "not_owner") {
    logger.debug({ ...metadata, reason }, "Linear pilot refused delivery");
    return undefined;
  }
  return logPilotRefusal(reason, metadata);
}

export function pilotDeliveryMetadata(payload: unknown): DeliveryMetadata {
  if (typeof payload !== "object" || payload === null) return {};
  const action: unknown = Reflect.get(payload, "action");
  const session: unknown = Reflect.get(payload, "agentSession");
  const id: unknown =
    typeof session === "object" && session !== null ? Reflect.get(session, "id") : undefined;
  return {
    ...(action === "created" || action === "prompted" ? { action } : {}),
    ...(typeof id === "string" && surfaceUuid(id) ? { nativeSessionId: id.toLowerCase() } : {}),
  };
}

export function logPilotRefusal(
  reason: string,
  metadata: DeliveryMetadata,
  diagnostics?: LinearAgentErrorDetails,
  scrubValues?: readonly string[],
): undefined {
  const { linearErrorType, linearErrorKinds, linearErrorText } = diagnostics ?? {};
  const details = redact(
    {
      ...(linearErrorType === undefined ? {} : { linearErrorType }),
      ...(linearErrorKinds === undefined ? {} : { linearErrorKinds }),
      ...(linearErrorText === undefined ? {} : { linearErrorText }),
    },
    scrubValues ? { scrubValues } : {},
  );
  logger.info(
    { ...metadata, reason, ...(typeof details === "object" ? details : {}) },
    "Linear pilot refused delivery",
  );
  return undefined;
}
