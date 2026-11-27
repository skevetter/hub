import type {
  ProjectConfigurationStore,
  StoredProjectConfiguration,
} from "../../configuration/store.js";
import type { CompiledTriggerConfig } from "../../config/index.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
} from "../../attachments/capabilities.js";
import { reportFailure } from "../../failures/index.js";
import { agentFailureNotice, missingBillingUrl } from "../failure-notice.js";
import {
  type ExternalTrigger,
  type TriggerContextMaterialization,
  type TriggerProvider,
  type TriggerProviderMatch,
  type TriggerProviderReactionState,
} from "../index.js";
import type { SlackBotClient, SlackThreadMessage } from "./client.js";
import { NormalizedSlackMentionEventSchema, type NormalizedSlackMentionEvent } from "./events.js";
import {
  matchSlackTriggers,
  readSlackInvocationParserMessage,
  readSlackPromptBody,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";

export interface SlackAttachmentLocator {
  id: string;
  filename: string;
  content_type: string | null;
  size: number | null;
}

interface SlackThreadContextLocator {
  status: "deferred";
  channel: { id: string };
  thread: { ts: string };
  before: { ts: string };
}

export interface SlackMergeData {
  slack: {
    event_type: "app_mention";
    event_id: string;
    event_ts: string;
    event_time: number;
    connection_id: string | null;
    team: { id: string };
    app: { id: string };
    trigger_message: {
      ts: string;
      content: string;
      body: string;
      author: { id: string };
      channel: { id: string };
      thread: { ts: string } | null;
      created_at: string;
      attachments: SlackAttachmentLocator[];
    };
    trigger_thread_context:
      | SlackThreadContextLocator
      | {
          status: "not_applicable";
        };
  };
}

interface SlackMergeMessage {
  ts: string;
  content: string;
  author: { id: string };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentDescriptor[];
}

interface SlackContextPayload {
  status: "available" | "incomplete" | "unavailable" | "not_applicable";
  messages: SlackMergeMessage[];
}

export interface SlackMaterializedContext {
  slack: {
    thread: SlackContextPayload;
  };
}

export interface SlackTriggerContext {
  provider: "slack";
  target: SlackOutputContext;
  event: SlackMergeData;
}

export interface SlackOutputContext {
  provider: "slack";
  organizationId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
}

type SlackReactionPhase = "accepted" | "started";

type SlackProvider = TriggerProvider<
  "slack",
  SlackTriggerContext,
  SlackOutputContext,
  SlackMaterializedContext
>;

interface SlackProviderOptions {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  botUserIdForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
  client: SlackBotClient;
  attachments?: AttachmentCapabilityRegistry;
  billingUrlForOrganization?: (organizationId: string) => Promise<string>;
}

export function createSlackTriggerProvider(options: SlackProviderOptions): SlackProvider {
  return {
    name: "slack",
    eventNames: ["slack.mention"],
    match(trigger) {
      return matchSlackTrigger(options, trigger);
    },
    materializeContext(launch) {
      return materializeSlackContext(options, launch);
    },
    ...slackReactionHooks(options),
  };
}

async function matchSlackTrigger(
  options: SlackProviderOptions,
  trigger: ExternalTrigger,
): ReturnType<SlackProvider["match"]> {
  const rawEvent = NormalizedSlackMentionEventSchema.parse(trigger.payload);
  const botUserId = await options.botUserIdForWorkspace(trigger.organizationId, rawEvent.teamId);
  if (botUserId === undefined) return "configuration_unavailable";
  const stored = await options
    .configurationStoreForProject(trigger.projectId)
    .getRevision(trigger.configurationRevisionId);
  if (stored === undefined) return "configuration_unavailable";
  if (!stored.configuration.triggers.some((candidate) => candidate.on === trigger.source))
    return "no_trigger_for_source";
  const event = needsSlackUsername(stored.configuration.triggers, rawEvent.author.id)
    ? await enrichSlackAuthor(rawEvent, trigger.organizationId, options.client)
    : rawEvent;
  const matchedTriggers = matchSlackTriggers(
    stored.configuration,
    event,
    botUserId,
    trigger.connectionId,
  );
  const matches: TriggerProviderMatch<SlackTriggerContext, SlackOutputContext>[] = [];
  for (const { trigger: matchedTrigger } of matchedTriggers) {
    const match = buildSlackMatch({
      triggerName: matchedTrigger.name,
      stored,
      rawEvent,
      botUserId,
      trigger,
    });
    if (match !== undefined) matches.push(match);
  }
  return matches.length === 0 ? "trigger_filters_rejected" : matches;
}

interface SlackMatchOptions {
  triggerName: string;
  stored: StoredProjectConfiguration;
  rawEvent: NormalizedSlackMentionEvent;
  botUserId: string;
  trigger: ExternalTrigger;
}

function buildSlackMatch({
  triggerName,
  stored,
  rawEvent,
  botUserId,
  trigger,
}: SlackMatchOptions): TriggerProviderMatch<SlackTriggerContext, SlackOutputContext> | undefined {
  const compiledTrigger = stored.configuration.triggers.find(
    (candidate) => candidate.name === triggerName,
  );
  if (compiledTrigger === undefined) throw new Error(`compiled trigger not found: ${triggerName}`);
  const outputContext: SlackOutputContext = {
    provider: "slack",
    organizationId: trigger.organizationId,
    teamId: rawEvent.teamId,
    channelId: rawEvent.channelId,
    threadTs: rawEvent.threadTs ?? rawEvent.messageTs,
    messageTs: rawEvent.messageTs,
  };
  const triggerContext: SlackTriggerContext = {
    provider: "slack",
    target: outputContext,
    event: buildSlackMergeData(rawEvent, botUserId, trigger.connectionId),
  };
  const invocation = parseInvocation(
    rawEvent.content,
    compiledTrigger.inputs,
    undefined,
    readSlackInvocationParserMessage(rawEvent, botUserId, compiledTrigger.filters),
  );
  if (
    invocation.status === "accepted" &&
    !matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)
  ) {
    return undefined;
  }
  const base = {
    conversation: {
      key: JSON.stringify([
        "slack",
        rawEvent.teamId,
        rawEvent.channelId,
        rawEvent.threadTs ?? rawEvent.messageTs,
      ]),
      label: "Slack thread",
    },
    triggerName,
    triggerContext,
    outputContext,
    configurationRevisionId: stored.revision.id,
    hubConfig: stored.configuration,
  };
  if (invocation.status === "rejected") return { ...base, invocation };
  return { ...base, invocation };
}

