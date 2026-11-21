import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import { ProblemSchema } from "./contracts.js";
import { webhookFixture } from "./test-utils/webhook-fixture.js";
import { createManualRunProvider } from "../triggers/manual/provider.js";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { renderExpressionTemplate } from "../workflows/expression.js";
import { createActiveProjectConfiguration } from "../test-utils/project-configuration.js";
import { asTriggerContextValue } from "../triggers/index.js";
import { parseInvocationInputs } from "../triggers/invocation.js";

const dispatchedSchema = z
  .object({
    deliveryKey: z.string(),
    providerEventReceiptId: z.string().uuid(),
    triggerRunId: z.string().uuid(),
    configuredTriggerName: z.string(),
    workflowStatus: z.string(),
    duplicate: z.boolean(),
  })
  .strict();
const eventSchema = z.object({
  provider: z.literal("manual"),
  deliveryId: z.string(),
  event: z.object({
    manual: z.object({
      actor: z.string(),
      input: z.union([z.string(), z.object({ truncated: z.literal(true), bytes: z.number() })]),
      data: z.record(z.string(), z.unknown()).optional(),
      source: z.enum(["manual.run", "webhook.received"]),
      trigger: z.string(),
      delivery_id: z.string(),
    }),
  }),
});

async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(ProblemSchema.parse(await response.json()).code, code);
}

