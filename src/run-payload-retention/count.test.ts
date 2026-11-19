import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { TriggerRunRecord } from "../db/types.js";
import { summarizeRunPayload } from "./summary.js";
import { RunPayloadRetention } from "./index.js";
import { readRunPayloadRetentionSettings } from "./settings.js";

const NOW = new Date("2026-11-18T00:00:00Z");

it("validates independent retention settings and refuses a shorter window in on mode", () => {
  assert.deepEqual(readRunPayloadRetentionSettings({}, 90), {
    mode: "off",
    retentionDays: 30,
    maxRunsPerPass: 50,
  });
  const env = {
    PASEO_HUB_RUN_PAYLOAD_EXPIRY: "count",
    PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS: "1",
    PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS: "2",
  };
  assert.deepEqual(readRunPayloadRetentionSettings(env, 90), {
    mode: "count",
    retentionDays: 1,
    maxRunsPerPass: 2,
  });
  assert.throws(
    () =>
      readRunPayloadRetentionSettings(
        {
          ...env,
          PASEO_HUB_RUN_PAYLOAD_EXPIRY: "on",
        },
        90,
      ),
    /PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS=1.*PASEO_HUB_TIMELINE_RETENTION_DAYS=90/u,
  );
  for (const value of ["0", "1.5", "366", "-1", "1e1"]) {
    assert.throws(
      () =>
        readRunPayloadRetentionSettings(
          {
            ...env,
            PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS: value,
          },
          90,
        ),
      /PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS/u,
    );
  }
  assert.throws(
    () =>
      readRunPayloadRetentionSettings(
        {
          ...env,
          PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS: "0",
        },
        90,
      ),
    /PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS/u,
  );
  assert.throws(
    () =>
      readRunPayloadRetentionSettings(
        {
          ...env,
          PASEO_HUB_RUN_PAYLOAD_EXPIRY: "apply",
        },
        90,
      ),
    /PASEO_HUB_RUN_PAYLOAD_EXPIRY/u,
  );
});

it("counts with a fixed cutoff and leaves all rows byte-for-byte unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-run-payload-count-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(directory);
  try {
    await runtime.migrate();
    const statements = [
      `insert into organization (id, name, slug) values ('count', 'Count', 'count')`,
      `insert into projects (id, organization_id, name, slug)
       values ('10000000-0000-4000-8000-000000000001', 'count', 'Count', 'count')`,
      `insert into project_configuration_revisions
       (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
       values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
       'count', 1, 'manual', '{}', '{}', 'count')`,
      `insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload)
       values ('count', 'manual', 'count', 'webhook.received', '{"sentinel":"receipt-raw"}')`,
      `insert into trigger_runs (id, organization_id, project_id, configuration_revision_id,
       provider_event_receipt_id, configured_trigger_name, status, completed_at, created_at, prompt, deadline_at)
       select ('30000000-0000-4000-8000-00000000000' || n)::uuid,
       'count', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
       id, 'run-' || n, status, completed_at::timestamptz, '2026-10-01T00:00:00Z', 'run-raw', '2026-12-01T00:00:00Z'
       from provider_event_receipts cross join (values
         (1, 'succeeded', '2026-10-18T23:59:59.999Z'),
         (2, 'succeeded', '2026-10-19T00:00:00Z'),
         (3, 'succeeded', null),
         (4, 'running', null)
       ) as f(n, status, completed_at) where delivery_id = 'count'`,
    ];
    for (const statement of statements) await runtime.query(statement);
    const hashes = async () =>
      (
        await runtime.query(
          `select md5(to_jsonb(run)::text) as value from trigger_runs run order by id`,
        )
      ).rows;
    const before = await hashes();
    const retention = new RunPayloadRetention(createDatabase(runtime, locks), {
      mode: "count",
      retentionDays: 30,
      maxRunsPerPass: 2,
    });
    assert.equal((await retention.runBatch(NOW)).complete, false);
    assert.equal((await retention.runBatch(new Date("2027-01-01"))).complete, false);
    assert.deepEqual(await retention.runBatch(NOW), {
      complete: true,
      expired: 0,
      launchIntentsExpired: 0,
      sessionsReduced: 0,
      auxiliaryCounts: { launchIntent: {}, session: {}, machine: {} },
      counts: {
        eligible: { count: 1, oldestAgeMs: 30 * 86_400_000 + 1 },
        not_old_enough: { count: 1, oldestAgeMs: 30 * 86_400_000 },
        missing_completion: { count: 1, oldestAgeMs: 48 * 86_400_000 },
        live: { count: 1, oldestAgeMs: 48 * 86_400_000 },
      },
    });
    assert.deepEqual(await hashes(), before);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("constructs provider links from validated IDs and drops event text and untrusted URLs", () => {
  const run: TriggerRunRecord = {
    id: "run",
    organizationId: "org",
    projectId: "project",
    configurationRevisionId: "revision",
    providerEventReceiptId: "receipt",
    configuredTriggerName: "workflow",
    createdAt: NOW,
    outcome: "rejected",
    status: "rejected",
    completedAt: NOW,
    rejection: { code: "missing_required", inputName: "field" },
    conversation: { key: "raw-sentinel-private", label: "raw-sentinel-title" },
    prompt: "raw-sentinel-prompt",
    inputs: {},
    values: {},
    triggerContext: {},
    outputContext: {},
  };
  const summarize = (
    provider: "github" | "slack" | "discord",
    outputContext: unknown,
    triggerContext: unknown = {},
    repo: string | null = null,
  ) =>
    summarizeRunPayload(
      { ...run, outputContext, triggerContext },
      { provider, repo },
      {},
      undefined,
      undefined,
    );
  const github = summarize(
    "github",
    {},
    {
      event: {
        github: {
          item: {
            type: "pull_request",
            number: 7,
            title: "raw-sentinel-title",
            url: "https://invalid.example/raw-sentinel-url",
          },
        },
      },
    },
    "owner/repo",
  );
  assert.equal(github.providerLink, "https://github.com/owner/repo/pull/7");
  assert.doesNotMatch(JSON.stringify(github), /raw-sentinel-/u);
  assert.equal(
    summarize("slack", {
      channelId: "C0123456789",
      messageTs: "1750000000.123456",
    }).providerLink,
    "https://app.slack.com/archives/C0123456789/p1750000000123456",
  );
  assert.equal(
    summarize("slack", {
      channelId: "C0123456789/raw-sentinel-query",
      messageTs: "1750000000.123456",
    }).providerLink,
    null,
  );
  assert.equal(
    summarize("discord", {
      guildId: "12345678901234567",
      channelId: "22345678901234567",
      messageId: "32345678901234567",
    }).providerLink,
    "https://discord.com/channels/12345678901234567/22345678901234567/32345678901234567",
  );
  assert.equal(summarize("github", {}, {}, "../raw-sentinel-repo").providerLink, null);
});
