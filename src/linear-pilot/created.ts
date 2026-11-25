import type { QueryHandle } from "../db/runtime/index.js";
import { validMessage } from "../interactive-sessions/store.js";
import { recordLinearPilotAdmission } from "./admission-receipt.js";
import type { LinearPilotConfig } from "./config.js";
import { logPilotRefusal } from "./diagnostics.js";
import type { qualifyLinearPilotDelivery } from "./installation.js";

type Qualified = NonNullable<Awaited<ReturnType<typeof qualifyLinearPilotDelivery>>>;

interface CreatedContext {
  qualified: Qualified;
  config: LinearPilotConfig;
  database: QueryHandle;
  deadline: number;
  accepting(): boolean;
}

export function createdMetadata(nativeSessionId: string) {
  return { nativeSessionId, action: "created" } as const;
}

export function canAcknowledge(context: Pick<CreatedContext, "accepting" | "deadline">) {
  return context.accepting() && Date.now() < context.deadline;
}

export async function prepareCreated(context: CreatedContext, receivedAt: Date) {
  const {
    qualified: { event, installation },
    config,
    database,
  } = context;
  const metadata = createdMetadata(event.nativeSessionId);
  const receipt = {
    ...installation,
    profileId: config.profileId,
    kind: "created" as const,
    humanId: event.humanId,
    nativeSessionId: event.nativeSessionId,
    receivedAt,
  };
  const { message } = event;
  if (message === undefined) return undefined;
  if (!validMessage(message)) return logPilotRefusal("unqualified_content", metadata);
  if (!canAcknowledge(context)) return logPilotRefusal("ack_window_closed", metadata);
  if (!(await recordLinearPilotAdmission(database, receipt)))
    return logPilotRefusal("admission_not_claimed", metadata);
  return message;
}
