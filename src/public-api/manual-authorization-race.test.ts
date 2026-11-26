import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import { z } from "zod";
import { createHubApplication } from "../app.js";
import { cliCredentialParts, OrganizationCliCredentials } from "../auth/cli-credentials.js";
import { PublicCredentialAuthenticator } from "../auth/public-credentials.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { ManualRunPayloadSchema } from "../triggers/manual/provider.js";
import { DispatchedManualRunSchema, ProblemSchema } from "./contracts.js";
import type { PublicApi } from "./index.js";
import { webhookFixture } from "./test-utils/webhook-fixture.js";

function definition(name: string, actor: string, script: boolean): string {
  const action = script
    ? "  script: printf ok\n"
    : "  agent: { provider: codex, mode: full-access }\n  prompt: Handle it\n";
  return `name: ${name}\non:\n  manual.run:\n    filters: { from_users: [${actor}] }\nrun:\n  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }\n${action}`;
}

interface ManualRequestInput {
  trigger: string;
  deliveryKey?: string;
  actor?: string | undefined;
  message?: string;
}

function manualRequest(api: PublicApi, secret: string, input: ManualRequestInput) {
  return api.handle(buildManualRequest("http://hub.test", secret, input));
}

function buildManualRequest(baseUrl: string, secret: string, input: ManualRequestInput) {
  const { trigger, deliveryKey = randomUUID(), actor, message = "Original event" } = input;
  return new Request(`${baseUrl}/api/v1/manual-runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      projectSlug: "default",
      trigger,
      actor,
      deliveryKey,
      input: { message },
    }),
  });
}

const cliEmail = "webhook@example.test";

function applicationForEmailPolicy(
  hub: Awaited<ReturnType<typeof webhookFixture>>,
  verifiedActorEmailRequired: boolean,
) {
  return createHubApplication({
    database: hub.database,
    entitlements: createUnlimitedEntitlementsService(),
    publicApi: {
      status: "enabled",
      authenticator: new PublicCredentialAuthenticator(
        hub.keys,
        new OrganizationCliCredentials(hub.runtime),
      ),
    },
    verifiedActorEmailRequired,
  });
}

describe("credential actors on the public manual endpoint", () => {
  it.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ])(
    "checks CLI email when mail is %s and verification is %s",
    async (mail, verified) => {
      const hub = await webhookFixture();
      const application = applicationForEmailPolicy(hub, mail);
      try {
        await hub.runtime.query('update "user" set email_verified = $1 where id = $2', [
          verified,
          "webhook-owner",
        ]);
        const trigger = await hub.save("cli-email-verification", { actor: cliEmail });
        const credential = await hub.cliCredential();
        await application.hub.start();
        const result = await manualRequest(application.publicApi, credential, {
          trigger: trigger.name,
        });
        const receipts = await hub.runtime.query(
          "select id from provider_event_receipts where organization_id = $1 and source = 'manual.run'",
          ["webhook-a"],
        );
        if (mail && !verified) {
          assert.equal(result.status, 403);
          assert.equal(ProblemSchema.parse(await result.json()).code, "actor_forbidden");
          assert.deepEqual(receipts.rows, []);
        } else {
          assert.equal(result.status, 200);
          const dispatched = DispatchedManualRunSchema.parse(await result.json());
          assert.deepEqual(receipts.rows, [{ id: dispatched.providerEventReceiptId }]);
        }
      } finally {
        await application.hub.stop();
        await hub.close();
      }
    },
    120_000,
  );

  it("uses the lowercase account email for CLI credentials over HTTP", async () => {
    const hub = await webhookFixture();
    try {
      await hub.runtime.query('update "user" set email = $1 where id = $2', [
        "Webhook@Example.Test",
        "webhook-owner",
      ]);
      const trigger = await hub.save("email-only", { actor: cliEmail });
      const cli = await hub.cliCredential();
      const baseUrl = await hub.listen();
      for (const actor of [undefined, cliEmail]) {
        const response = await fetch(
          buildManualRequest(baseUrl, cli, { trigger: trigger.name, actor }),
        );
        assert.equal(response.status, 200);
        const { providerEventReceiptId, triggerRunId } = DispatchedManualRunSchema.parse(
          await response.json(),
        );
        const receipt = await hub.database.findProviderEventReceiptById(providerEventReceiptId);
        const run = await hub.database.findTriggerRunForOrganization("webhook-a", triggerRunId);
        assert.equal(run?.startedByUserId, "webhook-owner");
        const payload = ManualRunPayloadSchema.parse(receipt?.payload);
        assert.equal(payload.actor, cliEmail);
        assert.equal(payload.authenticatedBy?.kind, "cli-credential");
        assert.equal(payload.authenticatedBy.boundActor, cliEmail);
      }
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("deduplicates a CLI delivery key per account, not per project alone", async () => {
    const hub = await webhookFixture();
    try {
      const owner = await hub.cliCredential();
      const admin = await addCliAdmin(hub);
      const trigger = await hub.save("shared-delivery-key", { actor: '"*"' });
      const input = { trigger: trigger.name, deliveryKey: randomUUID() };
      const dispatch = async (secret: string) => {
        const response = await manualRequest(hub.application.publicApi, secret, input);
        assert.equal(response.status, 200);
        return DispatchedManualRunSchema.parse(await response.json());
      };
      const first = await dispatch(owner);
      const second = await dispatch(admin);
      assert.notEqual(first.triggerRunId, second.triggerRunId);
      assert.notEqual(first.providerEventReceiptId, second.providerEventReceiptId);
      assert.equal((await dispatch(owner)).triggerRunId, first.triggerRunId);
      const runs = await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10);
      assert.deepEqual(
        new Set(runs.map(({ id }) => id)),
        new Set([first.triggerRunId, second.triggerRunId]),
      );
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("rejects a CLI credential's mismatched claims before persisting a receipt", async () => {
    const hub = await webhookFixture();
    try {
      const otherMember = "other@example.test";
      await hub.runtime.query(
        'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
        ["other-user", "Other Member", otherMember],
      );
      await hub.runtime.query(
        "insert into member (id, organization_id, user_id, role) values ($1, $2, $3, $4)",
        ["other-membership", "webhook-a", "other-user", "member"],
      );
      const trigger = await hub.save("cli-claims", { actor: '"*"' });
      const cli = await hub.cliCredential();
      const persist = vi.spyOn(hub.database, "persistManualEvent");
      for (const actor of [cliEmail.toUpperCase(), otherMember, "sender"]) {
        const response = await manualRequest(hub.application.publicApi, cli, {
          trigger: trigger.name,
          actor,
        });
        assert.equal(response.status, 403);
        assert.equal(ProblemSchema.parse(await response.json()).code, "actor_forbidden");
      }
      assert.equal(persist.mock.calls.length, 0);
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("rejects a CLI credential without a resolvable user", async () => {
    const hub = await webhookFixture();
    const authorize = vi.spyOn(OrganizationCliCredentials.prototype, "authorize");
    try {
      const trigger = await hub.save("missing-user", { actor: '"*"' });
      const cli = await hub.cliCredential();
      authorize.mockResolvedValueOnce({
        status: "authorized",
        access: {
          kind: "cliCredential",
          credentialId: "missing-user",
          organizationId: "webhook-a",
          scopes: ["runs:dispatch"],
        },
      });
      const persist = vi.spyOn(hub.database, "persistManualEvent");
      const response = await manualRequest(hub.application.publicApi, cli, {
        trigger: trigger.name,
      });
      assert.equal(response.status, 403);
      assert.equal(ProblemSchema.parse(await response.json()).code, "key_actor_required");
      assert.equal(persist.mock.calls.length, 0);
    } finally {
      authorize.mockRestore();
      await hub.close();
    }
  }, 120_000);

  it("allows unbound key slug claims and rejects email claims by API keys", async () => {
    const hub = await webhookFixture();
    try {
      const trigger = await hub.save("key-claims", { actor: '"*"' });
      const unbound = await hub.createKey(["runs:dispatch"], { actor: null });
      const bound = await hub.createKey(["runs:dispatch"], { actor: "sender" });
      const persist = vi.spyOn(hub.database, "persistManualEvent");
      for (const secret of [unbound.secret, bound.secret]) {
        const response = await manualRequest(hub.application.publicApi, secret, {
          trigger: trigger.name,
          actor: cliEmail,
        });
        assert.equal(response.status, 403);
        assert.equal(ProblemSchema.parse(await response.json()).code, "actor_forbidden");
      }
      assert.equal(persist.mock.calls.length, 0);
      const response = await manualRequest(hub.application.publicApi, unbound.secret, {
        trigger: trigger.name,
        actor: "sender",
      });
      assert.equal(response.status, 200);
      assert.equal(persist.mock.calls.length, 1);
    } finally {
      await hub.close();
    }
  }, 120_000);
});

async function addCliAdmin(hub: Awaited<ReturnType<typeof webhookFixture>>): Promise<string> {
  const userId = "other-admin";
  await hub.runtime.query(
    'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
    [userId, "Other Admin", "admin@example.test"],
  );
  await hub.runtime.query(
    "insert into member (id, organization_id, user_id, role) values ($1, 'webhook-a', $2, 'admin')",
    ["admin-membership", userId],
  );
  const secret = `paseo_cli_${randomUUID().replaceAll("-", "").slice(0, 12)}_test-secret`;
  const { prefix, verifier } = cliCredentialParts(secret);
  await hub.runtime.query(
    "insert into organization_cli_credentials (id, organization_id, prefix, verifier, created_by_user_id) values ($1, 'webhook-a', $2, $3, $4)",
    [randomUUID(), prefix, verifier, userId],
  );
  return secret;
}

describe("manual authorization against the persisted revision", () => {
  it.each(["unbound", "cli", "bound"] as const)(
    "checks the dispatched script after an agent replacement for %s credentials",
    async (kind) => {
      const hub = await webhookFixture();
      try {
        const trigger = await hub.save("mutable-trigger", { actor: `sender, ${cliEmail}` });
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
          response = await manualRequest(hub.application.publicApi, secret, {
            trigger: trigger.name,
            actor: kind === "cli" ? undefined : "sender",
          });
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
    "keeps the pending script receipt untouched when %s credentials reuse its key",
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
          interrupted = await manualRequest(hub.application.publicApi, sender.secret, {
            trigger: trigger.name,
            deliveryKey,
          });
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
          yaml: definition(trigger.name, `outsider, ${cliEmail}`, false),
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
        const replay = await manualRequest(hub.application.publicApi, secret, {
          trigger: trigger.name,
          deliveryKey,
          actor: kind === "cli" ? undefined : "outsider",
        });
        if (kind === "cli") {
          assert.equal(replay.status, 200);
          const dispatched = DispatchedManualRunSchema.parse(await replay.json());
          assert.notEqual(dispatched.providerEventReceiptId, receiptId);
        } else {
          assert.equal(replay.status, 403);
          assert.equal(
            ProblemSchema.parse(await replay.json()).code,
            kind === "bound-outsider" ? "actor_forbidden" : "key_actor_required",
          );
        }
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
      assert.equal(denied.status, 404);
      assert.equal(ProblemSchema.parse(await denied.json()).code, "trigger_not_found");
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
            ? manualRequest(hub.application.publicApi, secret, {
                trigger: trigger.name,
                deliveryKey,
                actor,
                message,
              })
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