async function materializeSlackContext(
  options: SlackProviderOptions,
  launch: TriggerContextMaterialization<SlackTriggerContext>,
): Promise<SlackMaterializedContext> {
  const locator = launch.triggerContext.event.slack.trigger_thread_context;
  if (locator.status === "not_applicable") {
    return { slack: { thread: { status: "not_applicable", messages: [] } } };
  }
  if (options.client.readThreadMessages === undefined) {
    return { slack: { thread: { status: "unavailable", messages: [] } } };
  }
  let history;
  try {
    history = await options.client.readThreadMessages({
      organizationId: launch.organizationId,
      teamId: launch.triggerContext.event.slack.team.id,
      channelId: locator.channel.id,
      threadTs: locator.thread.ts,
      beforeTs: locator.before.ts,
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.thread.hydrate", component: "triggers", provider: "slack" },
      {
        diagnostic: {
          teamId: launch.triggerContext.event.slack.team.id,
          channelId: locator.channel.id,
        },
      },
    );
    return { slack: { thread: { status: "unavailable", messages: [] } } };
  }
  const messages = await Promise.all(
    history.messages.map(async (message) => ({
      ts: message.ts,
      content: message.content,
      author: message.author,
      channel: { id: locator.channel.id },
      created_at: message.createdAt,
      attachments: await registerAttachments(message.attachments, {
        providerEventReceiptId: launch.providerEventReceiptId,
        organizationId: launch.organizationId,
        teamId: launch.triggerContext.event.slack.team.id,
        connectionId: launch.triggerContext.event.slack.connection_id,
        executionId: launch.executionId,
        attachments: options.attachments,
      }),
    })),
  );
  return {
    slack: {
      thread: {
        status: history.complete ? "available" : "incomplete",
        messages,
      },
    },
  };
}

function slackReactionHooks(
  options: SlackProviderOptions,
): Pick<
  SlackProvider,
  | "onDispatchAccepted"
  | "onAgentExecutionStarted"
  | "onAgentExecutionCompleted"
  | "onWorkflowRunCanceled"
  | "onAgentExecutionFailed"
  | "onMachineTerminated"
> {
  return {
    async onDispatchAccepted(_triggerContext, _outputContext, reactionState) {
      if (slackReactionPhase(reactionState) !== undefined) return reactionState;
      return { phase: "accepted" };
    },
    async onAgentExecutionStarted(context, _outputContext, reactionState) {
      if (slackReactionPhase(reactionState) === "started") return reactionState;
      await replaceReaction(options.client, context.target, "eyes", "hourglass_flowing_sand");
      return { phase: "started" };
    },
    async onAgentExecutionCompleted(context, _outputContext, _result, reactionState) {
      await removeReactionForPhase(options.client, context.target, reactionState, "started");
      await addReaction(options.client, context.target, "white_check_mark");
      return null;
    },
    async onWorkflowRunCanceled(context, reactionState) {
      await removeReactionForPhase(options.client, context.target, reactionState);
      return null;
    },
    async onAgentExecutionFailed(context, _output, reason, reactionState) {
      await failWithNotice(
        options.client,
        context.target,
        await agentFailureNotice(
          reason,
          context.target.organizationId,
          options.billingUrlForOrganization ?? missingBillingUrl,
        ),
        reactionState,
      );
      return null;
    },
    async onMachineTerminated(context, reason, reactionState) {
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await failWithNotice(
          options.client,
          context.target,
          `Paseo agent failed: ${reason}`,
          reactionState,
        );
        return null;
      }
      return reactionState;
    },
  };
}

