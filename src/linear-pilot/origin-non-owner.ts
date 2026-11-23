import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { DatabaseRuntime, QueryHandle } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import { logger } from "../logger.js";
import type { LinearPilotRegistration } from "../providers/linear/index.js";
import type { LinearConnectionBinding } from "../providers/linear/client.js";
import { surfaceUuid } from "../surfaces/store.js";
import type { LinearPilotConfig } from "./config.js";
import {
  precheckLinearPilotScope,
  mayVerifyNonOwnerMention,
  verifyLinearPilotIntake,
  type NonOwnerMention,
} from "./intake.js";
import { createOriginActivities, originClient, readOriginWithin } from "./origin-activities.js";

const REASON = "linear_pilot_not_owner_reply";
const HOUR_MS = 60 * 60 * 1000;
const WORKSPACE_LIMIT = 20;
const ACTOR_LIMIT = 3;
const READ_TIMEOUT_MS = 3000;

type Delivery = Parameters<LinearPilotRegistration["offer"]>[0];
type Provider = Parameters<LinearPilotRegistration["offer"]>[1];
type NonOwnerBinding = {
  [Key in keyof LinearConnectionBinding]: NonNullable<LinearConnectionBinding[Key]>;
};

interface Options {
  database: DatabaseRuntime;
  locks: Locks;
  config: LinearPilotConfig;
  accepting(): boolean;
}

interface Attempt {
  binding: NonOwnerBinding;
  mention: NonOwnerMention;
  provider: Provider;
  receivedAt: Date;
}

async function readBinding(query: QueryHandle, config: LinearPilotConfig, applicationId: string) {
  const {
    rows: [binding],
  } = await query.query<NonOwnerBinding>(
    `select id, organization_id as "organizationId", linear_organization_id as "linearOrganizationId",
            provider_application_id as "providerApplicationId", app_user_id as "appUserId"
       from linear_connections connection
      where organization_id = $1 and linear_organization_id = $2
        and provider_application_id = $3 and app_user_id <> $4
        and not exists (
          select 1 from surface_policies policy
           where policy.organization_id = connection.organization_id
             and policy.connection_id = connection.id and policy.enabled
        )`,
    [config.hubOrganizationId, config.linearOrganizationId, applicationId, config.allowedHumanId],
  );
  return binding;
}

function verifyMention(config: LinearPilotConfig, binding: NonOwnerBinding, input: Delivery) {
  const result = verifyLinearPilotIntake({
    config,
    payload: input.payload,
    installation: {
      organizationId: binding.organizationId,
      workspaceId: binding.linearOrganizationId,
      applicationId: binding.providerApplicationId,
      oauthClientId: binding.providerApplicationId,
      appUserId: binding.appUserId,
    },
  });
  if (result.ok || !result.nonOwnerMention) return undefined;
  const mention = result.nonOwnerMention;
  if (!surfaceUuid(mention.nativeSessionId)) return undefined;
  return { ...mention, nativeSessionId: mention.nativeSessionId.toLowerCase() };
}

interface Claim {
  binding: NonOwnerBinding;
  key: string;
  actorHash: string;
  receivedAt: Date;
}

async function existingClaim(query: QueryHandle, { binding, key }: Claim) {
  const result = await query.query(
    `select 1 from provider_event_receipts where organization_id = $1 and delivery_id = $2`,
    [binding.organizationId, key],
  );
  return result.rows.length !== 0;
}

async function durableLimit(query: QueryHandle, claim: Claim, cutoff: number) {
  const { binding, actorHash } = claim;
  const {
    rows: [row],
  } = await query.query<{ total: number; actor: number }>(
    `select count(*)::int as total,
            count(*) filter (where payload->>'actorHash' = $4)::int as actor
       from provider_event_receipts
      where organization_id = $1 and provider = 'linear' and dropped_reason = $2
        and received_at > $3 and payload->>'workspaceId' = $5`,
    [binding.organizationId, REASON, new Date(cutoff), actorHash, binding.linearOrganizationId],
  );
  return !row || row.total >= WORKSPACE_LIMIT || row.actor >= ACTOR_LIMIT;
}

async function insertClaim(query: QueryHandle, claim: Claim) {
  const { binding, key, actorHash, receivedAt } = claim;
  const result = await query.query(
    `insert into provider_event_receipts
       (organization_id, provider, connection_id, delivery_id, provider_application_id,
        source, payload, received_at, dropped_reason)
     values ($1, 'linear', $2, $3, $4, 'linear.agent_session', $5::jsonb, $6, $7)
     on conflict do nothing`,
    [
      binding.organizationId,
      binding.id,
      key,
      binding.providerApplicationId,
      JSON.stringify({ actorHash, workspaceId: binding.linearOrganizationId }),
      receivedAt,
      REASON,
    ],
  );
  return result.rowCount === 1;
}

