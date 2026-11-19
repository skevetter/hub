import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { ChannelType, Client, Message, TextChannel } from "discord.js";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { markTestReceipt, waitForReceiptLock } from "../db/test-utils/receipt-expiry.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as org,
  type TimelinePostgresHarness,
} from "../db/test-utils/run-timeline-postgres.js";
import type { Database, DurableProviderEvent, ProviderEventEvidence } from "../db/types.js";
import { createMemoryDatabase } from "../db/memory.js";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { startSlackSocketFixture } from "../test-utils/slack-socket-fixture.js";
import { DurableWorkflowEngine } from "../workflows/engine.js";
import { createDiscordGatewaySource } from "./discord/gateway.js";
import { MemoryDiscordBotClient } from "./discord/memory-bot.js";
import { createWebhookSource } from "./github/webhook.js";
import {
  notificationDeliveryId,
  toNotificationPayload,
} from "./github-notifications/notification.js";
import { notificationYaml, thread } from "./github-notifications/test-fixture.js";
import { createLinearWebhookSource } from "./linear/webhook.js";
import { createManualRunProvider } from "./manual/provider.js";
import { ScheduleOccurrenceConflict } from "./schedule/internal/repository.js";
import { scheduleYaml } from "./schedule/test-fixture.js";
import { createSlackEventSource } from "./slack/source/index.js";
import { createSlackWebhookSource } from "./slack/webhook.js";
import { OrganizationTriggerStore } from "./store.js";

const secret = "fixture-signing-only";
const now = new Date("2026-10-14T10:00:00Z");
const connections = {
  github: randomUUID(),
  linear: randomUUID(),
  slack: randomUUID(),
  discord: randomUUID(),
};
const providers = ["github", "linear", "slack", "discord"] as const;

function githubRequest(delivery: string, event: "issue_comment" | "push", change = "") {
  const body = JSON.stringify({
    action: "created",
    installation: { id: 42 },
    repository: { id: 9001, full_name: "acme/widgets" },
    change,
  });
  return new Request("http://hub.test/github", {
    method: "POST",
    body,
    headers: {
      "x-github-delivery": delivery,
      "x-github-event": event,
      "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    },
  });
}

function linearRequest(delivery: string, date: number) {
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: "linear-org",
    webhookTimestamp: date,
    actor: { id: "user", name: "Operator" },
    data: { id: "comment", issueId: "issue", body: "Please investigate" },
  });
  return new Request("http://hub.test/linear", {
    method: "POST",
    body,
    headers: {
      "linear-delivery": delivery,
      "linear-event": "Comment",
      "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
    },
  });
}

function slackEvent(id: string, text: string) {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A123",
    event_id: id,
    event_time: now.getTime() / 1000,
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      text,
      ts: "1700000000.001",
      event_ts: "1700000000.001",
    },
  };
}

function slackRequest(eventId: string, text: string) {
  const body = JSON.stringify(slackEvent(eventId, text));
  const timestamp = String(now.getTime() / 1000);
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return new Request("http://hub.test/slack", {
    method: "POST",
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": "v0=" + signature,
    },
  });
}

function discordMessage(client: Client, id: string) {
  const channel: unknown = Reflect.construct(TextChannel, [
    undefined,
    { id: "200", guild_id: "100", type: ChannelType.GuildText },
    client,
  ]);
  assert.ok(channel instanceof TextChannel);
  client.channels.cache.set(channel.id, channel);
  const message: unknown = Reflect.construct(Message, [
    client,
    {
      id,
      guild_id: "100",
      channel_id: channel.id,
      content: "<@900> hello",
      author: { id: "400", username: "sender", bot: false },
      mentions: [{ id: "900", username: "bot", bot: true }],
      mention_roles: [],
      attachments: [],
    },
  ]);
  assert.ok(message instanceof Message && message.inGuild());
  return message;
}

