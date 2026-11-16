import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { ProblemSchema } from "./contracts.js";
import type { PublicApi } from "./index.js";
import { webhookFixture } from "./test-utils/webhook-fixture.js";

function definition(name: string, actor: string, script: boolean): string {
  const action = script
    ? "  script: printf ok\n"
    : "  agent: { provider: codex, mode: full-access }\n  prompt: Handle it\n";
  return `name: ${name}\non:\n  manual.run:\n    filters: { from_users: [${actor}] }\nrun:\n  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }\n${action}`;
}

function manualRequest(
  api: PublicApi,
  secret: string,
  trigger: string,
  deliveryKey: string,
  actor = "sender",
  message = "Original event",
) {
  return api.handle(
    new Request("http://hub.test/api/v1/manual-runs", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        projectSlug: "default",
        trigger,
        actor,
        deliveryKey,
        input: { message },
      }),
    }),
  );
}

describe("manual authorization against the persisted revision", () => {
  it.each(["unbound", "cli", "bound"] as const)(
    "checks the dispatched script after an agent replacement for %s credentials",
    async (kind) => {
      const hub = await webhookFixture();
      try {
        const trigger = await hub.save("mutable-trigger");
        const store = new OrganizationTriggerStore(
          hub.database,
          "webhook-a",
          acceptingAgentValidator(),
        );
        const secret =
          kind === "cli"
            ? await hub.cliCredential()
            : (
                await hub.createKey(["runs:dispatch"], {
                  actor: kind === "bound" ? "sender" : null,
                })
              ).secret;
        const persist = hub.database.persistManualEvent.bind(hub.database);
        let replaced = false;
        hub.database.persistManualEvent = async (input) => {
          if (!replaced) {
            replaced = true;
            await store.save({
              triggerId: trigger.id,
              yaml: definition(trigger.name, "sender", true),
              userId: "webhook-owner",
            });
          }
          return persist(input);
        };
        let response: Response;
        try {
          response = await manualRequest(
            hub.application.publicApi,
            secret,
            trigger.name,
            randomUUID(),
          );
        } finally {
          hub.database.persistManualEvent = persist;
        }
        assert.equal(replaced, true);
        assert.equal(response.status, kind === "bound" ? 200 : 403);
        const runs = await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10);
        if (kind === "bound") {
          assert.equal(runs.length, 1);
          const current = await hub.database.findActiveProjectConfiguration(
            trigger.runtimeProjectId,
          );
          assert.equal(runs[0]?.configurationRevisionId, current?.id);
        } else {
          assert.equal(ProblemSchema.parse(await response.json()).code, "key_actor_required");
          assert.deepEqual(runs, []);
        }
      } finally {
        await hub.close();
      }
    },
    120_000,
  );

  it.each(["unbound", "cli", "bound-outsider"] as const)(
    "rechecks %s permissions on the pinned script before replaying an event without a run",
    async (kind) => {
      const hub = await webhookFixture();
      try {
        const trigger = await hub.save("pending-script", { script: true });
        const sender = await hub.createKey(["runs:dispatch"], { actor: "sender" });
        const deliveryKey = randomUUID();
        const persist = hub.database.persistManualEvent.bind(hub.database);
        let receiptId: string | undefined;
        hub.database.persistManualEvent = async (input) => {
          const persisted = await persist(input);
          if (persisted.status === "accepted") receiptId = persisted.event.providerEventReceiptId;
          throw new Error("Interrupted before provider matching");
        };
        let interrupted: Response;
        try {
          interrupted = await manualRequest(
            hub.application.publicApi,
            sender.secret,
            trigger.name,
            deliveryKey,
          );
        } finally {
          hub.database.persistManualEvent = persist;
        }
        assert.equal(interrupted.status, 500);
        assert.ok(receiptId);
        const original = await hub.database.findProviderEventReceiptById(receiptId);
        assert.ok(original);
        assert.deepEqual(await hub.database.findTriggerRunsByProviderEventReceiptId(receiptId), []);
        const store = new OrganizationTriggerStore(
          hub.database,
          "webhook-a",
          acceptingAgentValidator(),
        );
        await store.save({
          triggerId: trigger.id,
          yaml: definition(trigger.name, "outsider", false),
          userId: "webhook-owner",
        });
        const secret =
          kind === "cli"
            ? await hub.cliCredential()
            : (
                await hub.createKey(["runs:dispatch"], {
                  actor: kind === "bound-outsider" ? "outsider" : null,
                })
              ).secret;
        const replay = await manualRequest(
          hub.application.publicApi,
          secret,
          trigger.name,
          deliveryKey,
          "outsider",
        );
        assert.equal(replay.status, 403);
        assert.equal(
          ProblemSchema.parse(await replay.json()).code,
          kind === "bound-outsider" ? "actor_forbidden" : "key_actor_required",
        );
        assert.deepEqual(await hub.database.findTriggerRunsByProviderEventReceiptId(receiptId), []);
        assert.deepEqual(
          (await hub.database.findProviderEventReceiptById(receiptId))?.payload,
          original.payload,
        );
      } finally {
        await hub.close();
      }
    },
    120_000,
  );

  it("checks the current webhook key against a pending receipt's pinned script audience", async () => {
    const hub = await webhookFixture();
    try {
      const trigger = await hub.save("pending-hook", { script: true });
      const deliveryKey = randomUUID();
      const persist = hub.database.persistManualEvent.bind(hub.database);
      let receiptId: string | undefined;
      hub.database.persistManualEvent = async (input) => {
        const persisted = await persist(input);
        if (persisted.status === "accepted") receiptId = persisted.event.providerEventReceiptId;
        throw new Error("Interrupted before provider matching");
      };
      let interrupted: Response;
      try {
        interrupted = await hub.send(trigger.name, { message: "Original event" }, { deliveryKey });
      } finally {
        hub.database.persistManualEvent = persist;
      }
      assert.equal(interrupted.status, 500);
      assert.ok(receiptId);
      const original = await hub.database.findProviderEventReceiptById(receiptId);
      assert.ok(original);
      const store = new OrganizationTriggerStore(
        hub.database,
        "webhook-a",
        acceptingAgentValidator(),
      );
      await store.save({
        triggerId: trigger.id,
        yaml: definition(trigger.name, "sender, outsider", false),
        userId: "webhook-owner",
      });
      const outsider = await hub.createKey(["events:send"], { actor: "outsider" });
      const denied = await hub.send(trigger.name, {}, { secret: outsider.secret, deliveryKey });
      assert.equal(denied.status, 403);
      assert.equal(ProblemSchema.parse(await denied.json()).code, "actor_forbidden");
      assert.deepEqual(await hub.database.findTriggerRunsByProviderEventReceiptId(receiptId), []);
      assert.deepEqual(
        (await hub.database.findProviderEventReceiptById(receiptId))?.payload,
        original.payload,
      );
      const recovered = await hub.send(trigger.name, {}, { deliveryKey });
      assert.equal(recovered.status, 200);
      const runs = await hub.database.findTriggerRunsByProviderEventReceiptId(receiptId);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.prompt, "Original event");
      assert.equal(
        runs[0]?.configurationRevisionId,
        original.acceptedRoutes?.[0]?.configurationRevisionId,
      );
    } finally {
      await hub.close();
    }
  }, 120_000);

  it.each(["manual", "webhook"] as const)(
    "preserves original %s attribution when another permitted actor recovers a pending script",
    async (path) => {
      const hub = await webhookFixture();
      try {
        const trigger = await hub.save("shared-attribution", {
          script: true,
          actor: "sender, outsider",
        });
        const sender = await hub.createKey(["runs:dispatch", "events:send"], { actor: "sender" });
        const outsider = await hub.createKey(["runs:dispatch", "events:send"], {
          actor: "outsider",
        });
        const deliveryKey = randomUUID();
        const deliver = (secret: string, actor: string, message: string) =>
          path === "manual"
            ? manualRequest(
                hub.application.publicApi,
                secret,
                trigger.name,
                deliveryKey,
                actor,
                message,
              )
            : hub.send(trigger.name, { message }, { secret, deliveryKey });
        const persist = hub.database.persistManualEvent.bind(hub.database);
        let receiptId: string | undefined;
        hub.database.persistManualEvent = async (input) => {
          const result = await persist(input);
          if (result.status === "accepted") receiptId = result.event.providerEventReceiptId;
          throw new Error("Interrupted before provider matching");
        };
        let interrupted: Response;
        try {
          interrupted = await deliver(sender.secret, "sender", "Original attribution");
        } finally {
          hub.database.persistManualEvent = persist;
        }
        assert.equal(interrupted.status, 500);
        assert.ok(receiptId);
        const original = await hub.database.findProviderEventReceiptById(receiptId);
        assert.ok(original);
        assert.deepEqual(await hub.database.findTriggerRunsByProviderEventReceiptId(receiptId), []);
        const replay = await deliver(outsider.secret, "outsider", "Replacement must not run");
        assert.equal(replay.status, 200);
        const runs = await hub.database.findTriggerRunsByProviderEventReceiptId(receiptId);
        assert.equal(runs.length, 1);
        const run = runs[0];
        assert.ok(run);
        assert.equal(run.prompt, "Original attribution");
        const originalPayload = z
          .object({
            actor: z.string(),
            input: z.unknown(),
            data: z.unknown().optional(),
            authenticatedBy: z.object({ credentialId: z.string() }),
          })
          .parse(original.payload);
        assert.equal(originalPayload.actor, "sender");
        assert.equal(originalPayload.authenticatedBy.credentialId, sender.summary.id);
        const context = z
          .object({
            event: z.object({
              manual: z.object({ actor: z.string(), input: z.string(), data: z.unknown() }),
            }),
          })
          .parse(run.triggerContext);
        assert.equal(context.event.manual.actor, originalPayload.actor);
        assert.equal(context.event.manual.input, run.prompt);
        assert.deepEqual(
          context.event.manual.data,
          path === "manual" ? originalPayload.input : originalPayload.data,
        );
        assert.equal(z.object({ actor: z.string() }).parse(run.outputContext).actor, "sender");
        assert.deepEqual(await hub.database.findProviderEventReceiptById(receiptId), original);
        const activity = await hub.database.findOrganizationActivityRun("webhook-a", run.id);
        assert.ok(activity);
        assert.deepEqual(activity.receipt, original);
        const activityActor = z.object({ actor: z.string() }).parse(activity.receipt.payload).actor;
        assert.equal(context.event.manual.actor, activityActor);
        const listed = (
          await hub.database.listProjectActivityRuns(trigger.runtimeProjectId, 10)
        ).find((entry) => entry.run.id === run.id);
        assert.ok(listed);
        if (path === "webhook") assert.equal(listed.webhookActor, activityActor);
      } finally {
        await hub.close();
      }
    },
    120_000,
  );
});
