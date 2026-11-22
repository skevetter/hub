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
    comment: ref.nullable(),
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
              z.object({
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
type DelegationVerdict =
  | { message: string }
  | { reason: "origin_unproven" | "oversized" | "unqualified_content" };
const unproven = { reason: "origin_unproven" } as const;

function matchesSession(session: Session, signed: LinearPilotEvent) {
  return (
    session.id === signed.nativeSessionId &&
    session.appUser.id === signed.appUserId &&
    session.creator?.id === signed.humanId &&
    session.comment === null &&
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

function issuePrompt(issue: Issue): DelegationVerdict {
  const message = `Work on ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}`;
  if (message.length > MAX_PILOT_MESSAGE_CHARS) return { reason: "oversized" };
  return validMessage(message) ? { message } : { reason: "unqualified_content" };
}

function verify({ agentSession: session }: DelegationReadback, signed: LinearPilotEvent) {
  const { issue } = session;
  if (!issue || !matchesSession(session, signed) || !matchesIssue(issue, signed)) return unproven;
  if (!issue.history.nodes.some((entry) => matchesEntry(entry, session.createdAt, signed)))
    return undefined;
  return issuePrompt(issue);
}

export async function proveDelegation(
  signed: LinearPilotEvent,
  ackDeadline: number,
  read: (signal: AbortSignal) => Promise<DelegationReadback>,
) {
  const deadline = Math.min(ackDeadline, Date.now() + PROOF_BUDGET_MS);
  if (Date.now() >= deadline) return unproven;
  const controller = new AbortController();
  const timeout = Promise.withResolvers<typeof unproven>();
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timeout.resolve(unproven);
    controller.abort();
  }, deadline - Date.now());
  async function check() {
    const first = verify(await read(controller.signal), signed);
    if (first) return first;
    if (Date.now() + HISTORY_RECHECK_MS >= deadline) return unproven;
    await new Promise<void>((resolve) => {
      recheck = setTimeout(resolve, HISTORY_RECHECK_MS);
    });
    if (controller.signal.aborted || Date.now() >= deadline) return unproven;
    return verify(await read(controller.signal), signed) ?? unproven;
  }
  try {
    const verdict = await Promise.race([timeout.promise, check()]);
    return Date.now() >= deadline ? unproven : verdict;
  } finally {
    clearTimeout(timer);
    clearTimeout(recheck);
  }
}