async function providerRoutes(database: Database) {
  const project = await database.createProject({
    organizationId: org,
    name: "Provider replay",
    slug: "provider-replay",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { triggers: [], environments: [] },
    contentHash: "provider-replay",
  });
  await database.activateProjectConfigurationRevision(
    project.id,
    revision.id,
    providers.map((provider) => ({
      provider,
      connectionId: connections[provider],
      resourceId: null,
      triggerName: provider,
    })),
  );
}

describe("native provider receipt replay", () => {
  let harness: TimelinePostgresHarness;
  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
    await harness.runtime.query(
      `insert into github_connections
         (id, organization_id, installation_id, slug, account_id, account_login, account_type, status,
          provider_application_id)
       values ($1, $2, 42, 'github', 'account', 'acme', 'Organization', 'active', 'fixture-app')`,
      [connections.github, org],
    );
    await harness.runtime.query(
      `insert into linear_connections
         (id, organization_id, linear_organization_id, provider_application_id, slug,
          linear_organization_name, app_user_id, access_token, refresh_token, scopes)
       values ($1, $2, 'linear-org', 'app', 'linear', 'Fixture', 'app-user', 'access', 'refresh',
               '["read","comments:create","app:assignable","app:mentionable"]')`,
      [connections.linear, org],
    );
    await harness.runtime.query(
      `insert into slack_connections
         (id, organization_id, team_id, slug, team_name, bot_user_id, bot_access_token, scopes)
       values ($1, $2, 'T123', 'slack', 'Fixture', 'UBOT', 'fixture', '[]')`,
      [connections.slack, org],
    );
    await harness.runtime.query(
      `insert into discord_connections (id, organization_id, guild_id, slug, guild_name)
       values ($1, $2, '100', 'discord', 'Fixture')`,
      [connections.discord, org],
    );
    await providerRoutes(harness.database);
    await enrollTestDaemon(harness.database, org);
  }, 120_000);
  afterAll(async () => harness?.close(), 120_000);

  it("acknowledges GitHub across delivery IDs and fences push sync on a marked row", async () => {
    const dispatched: DurableProviderEvent[] = [];
    const pushes: string[] = [];
    const source = createWebhookSource(secret, {
      accept: (input) => harness.database.acceptGitHubEvent(input),
      applyLifecycle: async () => assert.fail("unexpected lifecycle event"),
      synchronizePush: async ({ deliveryId }) => {
        pushes.push(deliveryId);
      },
    });
    await source.start(async (event) => {
      dispatched.push(event);
    });
    for (const event of ["issue_comment", "push"] as const) {
      assert.equal((await source.handle(githubRequest(event, event, event))).status, 200);
      assert.equal(
        (await source.handle(githubRequest(event + "-intact", event, event))).status,
        200,
      );
      const original = dispatched.at(-1);
      assert.equal(original?.deliveryId, event);
      await markTestReceipt(harness.runtime, original.providerEventReceiptId, "expiring");
      assert.equal(
        (await source.handle(githubRequest(event + "-changed", event, event))).status,
        200,
      );
      await markTestReceipt(harness.runtime, original.providerEventReceiptId, "expired");
      assert.equal(
        (await source.handle(githubRequest(event + "-expired", event, event))).status,
        200,
      );
      assert.equal(
        await harness.database.findProviderEventReceiptByDeliveryId(event + "-expired", org),
        undefined,
      );
    }
    assert.deepEqual(
      dispatched.map(({ deliveryId }) => deliveryId),
      ["issue_comment", "issue_comment", "push", "push"],
    );
    assert.deepEqual(pushes, ["push", "push-intact"]);
    await source.stop();
  });

  it("keeps the lifecycle audit copy fenced behind the original sync claim", async () => {
    let newSyncs = 0;
    const source = createWebhookSource(secret, {
      accept: async () => assert.fail("lifecycle reached workflow routing"),
      applyLifecycle: async (input) => {
        const claim = await harness.database.claimGitHubLifecycleReceipt({
          ...input,
          providerApplicationId: "fixture-app",
        });
        if (claim.status === "claimed") newSyncs++;
      },
    });
    const send = (delivery: string) => {
      const body = JSON.stringify({ action: "created", installation: { id: 42 } });
      return source.handle(
        new Request("http://hub.test/github", {
          method: "POST",
          body,
          headers: {
            "x-github-delivery": delivery,
            "x-github-event": "installation",
            "x-hub-signature-256":
              "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
          },
        }),
      );
    };
    assert.equal((await send("lifecycle")).status, 200);
    const receipt = await harness.database.findProviderEventReceiptByDeliveryId("lifecycle", org);
    assert.ok(receipt);
    await markTestReceipt(harness.runtime, receipt.id, "expired");
    assert.equal((await send("lifecycle-new-header")).status, 200);
    assert.equal(newSyncs, 1);
    assert.equal((await harness.database.findProviderEventReceiptById(receipt.id))?.payload, null);
  });

  it("acknowledges a fresh Linear retry before issue hydration and still refuses stale proof", async () => {
    const dispatched: DurableProviderEvent[] = [];
    let hydrateCount = 0;
    let clock = now.getTime();
    const source = createLinearWebhookSource({
      signingSecret: secret,
      now: () => clock,
      accept: (input) => harness.database.acceptLinearEvent(input),
      findMarkedReceipt: (...args) => harness.database.findMarkedLinearReceipt(...args),
      resolveIssue: async () => {
        hydrateCount++;
        return {
          id: "issue",
          identifier: "ENG-1",
          title: "Test title",
          description: null,
          projectId: "linear-project",
          stateId: "ready",
          assigneeId: null,
          labelIds: [],
        };
      },
    });
    await source.start(async (event) => {
      dispatched.push(event);
    });
    const delivery = "linear-hydration-retry";
    assert.equal((await source.handle(linearRequest(delivery, clock))).status, 200);
    const original = dispatched[0];
    assert.ok(original);
    assert.equal(hydrateCount, 1);
    for (const state of ["expiring", "expired"] as const) {
      await markTestReceipt(harness.runtime, original.providerEventReceiptId, state);
      clock += 120_000;
      assert.equal((await source.handle(linearRequest(delivery, now.getTime()))).status, 401);
      assert.equal((await source.handle(linearRequest(delivery, clock))).status, 200);
    }
    assert.equal(hydrateCount, 1);
    assert.equal(dispatched.length, 1);
    await source.stop();
  });

  it("acknowledges marked Slack HTTP and socket deliveries and a Discord gateway repeat", async () => {
    const dispatched: DurableProviderEvent[] = [];
    const handler = async (event: DurableProviderEvent) => {
      dispatched.push(event);
    };
    const slack = createSlackWebhookSource({
      appId: "A123",
      signingSecret: secret,
      now: () => now.getTime(),
      accept: (input) => harness.database.acceptSlackEvent(input),
    });
    await slack.start(handler);
    const eventId = "E-Replay";
    assert.equal((await slack.handle(slackRequest(eventId, "<@UBOT> original"))).status, 200);
    const original = dispatched[0];
    assert.ok(original);
    await markTestReceipt(harness.runtime, original.providerEventReceiptId, "expiring");
    assert.equal((await slack.handle(slackRequest(eventId, "<@UBOT> changed"))).status, 200);
    await markTestReceipt(harness.runtime, original.providerEventReceiptId, "expired");
    const socketFixture = await startSlackSocketFixture();
    const socket = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-fixture",
      },
      socket: { apiUrl: socketFixture.openUrl },
      accept: (input) => harness.database.acceptSlackEvent(input),
    });
    try {
      await socket.start(handler);
      await vi.waitFor(() => assert.equal(socket.status().state, "connected"));
      socketFixture.send({
        type: "events_api",
        envelope_id: "replayed-slack",
        payload: slackEvent(eventId, "<@UBOT> duplicate"),
      });
      await vi.waitFor(() => assert.equal(socketFixture.acks.length, 1));
      assert.deepEqual(socketFixture.acks, [{ envelope_id: "replayed-slack" }]);
      assert.equal(dispatched.length, 1);
    } finally {
      await socket.stop();
      await socketFixture.close();
      await slack.stop();
    }

    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const gateway = createDiscordGatewaySource({
      bot,
      accept: (input) => harness.database.acceptDiscordEvent(input),
      applyGuildDelete: async () => assert.fail("unexpected guild delete"),
    });
    await gateway.start(handler);
    const client = new Client({ intents: [] });
    try {
      const message = discordMessage(client, "300");
      await bot.emitMessage(message);
      const discord = dispatched[1];
      assert.ok(discord);
      for (const state of ["expiring", "expired"] as const) {
        await markTestReceipt(harness.runtime, discord.providerEventReceiptId, state);
        await bot.emitMessage(message);
      }
      assert.equal(dispatched.length, 2);
      assert.deepEqual(bot.threadReads, []);
      assert.deepEqual(bot.reactions, []);
    } finally {
      await gateway.stop();
      await client.destroy();
    }
  });

  it.each(["github", "linear", "slack", "discord"] as const)(
    "rechecks %s after a real insert conflict leaves a marked receipt",
    async (provider) => {
      const database = harness.database;
      const deliveryId = randomUUID();
      const source = provider + ".test";
      const id = randomUUID();
      const evidence = { deliveryId, source, payload: { changed: true }, receivedAt: now };
      const incoming = {
        github: () => database.acceptGitHubEvent({ ...evidence, installationId: 42 }),
        linear: () =>
          database.acceptLinearEvent({ ...evidence, linearOrganizationId: "linear-org" }),
        slack: () => database.acceptSlackEvent({ ...evidence, teamId: "T123" }),
        discord: () => database.acceptDiscordEvent({ ...evidence, guildId: "100" }),
      }[provider];
      const staged = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holding = harness.runtime.transaction(async (tx) => {
        await tx.query(
          `insert into provider_event_receipts
            (id, organization_id, provider, connection_id, delivery_id, source, payload)
           values ($1,$2,$3,$4,$5,$6,'{}')`,
          [id, org, provider, connections[provider], deliveryId, source],
        );
        await markTestReceipt(tx, id, "expiring");
        staged.resolve();
        await release.promise;
      });
      await Promise.race([staged.promise, holding.then(() => assert.fail("no concurrent claim"))]);
      const replay = incoming();
      try {
        await waitForReceiptLock(harness.runtime, 'insert into "provider_event_receipts"');
      } finally {
        release.resolve();
        await Promise.allSettled([holding, replay]);
      }
      assert.deepEqual(await replay, {
        status: "duplicate",
        receiptId: id,
        payloadExpiryState: "expiring",
      });
      assert.deepEqual(await database.findTriggerRunsByProviderEventReceiptId(id), []);
    },
  );

  it("projects both provider marker states in memory with the same dedupe scopes", async () => {
    const database = createMemoryDatabase({ organizationIds: [org] });
    const gitHub = await harness.database.findGitHubConnection(42);
    const linear = await harness.database.findLinearConnection("linear-org");
    const slack = await harness.database.findSlackConnection("T123");
    const discord = await harness.database.findDiscordConnection("100");
    assert.ok(gitHub && linear && slack && discord);
    vi.spyOn(database, "findGitHubConnection").mockResolvedValue(gitHub);
    vi.spyOn(database, "findLinearConnection").mockResolvedValue(linear);
    vi.spyOn(database, "findSlackConnection").mockResolvedValue(slack);
    vi.spyOn(database, "findDiscordConnection").mockResolvedValue(discord);
    await providerRoutes(database);
    for (const [provider, accept] of Object.entries({
      github: (evidence: ProviderEventEvidence) =>
        database.acceptGitHubEvent({ ...evidence, installationId: 42, repositoryId: 9001 }),
      linear: (evidence: ProviderEventEvidence) =>
        database.acceptLinearEvent({ ...evidence, linearOrganizationId: "linear-org" }),
      slack: (evidence: ProviderEventEvidence) =>
        database.acceptSlackEvent({ ...evidence, teamId: "T123" }),
      discord: (evidence: ProviderEventEvidence) =>
        database.acceptDiscordEvent({ ...evidence, guildId: "100" }),
    })) {
      const evidence = {
        source: provider + ".test",
        deliveryId: randomUUID(),
        signatureHash: randomUUID(),
        receivedAt: now,
        payload: { content: "original" },
      };
      const first = await accept(evidence);
      assert.equal(first.status, "accepted");
      const receipt = await database.findProviderEventReceiptById(first.receiptId);
      assert.ok(receipt);
      for (const state of ["expiring", "expired"] as const) {
        Object.assign(receipt, { payloadExpiryState: state, payloadExpiredAt: now });
        assert.deepEqual(
          await accept({ ...evidence, deliveryId: "changed-" + provider, payload: {} }),
          {
            status: "duplicate",
            receiptId: receipt.id,
            payloadExpiryState: state,
          },
        );
        assert.equal((await database.findProviderEventReceiptById(receipt.id))?.payload, null);
        if (provider === "linear") {
          assert.equal(
            await database.findMarkedLinearReceipt(
              "linear-org",
              evidence.deliveryId,
              evidence.signatureHash,
            ),
            true,
          );
        }
      }
    }
  });

  it("keeps a typed pre-routing drop and acknowledges it without a new route lookup", async () => {
    const database = harness.database;
    const input = {
      installationId: 42,
      deliveryId: "unsupported",
      signatureHash: randomUUID(),
      source: "github.unknown",
      payload: { private: "evidence" },
      receivedAt: now,
      dropReason: "no_trigger_for_source",
    } as const;
    const first = await database.acceptGitHubEvent(input);
    assert.equal(first.status, "dropped");
    assert.equal(
      (await database.findProviderEventReceiptById(first.receiptId))?.preRoutingDrop,
      "no_trigger_for_source",
    );
    await markTestReceipt(harness.runtime, first.receiptId, "expired");
    assert.deepEqual(
      await database.acceptGitHubEvent({ ...input, deliveryId: "unsupported-retry" }),
      {
        status: "dropped",
        receiptId: first.receiptId,
        reason: "no_trigger_for_source",
        payloadExpiryState: "expired",
      },
    );
  });

  it("does not rematch an engine event fetched before the receipt fence commits", async () => {
    const accepted = await harness.database.acceptGitHubEvent({
      installationId: 42,
      repositoryId: 9001,
      source: "github.issue_comment",
      deliveryId: "stale-engine",
      payload: { secret: "old" },
      receivedAt: now,
    });
    assert.equal(accepted.status, "accepted");
    const event = accepted.events[0];
    assert.ok(event);
    await markTestReceipt(harness.runtime, event.providerEventReceiptId, "expired");
    const workflow = new DurableWorkflowEngine({
      database: harness.database,
      entitlements: null,
      providers: [
        {
          name: "github",
          eventNames: ["github.issue_comment"],
          match: async () => assert.fail("unexpected provider matching"),
        },
      ],
    });
    assert.deepEqual(await workflow.enqueue(event), {
      providerEventReceiptId: event.providerEventReceiptId,
      replayed: true,
    });
  });

  it.each(["accepted", "rejected"] as const)(
    "does not commit an engine %s match prepared before marking",
    async (outcome) => {
      const store = new OrganizationTriggerStore(harness.database, org, acceptingAgentValidator());
      const name = "stale-" + outcome;
      const trigger = await store.save({
        yaml: `name: ${name}
on:
  manual.run:
    filters: { from_users: [sender] }
inputs:
  count: { type: number }
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Inspect the receipt
`,
        userId: null,
      });
      const writer = await harness.connect();
      const expiry = await harness.connect();
      const persisted = await writer.database.persistManualEvent({
        organizationId: org,
        projectId: trigger.runtimeProjectId,
        source: "manual.run",
        deliveryId: randomUUID(),
        receivedAt: now,
        payload: {
          trigger: name,
          actor: "sender",
          input: { message: "original", count: outcome === "accepted" ? 1 : "invalid" },
        },
      });
      assert.equal(persisted.status, "accepted");
      const provider = createManualRunProvider(
        (id) => new ProjectConfigurationStore(writer.database, id),
      );
      const prepared = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let callbacks = 0;
      const workflow = new DurableWorkflowEngine({
        database: writer.database,
        entitlements: null,
        providers: [
          {
            ...provider,
            async match(event) {
              const matches = await provider.match(event);
              assert.ok(typeof matches !== "string" && matches.length === 1);
              assert.equal(matches[0]?.invocation.status, outcome);
              prepared.resolve();
              await release.promise;
              return matches;
            },
          },
        ],
        onProgressRequested() {
          callbacks++;
        },
        async onWorkflowRunAccepted() {
          callbacks++;
        },
      });
      const processing = workflow.enqueue(persisted.event);
      try {
        await Promise.race([
          prepared.promise,
          processing.then(() => assert.fail("no engine match barrier")),
        ]);
        await markTestReceipt(expiry.runtime, persisted.event.providerEventReceiptId, "expiring");
      } finally {
        release.resolve();
        await processing;
      }
      assert.deepEqual(await processing, {
        providerEventReceiptId: persisted.event.providerEventReceiptId,
        replayed: true,
      });
      assert.deepEqual(
        await writer.database.findTriggerRunsByProviderEventReceiptId(
          persisted.event.providerEventReceiptId,
        ),
        [],
      );
      assert.equal(callbacks, 0);
    },
  );

  it("returns the original schedule occurrence and treats an orphan as a typed conflict", async () => {
    const { database, runtime } = harness;
    const store = new OrganizationTriggerStore(database, org, acceptingAgentValidator());
    const trigger = await store.save({
      yaml: scheduleYaml.replace("devbox", TEST_DAEMON_SLUG),
      userId: null,
    });
    const due = (
      await runtime.query<{ next_at: Date }>(
        "select next_at from trigger_schedules where trigger_id = $1",
        [trigger.id],
      )
    ).rows[0]?.next_at;
    assert.ok(due);
    assert.equal(await database.schedules.tick(due), 1);
    const deliveryId = `schedule:${trigger.id}:${due.toISOString()}`;
    const receipt = await database.findProviderEventReceiptByDeliveryId(deliveryId, org);
    assert.ok(receipt);
    const [original] = await database.findTriggerRunsByProviderEventReceiptId(receipt.id);
    assert.ok(original);
    await store.save({
      triggerId: trigger.id,
      yaml: scheduleYaml
        .replace("devbox", TEST_DAEMON_SLUG)
        .replace("Scan at", "Current prompt at"),
      userId: null,
    });
    const current = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(current);
    await runtime.query(
      "update project_configuration_revisions set normalized_configuration = '{}' where id = $1",
      [current.id],
    );
    for (const expiryFirst of [false, true]) {
      const state = expiryFirst ? "expired" : "expiring";
      await runtime.query(
        "update trigger_schedules set next_at = $2, active_run_id = null where trigger_id = $1",
        [trigger.id, due],
      );
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const expiry = await harness.connect();
      const replay = await harness.connect({
        async afterQuery(sql) {
          if (expiryFirst || !sql.includes("delivery_id = $2 for share")) return;
          held.resolve();
          await release.promise;
        },
      });
      const marker = () =>
        expiry.runtime.transaction(async (tx) => {
          await markTestReceipt(tx, receipt.id, state);
          if (!expiryFirst) return;
          held.resolve();
          await release.promise;
        });
      const tick = (): Promise<number> => replay.database.schedules.tick(due);
      const first = expiryFirst ? marker() : tick();
      await Promise.race([held.promise, first.then(() => assert.fail("no schedule barrier"))]);
      const second = expiryFirst ? tick() : marker();
      try {
        assert.equal(
          await harness.waitForLockOrRead(expiryFirst ? replay.pid : expiry.pid),
          "blocked",
        );
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
      assert.equal(await (expiryFirst ? second : first), 0);
      const schedule = (
        await runtime.query<{ active_run_id: string; next_at: Date }>(
          "select active_run_id, next_at from trigger_schedules where trigger_id = $1",
          [trigger.id],
        )
      ).rows[0];
      assert.equal(schedule?.active_run_id, original.id);
      assert.ok(schedule.next_at > due);
    }
    await runtime.query(
      "update trigger_schedules set next_at = $2, active_run_id = null where trigger_id = $1",
      [trigger.id, due],
    );
    await runtime.query("delete from trigger_runs where id = $1", [original.id]);
    await assert.rejects(database.schedules.tick(due), ScheduleOccurrenceConflict);
    assert.deepEqual(await database.findTriggerRunsByProviderEventReceiptId(receipt.id), []);
  });

  it("dedupes a notification thread/update before loading current workflow filters", async () => {
    const { database, runtime } = harness;
    const store = new OrganizationTriggerStore(database, org, acceptingAgentValidator());
    const trigger = await store.save({
      yaml: notificationYaml("first-notification").replace("devbox", TEST_DAEMON_SLUG),
      userId: null,
    });
    const event = thread({ id: "8888", updated_at: now.toISOString() });
    const cursor = { since: now, lastModified: null, nextPollAt: now };
    const batch = { threads: [event], limit: 1, cursor, stoppedCursor: () => cursor };
    assert.deepEqual(await database.githubNotifications.deliver(batch, now), {
      started: 1,
      deferred: false,
    });
    const receipt = await database.findProviderEventReceiptByDeliveryId(
      notificationDeliveryId(toNotificationPayload(event)),
      org,
    );
    assert.ok(receipt);
    const newTrigger = await store.save({
      yaml: notificationYaml("new-notification").replace("devbox", TEST_DAEMON_SLUG),
      userId: null,
    });
    const newRevision = await database.findActiveProjectConfiguration(newTrigger.runtimeProjectId);
    assert.ok(newRevision);
    await runtime.query(
      'update project_configuration_revisions set normalized_configuration = \'{"triggers":[{"on":"github.notification"}]}\' where id = $1',
      [newRevision.id],
    );
    for (const state of ["expiring", "expired"] as const) {
      await markTestReceipt(runtime, receipt.id, state);
      assert.deepEqual(await database.githubNotifications.deliver(batch, now), {
        started: 0,
        deferred: false,
      });
    }
    assert.equal(
      (await database.listTriggerRunsForProject(trigger.runtimeProjectId, 10)).length,
      1,
    );
    assert.equal(
      (await database.listTriggerRunsForProject(newTrigger.runtimeProjectId, 10)).length,
      0,
    );
    await runtime.query(
      "update project_configuration_revisions set normalized_configuration = $2 where id = $1",
      [newRevision.id, newRevision.normalizedConfiguration],
    );
    const newUpdate = { ...event, updated_at: new Date(now.getTime() + 1000).toISOString() };
    assert.deepEqual(
      await database.githubNotifications.deliver({ ...batch, threads: [newUpdate] }, now),
      { started: 2, deferred: false },
    );
  });

  it("keeps a notification insert conflict from starting work while advancing the cursor", async () => {
    const { database, runtime } = harness;
    const event = thread({ id: "9999", updated_at: now.toISOString() });
    const cursor = { since: now, lastModified: "after-conflict", nextPollAt: now };
    const id = randomUUID();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const tombstone = runtime.transaction(async (tx) => {
      await tx.query(
        `insert into provider_event_receipts
           (id, organization_id, provider, delivery_id, source, payload)
         values ($1, $2, 'github_notification', $3, 'github.notification', '{}')`,
        [id, org, notificationDeliveryId(toNotificationPayload(event))],
      );
      await markTestReceipt(tx, id, "expiring");
      held.resolve();
      await release.promise;
    });
    await Promise.race([
      held.promise,
      tombstone.then(() => assert.fail("no notification barrier")),
    ]);
    const delivery = database.githubNotifications.deliver(
      { threads: [event], limit: 1, cursor, stoppedCursor: () => cursor },
      now,
    );
    try {
      await waitForReceiptLock(runtime, "insert into provider_event_receipts");
    } finally {
      release.resolve();
      await Promise.allSettled([tombstone, delivery]);
    }
    assert.deepEqual(await delivery, { started: 0, deferred: false });
    assert.deepEqual(await database.findTriggerRunsByProviderEventReceiptId(id), []);
    assert.deepEqual(await database.githubNotifications.readCursor(), cursor);
  });
});
