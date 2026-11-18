import { z } from "zod";
import type { Database, LinearConnectionRecord } from "../../db/types.js";

export const LINEAR_REQUIRED_SCOPES = [
  "read",
  "comments:create",
  "app:assignable",
  "app:mentionable",
] as const;

/** Keep an issue description plus its preceding discussion within one bounded context window. */
export const LINEAR_ISSUE_CONTEXT_LIMIT = 50;
export const LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT = LINEAR_ISSUE_CONTEXT_LIMIT - 1;
const LINEAR_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const LINEAR_RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024;
const LINEAR_RESPONSE_BODY_TIMEOUT_MS = 5_000;

const LinearTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

const OAuthErrorSchema = z.object({ error: z.string() });

const ViewerResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string().min(1),
      organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    }),
  }),
});

const GraphqlErrorsSchema = z.object({ errors: z.array(z.unknown()) });
const GraphqlErrorSchema = z.object({
  message: z.string().optional(),
  extensions: z.object({ code: z.string().optional() }).optional(),
});

const IssueResponseSchema = z.object({
  data: z.object({
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string().min(1).optional(),
        title: z.string(),
        description: z.string().nullable().optional(),
        url: z.string().url().optional(),
        project: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        state: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        assignee: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        labels: z.object({ nodes: z.array(z.object({ id: z.string().min(1) })) }),
      })
      .nullable(),
  }),
});

