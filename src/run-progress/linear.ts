import type { Database, LinearConnectionRecord } from "../db/types.js";
import {
  LinearApiError,
  LinearCredentialError,
  LinearTransportError,
  linearConnectionRequiresReauthorization,
  type LinearApiClient,
} from "../providers/linear/client.js";
import { LinearOutputContextSchema } from "../triggers/linear/provider.js";
import type { CredentialLocator, ProgressCall, ProgressProvider } from "./types.js";

interface LinearProgressOptions {
  client: Pick<LinearApiClient, "createComment" | "updateComment">;
  connectionForLinearOrganization: Database["findLinearConnection"];
  clientSecret: string;
}

export function createLinearProgressProvider(options: LinearProgressOptions): ProgressProvider {
  const { client, connectionForLinearOrganization, clientSecret } = options;
  // The writer passes the same locator through authorization, secret checks, and one mutation.
  const authorized = new WeakMap<CredentialLocator, LinearConnectionRecord>();

  const writeOptions = (locator: CredentialLocator, signal: AbortSignal) => {
    const connection = authorized.get(locator);
    authorized.delete(locator);
    if (connection === undefined) throw new LinearCredentialError("connection_not_owned");
    const { id, organizationId, linearOrganizationId, providerApplicationId, appUserId } =
      connection;
    return {
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
      const connection = await connectionForLinearOrganization(locator.linearOrganizationId);
      signal.throwIfAborted();
      if (connection === undefined) return { unavailable: "connection_unavailable" };
      if (connection.organizationId !== run.organizationId)
        return { refused: "connection_not_owned" };
      if (linearConnectionRequiresReauthorization(connection))
        return { unavailable: "reauthorize" };
      authorized.set(locator, connection);
      return "ok";
    },
    secrets(locator, signal) {
      signal.throwIfAborted();
      const connection = authorized.get(locator);
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
        const commentId = await client.createComment(
          { linearOrganizationId: credential.linearOrganizationId, issueId, body },
          writeOptions(credential, signal),
        );
        return { status: "ok", ref: { credential, commentId } };
      } catch (error) {
        return mapCreateError(error);
      }
    },
    async edit({ credential, commentId }, body, signal) {
      if (
        credential.kind !== "linear-organization" ||
        typeof commentId !== "string" ||
        commentId === ""
      )
        return { status: "unavailable", code: "invalid_reference" };
      try {
        await client.updateComment(
          { linearOrganizationId: credential.linearOrganizationId, commentId, body },
          writeOptions(credential, signal),
        );
        return { status: "ok" };
      } catch (error) {
        return mapWriteError(error);
      }
    },
  };
}

const permissionErrorCodes = new Set([
  "FORBIDDEN",
  "PERMISSIONDENIED",
  "INSUFFICIENTSCOPE",
  "INVALIDSCOPE",
  "ACCESSDENIED",
]);
const missingTargetCodes = new Set(["NOTFOUND", "ENTITYNOTFOUND"]);
const permissionErrorMessage =
  /\b(?:forbidden|access denied|not (?:authorized|allowed) to)\b|\b(?:scope|permission)s?\b.*\b(?:required|missing|denied)\b|\b(?:required|missing|insufficient)\b.*\b(?:scope|permission)s?\b/iu;
const missingTargetMessage =
  /\b(?:comment|issue|entity)\b.{0,80}\b(?:not found|does not exist)\b|\b(?:could not|cannot) find (?:the )?(?:comment|issue|entity)\b/iu;

const uncertainWrite = { status: "retry", afterMs: 0, notCreated: false, transient: true } as const;

function mapCreateError(error: unknown): ProgressCall {
  if (error instanceof LinearApiError) {
    if (error.status < 400 || error.hasPartialData) return uncertainWrite;
    if (error.code?.toUpperCase() === "RATELIMITED" && error.status !== 400 && error.status !== 429)
      return uncertainWrite;
  }
  return mapWriteError(error);
}

function mapWriteError(error: unknown): ProgressCall {
  if (error instanceof LinearTransportError) return uncertainWrite;
  if (error instanceof LinearCredentialError) {
    return error.code === "connection_not_owned" || error.code === "body_contains_secret"
      ? { status: "refused", code: error.code }
      : { status: "unavailable", code: error.code };
  }
  if (error instanceof LinearApiError) {
    const code = (error.code ?? "").replaceAll("_", "").toUpperCase();
    const message = error.graphqlMessage ?? error.message;
    if (error.status === 429 || code === "RATELIMITED")
      return { status: "retry", afterMs: error.retryAfterMs ?? 30_000, notCreated: true };
    if (
      error.status === 403 ||
      permissionErrorCodes.has(code) ||
      permissionErrorMessage.test(message)
    )
      return { status: "unavailable", code: "scope_missing" };
    if (error.status === 401 || code === "UNAUTHENTICATED" || code === "AUTHENTICATIONERROR")
      return { status: "unavailable", code: "reauthorize" };
    if (error.status === 404 || missingTargetCodes.has(code) || missingTargetMessage.test(message))
      return { status: "gone" };
  }
  throw error;
}
