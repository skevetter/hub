import { z } from "zod";
import { ProviderVerificationError } from "../../provider-applications/index.js";
import {
  openSlackSocket,
  SlackSocketConnectionError,
} from "../../triggers/slack/source/internal/connection.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "./client.js";

const AuthTestSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  team_id: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  bot_id: z.string().min(1).optional(),
});
const BotInfoSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  bot: z
    .object({ id: z.string().min(1), app_id: z.string().min(1), user_id: z.string().min(1) })
    .optional(),
});

export interface VerifiedSlackSocketInstallation {
  appId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
}

export interface SlackSocketInstallationVerifier {
  verify(appToken: string, botToken: string): Promise<VerifiedSlackSocketInstallation>;
}

export function createSlackSocketInstallationVerifier(
  options: { apiBaseUrl?: string; timeoutMs?: number } = {},
): SlackSocketInstallationVerifier {
  const api = options.apiBaseUrl ?? "https://slack.com/api";
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async verify(appToken, botToken) {
      const transaction = new AbortController();
      const timeout = setTimeout(
        () => transaction.abort(new Error("Slack verification timed out")),
        timeoutMs,
      );
      try {
        const connection = await openSlackSocket({
          appToken,
          apiUrl: `${api}/apps.connections.open`,
          signal: transaction.signal,
          timeoutMs,
        }).catch((error: unknown) => {
          if (transaction.signal.aborted) throw new ProviderVerificationError("timeout");
          return mapConnectionError(error);
        });
        await connection.close(Math.max(10, Math.min(500, timeoutMs / 4)), "verified");

        const auth = await slackJson({
          request: fetch,
          url: `${api}/auth.test`,
          token: botToken,
          schema: AuthTestSchema,
          transaction,
        });
        const scopes = parseScopes(auth.response.headers.get("x-oauth-scopes"));
        assertSlackAuth(auth.value, auth.response, scopes);

        const info = await slackJson({
          request: fetch,
          url: `${api}/bots.info?${new URLSearchParams({ bot: auth.value.bot_id })}`,
          token: botToken,
          schema: BotInfoSchema,
          transaction,
        });
        verifySlackBotIdentity(info.value, info.response, auth.value, connection);
        return verifiedSlackInstallation(connection.appId, auth.value, botToken, scopes);
      } catch (error) {
        if (error instanceof ProviderVerificationError) throw error;
        if (transaction.signal.aborted) throw new ProviderVerificationError("timeout");
        throw new ProviderVerificationError("network", undefined, { cause: error });
      } finally {
        clearTimeout(timeout);
        transaction.abort();
      }
    },
  };
}

function verifiedSlackInstallation(
  appId: string,
  auth: SlackAuthIdentity,
  botToken: string,
  scopes: string[],
): VerifiedSlackSocketInstallation {
  return {
    appId,
    teamId: auth.team_id,
    teamName: auth.team,
    botUserId: auth.user_id,
    botAccessToken: botToken,
    scopes,
  };
}

type SlackAuth = z.infer<typeof AuthTestSchema>;
type SlackAuthIdentity = {
  [Key in "team_id" | "team" | "user_id" | "bot_id"]: NonNullable<SlackAuth[Key]>;
};

function assertSlackAuth(
  value: SlackAuth,
  response: Response,
  scopes: string[],
): asserts value is SlackAuth & SlackAuthIdentity {
  if (!value.ok) throw verificationError(value.error, response.status);
  if (
    value.team_id === undefined ||
    value.team === undefined ||
    value.user_id === undefined ||
    value.bot_id === undefined
  ) {
    throw new ProviderVerificationError("invalidResponse", response.status);
  }
  if (SLACK_REQUIRED_BOT_SCOPES.some((scope) => !scopes.includes(scope))) {
    throw new ProviderVerificationError("permissionMissing", response.status, {
      subject: "botToken",
    });
  }
}

function verifySlackBotIdentity(
  value: z.infer<typeof BotInfoSchema>,
  response: Response,
  auth: SlackAuthIdentity,
  connection: { appId: string },
): void {
  if (!value.ok || value.bot === undefined) throw verificationError(value.error, response.status);
  if (
    value.bot.app_id !== connection.appId ||
    value.bot.user_id !== auth.user_id ||
    value.bot.id !== auth.bot_id
  ) {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "identityMismatch",
    });
  }
}

interface SlackJsonOptions<T> {
  request: typeof fetch;
  url: string;
  token: string;
  schema: z.ZodType<T>;
  transaction: AbortController;
}

async function slackJson<T>(
  options: SlackJsonOptions<T>,
): Promise<{ value: T; response: Response }> {
  const { request, url, token, schema, transaction } = options;
  let response: Response;
  try {
    response = await request(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: transaction.signal,
    });
  } catch (error) {
    if (transaction.signal.aborted) throw new ProviderVerificationError("timeout");
    throw new ProviderVerificationError("network", undefined, { cause: error });
  }
  if (!response.ok) {
    transaction.abort(new Error("Slack verification response discarded"));
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 429) throw new ProviderVerificationError("rateLimited", 429);
    if (response.status >= 500)
      throw new ProviderVerificationError("upstreamUnavailable", response.status);
    throw new ProviderVerificationError("credentialsRejected", response.status);
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
  return { value: parsed.data, response };
}

function mapConnectionError(error: unknown): never {
  if (!(error instanceof SlackSocketConnectionError)) throw error;
  if (error.code === "rate_limited") throw new ProviderVerificationError("rateLimited", 429);
  if (error.code.startsWith("http_5")) {
    throw new ProviderVerificationError("upstreamUnavailable", Number(error.code.slice(5)));
  }
  if (error.reason === "transient") throw new ProviderVerificationError("network");
  throw new ProviderVerificationError("credentialsRejected", undefined, { subject: "appToken" });
}

function verificationError(error: string | undefined, status?: number): ProviderVerificationError {
  return new ProviderVerificationError(
    error === "missing_scope" ? "permissionMissing" : "credentialsRejected",
    status,
    { subject: "botToken" },
  );
}

function parseScopes(value: string | null): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}
