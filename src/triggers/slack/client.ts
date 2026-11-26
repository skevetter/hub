import { z } from "zod";
import { reportFailure } from "../../failures/index.js";

const SlackApiResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional() }).loose();
const SlackFileSchema = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(255).optional(),
    mimetype: z.string().min(1).max(255).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .loose();
const SlackThreadMessageSchema = z
  .object({
    ts: z.string().regex(/^\d+\.\d+$/u),
    text: z.string().default(""),
    user: z.string().min(1).max(255).optional(),
    bot_id: z.string().min(1).max(255).optional(),
    files: z.array(SlackFileSchema).optional(),
  })
  .loose();
const SlackThreadRepliesSchema = SlackApiResponseSchema.extend({
  messages: z.array(SlackThreadMessageSchema).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const SlackFileInfoSchema = SlackApiResponseSchema.extend({
  file: z
    .object({
      id: z.string().min(1).max(255),
      url_private_download: z.url(),
    })
    .optional(),
});
const SlackUserInfoSchema = SlackApiResponseSchema.extend({
  user: z.object({ name: z.string().min(1).max(255) }).optional(),
});
const SLACK_API_TIMEOUT_MS = 10_000;
const SLACK_THREAD_REPLIES_MAX_PAGES = 10;
const SLACK_THREAD_CONTEXT_LIMIT = 50;

export interface SlackAttachmentMetadata {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
}

export interface SlackThreadMessage {
  ts: string;
  createdAt: string;
  content: string;
  author: { id: string };
  attachments: SlackAttachmentMetadata[];
}

export interface SlackThreadReadResult {
  messages: SlackThreadMessage[];
  complete: boolean;
}

export interface SlackBotClient {
  sendMessage(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }): Promise<void>;
  addReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  removeReaction(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  readThreadMessages?(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
  }): Promise<SlackThreadReadResult>;
  lookupUserName?(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined>;
  downloadAttachment?(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response>;
}

interface SlackBotClientOptions {
  tokenForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export function createSlackBotClient(options: SlackBotClientOptions): SlackBotClient {
  const request = options.fetch ?? fetch;
  const { call, callJson } = createPostCalls(options, request);
  const queryJson = createQueryCall(options, request);
  const { lookupUserName, downloadAttachment } = createResourceReaders(options, request, callJson);

  return {
    sendMessage: (input) =>
      call(input.organizationId, input.teamId, "chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.content,
      }),
    addReaction: (input) =>
      call(input.organizationId, input.teamId, "reactions.add", {
        channel: input.channelId,
        timestamp: input.messageTs,
        name: input.name,
      }),
    removeReaction: (input) =>
      call(input.organizationId, input.teamId, "reactions.remove", {
        channel: input.channelId,
        timestamp: input.messageTs,
        name: input.name,
      }),
    readThreadMessages: createThreadReader(queryJson),
    lookupUserName,
    downloadAttachment,
  };
}
function createPostCalls(options: SlackBotClientOptions, request: typeof fetch) {
  async function call(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, string>,
  ): Promise<void> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    const result = SlackApiResponseSchema.parse(await response.json());
    assertSlackApiSuccess(result);
  }

  async function callJson(
    organizationId: string,
    teamId: string,
    method: string,
    body: Record<string, string>,
  ): Promise<unknown> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    return response.json();
  }

  return { call, callJson };
}

function createQueryCall(options: SlackBotClientOptions, request: typeof fetch) {
  async function queryJson(
    organizationId: string,
    teamId: string,
    method: string,
    query: Record<string, string>,
  ): Promise<unknown> {
    const token = await options.tokenForWorkspace(organizationId, teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    return response.json();
  }

  return queryJson;
}

type ThreadInput = Parameters<NonNullable<SlackBotClient["readThreadMessages"]>>[0];
type ThreadPage = z.infer<typeof SlackThreadRepliesSchema>;

interface ThreadHistory {
  root: SlackThreadMessage | undefined;
  selectedReplies: SlackThreadMessage[];
}

function createThreadReader(queryJson: ReturnType<typeof createQueryCall>) {
  return async function readThreadMessages(input: ThreadInput): Promise<SlackThreadReadResult> {
    let cursor: string | undefined;
    const history: ThreadHistory = { root: undefined, selectedReplies: [] };
    const seenCursors = new Set<string>();
    let complete = true;
    let pagesRead = 0;
    while (true) {
      let result: z.infer<typeof SlackThreadRepliesSchema>;
      try {
        result = SlackThreadRepliesSchema.parse(
          await queryJson(
            input.organizationId,
            input.teamId,
            "conversations.replies",
            threadQuery(input, cursor),
          ),
        );
        assertSlackApiSuccess(result);
      } catch (error) {
        reportThreadPageError(error, history, input, pagesRead);
        complete = false;
        break;
      }
      selectThreadPage(history, result, input);
      pagesRead += 1;
      cursor = threadPageCursor(result);
      if (cursor === undefined) break;
      if (seenCursors.has(cursor)) {
        complete = false;
        break;
      }
      seenCursors.add(cursor);
      if (pagesRead === SLACK_THREAD_REPLIES_MAX_PAGES) {
        complete = false;
        break;
      }
    }

    if (history.root === undefined) throw new Error("Slack thread root unavailable");
    return {
      messages: [
        history.root,
        ...history.selectedReplies.sort((left, right) => compareSlackTs(left.ts, right.ts)),
      ],
      complete,
    };
  };
}

function threadQuery(input: ThreadInput, cursor: string | undefined): Record<string, string> {
  return {
    channel: input.channelId,
    ts: input.threadTs,
    latest: input.beforeTs,
    inclusive: "false",
    limit: "100",
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function assertSlackApiSuccess(result: z.infer<typeof SlackApiResponseSchema>): void {
  if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
}

function reportThreadPageError(
  error: unknown,
  history: ThreadHistory,
  input: ThreadInput,
  pagesRead: number,
): void {
  if (history.root === undefined && history.selectedReplies.length === 0) throw error;
  reportFailure(
    error,
    { operation: "slack.thread.history.page", component: "providers", provider: "slack" },
    { diagnostic: { teamId: input.teamId, channelId: input.channelId, pagesRead } },
  );
}

function selectThreadPage(history: ThreadHistory, result: ThreadPage, input: ThreadInput): void {
  const page = (result.messages ?? [])
    .map(normalizeThreadMessage)
    .filter((message) => compareSlackTs(message.ts, input.beforeTs) < 0);
  history.root ??= page.find((message) => message.ts === input.threadTs);
  history.selectedReplies = [
    ...history.selectedReplies,
    ...page.filter((message) => message.ts !== input.threadTs),
  ]
    .sort((left, right) => compareSlackTs(right.ts, left.ts))
    .slice(0, SLACK_THREAD_CONTEXT_LIMIT - 1);
}

function threadPageCursor(result: ThreadPage): string | undefined {
  const next = result.response_metadata?.next_cursor;
  return next === undefined || next.length === 0 ? undefined : next;
}

function createResourceReaders(
  options: SlackBotClientOptions,
  request: typeof fetch,
  callJson: ReturnType<typeof createPostCalls>["callJson"],
) {
  async function downloadAttachment(input: {
    organizationId: string;
    teamId: string;
    fileId: string;
  }): Promise<Response> {
    const token = await options.tokenForWorkspace(input.organizationId, input.teamId);
    if (token === undefined) throw new Error("Slack workspace is not connected");
    const result = SlackFileInfoSchema.parse(
      await callJson(input.organizationId, input.teamId, "files.info", { file: input.fileId }),
    );
    if (!result.ok || result.file?.id !== input.fileId) {
      throw new Error(`Slack file ${input.fileId} is unavailable`);
    }
    const downloadUrl = new URL(result.file.url_private_download);
    if (
      downloadUrl.protocol !== "https:" ||
      !["files.slack.com", "slack.com"].includes(downloadUrl.hostname)
    ) {
      throw new Error("Slack returned an invalid attachment URL");
    }
    return request(downloadUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
  }

  async function lookupUserName(input: {
    organizationId: string;
    teamId: string;
    userId: string;
  }): Promise<string | undefined> {
    const result = SlackUserInfoSchema.parse(
      await callJson(input.organizationId, input.teamId, "users.info", { user: input.userId }),
    );
    if (!result.ok) throw new Error(`Slack API ${result.error ?? "unknown_error"}`);
    return result.user?.name;
  }

  return { downloadAttachment, lookupUserName };
}

function normalizeThreadMessage(
  message: z.infer<typeof SlackThreadMessageSchema>,
): SlackThreadMessage {
  return {
    ts: message.ts,
    createdAt: new Date(Number(message.ts) * 1_000).toISOString(),
    content: message.text,
    author: { id: message.user ?? message.bot_id ?? "unknown" },
    attachments: (message.files ?? []).map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  };
}

function compareSlackTs(left: string, right: string): number {
  return Number(left) - Number(right);
}
