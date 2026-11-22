import type { Database, LinearConnectionRecord } from "../db/types.js";
import {
  DEFAULT_LINEAR_RETRY_AFTER_MS,
  LinearApiError,
  LinearCredentialError,
  LinearTransportError,
  authorizeLinearCommentConnection,
  linearConnectionBinding,
  type LinearApiClient,
} from "../providers/linear/client.js";
import { LinearOutputContextSchema } from "../triggers/linear/provider.js";
import type { CredentialLocator, ProgressCall, ProgressProvider, RunScope } from "./types.js";

interface LinearProgressOptions {
  client: Pick<LinearApiClient, "createComment" | "updateComment">;
  connectionForLinearOrganization: Database["findLinearConnection"];
  readRunOutputContext: (run: RunScope) => Promise<unknown>;
  clientSecret: string;
}

export function createLinearProgressProvider(options: LinearProgressOptions): ProgressProvider {
  const { client, connectionForLinearOrganization, readRunOutputContext, clientSecret } = options;
  // The writer passes the same locator through authorization, secret checks, and one mutation.
  const authorized = new WeakMap<
    CredentialLocator,
    {
      connection: LinearConnectionRecord;
      issueId: string;
    }
  >();

  const writeOptions = (locator: CredentialLocator, signal: AbortSignal) => {
    const authorization = authorized.get(locator);
    authorized.delete(locator);
    if (authorization === undefined) throw new LinearCredentialError("connection_not_owned");
    return {
      issueId: authorization.issueId,
      binding: linearConnectionBinding(authorization.connection),
      signal,
    };
  };

  return {
    name: "linear",
    maxBodyChars: 4_000,
    destination(run) {
      const context = LinearOutputContextSchema.safeParse(run.outputContext);
      if (!context.success) return undefined;
      return {
        credential: {
          kind: "linear-organization",
          linearOrganizationId: context.data.linearOrganizationId,
        },
        issueId: context.data.issueId,
      };
    },
    async authorize(locator, run, signal) {
      authorized.delete(locator);
      if (locator.kind !== "linear-organization") return { refused: "invalid_credential" };
      signal.throwIfAborted();
      const context = LinearOutputContextSchema.safeParse(await readRunOutputContext(run));
      signal.throwIfAborted();
      if (!context.success || context.data.linearOrganizationId !== locator.linearOrganizationId)
        return { refused: "target_mismatch" };
      const authority = await authorizeLinearCommentConnection(
        connectionForLinearOrganization,
        locator.linearOrganizationId,
        run.organizationId,
        "write",
        signal,
      );
      if (!("connection" in authority)) return authority;
      authorized.set(locator, { connection: authority.connection, issueId: context.data.issueId });
      return "ok";
    },
    secrets(locator, signal) {
      signal.throwIfAborted();
      const connection = authorized.get(locator)?.connection;
      return Promise.resolve(
        connection === undefined
          ? []
          : [clientSecret, connection.accessToken, connection.refreshToken ?? ""],
      );
    },
    async create({ credential, issueId }, body, signal) {
      if (
        credential.kind !== "linear-organization" ||
        typeof issueId !== "string" ||
        issueId === ""
      )
        return { status: "unavailable", code: "invalid_destination" };
      try {
        const authorization = writeOptions(credential, signal);
        if (issueId !== authorization.issueId) return targetMismatch;
        const { linearOrganizationId } = authorization.binding;
        const commentId = await client.createComment(
          { linearOrganizationId, issueId, body },
          authorization,
        );
        return { status: "ok", ref: { credential, commentId, issueId, linearOrganizationId } };
      } catch (error) {
        return mapCreateError(error);
      }
    },
    async edit({ credential, commentId, issueId, linearOrganizationId }, body, signal) {
      if (
        credential.kind !== "linear-organization" ||
        typeof commentId !== "string" ||
        commentId === ""
      )
        return { status: "unavailable", code: "invalid_reference" };
      try {
        const authorization = writeOptions(credential, signal);
        if (
          issueId !== authorization.issueId ||
          linearOrganizationId !== authorization.binding.linearOrganizationId
        )
          return targetMismatch;
        await client.updateComment({ linearOrganizationId, commentId, body }, authorization);
        return { status: "ok" };
      } catch (error) {
        return mapWriteError(error);
      }
    },
  };
}

const targetMismatch = { status: "refused", code: "target_mismatch" } as const;

const uncertainWrite = { status: "retry", afterMs: 0, notCreated: false, transient: true } as const;

const scopeErrorCodes = new Set([
  "INSUFFICIENT_SCOPE",
  "INVALID_SCOPE",
  "FORBIDDEN",
  "PERMISSION_DENIED",
  "ACCESS_DENIED",
]);
const authenticationErrorCodes = new Set(["AUTHENTICATION_ERROR", "UNAUTHENTICATED"]);
const missingTargetCodes = new Set(["NOT_FOUND", "ENTITY_NOT_FOUND", "ENTITYNOTFOUND"]);

function mapCreateError(error: unknown): ProgressCall {
  const outcome = mapWriteError(error);
  if (outcome.status === "retry" && !outcome.notCreated) return uncertainWrite;
  if (outcome.status === "gone" && error instanceof LinearApiError && error.status !== 404)
    return uncertainWrite;
  return outcome;
}

function mapWriteError(error: unknown): ProgressCall {
  if (error instanceof LinearTransportError) return uncertainWrite;
  if (error instanceof LinearCredentialError) {
    return error.code === "connection_not_owned" || error.code === "body_contains_secret"
      ? { status: "refused", code: error.code }
      : { status: "unavailable", code: error.code };
  }
  if (!(error instanceof LinearApiError)) throw error;
  if (error.status >= 500) return uncertainWrite;
  switch (error.status) {
    case 401:
      return { status: "unavailable", code: "reauthorize" };
    case 403:
      return { status: "unavailable", code: "scope_missing" };
    case 404:
      return { status: "gone" };
  }
  const { graphqlCodes } = error;
  if (graphqlCodes.some((code) => authenticationErrorCodes.has(code)))
    return { status: "unavailable", code: "reauthorize" };
  if (graphqlCodes.some((code) => scopeErrorCodes.has(code)))
    return { status: "unavailable", code: "scope_missing" };
  if (error.status === 429 || graphqlCodes.includes("RATELIMITED")) return rateLimited(error);
  if (graphqlCodes.some((code) => missingTargetCodes.has(code))) return { status: "gone" };
  return uncertainWrite;
}

function rateLimited(error: LinearApiError): ProgressCall {
  return {
    status: "retry",
    afterMs: error.retryAfterMs ?? DEFAULT_LINEAR_RETRY_AFTER_MS,
    notCreated: error.rateLimitBeforeExecution,
  };
}
