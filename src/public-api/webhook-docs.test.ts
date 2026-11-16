import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { it } from "vitest";
import { z } from "zod";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { webhookFixture } from "./test-utils/webhook-fixture.js";

const execFileAsync = promisify(execFile);
const responseSchema = z
  .object({
    deliveryKey: z.string(),
    providerEventReceiptId: z.string().uuid(),
    triggerRunId: z.string().uuid(),
    configuredTriggerName: z.literal("build-finished"),
    workflowStatus: z.string(),
    duplicate: z.boolean(),
  })
  .strict();
const report = {
  message: "build 43 finished: 2 tests failed",
  status: "failed",
  failures: 2,
};

it("runs every webhook guide example against the embedded HTTP server", async () => {
  const document = await readFile(new URL("../../docs/webhooks.md", import.meta.url), "utf8");
  const examples = [...document.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gmu)].map((match) => ({
    language: match[1]?.trim() ?? "",
    code: match[2] ?? "",
  }));
  assert.deepEqual(
    examples.map((example) => example.language),
    ["yaml", "sh", "javascript", "python"],
    "Every fence must be a recognized executable example, with its execution covered below",
  );
  const hub = await webhookFixture();
  try {
    const key = await hub.createKey(["events:send"], {
      actor: "ci-partner",
      allowedTriggers: ["build-finished"],
    });
    const origin = await hub.listen();
    const env = {
      ...process.env,
      HUB_URL: origin,
      HUB_KEY: key.secret,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const store = new OrganizationTriggerStore(
      hub.database,
      "webhook-a",
      acceptingAgentValidator(),
    );
    const executed: string[] = [];
    const runIds = new Set<string>();
    let projectId: string | undefined;
    for (const example of examples) {
      if (example.language === "yaml") {
        const trigger = await store.save({ yaml: example.code, userId: "webhook-owner" });
        assert.equal(trigger.name, "build-finished");
        projectId = trigger.runtimeProjectId;
        executed.push(example.language);
        continue;
      }
      assert.ok(projectId, "Install the documented YAML before sending its examples");
      let command: string;
      let args: string[];
      switch (example.language) {
        case "sh":
          command = "/bin/sh";
          args = ["-c", example.code];
          break;
        case "javascript":
          command = process.execPath;
          args = ["--input-type=module", "--eval", example.code];
          break;
        case "python":
          command = "python3";
          args = ["-c", example.code];
          break;
        default:
          throw new Error(`Unexecuted documentation language: ${example.language}`);
      }
      const execute = () => execFileAsync(command, args, { env, timeout: 30_000 });
      const first = responseSchema.parse(JSON.parse((await execute()).stdout));
      assert.equal(first.duplicate, false, example.language);
      assert.equal(first.workflowStatus, "running");
      assert.equal(runIds.has(first.triggerRunId), false);
      runIds.add(first.triggerRunId);
      const run = await hub.database.findTriggerRunById(first.triggerRunId);
      assert.ok(run);
      assert.equal(run.projectId, projectId);
      assert.equal(run.prompt, report.message);
      assert.deepEqual(run.inputs, { status: report.status, failures: report.failures });
      const context = z
        .object({
          event: z.object({
            manual: z.object({
              actor: z.literal("ci-partner"),
              input: z.literal(report.message),
              data: z.unknown(),
              source: z.literal("webhook.received"),
            }),
          }),
        })
        .parse(run.triggerContext);
      assert.deepEqual(context.event.manual.data, report);
      const receipt = await hub.database.findProviderEventReceiptById(first.providerEventReceiptId);
      assert.equal(receipt?.source, "webhook.received");
      assert.deepEqual(z.object({ data: z.unknown() }).parse(receipt?.payload).data, report);
      const duplicate = responseSchema.parse(JSON.parse((await execute()).stdout));
      assert.deepEqual(duplicate, { ...first, duplicate: true });
      const replay = await fetch(`${origin}/api/v1/hooks/build-finished`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.secret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": first.deliveryKey,
        },
        body: JSON.stringify({ message: "ignored duplicate", status: 123, failures: "wrong type" }),
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), duplicate);
      executed.push(example.language);
    }
    assert.deepEqual(
      executed,
      examples.map((example) => example.language),
    );
    assert.equal(executed.length, 4);
    assert.equal(runIds.size, 3);
    assert.ok(projectId);
    const runs = await hub.database.listTriggerRunsForProject(projectId, 10);
    assert.deepEqual(new Set(runs.map((run) => run.id)), runIds);
  } finally {
    await hub.close();
  }
}, 120_000);
