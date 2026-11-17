import { z } from "zod";
import type { JsonValue } from "../config/compiler.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import type { ProgressProviderName } from "../run-timeline/store.js";

const credentialLocator = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("installation"), installationId: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("progress-token") }),
  z.strictObject({ kind: z.literal("slack-workspace"), teamId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("linear-organization"),
    linearOrganizationId: z.string().min(1),
  }),
]);

export type CredentialLocator = z.infer<typeof credentialLocator>;

export type ProgressDestination = { credential: CredentialLocator } & Record<string, JsonValue>;
export type StoredRef = ProgressDestination;
export type RunScope = Pick<AcceptedTriggerRunRecord, "id" | "organizationId" | "projectId">;

export function parseStoredRef(value: JsonValue | undefined): StoredRef | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const credential = credentialLocator.safeParse(value["credential"]);
  if (!credential.success) return undefined;
  return { ...value, credential: credential.data };
}

export type ProgressCall =
  | { status: "ok"; ref?: StoredRef }
  | { status: "retry"; afterMs: number; notCreated: boolean; transient?: true }
  | { status: "gone" }
  | { status: "unavailable"; code: string }
  | { status: "refused"; code: string };

export interface ProgressProvider {
  readonly name: ProgressProviderName;
  readonly maxBodyChars: number;
  destination(run: AcceptedTriggerRunRecord): ProgressDestination | undefined;
  authorize(
    locator: CredentialLocator,
    run: RunScope,
    signal: AbortSignal,
  ): Promise<"ok" | { refused: string } | { unavailable: string }>;
  create(
    destination: ProgressDestination,
    body: string,
    signal: AbortSignal,
  ): Promise<ProgressCall>;
  edit(ref: StoredRef, body: string, signal: AbortSignal): Promise<ProgressCall>;
  secrets(locator: CredentialLocator, signal: AbortSignal): Promise<readonly string[]>;
}

export type ProgressStore = Pick<
  Database,
  | "findProviderEventReceiptById"
  | "findOrganizationSlugById"
  | "findTriggerRunForOrganization"
  | "listWorkflowStepRunsForTriggerRun"
  | "listRunTimelineEvents"
  | "insertRunProgressMessageIfAbsent"
  | "findRunProgressMessage"
  | "acquireRunProgressLease"
  | "updateRunProgressMessage"
  | "listRunProgressMessagesToFinish"
  | "listOpenRunProgressMessages"
  | "requestCompensation"
  | "completeCompensation"
>;

export interface ProgressClock {
  now(): number;
  monotonic(): number;
  timer(callback: () => void, ms: number): () => void;
}

export const progressClock: ProgressClock = {
  now: Date.now,
  monotonic: () => performance.now(),
  timer(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