describe("embedded authenticated webhook intake", () => {
  it("starts only the named trigger for text and JSON with bound identity and rendered context", async () => {
    const hub = await webhookFixture();
    try {
      const trigger = await hub.save();
      const other = await hub.save("other-build");
      const text = await hub.send(trigger.name, "status=failed count=3 plain message");
      assert.equal(text.status, 202);
      const textRun = dispatchedSchema.parse(await text.json());
      const recordedText = await hub.database.findTriggerRunById(textRun.triggerRunId);
      assert.equal(recordedText?.prompt, "status=failed count=3 plain message");
      assert.deepEqual(recordedText?.inputs, { status: "failed", count: 3 });
      const data = {
        message: "JSON message",
        status: "failed",
        count: 2,
        actor: "spoofed",
        mode: "full-access",
        metadata: { retained: true },
      };
      const json = await hub.send(trigger.name, data);
      assert.equal(json.status, 202);
      const result = dispatchedSchema.parse(await json.json());
      assert.equal(result.duplicate, false);
      const run = await hub.database.findTriggerRunById(result.triggerRunId);
      assert.ok(run);
      assert.equal(run.prompt, data.message);
      assert.deepEqual(run.inputs, { status: "failed", count: 2 });
      assert.equal(run.projectId, trigger.runtimeProjectId);
      assert.deepEqual(
        await hub.database.listTriggerRunsForProject(other.runtimeProjectId, 10),
        [],
      );
      const context = eventSchema.parse(run.triggerContext);
      assert.equal(context.event.manual.actor, "sender");
      assert.deepEqual(context.event.manual.data, data);
      assert.equal(context.event.manual.source, "webhook.received");
      const provider = createManualRunProvider(
        (id) => new ProjectConfigurationStore(hub.database, id),
      );
      if (provider.materializeContext === undefined) throw new Error("manual context unavailable");
      const materialized = await provider.materializeContext({
        executionId: randomUUID(),
        organizationId: "webhook-a",
        projectId: run.projectId,
        providerEventReceiptId: run.providerEventReceiptId,
        triggerContext: context,
      });
      assert.equal(
        renderExpressionTemplate("${{ paseo.context }}", {
          prompt: run.prompt,
          context: asTriggerContextValue(materialized),
          inputs: parseInvocationInputs(run.inputs),
          steps: {},
          values: {},
        }),
        JSON.stringify(context.event),
      );
      const receipt = await hub.database.findProviderEventReceiptById(
        result.providerEventReceiptId,
      );
      assert.equal(receipt?.source, "webhook.received");
      assert.deepEqual(z.object({ data: z.unknown(), actor: z.string() }).parse(receipt?.payload), {
        data,
        actor: "sender",
      });
      assert.equal(JSON.stringify(receipt).includes(hub.key.secret), false);
      assert.equal(JSON.stringify(run).includes(hub.key.secret), false);
      const listed = (await hub.database.listProjectActivityRuns(run.projectId, 10)).find(
        (entry) => entry.run.id === run.id,
      );
      assert.ok(listed);
      assert.equal(listed.webhookActor, "sender");
      assert.equal("payload" in listed.receipt, false);
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("bounds oversized multibyte context with serialized-byte markers without losing the prompt, inputs or receipt", async () => {
    const hub = await webhookFixture();
    try {
      await hub.save();
      const message = "\u00e9".repeat(32_768);
      const data = { message, count: 2, nested: { evidence: "x".repeat(100_000) } };
      const response = await hub.send("build-finished", data);
      assert.equal(response.status, 202);
      const result = dispatchedSchema.parse(await response.json());
      const run = await hub.database.findTriggerRunById(result.triggerRunId);
      assert.ok(run);
      assert.equal(run.prompt, message);
      assert.deepEqual(run.inputs, { count: 2, status: "failed" });
      assert.ok(Buffer.byteLength(JSON.stringify(run.triggerContext)) <= 65_536);
      const context = eventSchema.parse(run.triggerContext);
      assert.deepEqual(context.event.manual.input, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(message)),
      });
      assert.deepEqual(context.event.manual.data, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(data)),
      });
      const receipt = await hub.database.findProviderEventReceiptById(
        result.providerEventReceiptId,
      );
      assert.deepEqual(z.object({ data: z.unknown() }).parse(receipt?.payload).data, data);
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("refuses missing, invalid, revoked, wrong-scope, unbound and CLI credentials", async () => {
    const hub = await webhookFixture();
    try {
      await hub.save();
      await error(await hub.send("build-finished", {}, { secret: null }), 401, "unauthorized");
      await error(
        await hub.send("build-finished", {}, { secret: "invalid-test-key" }),
        401,
        "unauthorized",
      );
      const wrongScope = await hub.createKey(["runs:dispatch"]);
      await error(
        await hub.send("build-finished", {}, { secret: wrongScope.secret }),
        403,
        "insufficient_scope",
      );
      const unbound = await hub.createKey();
      await hub.runtime.query("update organization_api_keys set actor = null where id = $1", [
        unbound.summary.id,
      ]);
      await error(
        await hub.send("build-finished", {}, { secret: unbound.secret }),
        403,
        "key_actor_required",
      );
      const cli = await hub.cliCredential();
      await error(await hub.send("build-finished", {}, { secret: cli }), 403, "key_actor_required");
      const revoked = await hub.createKey();
      await hub.keys.revoke("webhook-a", revoked.summary.id);
      await error(
        await hub.send("build-finished", {}, { secret: revoked.secret }),
        401,
        "unauthorized",
      );
      const query = await hub.application.publicApi.handle(
        new Request(`http://hub.test/api/v1/hooks/build-finished?key=${hub.key.secret}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      await error(query, 401, "unauthorized");
      const onlyEvents = await hub.application.publicApi.handle(
        new Request("http://hub.test/api/v1/manual-runs", {
          method: "POST",
          headers: {
            authorization: `Bearer ${hub.key.secret}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      await error(onlyEvents, 403, "insufficient_scope");
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("isolates organizations and allowed trigger names without a project-slug fallback", async () => {
    const hub = await webhookFixture();
    try {
      const trigger = await hub.save();
      await hub.save("not-allowed");
      const restricted = await hub.createKey(["events:send"], {
        actor: "sender",
        allowedTriggers: [trigger.name],
      });
      await error(
        await hub.send("not-allowed", {}, { secret: restricted.secret }),
        404,
        "trigger_not_found",
      );
      assert.equal((await hub.send(trigger.name, {}, { secret: restricted.secret })).status, 202);
      const other = await hub.createKey(["events:send"], { actor: "sender" }, "webhook-b");
      await error(
        await hub.send(trigger.name, {}, { secret: other.secret }),
        404,
        "trigger_not_found",
      );
      await createActiveProjectConfiguration(
        hub.database,
        {
          environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
          triggers: [
            {
              name: "legacy",
              on: "manual.run",
              filters: { from_users: ["sender"] },
              max_runtime: "1h",
              steps: [
                {
                  id: "work",
                  environment: "runner",
                  max_runtime: "10m",
                  idle_timeout: "1m",
                  agent: { provider: "codex" },
                  prompt: [{ text: "legacy" }],
                },
              ],
            },
          ],
        },
        { organizationId: "webhook-a", projectSlug: "legacy", userId: "webhook-owner" },
      );
      await error(await hub.send("legacy", {}), 404, "trigger_not_found");
      assert.equal(
        await hub.database.countActiveTriggerRuns(
          "webhook-b",
          trigger.runtimeProjectId,
          trigger.name,
        ),
        0,
      );
      assert.equal(
        await hub.database.countActiveTriggerRuns(
          "webhook-a",
          trigger.runtimeProjectId,
          "other-name",
        ),
        0,
      );
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("hides disabled, wrong-kind, missing and unconfigured triggers and enforces actor filters", async () => {
    const hub = await webhookFixture();
    try {
      await hub.save("disabled", { enabled: false });
      await hub.save("scheduled", { event: "schedule.tick" });
      await hub.save("forbidden", { actor: "other" });
      for (const name of ["missing", "disabled", "scheduled"])
        await error(await hub.send(name, {}), 404, "trigger_not_found");
      await error(await hub.send("forbidden", { actor: "other" }), 403, "actor_forbidden");
      const empty = await hub.save("unconfigured");
      await hub.runtime.query(
        "update projects set active_configuration_revision_id = null where id = $1",
        [empty.runtimeProjectId],
      );
      await error(await hub.send(empty.name, {}), 404, "trigger_not_found");
      const manual = await hub.createKey(["runs:dispatch"]);
      const response = await hub.application.publicApi.handle(
        new Request("http://hub.test/api/v1/manual-runs", {
          method: "POST",
          headers: { authorization: `Bearer ${manual.secret}`, "content-type": "application/json" },
          body: JSON.stringify({
            projectSlug: "default",
            trigger: empty.name,
            deliveryKey: randomUUID(),
            input: {},
          }),
        }),
      );
      await error(response, 404, "configuration_not_found");
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("returns original ids on duplicates, separates triggers and keeps invalid keys free", async () => {
    const hub = await webhookFixture();
    try {
      const trigger = await hub.save();
      await hub.save("second");
      const deliveryKey = "same-delivery";
      const first = await hub.send(
        trigger.name,
        { message: "original", count: 2 },
        { deliveryKey },
      );
      assert.equal(first.status, 202);
      const original = dispatchedSchema.parse(await first.json());
      const second = await hub.send(
        trigger.name,
        { count: "ignored duplicate body" },
        { deliveryKey },
      );
      assert.equal(second.status, 200);
      assert.deepEqual(dispatchedSchema.parse(await second.json()), {
        ...original,
        duplicate: true,
      });
      const different = await hub.send("second", {}, { deliveryKey });
      assert.equal(different.status, 202);
      assert.notEqual(
        dispatchedSchema.parse(await different.json()).triggerRunId,
        original.triggerRunId,
      );
      const freshKey = randomUUID();
      const rejected = await hub.send(trigger.name, { count: "wrong" }, { deliveryKey: freshKey });
      await error(rejected, 422, "invalid_input");
      const corrected = await hub.send(trigger.name, { count: 2 }, { deliveryKey: freshKey });
      assert.equal(corrected.status, 202);
      assert.equal(dispatchedSchema.parse(await corrected.json()).duplicate, false);
      const noKeyA = dispatchedSchema.parse(await (await hub.send(trigger.name)).json());
      const noKeyB = dispatchedSchema.parse(await (await hub.send(trigger.name)).json());
      assert.notEqual(noKeyA.triggerRunId, noKeyB.triggerRunId);
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("returns exactly one new delivery and one duplicate through a controlled persistence overlap", async () => {
    const hub = await webhookFixture();
    const persistedFirst = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const persist = hub.database.persistManualEvent.bind(hub.database);
    let first: Promise<Response> | undefined;
    let replays = 0;
    try {
      const trigger = await hub.save();
      const deliveryKey = randomUUID();
      hub.database.persistManualEvent = async (input) => {
        const result = await persist(input);
        if (result.replayed === true) replays += 1;
        else {
          persistedFirst.resolve();
          await releaseFirst.promise;
        }
        return result;
      };
      first = hub.send(trigger.name, { message: "original", count: 2 }, { deliveryKey });
      await Promise.race([
        persistedFirst.promise,
        first.then(() => {
          throw new Error("First request ended before its receipt was persisted");
        }),
      ]);
      const second = await hub.send(
        trigger.name,
        { message: "replacement", count: 3 },
        { deliveryKey },
      );
      assert.equal(second.status, 200);
      const duplicate = dispatchedSchema.parse(await second.json());
      assert.equal(duplicate.duplicate, true);
      releaseFirst.resolve();
      const originalResponse = await first;
      assert.equal(originalResponse.status, 202);
      const original = dispatchedSchema.parse(await originalResponse.json());
      assert.equal(original.duplicate, false);
      assert.equal(
        [originalResponse, second].filter((response) => response.status === 202).length,
        1,
      );
      assert.equal(duplicate.deliveryKey, original.deliveryKey);
      assert.equal(duplicate.providerEventReceiptId, original.providerEventReceiptId);
      assert.equal(duplicate.triggerRunId, original.triggerRunId);
      assert.equal(duplicate.configuredTriggerName, original.configuredTriggerName);
      assert.equal(replays, 1);
      const runs = await hub.database.findTriggerRunsByProviderEventReceiptId(
        original.providerEventReceiptId,
      );
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.prompt, "original");
      assert.deepEqual(runs[0]?.inputs, { status: "failed", count: 2 });
    } finally {
      releaseFirst.resolve();
      if (first !== undefined) await Promise.allSettled([first]);
      hub.database.persistManualEvent = persist;
      await hub.close();
    }
  }, 120_000);

  it("accepts filtered events without run ids and replays their filtered result", async () => {
    const hub = await webhookFixture();
    try {
      const trigger = await hub.save("filtered", { filtered: true });
      const deliveryKey = randomUUID();
      const response = await hub.send(trigger.name, { status: "passed" }, { deliveryKey });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { status: "filtered", duplicate: false });
      const duplicate = await hub.send(trigger.name, { status: "failed" }, { deliveryKey });
      assert.equal(duplicate.status, 200);
      assert.deepEqual(await duplicate.json(), { status: "filtered", duplicate: true });
      assert.deepEqual(
        await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10),
        [],
      );
      const { records } = await hub.database.listDroppedEventPage("webhook-a", {
        limit: 15,
        provider: "webhook",
      });
      assert.equal(records[0]?.reason, "trigger_filters_rejected");
      assert.equal(records[0]?.triggerId, trigger.id);
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("caps active runs but permits safe duplicate retries at the cap", async () => {
    const hub = await webhookFixture({ maxActiveRuns: 1 });
    try {
      const trigger = await hub.save();
      const first = await hub.send(trigger.name, {}, { deliveryKey: "first" });
      assert.equal(first.status, 202);
      const busy = await hub.send(trigger.name, {}, { deliveryKey: "next" });
      assert.equal(busy.headers.get("retry-after"), "30");
      await error(busy, 429, "trigger_busy");
      assert.equal((await hub.send(trigger.name, {}, { deliveryKey: "first" })).status, 200);
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("requires bound actors for manual scripts on both endpoints and accepts a bound sender", async () => {
    const hub = await webhookFixture();
    try {
      const trigger = await hub.save("script-build", { script: true });
      const legacy = await hub.createKey(["runs:dispatch"], { actor: null });
      const request = (secret: string, actor?: string) =>
        hub.application.publicApi.handle(
          new Request("http://hub.test/api/v1/manual-runs", {
            method: "POST",
            headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
            body: JSON.stringify({
              projectSlug: "default",
              trigger: trigger.name,
              actor,
              deliveryKey: randomUUID(),
              input: {},
            }),
          }),
        );
      await error(await request(legacy.secret, "sender"), 403, "key_actor_required");
      const unboundHook = await hub.createKey();
      await hub.runtime.query("update organization_api_keys set actor = null where id = $1", [
        unboundHook.summary.id,
      ]);
      await error(
        await hub.send(trigger.name, {}, { secret: unboundHook.secret }),
        403,
        "key_actor_required",
      );
      const bound = await hub.createKey(["runs:dispatch"], { actor: "sender" });
      assert.equal((await request(bound.secret)).status, 200);
      const webhook = await hub.send(trigger.name, {
        message: "$(do-not-run) ${{ paseo.inputs.status }}",
      });
      assert.equal(webhook.status, 202);
      const result = dispatchedSchema.parse(await webhook.json());
      const steps = await hub.database.listWorkflowStepRunsForTriggerRun(result.triggerRunId);
      assert.equal(steps.length, 1);
      const revision = await new ProjectConfigurationStore(
        hub.database,
        trigger.runtimeProjectId,
      ).getActive();
      const script = revision?.configuration.triggers[0]?.steps[0];
      assert.ok(script && "script" in script);
      assert.equal(script.script, "printf ok");
    } finally {
      await hub.close();
    }
  }, 120_000);
});