interface Slot {
  actorHash: string;
  time: number;
}

async function claimAttempt(options: Options, slots: Slot[], attempt: Attempt) {
  const { database, locks } = options;
  const { binding, mention, receivedAt } = attempt;
  const digest = (id: string) => createHash("sha256").update(id).digest("hex");
  const actorHash = digest(mention.actorId);
  const claim = {
    binding,
    key: `linear-pilot-not-owner:${digest(mention.nativeSessionId)}`,
    actorHash,
    receivedAt,
  };
  const cutoff = Date.now() - HOUR_MS;
  return database.transaction(async (query) => {
    await locks.withTxLock(query, `linear-pilot-not-owner:${binding.linearOrganizationId}`);
    if (await existingClaim(query, claim)) return "duplicate";
    const recent = slots.filter(({ time }) => time > cutoff);
    if (
      recent.length >= WORKSPACE_LIMIT ||
      recent.filter((slot) => slot.actorHash === actorHash).length >= ACTOR_LIMIT
    )
      return "rate_limited";
    if (await durableLimit(query, claim, cutoff)) return "rate_limited";
    return (await insertClaim(query, claim)) ? "claimed" : "duplicate";
  });
}

function noteAttempt(slots: Slot[], attempt: Attempt) {
  const cutoff = Date.now() - HOUR_MS;
  const fresh = slots.filter(({ time }) => time > cutoff);
  const actorHash = createHash("sha256").update(attempt.mention.actorId).digest("hex");
  slots.splice(0, slots.length, ...fresh, { actorHash, time: attempt.receivedAt.getTime() });
}

function matchesMention(
  session: Awaited<ReturnType<ReturnType<typeof originClient>["readNonOwnerOrigin"]>>,
  { nativeSessionId, actorId, commentId }: NonOwnerMention,
) {
  if (!session || session.id !== nativeSessionId) return false;
  return (
    isHumanCreator(session.creator, actorId) &&
    session.comment?.id === commentId &&
    session.comment.user?.id === actorId &&
    session.comment.botActor === null
  );
}

function isHumanCreator(
  creator: { id: string; active: boolean; app: boolean } | null,
  actorId: string,
) {
  return creator?.id === actorId && creator.active && !creator.app;
}

function logAttempt(attempt: Attempt, reason: string) {
  logger.info(
    {
      workspaceId: attempt.binding.linearOrganizationId,
      nativeSessionId: attempt.mention.nativeSessionId,
      reason,
    },
    "Linear pilot non-owner reply",
  );
}

async function verifyAndPost(options: Options, attempt: Attempt) {
  const { binding, provider, mention } = attempt;
  const client = originClient({
    provider,
    database: options.database,
    binding,
    permits: (operation) =>
      options.accepting() &&
      (operation.kind === "readNonOwnerOrigin" || operation.kind === "createActivity") &&
      operation.sessionId === mention.nativeSessionId,
    current: async (query) => {
      const now = await readBinding(query, options.config, provider.oauthClientId);
      return now?.id === binding.id && now.appUserId === binding.appUserId;
    },
  });
  const session = await readOriginWithin(READ_TIMEOUT_MS, (signal) =>
    client.readNonOwnerOrigin(mention.nativeSessionId, signal),
  );
  if (session === undefined || !matchesMention(session, mention))
    return logAttempt(attempt, "not_owner_unverified");
  await createOriginActivities(client, binding).notOwner({
    binding,
    nativeSessionId: mention.nativeSessionId,
    applicationId: binding.providerApplicationId,
  });
}

export function createNonOwnerOrigin(options: Options) {
  const slots: Slot[] = [];
  return {
    async qualify(input: Delivery, provider: Provider) {
      const precheck = precheckLinearPilotScope({ config: options.config, payload: input.payload });
      if (precheck.ok || precheck.reason !== "not_owner") return undefined;
      if (!mayVerifyNonOwnerMention(options.config, input.payload)) return undefined;
      const binding = await readBinding(options.database, options.config, provider.oauthClientId);
      if (!binding) return undefined;
      const mention = verifyMention(options.config, binding, input);
      return mention && { binding, provider, mention, receivedAt: input.receivedAt };
    },
    async reply(attempt: Attempt) {
      await setImmediate();
      if (!options.accepting()) return;
      const claim = await claimAttempt(options, slots, attempt);
      if (claim === "duplicate") return;
      if (claim === "rate_limited") return logAttempt(attempt, "not_owner_rate_limited");
      noteAttempt(slots, attempt);
      await verifyAndPost(options, attempt);
    },
  };
}