const IssueCommentHistoryResponseSchema = z.object({
  data: z.object({
    comments: z.object({
      nodes: z.array(
        z.object({
          id: z.string().min(1),
          body: z.string(),
          createdAt: z.string().datetime(),
          user: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1).nullable().optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
      pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    }),
  }),
});

const CommentCreateResponseSchema = z.object({
  data: z.object({
    commentCreate: z.object({
      success: z.literal(true),
      comment: z.object({ id: z.string().min(1) }),
    }),
  }),
});

const CommentUpdateResponseSchema = z.object({
  data: z.object({
    commentUpdate: z.object({ success: z.literal(true) }),
  }),
});

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
    readonly rateLimitBeforeExecution = false,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}

export class LinearTransportError extends Error {
  constructor(cause: unknown) {
    super("Linear request failed", { cause });
    this.name = "LinearTransportError";
  }
}

const credentialErrorMessages = {
  connection_unavailable: "Linear connection unavailable",
  connection_not_owned: "Linear connection belongs to another Hub organization",
  reauthorize: "Linear connection requires reauthorization",
  body_contains_secret: "Linear progress body contains the access token",
} as const;

export class LinearCredentialError extends Error {
  constructor(readonly code: keyof typeof credentialErrorMessages) {
    super(credentialErrorMessages[code]);
    this.name = "LinearCredentialError";
  }
}

export interface LinearInstallation {
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface LinearTokenRefresh {
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

export interface LinearConnectionClient {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<LinearInstallation>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<LinearTokenRefresh>;
  revoke(accessToken: string): Promise<void>;
}

export interface LinearIssueDetails {
  id: string;
  identifier?: string;
  title: string;
  description: string | null;
  url?: string;
  projectId: string | null;
  stateId: string | null;
  assigneeId: string | null;
  labelIds: string[];
}

export interface LinearIssueComment {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name?: string } | null;
}

export interface LinearIssueCommentHistory {
  comments: LinearIssueComment[];
  complete: boolean;
}

export interface LinearApiClient {
  readIssue(input: {
    linearOrganizationId: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined>;
  readIssueComments(input: {
    linearOrganizationId: string;
    issueId: string;
    beforeCreatedAt: string;
  }): Promise<LinearIssueCommentHistory>;
  createComment(
    input: { linearOrganizationId: string; issueId: string; body: string },
    options?: LinearCommentWriteOptions,
  ): Promise<string>;
  updateComment(
    input: { linearOrganizationId: string; commentId: string; body: string },
    options?: LinearCommentWriteOptions,
  ): Promise<void>;
}

type LinearConnectionBinding = Pick<
  LinearConnectionRecord,
  "id" | "organizationId" | "linearOrganizationId" | "providerApplicationId" | "appUserId"
>;

interface LinearCommentWriteOptions {
  binding: LinearConnectionBinding;
  signal: AbortSignal;
}

interface GraphqlPayload {
  query: string;
  variables: Record<string, string>;
}

export function hasRequiredLinearScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return LINEAR_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

export function linearConnectionRequiresReauthorization(
  connection: Pick<LinearConnectionRecord, "scopes" | "refreshToken" | "accessTokenExpiresAt">,
  now = new Date(),
): boolean {
  return (
    !hasRequiredLinearScopes(connection.scopes) ||
    (connection.refreshToken === null && !hasUsableLinearAccessToken(connection, now))
  );
}

function hasUsableLinearAccessToken(
  connection: Pick<LinearConnectionRecord, "accessTokenExpiresAt">,
  now: Date,
): boolean {
  const expiresAt = connection.accessTokenExpiresAt;
  return (
    expiresAt === null || expiresAt.getTime() > now.getTime() + LINEAR_ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}

export function createLinearConnectionClient(options: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearConnectionClient {
  const request = options.fetch ?? fetch;
  const redirectUri = new URL(
    "/api/integrations/linear/callback",
    options.publicBaseUrl,
  ).toString();
  const now = options.now ?? (() => new Date());

  return {
    authorizationUrl(state) {
      const parameters = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: LINEAR_REQUIRED_SCOPES.join(","),
        state,
        actor: "app",
        prompt: "consent",
      });
      return `https://linear.app/oauth/authorize?${parameters.toString()}`;
    },
    async exchangeCode(code) {
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        },
        now,
      );
      const viewer = await readViewer(request, token.accessToken);
      return {
        linearOrganizationId: viewer.organization.id,
        linearOrganizationName: viewer.organization.name,
        appUserId: viewer.id,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        accessTokenExpiresAt: token.accessTokenExpiresAt ?? null,
        scopes: token.scopes ?? [...LINEAR_REQUIRED_SCOPES],
      };
    },
    async refresh(refreshToken, signal) {
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        now,
        signal,
      );
      return {
        accessToken: token.accessToken,
        ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
        accessTokenExpiresAt: token.accessTokenExpiresAt ?? null,
        ...(token.scopes === undefined ? {} : { scopes: token.scopes }),
      };
    },
    async revoke(accessToken) {
      const response = await request("https://api.linear.app/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          token: accessToken,
        }),
      });
      if (!response.ok) throw new Error(`Linear revoke HTTP ${response.status}`);
    },
  };
}

/**
 * The API client always finds credentials through the external Linear organization ID. That ID is
 * part of signed webhook evidence and output context, while Hub organization IDs remain internal.
 */
