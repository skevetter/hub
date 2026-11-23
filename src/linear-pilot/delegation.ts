import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { validMessage } from "../interactive-sessions/store.js";
import { MAX_PILOT_MESSAGE_CHARS, type LinearPilotEvent } from "./intake.js";

export const DELEGATION_HISTORY_LIMIT = 20;
const PROOF_BUDGET_MS = 4_000;
const HISTORY_WINDOW_NS = 120_000_000_000n;
const HISTORY_RECHECK_MS = 1_000;
const id = z.string().min(1).max(255);
const ref = z.object({ id });
const timestamp = z.iso.datetime({ offset: true }).transform((value, ctx) => {
  try {
    return Temporal.Instant.from(value).epochNanoseconds;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid Linear timestamp" });
    return z.NEVER;
  }
});

export const delegationReadback = z.object({
  agentSession: ref.extend({
    createdAt: timestamp,
    appUser: ref,
    creator: ref.nullable(),
    comment: ref.extend({ user: ref.nullable() }).nullable(),
    sourceComment: ref.nullable(),
    issue: ref
      .extend({
        identifier: z.string().min(1),
        title: z.string().min(1),
        description: z.string().nullable(),
        team: ref.extend({ organization: ref }),
        delegate: ref.nullable(),
        assignee: ref.nullable(),
        history: z.object({
          nodes: z
            .array(
              ref.extend({
                createdAt: timestamp,
                actor: ref.nullable(),
                botActor: z.object({ id: id.nullable() }).nullable(),
                toDelegate: ref.nullable(),
                toAssignee: ref.nullable(),
                triageResponsibilityAutoAssigned: z.boolean().nullable(),
              }),
            )
            .max(DELEGATION_HISTORY_LIMIT),
        }),
      })
      .nullable(),
  }),
});

type DelegationReadback = z.infer<typeof delegationReadback>;
type Session = DelegationReadback["agentSession"];
type Issue = NonNullable<Session["issue"]>;
type MatchedDelegation =
  | { message: string; historyEntryId: string }
  | { reason: "oversized" | "unqualified_content"; historyEntryId: string };
export type DelegationProofStage =
  | "session_mismatch"
  | "issue_mismatch"
  | "no_history_match"
  | "timeout"
  | "readback_failed";

function unproven(stage: DelegationProofStage) {
  return { reason: "origin_unproven", stage } as const;
}

const timedOut = unproven("timeout");
const noHistoryMatch = unproven("no_history_match");
type DelegationVerdict = MatchedDelegation | ReturnType<typeof unproven>;
export type DelegationRefusal =
  | Extract<DelegationVerdict, { reason: string }>["reason"]
  | "origin_reused";

function matchesSession(session: Session, signed: LinearPilotEvent) {
  const commentAuthor = session.comment?.user?.id;
  return (
    session.id === signed.nativeSessionId &&
    session.appUser.id === signed.appUserId &&
    session.creator?.id === signed.humanId &&
    (commentAuthor === undefined || commentAuthor === signed.humanId) &&
    session.sourceComment === null
  );
}

function matchesIssue(issue: Issue, signed: LinearPilotEvent) {
  return (
    issue.id === signed.issueId &&
    issue.team.id === signed.teamId &&
    issue.team.organization.id === signed.workspaceId &&
    (issue.delegate?.id === signed.appUserId || issue.assignee?.id === signed.appUserId)
  );
}

function matchesEntry(
  entry: Issue["history"]["nodes"][number],
  sessionAt: bigint,
  signed: LinearPilotEvent,
) {
  const age = sessionAt - entry.createdAt;
  return (
    age >= 0n &&
    age <= HISTORY_WINDOW_NS &&
    entry.actor?.id === signed.humanId &&
    entry.botActor === null &&
    entry.triageResponsibilityAutoAssigned !== true &&
    (entry.toDelegate?.id === signed.appUserId || entry.toAssignee?.id === signed.appUserId)
  );
}

function issuePrompt(issue: Issue, historyEntryId: string): MatchedDelegation {
  const message = `Work on ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}`;
  if (message.length > MAX_PILOT_MESSAGE_CHARS) return { reason: "oversized", historyEntryId };
  return validMessage(message)
    ? { message, historyEntryId }
    : { reason: "unqualified_content", historyEntryId };
}

function verify({ agentSession: session }: DelegationReadback, signed: LinearPilotEvent) {
  const { issue } = session;
  if (!matchesSession(session, signed)) return unproven("session_mismatch");
  if (!issue || !matchesIssue(issue, signed)) return unproven("issue_mismatch");
  const match = newestMatchingEntry(issue.history.nodes, session.createdAt, signed);
  return match && issuePrompt(issue, match.id);
}

function newestMatchingEntry(
  entries: Issue["history"]["nodes"],
  sessionAt: bigint,
  signed: LinearPilotEvent,
) {
  let newest: (typeof entries)[number] | undefined;
  for (const entry of entries) {
    if (!matchesEntry(entry, sessionAt, signed)) continue;
    if (
      !newest ||
      entry.createdAt > newest.createdAt ||
      (entry.createdAt === newest.createdAt && entry.id < newest.id)
    ) {
      newest = entry;
    }
  }
  return newest;
}

export async function proveDelegation(
  signed: LinearPilotEvent,
  ackDeadline: number,
  read: (signal: AbortSignal) => Promise<DelegationReadback>,
) {
  const deadline = Math.min(ackDeadline, Date.now() + PROOF_BUDGET_MS);
  if (Date.now() >= deadline) return timedOut;
  const controller = new AbortController();
  const timeout = Promise.withResolvers<typeof timedOut>();
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timeout.resolve(timedOut);
    controller.abort();
  }, deadline - Date.now());
  async function check() {
    const first = verify(await read(controller.signal), signed);
    if (first) return first;
    if (Date.now() + HISTORY_RECHECK_MS >= deadline) return noHistoryMatch;
    await new Promise<void>((resolve) => {
      recheck = setTimeout(resolve, HISTORY_RECHECK_MS);
    });
    if (controller.signal.aborted || Date.now() >= deadline) return timedOut;
    return verify(await read(controller.signal), signed) ?? noHistoryMatch;
  }
  try {
    const verdict = await Promise.race([timeout.promise, check()]);
    return Date.now() >= deadline ? timedOut : verdict;
  } finally {
    clearTimeout(timer);
    clearTimeout(recheck);
  }
}