async function enrichSlackAuthor(
  event: NormalizedSlackMentionEvent,
  organizationId: string,
  client: SlackBotClient,
): Promise<NormalizedSlackMentionEvent> {
  if (client.lookupUserName === undefined) return event;
  try {
    const username = await client.lookupUserName({
      organizationId,
      teamId: event.teamId,
      userId: event.author.id,
    });
    return username === undefined ? event : { ...event, author: { ...event.author, username } };
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.user.lookup", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, userId: event.author.id } },
    );
    return event;
  }
}

function needsSlackUsername(
  triggers: readonly Pick<CompiledTriggerConfig, "on" | "filters">[],
  authorId: string,
): boolean {
  return triggers.some(
    (candidate) =>
      candidate.on === "slack.mention" &&
      candidate.filters?.from_users !== undefined &&
      !candidate.filters.from_users.includes("*") &&
      !candidate.filters.from_users.includes(authorId),
  );
}

async function removeReactionForPhase(
  client: SlackBotClient,
  target: SlackOutputContext,
  reactionState: TriggerProviderReactionState | undefined,
  fallbackPhase?: SlackReactionPhase,
): Promise<void> {
  const phase = slackReactionPhase(reactionState) ?? fallbackPhase;
  if (phase === "accepted") {
    await removeReactionSafely(client, target, "eyes");
    return;
  }
  if (phase === "started") {
    await removeReactionSafely(client, target, "hourglass_flowing_sand");
    return;
  }
  await removeReactionSafely(client, target, "eyes");
  await removeReactionSafely(client, target, "hourglass_flowing_sand");
}

function slackReactionPhase(
  reactionState: TriggerProviderReactionState | undefined,
): SlackReactionPhase | undefined {
  if (typeof reactionState !== "object" || reactionState === null || Array.isArray(reactionState)) {
    return undefined;
  }
  const phase = reactionState["phase"];
  return phase === "accepted" || phase === "started" ? phase : undefined;
}

function buildSlackMergeData(
  event: NormalizedSlackMentionEvent,
  botUserId: string,
  connectionId: string | null | undefined,
): SlackMergeData {
  return {
    slack: {
      event_type: "app_mention",
      event_id: event.id,
      event_ts: event.eventTs,
      event_time: event.eventTime,
      connection_id: connectionId ?? null,
      team: { id: event.teamId },
      app: { id: event.appId },
      trigger_message: {
        ts: event.messageTs,
        content: event.content,
        body: readSlackPromptBody(event, botUserId),
        author: event.author,
        channel: { id: event.channelId },
        thread: event.threadTs === null ? null : { ts: event.threadTs },
        created_at: event.createdAt,
        attachments: event.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          content_type: attachment.contentType,
          size: attachment.size,
        })),
      },
      trigger_thread_context:
        event.threadTs === null
          ? { status: "not_applicable" }
          : {
              status: "deferred",
              channel: { id: event.channelId },
              thread: { ts: event.threadTs },
              before: { ts: event.messageTs },
            },
    },
  };
}

async function registerAttachments(
  source: SlackThreadMessage["attachments"],
  {
    providerEventReceiptId,
    organizationId,
    teamId,
    connectionId,
    executionId,
    attachments,
  }: {
    providerEventReceiptId: string;
    organizationId: string;
    teamId: string;
    connectionId: string | null;
    executionId: string;
    attachments: AttachmentCapabilityRegistry | undefined;
  },
): Promise<AttachmentDescriptor[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null) {
    throw new Error("attachment ownership unavailable");
  }
  const references = await Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId,
        organizationId,
        connectionId,
        provider: "slack",
        sourceId: file.id,
        locator: { teamId, fileId: file.id },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
  return references.map((reference) => attachments.materialize(reference, executionId));
}

async function replaceReaction(
  client: SlackBotClient,
  event: SlackOutputContext,
  from: string,
  to: string,
): Promise<void> {
  await removeReactionSafely(client, event, from);
  await addReactionSafely(client, event, to);
}

async function failWithNotice(
  client: SlackBotClient,
  event: SlackOutputContext,
  reason: string,
  reactionState?: TriggerProviderReactionState,
): Promise<void> {
  await removeReactionForPhase(client, event, reactionState);
  await addReaction(client, event, "x");
  await client.sendMessage({
    organizationId: event.organizationId,
    teamId: event.teamId,
    channelId: event.channelId,
    threadTs: event.threadTs,
    content: reason,
  });
}

async function addReaction(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  await client.addReaction({
    organizationId: event.organizationId,
    teamId: event.teamId,
    channelId: event.channelId,
    messageTs: event.messageTs,
    name,
  });
}

async function addReactionSafely(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  try {
    await client.addReaction({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      name,
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.reaction.add", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, reaction: name } },
    );
  }
}

async function removeReactionSafely(
  client: SlackBotClient,
  event: SlackOutputContext,
  name: string,
): Promise<void> {
  try {
    await client.removeReaction({
      organizationId: event.organizationId,
      teamId: event.teamId,
      channelId: event.channelId,
      messageTs: event.messageTs,
      name,
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.reaction.cleanup", component: "triggers", provider: "slack" },
      { diagnostic: { teamId: event.teamId, reaction: name } },
    );
  }
}