export function createLinearApiClient(options: {
  connectionForLinearOrganization(
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined>;
  withLinearConnectionRefresh: Database["withLinearConnectionRefresh"];
  connectionClient: Pick<LinearConnectionClient, "refresh">;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearApiClient {
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  // Avoid duplicate local work, while the database transaction remains the cross-process source of
  // truth for refresh serialization and rebind safety.
  const refreshes = new Map<string, Promise<LinearConnectionRecord>>();

  const hasUsableAccessToken = (connection: LinearConnectionRecord): boolean =>
    hasUsableLinearAccessToken(connection, now());

  const checkWriteConnection = (
    connection: LinearConnectionRecord,
    write?: LinearCommentWriteOptions,
  ): void => {
    if (write === undefined) return;
    const { binding } = write;
    if (
      connection.id !== binding.id ||
      connection.organizationId !== binding.organizationId ||
      connection.linearOrganizationId !== binding.linearOrganizationId ||
      connection.providerApplicationId !== binding.providerApplicationId ||
      connection.appUserId !== binding.appUserId
    )
      throw new LinearCredentialError("connection_not_owned");
    if (linearConnectionRequiresReauthorization(connection, now()))
      throw new LinearCredentialError("reauthorize");
  };

  const connectionForToken = async (
    linearOrganizationId: string,
    write?: LinearCommentWriteOptions,
  ): Promise<LinearConnectionRecord> => {
    write?.signal.throwIfAborted();
    const connection = await options.connectionForLinearOrganization(linearOrganizationId);
    write?.signal.throwIfAborted();
    if (connection === undefined) throw new LinearCredentialError("connection_unavailable");
    checkWriteConnection(connection, write);
    if (hasUsableAccessToken(connection)) return connection;
    if (connection.refreshToken === null) throw new LinearCredentialError("reauthorize");
    return refreshConnection(linearOrganizationId, connection, write);
  };

  const refreshConnection = async (
    linearOrganizationId: string,
    connection: LinearConnectionRecord,
    write?: LinearCommentWriteOptions,
  ): Promise<LinearConnectionRecord> => {
    const key = JSON.stringify([connection.id, write?.binding.organizationId]);
    const existing = refreshes.get(key);
    if (existing !== undefined) return existing;
    const pending = options.withLinearConnectionRefresh(
      linearOrganizationId,
      async (current, updateTokens) => {
        write?.signal.throwIfAborted();
        if (current === undefined) throw new LinearCredentialError("connection_unavailable");
        checkWriteConnection(current, write);
        if (hasUsableAccessToken(current)) return current;
        if (current.refreshToken === null) throw new LinearCredentialError("reauthorize");
        const refreshed = await options.connectionClient.refresh(
          current.refreshToken,
          write?.signal,
        );
        write?.signal.throwIfAborted();
        await updateTokens(refreshed);
        write?.signal.throwIfAborted();
        return { ...current, ...refreshed };
      },
    );
    refreshes.set(key, pending);
    try {
      return await pending;
    } finally {
      if (refreshes.get(key) === pending) refreshes.delete(key);
    }
  };

  const accessTokenFor = async (linearOrganizationId: string) =>
    (await connectionForToken(linearOrganizationId)).accessToken;

  const commentMutation = async (
    input: { linearOrganizationId: string; body: string },
    payload: GraphqlPayload,
    write?: LinearCommentWriteOptions,
  ): Promise<unknown> => {
    const connection = await connectionForToken(input.linearOrganizationId, write);
    if (write !== undefined) {
      write.signal.throwIfAborted();
      const current = await options.connectionForLinearOrganization(input.linearOrganizationId);
      write.signal.throwIfAborted();
      if (
        current === undefined ||
        current.accessToken !== connection.accessToken ||
        current.refreshToken !== connection.refreshToken
      )
        throw new LinearCredentialError("connection_not_owned");
      checkWriteConnection(current, write);
      if (
        input.body.includes(current.accessToken) ||
        (current.refreshToken && input.body.includes(current.refreshToken))
      )
        throw new LinearCredentialError("body_contains_secret");
    }
    return graphql(request, connection.accessToken, payload, {
      mutation: true,
      signal: write?.signal,
      now,
    });
  };

  return {
    async readIssue(input) {
      const result = IssueResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoIssue($id: String!) {
            issue(id: $id) {
              id identifier title description url
              project { id }
              state { id }
              assignee { id }
              labels { nodes { id } }
            }
          }`,
          variables: { id: input.issueId },
        }),
      );
      const issue = result.data.issue;
      return issue === null
        ? undefined
        : {
            id: issue.id,
            ...(issue.identifier === undefined ? {} : { identifier: issue.identifier }),
            title: issue.title,
            description: issue.description ?? null,
            ...(issue.url === undefined ? {} : { url: issue.url }),
            projectId: issue.project?.id ?? null,
            stateId: issue.state?.id ?? null,
            assigneeId: issue.assignee?.id ?? null,
            labelIds: issue.labels.nodes.map(({ id }) => id),
          };
    },
    async readIssueComments(input) {
      const result = IssueCommentHistoryResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoIssueCommentHistory($issueId: String!, $before: DateTime!) {
            comments(
              last: ${LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT}
              orderBy: createdAt
              filter: {
                issue: { id: { eq: $issueId } }
                createdAt: { lt: $before }
              }
            ) {
              nodes { id body createdAt user { id name } }
              pageInfo { hasPreviousPage }
            }
          }`,
          variables: { issueId: input.issueId, before: input.beforeCreatedAt },
        }),
      );
      const comments = result.data.comments.nodes
        .map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          author:
            comment.user === undefined || comment.user === null
              ? null
              : {
                  id: comment.user.id,
                  ...(comment.user.name === undefined || comment.user.name === null
                    ? {}
                    : { name: comment.user.name }),
                },
        }))
        .sort(compareLinearCommentOrder);
      return {
        comments,
        complete: !result.data.comments.pageInfo.hasPreviousPage,
      };
    },
    async createComment(input, write) {
      const result = CommentCreateResponseSchema.parse(
        await commentMutation(
          input,
          {
            query: `mutation PaseoComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
          }`,
            variables: { issueId: input.issueId, body: input.body },
          },
          write,
        ),
      );
      return result.data.commentCreate.comment.id;
    },
    async updateComment(input, write) {
      CommentUpdateResponseSchema.parse(
        await commentMutation(
          input,
          {
            query: `mutation PaseoUpdateComment($id: String!, $body: String!) {
            commentUpdate(id: $id, input: { body: $body }) { success }
          }`,
            variables: { id: input.commentId, body: input.body },
          },
          write,
        ),
      );
    },
  };
}

