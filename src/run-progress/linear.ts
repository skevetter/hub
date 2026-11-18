import type { Database, LinearConnectionRecord } from "../db/types.js";
import {
  LinearApiError,
  LinearCredentialError,
  LinearTransportError,
  linearConnectionRequiresReauthorization,
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
    const { id, organizationId, linearOrganizationId, providerApplicationId, appUserId } =
      authorization.connection;
    return {
      issueId: authorization.issueId,
      binding: { id, organizationId, linearOrganizationId, providerApplicationId, appUserId },
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
      const connection = await connectionForLinearOrganization(locator.linearOrganizationId);
      signal.throwIfAborted();
      if (connection === undefined) return { unavailable: "connection_unavailable" };
      if (connection.linearOrganizationId !== context.data.linearOrganizationId)
        return { refused: "target_mismatch" };
      if (connection.organizationId !== run.organizationId)
        return { refused: "connection_not_owned" };
      if (linearConnectionRequiresReauthorization(connection))
        return { unavailable: "reauthorize" };
      authorized.set(locator, { connection, issueId: context.data.issueId });
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

function mapCreateError(error: unknown): ProgressCall {
  if (error instanceof LinearApiError && error.status < 400) return uncertainWrite;
  const outcome = mapWriteError(error);
  return outcome.status === "retry" && !outcome.notCreated ? uncertainWrite : outcome;
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
    case 429:
      return rateLimited(error);
  }
  switch (error.code?.toUpperCase()) {
    case "UNAUTHENTICATED":
      return { status: "unavailable", code: "reauthorize" };
    case "FORBIDDEN":
      return { status: "unavailable", code: "scope_missing" };
    case "NOT_FOUND":
    case "ENTITY_NOT_FOUND":
    case "ENTITYNOTFOUND":
      return { status: "gone" };
    case "RATELIMITED":
      return rateLimited(error);
    default:
      return uncertainWrite;
  }
}

function rateLimited(error: LinearApiError): ProgressCall {
  return {
    status: "retry",
    afterMs: error.retryAfterMs ?? 30_000,
    notCreated: error.rateLimitBeforeExecution,
  };
}
