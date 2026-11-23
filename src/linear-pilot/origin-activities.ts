import { createHash } from "node:crypto";
import type { QueryHandle } from "../db/runtime/index.js";
import type { LinearAgentOperation, createLinearAgentClient } from "../providers/linear/agent.js";
import type { LinearConnectionBinding } from "../providers/linear/client.js";
import type { LinearPilotRegistration } from "../providers/linear/index.js";

const DELEGATION_REFUSED_BODY =
  "Paseo could not confirm who started this. Mention @paseo in a comment instead.";
const EXPIRED_BODY = "This start request expired. Mention @paseo in a comment instead.";

const NOT_OWNER_BODY = "Paseo only works for the workspace owner in this pilot.";

type Provider = Parameters<LinearPilotRegistration["offer"]>[1];
type Client = ReturnType<typeof createLinearAgentClient>;

type OriginPurpose = "not_owner" | "awaiting_owner" | "owner_expired" | "delegationRefused";

export function originActivityId(sessionId: string, purpose: OriginPurpose): string {
  const interactionId = purpose === "delegationRefused" ? sessionId : "created";
  const identity = JSON.stringify([sessionId, purpose, interactionId]);
  const name = `https://paseo.sh/id/linear-pilot/v4/${encodeURIComponent(identity)}`;
  const bytes = createHash("sha256").update(name).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function originClient(input: {
  provider: Provider;
  database: QueryHandle;
  binding: LinearConnectionBinding;
  permits: (operation: LinearAgentOperation) => boolean;
  current: (database: QueryHandle) => Promise<boolean>;
}) {
  const { provider, database, binding, permits, current } = input;
  const authorize = async (query: QueryHandle, operation: LinearAgentOperation) =>
    permits(operation) && (await current(query)) && permits(operation);
  return provider.activityClient({
    binding,
    authorize: (_binding, operation) => authorize(database, operation),
    authorizeRefresh: (query, _binding, operation) => authorize(query, operation),
  });
}

export async function readOriginWithin<T>(
  timeoutMs: number,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const controller = new AbortController();
  const timeout = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    timeout.resolve(undefined);
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([timeout.promise, read(controller.signal).catch(() => undefined)]);
  } finally {
    clearTimeout(timer);
  }
}

function boundedTitle(title: string) {
  return title
    .replace(/[`<>[\]!|]/gu, "")
    .slice(0, 120)
    .replace(/[\uD800-\uDBFF]$/u, "");
}

export function createOriginActivities(
  client: Pick<Client, "createActivity">,
  expectedBinding: LinearConnectionBinding,
) {
  let notOwnerClaimed = false;
  async function write(
    sessionId: string,
    purpose: OriginPurpose,
    type: "elicitation" | "response" | "error",
    body: string,
  ) {
    await client.createActivity({
      sessionId,
      activityId: originActivityId(sessionId, purpose),
      content: { type, body },
    });
  }
  return {
    async notOwner({
      binding,
      nativeSessionId,
      applicationId,
    }: {
      binding: LinearConnectionBinding;
      nativeSessionId: string;
      applicationId: string;
    }) {
      if (binding !== expectedBinding || binding.providerApplicationId !== applicationId) return;
      if (notOwnerClaimed) return;
      notOwnerClaimed = true;
      await write(nativeSessionId, "not_owner", "response", NOT_OWNER_BODY);
    },
    awaitingOwner(
      nativeSessionId: string,
      { identifier, title }: { identifier: string; title: string },
    ) {
      return write(
        nativeSessionId,
        "awaiting_owner",
        "elicitation",
        `Reply here to start work on ${identifier}: ${boundedTitle(title)}.`,
      );
    },
    delegationRefused(nativeSessionId: string) {
      return write(nativeSessionId, "delegationRefused", "error", DELEGATION_REFUSED_BODY);
    },
    expired(nativeSessionId: string) {
      return write(nativeSessionId, "owner_expired", "error", EXPIRED_BODY);
    },
  };
}