function compareLinearCommentOrder(
  left: Pick<LinearIssueComment, "createdAt" | "id">,
  right: Pick<LinearIssueComment, "createdAt" | "id">,
): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

async function exchangeToken(
  request: typeof fetch,
  options: Pick<Parameters<typeof createLinearConnectionClient>[0], "clientId" | "clientSecret">,
  values: Record<string, string>,
  now: () => Date,
  signal?: AbortSignal,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  scopes?: string[];
}> {
  const response = await linearRequest(request, "https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      ...values,
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    if (signal !== undefined && response.status === 400) {
      const error = OAuthErrorSchema.safeParse(await readApiResponseJson(response, signal));
      if (error.success && error.data.error === "invalid_grant")
        throw new LinearCredentialError("reauthorize");
    } else {
      discardResponseBody(response);
    }
    throw new LinearApiError(`Linear OAuth HTTP ${response.status}`, response.status);
  }
  const token = LinearTokenResponseSchema.parse(await readResponseJson(response, signal));
  return {
    accessToken: token.access_token,
    ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
    ...(token.expires_in === undefined
      ? {}
      : { accessTokenExpiresAt: new Date(now().getTime() + token.expires_in * 1_000) }),
    ...(token.scope === undefined ? {} : { scopes: parseLinearScopes(token.scope) }),
  };
}

async function readViewer(request: typeof fetch, accessToken: string) {
  const result = ViewerResponseSchema.parse(
    await graphql(request, accessToken, {
      query: `query PaseoViewer { viewer { id organization { id name } } }`,
      variables: {},
    }),
  );
  return result.data.viewer;
}

async function graphql(
  request: typeof fetch,
  accessToken: string,
  payload: GraphqlPayload,
  options: { mutation?: true; signal?: AbortSignal | undefined; now?: () => Date } = {},
): Promise<unknown> {
  const { signal, mutation, now = () => new Date() } = options;
  const response = await linearRequest(request, "https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    ...(mutation ? { redirect: "error" } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok && (signal === undefined || response.status >= 500)) {
    discardResponseBody(response);
    throw new LinearApiError(`Linear GraphQL HTTP ${response.status}`, response.status);
  }
  const result = await readApiResponseJson(response, signal);
  checkGraphqlResponse(response, result, now);
  return result;
}

