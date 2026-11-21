import { createHash } from "node:crypto";
import { z } from "zod";
import type { AcceptedTriggerRunRecord, Database, LinearConnectionRecord } from "../db/types.js";
import {
  DEFAULT_LINEAR_RETRY_AFTER_MS,
  LinearApiError,
  LinearCredentialError,
  authorizeLinearCommentConnection,
  linearConnectionBinding,
  type LinearApiClient,
  type LinearCommentWriteOptions,
} from "../providers/linear/client.js";
import { MAX_RETRY_AFTER } from "../run-progress/backoff.js";
import { LinearOutputContextSchema } from "../triggers/linear/provider.js";
import { formatRunReply, type FinalReplyAnswer } from "./format.js";
import { hasLinearRunReplyMarker, linearRunReplyMarker } from "./marker.js";
import type { RunReplyFailure, RunReplyRecord } from "./store.js";

const sourceSchema = z.object({
  provider: z.literal("linear"),
  target: LinearOutputContextSchema,
  event: z.object({
    linear: z.object({
      event_type: z.enum(["comment", "issue"]),
      action: z.enum(["create", "update"]),
      connection_id: z.string().min(1),
      organization: z.object({ id: z.string().min(1) }),
      issue: z.object({ id: z.string().min(1) }),
      comment: z.object({ id: z.string().min(1), body: z.string() }).nullable(),
    }),
  }),
});

interface LinearRunReplyOptions {
  database: Database;
  client: Pick<LinearApiClient, "readIssue" | "readComment" | "createComment">;
  connectionForLinearOrganization: Database["findLinearConnection"];
  clientSecret: string;
  providerApplicationId: string;
  secrets?: readonly string[];
}

interface ReplyTarget {
  linearOrganizationId: string;
  issueId: string;
  sourceComment: { id: string; body: string } | null;
  connection: LinearConnectionRecord;
  authorization: LinearCommentWriteOptions;
  bindingHash: string;
}

export class LinearRunReplyWriter {
  constructor(private readonly options: LinearRunReplyOptions) {}

  async post(
    run: AcceptedTriggerRunRecord,
    answer: FinalReplyAnswer,
    perHour: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { runReplies } = this.options.database;
    const key = { organizationId: run.organizationId, runId: run.id };
    const delivery = await runReplies.find(key);
    if (delivery?.state !== "pending" || run.status === "running") return;
    if (run.status !== "succeeded") {
      await runReplies.finish({ ...key, from: "pending", failure: "run_unsuccessful" });
      return;
    }
    const prepared = await this.prepare(run, answer, signal);
    if (typeof prepared === "string") {
      await runReplies.finish({ ...key, from: "pending", failure: prepared });
      return;
    }
    const { target, text } = prepared;
    const body = `${text}\n\n${linearRunReplyMarker(delivery.commentId)}`;
    signal.throwIfAborted();
    const reservation = await runReplies.reserve({
      ...key,
      length: text.length,
      hash: hash(text),
      bindingHash: target.bindingHash,
      perHour,
    });
    if (reservation !== "reserved") return;

    const firstAttempt = await this.create(target, delivery.commentId, body);
    const created =
      typeof firstAttempt === "number"
        ? await this.retryCreate(target, delivery, body, firstAttempt)
        : firstAttempt;
    if (created !== undefined)
      await runReplies.finish({ ...key, from: "sending", failure: created });
  }

  async repair(run: AcceptedTriggerRunRecord, delivery: RunReplyRecord, signal: AbortSignal) {
    const key = { organizationId: run.organizationId, runId: run.id };
    if (
      run.status !== "succeeded" ||
      delivery.state !== "sending" ||
      delivery.organizationId !== key.organizationId ||
      delivery.runId !== key.runId
    )
      return;
    const found = await this.findPostedReply(run, delivery, signal);
    signal.throwIfAborted();
    await this.options.database.runReplies.finish({
      ...key,
      from: "sending",
      failure: found ? null : "delivery_unconfirmed",
    });
  }

  private async create(
    target: ReplyTarget,
    commentId: string,
    body: string,
  ): Promise<RunReplyFailure | null | undefined | number> {
    const { linearOrganizationId, issueId, authorization } = target;
    try {
      const created = await this.options.client.createComment(
        { linearOrganizationId, issueId, commentId, body },
        authorization,
      );
      return created === commentId ? null : undefined;
    } catch (error) {
      if (error instanceof LinearCredentialError) return credentialFailure(error);
      if (error instanceof LinearApiError) {
        if (error.status === 404) return "target_mismatch";
        if ([401, 403].includes(error.status)) return "provider_rejected";
        if (error.rateLimitBeforeExecution)
          return error.retryAfterMs ?? DEFAULT_LINEAR_RETRY_AFTER_MS;
        if (error.graphqlRejected) {
          return error.status === 429 || error.graphqlCodes.includes("RATELIMITED")
            ? "provider_rate_limited"
            : "provider_rejected";
        }
      }
      // A transport or response error can follow a committed comment.
      return undefined;
    }
  }

