import { logger } from "../logger.js";
import type { LinearAgentError, LinearAgentErrorDetails } from "../providers/linear/agent.js";
import { surfaceUuid } from "../surfaces/store.js";
import type { DelegationProofStage } from "./delegation.js";
import type { DelegationFallback } from "./intake.js";

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
  diagnostics?: LinearAgentErrorDetails & {
    stage?: DelegationProofStage;
    linearAgentCode?: LinearAgentError["code"];
  },
): undefined {
  const { linearErrorType, linearErrorKinds, stage, linearAgentCode } = diagnostics ?? {};
  logger.info(
    {
      ...metadata,
      reason,
      ...(stage === undefined ? {} : { stage }),
      ...(linearAgentCode === undefined ? {} : { linearAgentCode }),
      ...(linearErrorType === undefined ? {} : { linearErrorType }),
      ...(linearErrorKinds === undefined ? {} : { linearErrorKinds }),
    },
    "Linear pilot refused delivery",
  );
  return undefined;
}

export function logDelegationFallback(
  nativeSessionId: string,
  stage: DelegationFallback | undefined,
) {
  if (stage !== undefined)
    logger.info({ nativeSessionId, stage }, "Linear pilot delegation fallback");
}