function linearRequest(request: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted();
  return request(url, init).catch((error: unknown) => {
    if (init.signal?.aborted) throw error;
    throw new LinearTransportError(error);
  });
}

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readApiResponseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await readResponseJson(response, signal);
  } catch (error) {
    if (response.ok || signal?.aborted || !(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

async function readResponseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) {
    discardResponseBody(response);
    signal.throwIfAborted();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const { promise, reject } = Promise.withResolvers<never>();
  const deadline = performance.now() + LINEAR_RESPONSE_BODY_TIMEOUT_MS;
  const timeout = () => new Error("Linear response body read timed out");
  const timer = setTimeout(() => reject(timeout()), LINEAR_RESPONSE_BODY_TIMEOUT_MS);
  const abort = () => reject(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let body: string;
  try {
    body = await Promise.race([readResponseBody(reader, deadline, timeout), promise]);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new LinearTransportError(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(body);
  return value;
}

async function readResponseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
  timeout: () => Error,
): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (performance.now() >= deadline) throw timeout();
    if (done) return body + decoder.decode();
    bytes += value.byteLength;
    if (bytes > LINEAR_RESPONSE_BODY_LIMIT_BYTES)
      throw new Error("Linear response body exceeds 1 MiB");
    body += decoder.decode(value, { stream: true });
  }
}

function checkGraphqlResponse(response: Response, result: unknown, now: () => Date): void {
  const envelope = GraphqlErrorsSchema.safeParse(result);
  if (response.ok && !envelope.success) return;
  const rawErrors = envelope.success ? envelope.data.errors : [];
  const errors = rawErrors.flatMap((value) => {
    const parsed = GraphqlErrorSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const rateLimited = errors.find(
    ({ extensions }) => extensions?.code?.toUpperCase() === "RATELIMITED",
  );
  const error = rateLimited ?? errors[0];
  const delay =
    rateLimited !== undefined || response.status === 429
      ? linearRetryAfterMs(response.headers, now().getTime())
      : undefined;
  const rateLimitBeforeExecution =
    rateLimited !== undefined &&
    (response.status === 400 || response.status === 429) &&
    !hasResponseField(result, "data") &&
    !rawErrors.some((entry) => hasResponseField(entry, "path"));
  throw new LinearApiError(
    response.ok
      ? `Linear GraphQL ${error?.message ?? "response contained errors"}`
      : `Linear GraphQL HTTP ${response.status}`,
    response.status,
    error?.extensions?.code,
    delay,
    rateLimitBeforeExecution,
  );
}

function hasResponseField(value: unknown, field: string): boolean {
  return value !== null && typeof value === "object" && Object.hasOwn(value, field);
}

function linearRetryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const delay = /^\d+$/u.test(retryAfter)
      ? Number(retryAfter) * 1_000
      : Date.parse(retryAfter) - now;
    if (Number.isFinite(delay)) return Math.max(0, delay);
  }

  const resets = ["requests", "endpoint-requests", "complexity"]
    .flatMap((limit) => {
      const remaining = headers.get(`x-ratelimit-${limit}-remaining`);
      const reset = headers.get(`x-ratelimit-${limit}-reset`);
      return (remaining === null || remaining === "0") && reset !== null && /^\d+$/u.test(reset)
        ? [Number(reset) - now]
        : [];
    })
    .filter(Number.isFinite);
  return resets.length === 0 ? undefined : Math.max(0, ...resets);
}

function parseLinearScopes(scope: string | undefined): string[] {
  return [
    ...new Set(
      (scope ?? "")
        .split(/[\s,]+/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}