  private async retryCreate(
    target: ReplyTarget,
    { organizationId, runId, commentId }: RunReplyRecord,
    body: string,
    afterMs: number,
  ) {
    const { signal } = target.authorization;
    try {
      await waitForRetry(afterMs, signal);
      const run = await this.options.database.findTriggerRunForOrganization(organizationId, runId);
      if (run?.outcome !== "accepted" || run.payloadExpiryState != null) return "target_mismatch";
      if (run.status !== "succeeded") return "run_unsuccessful";
      if (!(await this.verifyTarget(target))) return "target_mismatch";
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) return "provider_rate_limited";
      return error instanceof LinearCredentialError ? credentialFailure(error) : "target_mismatch";
    }
    const result = await this.create(target, commentId, body);
    return typeof result === "number" ? "provider_rate_limited" : result;
  }

  private async findPostedReply(
    run: AcceptedTriggerRunRecord,
    delivery: RunReplyRecord,
    signal: AbortSignal,
  ) {
    try {
      const target = await this.authorize(run, signal);
      if (typeof target === "string" || delivery.bindingHash !== target.bindingHash) return false;
      const { linearOrganizationId, issueId, connection, authorization } = target;
      const comment = await this.options.client.readComment(
        { linearOrganizationId, commentId: delivery.commentId },
        authorization,
      );
      return (
        comment?.id === delivery.commentId &&
        comment.issue?.id === issueId &&
        comment.user?.id === connection.appUserId &&
        hasLinearRunReplyMarker(comment.body, delivery.commentId)
      );
    } catch {
      return false;
    }
  }

  private async prepare(
    run: AcceptedTriggerRunRecord,
    answer: FinalReplyAnswer,
    signal: AbortSignal,
  ) {
    if (answer.text.trim() === "") return "empty_answer";
    let target: ReplyTarget | RunReplyFailure;
    try {
      target = await this.authorize(run, signal);
    } catch (error) {
      signal.throwIfAborted();
      return error instanceof LinearCredentialError
        ? credentialFailure(error)
        : "connection_unavailable";
    }
    if (typeof target === "string") return target;
    const { connection } = target;
    const secrets = [
      this.options.clientSecret,
      connection.accessToken,
      connection.refreshToken ?? "",
      ...(this.options.secrets ?? []),
    ].filter(Boolean);
    let text: string;
    try {
      text = formatRunReply(answer, secrets);
    } catch {
      return "reply_unrenderable";
    }
    if (text === "") return "empty_answer";
    if (secrets.some((secret) => text.includes(secret))) return "body_contains_secret";
    try {
      return (await this.verifyTarget(target)) ? { target, text } : "target_mismatch";
    } catch (error) {
      signal.throwIfAborted();
      return error instanceof LinearCredentialError ? credentialFailure(error) : "target_mismatch";
    }
  }

  private async authorize(
    run: AcceptedTriggerRunRecord,
    signal: AbortSignal,
  ): Promise<ReplyTarget | RunReplyFailure> {
    const output = LinearOutputContextSchema.safeParse(run.outputContext);
    const source = sourceSchema.safeParse(run.triggerContext);
    if (!output.success || !source.success || run.payloadExpiryState != null)
      return "target_mismatch";
    const { linearOrganizationId, issueId } = output.data;
    const {
      target,
      event: { linear },
    } = source.data;
    if (
      linearOrganizationId !== target.linearOrganizationId ||
      linearOrganizationId !== linear.organization.id ||
      issueId !== target.issueId ||
      issueId !== linear.issue.id ||
      (linear.event_type === "comment" && (linear.action !== "create" || linear.comment === null))
    )
      return "target_mismatch";
    const authority = await authorizeLinearCommentConnection(
      this.options.connectionForLinearOrganization,
      linearOrganizationId,
      run.organizationId,
      "comments:create",
      signal,
    );
    if (!("connection" in authority)) {
      if ("unavailable" in authority && authority.unavailable === "scope_missing")
        return "scope_missing";
      return "connection_unavailable";
    }
    const { connection } = authority;
    if (
      connection.id !== linear.connection_id ||
      connection.providerApplicationId !== this.options.providerApplicationId
    )
      return "connection_unavailable";
    const binding = linearConnectionBinding(connection);
    const sourceComment = linear.event_type === "comment" ? linear.comment : null;
    return {
      linearOrganizationId,
      issueId,
      sourceComment,
      connection,
      authorization: { binding, requiredScope: "comments:create", signal },
      bindingHash: hash(JSON.stringify([binding, issueId, sourceComment?.id])),
    };
  }

  private async verifyTarget({
    linearOrganizationId,
    issueId,
    sourceComment,
    authorization,
  }: ReplyTarget) {
    const { client } = this.options;
    if (sourceComment === null)
      return (
        (await client.readIssue({ linearOrganizationId, issueId }, authorization))?.id === issueId
      );
    const comment = await client.readComment(
      { linearOrganizationId, commentId: sourceComment.id },
      authorization,
    );
    return (
      comment?.id === sourceComment.id &&
      comment.issue?.id === issueId &&
      comment.archivedAt === null &&
      comment.body === sourceComment.body
    );
  }
}

function credentialFailure(error: LinearCredentialError): RunReplyFailure {
  switch (error.code) {
    case "scope_missing":
    case "body_contains_secret":
      return error.code;
    default:
      return "connection_unavailable";
  }
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

async function waitForRetry(afterMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, Math.min(afterMs, MAX_RETRY_AFTER));
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
