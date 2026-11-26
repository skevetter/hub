import type { z } from "zod";
import type { apiKeySummarySchema } from "../auth/api-key-contract.js";
import type { StateView } from "../components/app/state-label.js";

export type WebhookKeyRecord = z.infer<typeof apiKeySummarySchema>;
export type WebhookKeyStatus = "active" | "expiring" | "expired" | "revoked";

export const DEFAULT_OVERLAP_MINUTES = 60;
export const MAX_OVERLAP_MINUTES = 24 * 60;

/** Live means not revoked and not past its expiry. A key with a future expiry is still live. */
export function webhookKeyStatus(
  key: Pick<WebhookKeyRecord, "revokedAt" | "expiresAt">,
  now: number,
): WebhookKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt === null) return "active";
  return new Date(key.expiresAt).getTime() > now ? "expiring" : "expired";
}

const STATES: Readonly<Record<WebhookKeyStatus, StateView>> = {
  active: { label: "Active", tone: "done" },
  expiring: { label: "Expiring", tone: "live" },
  expired: { label: "Expired", tone: "off" },
  revoked: { label: "Revoked", tone: "off" },
};

export function webhookKeyState(status: WebhookKeyStatus): StateView {
  return STATES[status];
}

/** A key that is already expiring has been rotated; rotating it again is refused. */
export function canRotateWebhookKey(status: WebhookKeyStatus): boolean {
  return status === "active";
}

export function canRevokeWebhookKey(status: WebhookKeyStatus): boolean {
  return status === "active" || status === "expiring";
}

/** Whole minutes in 0 to 1440, as seconds. Anything else is not a valid overlap. */
export function overlapSecondsFromMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return minutes <= MAX_OVERLAP_MINUTES ? minutes * 60 : null;
}

export function overlapError(value: string): string | undefined {
  return overlapSecondsFromMinutes(value) === null
    ? `Use a whole number of minutes from 0 to ${String(MAX_OVERLAP_MINUTES)}.`
    : undefined;
}

export function actorFixMessage(actor: string | null): string {
  const name = actor ?? "this key's actor";
  return `Deliveries with this key return 404 because the trigger's from_users does not allow ${name}. Add it to from_users in the trigger, or create a key with an allowed actor.`;
}
