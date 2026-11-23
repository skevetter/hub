import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { DurableProviderEvent } from "../../db/types.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { TriggerDispatchOutcome, TriggerHandler, TriggerSource } from "../index.js";
import {
  createManualTriggerSource,
  dispatchManualTrigger,
  handleManualTriggerRequest,
} from "./source.js";

describe("manual trigger source", () => {
  it("passes arbitrary provider-namespaced payloads to the handler", async () => {
    const manual = await ManualTriggers.recording();

    assert.deepEqual(
      await manual.deliver({
        organizationId: "org_1",
        projectId: manual.projectId,
        source: "discord.mention",
        deliveryId: "manual-discord-1",
        payload: {
          guildId: "guild-1",
          channelId: "channel-1",
          message: "@paseo ping",
        },
      }),
      { status: 200, body: { status: "accepted", deliveryId: "manual-discord-1" } },
    );
    assert.deepEqual(manual.received(), [
      {
        organizationId: "org_1",
        projectId: manual.projectId,
        source: "discord.mention",
        deliveryId: "manual-discord-1",
        payload: {
          guildId: "guild-1",
          channelId: "channel-1",
          message: "@paseo ping",
        },
      },
    ]);
    assert.deepEqual(manual.evidence(), [{ connectionId: null, resourceId: null }]);
  });

  it.each([
    ["browser-session", "manual.run"],
    ["cli-credential", "manual.run"],
    ["cli-credential", "discord.mention"],
  ])("rejects forged %s authentication on raw %s requests", async (kind, source) => {
    const manual = await ManualTriggers.recording();
    const response = await manual.deliver({
      organizationId: "org_1",
      projectId: manual.projectId,
      source,
      deliveryId: "trusted-identity",
      payload: {
        actor: "member@example.test",
        authenticatedBy: { kind, credentialId: "member-1", boundActor: null },
      },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(manual.received(), []);
  });

  it("rejects non-namespaced manual payload sources", async () => {
    const manual = await ManualTriggers.recording();

    assert.deepEqual(
      await manual.deliver({
        organizationId: "org_1",
        projectId: manual.projectId,
        source: "manual",
        deliveryId: "manual-legacy-1",
        payload: {},
      }),
      {
        status: 400,
        body: { error: "source must be provider-namespaced, for example github.issue_comment" },
      },
    );
  });

  it.each(["void", "result"] as const)(
    "propagates replay flags when the handler returns %s",
    async (resultKind) => {
      let handlerResult: TriggerDispatchOutcome | undefined;
      const manual = await ManualTriggers.recording(async (event) => {
        handlerResult =
          resultKind === "void"
            ? undefined
            : { providerEventReceiptId: event.providerEventReceiptId, replayed: false };
        return handlerResult;
      });
      const delivery = {
        organizationId: "org_1",
        projectId: manual.projectId,
        source: "webhook.received",
        deliveryId: "replayed-delivery",
        payload: { input: "original" },
      };
      const fresh = await manual.dispatch(delivery);
      assert.equal(fresh, handlerResult);
      const replayed = await manual.dispatch({
        ...delivery,
        source: "manual.run",
        payload: { input: "replacement" },
      });
      assert.deepEqual(replayed, {
        providerEventReceiptId: manual.events()[0]?.providerEventReceiptId,
        replayed: true,
      });
      assert.deepEqual(manual.received(), [delivery, delivery]);
    },
  );

  it("redispatches the original event after a handler failure", async () => {
    let calls = 0;
    const manual = await ManualTriggers.recording(async () => {
      if (++calls === 1) throw new Error("dispatch interrupted");
    });
    const delivery = {
      organizationId: "org_1",
      projectId: manual.projectId,
      source: "webhook.received",
      deliveryId: "interrupted-delivery",
      payload: { input: "original" },
    };
    await assert.rejects(manual.dispatch(delivery), /dispatch interrupted/);
    assert.deepEqual(await manual.dispatch(delivery), {
      providerEventReceiptId: manual.events()[0]?.providerEventReceiptId,
      replayed: true,
    });
    assert.equal(calls, 2);
    const [original, replay] = manual.events();
    assert.ok(original);
    assert.deepEqual(replay, { ...original, manualRetryAuthorization: null });
  });

  it("retains replay flags without a running handler and recovers after restart", async () => {
    const manual = await ManualTriggers.recording();
    await manual.source.stop();
    const delivery = {
      organizationId: "org_1",
      projectId: manual.projectId,
      source: "manual.run",
      deliveryId: "stopped-delivery",
      payload: {},
    };
    const fresh = await manual.dispatch(delivery);
    assert.ok(fresh);
    assert.notEqual(fresh.replayed, true);
    assert.deepEqual(await manual.dispatch(delivery), { ...fresh, replayed: true });
    const recovered: DurableProviderEvent[] = [];
    await manual.source.start(async (event) => {
      recovered.push(event);
    });
    assert.deepEqual(await manual.dispatch(delivery), { ...fresh, replayed: true });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.providerEventReceiptId, fresh.providerEventReceiptId);
  });

  it("returns the replay flag for a receipt without accepted routes", async () => {
    const database = createMemoryDatabase();
    database.persistManualEvent = async () => ({
      status: "duplicate",
      providerEventReceiptId: "unrouted-receipt",
      replayed: true,
    });
    const source = createManualTriggerSource(database);
    let called = false;
    await source.start(async () => {
      called = true;
    });
    assert.deepEqual(
      await dispatchManualTrigger(source, {
        organizationId: "org_1",
        projectId: "00000000-0000-4000-8000-000000000001",
        source: "manual.run",
        deliveryId: "unrouted-delivery",
        payload: {},
        receivedAt: new Date(0),
      }),
      { providerEventReceiptId: "unrouted-receipt", replayed: true },
    );
    assert.equal(called, false);
  });
});

interface ManualDelivery {
  organizationId: string;
  projectId: string;
  source: string;
  deliveryId: string;
  payload: unknown;
}

class ManualTriggers {
  private readonly handled: DurableProviderEvent[] = [];

  private constructor(
    readonly source: TriggerSource,
    readonly projectId: string,
  ) {}

  static async recording(handler?: TriggerHandler): Promise<ManualTriggers> {
    const database = createMemoryDatabase();
    const project = await database.createProject({
      organizationId: "org_1",
      name: "Manual project",
      slug: "manual-project",
      createdByUserId: "test-user",
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "manual-source-test-configuration",
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id);
    const manual = new ManualTriggers(createManualTriggerSource(database), project.id);
    await manual.source.start(async (trigger) => {
      manual.handled.push(trigger);
      return handler?.(trigger);
    });
    return manual;
  }

  async deliver(delivery: ManualDelivery): Promise<{ status: number; body: unknown }> {
    const response = await handleManualTriggerRequest(
      new Request("http://localhost/test/trigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(delivery),
      }),
      this.source,
      "trigger",
    );
    return { status: response.status, body: await response.json() };
  }

  dispatch(delivery: ManualDelivery) {
    return dispatchManualTrigger(this.source, { ...delivery, receivedAt: new Date(0) });
  }

  events() {
    return this.handled;
  }

  received(): ManualDelivery[] {
    return this.handled.map(({ organizationId, projectId, source, deliveryId, payload }) => ({
      organizationId,
      projectId,
      source,
      deliveryId,
      payload,
    }));
  }

  evidence() {
    return this.handled.map(({ connectionId, resourceId }) => ({ connectionId, resourceId }));
  }
}
