import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { compileHubConfig } from "../config/compiler.js";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { createMemoryDatabase } from "../db/memory.js";
import { scanRunPayloads } from "../db/run-payload-retention.js";
import type { QueryHandle } from "../db/runtime/index.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION,
} from "../db/test-utils/run-timeline-postgres.js";
import type { Database, ProviderEventReceiptRecord } from "../db/types.js";
import { createGitHubTriggerProvider } from "../triggers/github/provider.js";
import { createLinearTriggerProvider } from "../triggers/linear/provider.js";
import { DurableWorkflowEngine } from "../workflows/engine.js";
import { RunPayloadRetention } from "./index.js";

const NOW = new Date("2026-11-18T00:00:00Z");
const CUTOFF = new Date("2026-10-19T00:00:00Z");
const OLD = new Date(CUTOFF.getTime() - 1);
const ORGANIZATION = TIMELINE_ORGANIZATION;

function githubEvent(type: string, payload: object) {
  return {
    provider: "github",
    source: "github." + type,
    payload: {
      type,
      id: randomUUID(),
      repo: "owner/repo",
      repositoryId: 1,
      installationId: 1,
      createdAt: OLD.toISOString(),
      payload: { sender: { login: "owner" }, action: "opened", ...payload },
    },
  } as const;
}

const linearIssue = {
  id: "linear-issue",
  title: "Title",
  description: null,
  projectId: "project",
  stateId: "open",
  assigneeId: "user",
  labelIds: [],
};

function linearEvent(type: string, data: object) {
  return {
    provider: "linear",
    source: "linear." + type,
    payload: {
      type,
      id: randomUUID(),
      organizationId: "linear-test",
      actor: { id: "actor" },
      issue: linearIssue,
      ...data,
    },
  } as const;
}

function workflow(on: string, filters: object) {
  return { on, filters };
}

const githubActor = { from_users: ["owner"] };
const linearActor = { from_users: ["actor"] };
const issue = { number: 1, title: "Title", body: "Body", user: { login: "owner" } };
const issueCreated = workflow("github.issue_created", githubActor);
const pullRequestCreated = workflow("github.pull_request_created", githubActor);
const linearScope = workflow("linear.issue_entered_scope", {
  project: "project",
  states: ["open"],
});
const receipts = [
  {
    event: githubEvent("issues", { issue }),
    matching: issueCreated,
    unrelated: pullRequestCreated,
  },
  {
    event: githubEvent("pull_request", { pull_request: issue }),
    matching: pullRequestCreated,
    unrelated: issueCreated,
  },
  {
    event: githubEvent("issue_comment", {
      action: "created",
      issue,
      comment: { id: 2, body: "/review" },
    }),
    matching: workflow("github.issue_comment_created", { ...githubActor, contains: "/review" }),
    unrelated: workflow("github.issue_comment_created", { ...githubActor, contains: "/triage" }),
  },
  {
    event: linearEvent("issue", { action: "update", updatedFrom: { stateId: "backlog" } }),
    matching: linearScope,
    unrelated: workflow("linear.comment_created", linearActor),
  },
  {
    event: linearEvent("issue", { action: "update", updatedFrom: { assigneeId: null } }),
    matching: workflow("linear.issue_assigned", linearActor),
    unrelated: linearScope,
  },
  {
    event: linearEvent("comment", {
      action: "create",
      comment: { id: "comment", issueId: "linear-issue", body: "/review" },
    }),
    matching: workflow("linear.comment_created", { ...linearActor, contains: "/review" }),
    unrelated: workflow("linear.comment_created", { ...linearActor, contains: "/triage" }),
  },
];

function configuration(workflows: readonly ReturnType<typeof workflow>[]) {
  const runner = { name: "runner", kind: "daemon" as const, daemon: "runner", cwd: "/repo" };
  const compiled = compileHubConfig({
    environments: [runner],
    triggers: workflows.map(({ on, filters }, index) => ({
      name: ["primary", "secondary", "tertiary"][index],
      on,
      max_runtime: "2h",
      filters,
      steps: [
        {
          id: "reply",
          environment: "runner",
          max_runtime: "1h",
          idle_timeout: "5m",
          agent: { provider: "opencode", mode: "default" },
          prompt: [{ text: "Handle it" }],
        },
      ],
    })),
  });
  return { ...compiled, environments: [{ ...runner, daemonId: "runner" }] };
}

type TestEvent = Pick<ProviderEventReceiptRecord, "provider" | "source" | "payload">;
type SeedEvidence = (id: string, event: TestEvent) => Promise<void>;

async function insertRevision(
  database: Database,
  projectId: string,
  normalizedConfiguration: ReturnType<typeof configuration>,
) {
  return database.insertProjectConfigurationRevision({
    projectId,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration,
    contentHash: randomUUID(),
  });
}

async function seedReceipt(
  database: Database,
  seedEvidence: SeedEvidence,
  projectId: string,
  event: TestEvent,
  workflows: readonly ReturnType<typeof workflow>[],
) {
  const pinned = await insertRevision(database, projectId, configuration(workflows));
  await database.activateProjectConfigurationRevision(projectId, pinned.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: ORGANIZATION,
    projectId,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: event.payload,
    receivedAt: OLD,
  });
  assert.equal(receipt.status, "accepted");
  const admitted = { ...receipt.event, source: event.source };
  await seedEvidence(admitted.providerEventReceiptId, event);
  return admitted;
}

async function persistBranch(
  database: Database,
  event: Awaited<ReturnType<typeof seedReceipt>>,
  name: string,
) {
  const { run, created } = await database.createRejectedTriggerRun({
    ...event,
    configuredTriggerName: name,
    prompt: "",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    rejection: { code: "missing_required", inputName: "test" },
    createdAt: OLD,
  });
  assert.ok(created);
  return run.id;
}

async function verifyMatrix(database: Database, seedEvidence: SeedEvidence) {
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Fan-out fixtures",
    slug: "fan-out-fixtures",
    createdByUserId: null,
  });
  const providerOptions = {
    configurationStoreForProject: (id: string) => new ProjectConfigurationStore(database, id),
    reactions: {
      async createReaction() {
        throw new Error("unexpected provider call");
      },
      async deleteReaction() {
        throw new Error("unexpected provider call");
      },
    },
  };
  const providers = {
    github: createGitHubTriggerProvider(providerOptions),
    linear: createLinearTriggerProvider(providerOptions),
  };
  const engine = new DurableWorkflowEngine({
    database,
    entitlements: null,
    providers: Object.values(providers),
  });
  for (const { event, matching, unrelated } of receipts) {
    const label = matching.on;
    const excluded = workflow(matching.on, { ...matching.filters, from_users: ["excluded"] });
    const check = async (
      workflows: readonly ReturnType<typeof workflow>[],
      names: readonly string[],
    ) => {
      const receipt = await seedReceipt(database, seedEvidence, project.id, event, workflows);
      const matches = await providers[event.provider].match(receipt);
      assert.deepEqual(
        typeof matches === "string" ? [] : matches.map(({ triggerName }) => triggerName),
        names,
        label,
      );
      return receipt;
    };
    const assertEligibility = async (id: string, eligible: boolean) => {
      for (const countOnly of [true, false]) {
        const page = await database.scanRunPayloads(null, CUTOFF, 100, countOnly);
        assert.deepEqual(
          page.find((candidate) => candidate.id === id),
          { id, disposition: eligible ? "eligible" : "fan_out_unresolved", ageFrom: OLD },
          label,
        );
      }
      assert.equal(
        await database.expireRunPayloadChunk(id, CUTOFF, NOW),
        eligible ? "expiring" : "skipped",
        label,
      );
    };
    for (const workflows of [[matching], [matching, unrelated], [matching, excluded]]) {
      const receipt = await check(workflows, ["primary"]);
      const id = await persistBranch(database, receipt, "primary");
      await assertEligibility(id, true);
    }

    const incomplete = await check([matching, matching], ["primary", "secondary"]);
    const first = await persistBranch(database, incomplete, "primary");
    await assertEligibility(first, false);
    const current = await insertRevision(database, project.id, configuration([matching]));
    await database.activateProjectConfigurationRevision(project.id, current.id, []);
    await assertEligibility(first, false);
    await persistBranch(database, incomplete, "historical-extra");
    await assertEligibility(first, false);
    await persistBranch(database, incomplete, "secondary");
    await assertEligibility(first, true);

    const zeroMatches = await check([excluded], []);
    await engine.enqueue(zeroMatches);
    const stored = await database.findProviderEventReceiptById(zeroMatches.providerEventReceiptId);
    assert.equal(stored?.droppedReason, "trigger_filters_rejected", label);
    assert.deepEqual(
      await database.findTriggerRunsByProviderEventReceiptId(zeroMatches.providerEventReceiptId),
      [],
      label,
    );
  }

  const unresolvedEvents: TestEvent[] = [
    { provider: "slack", source: "slack.message", payload: {} },
    { provider: "discord", source: "discord.message", payload: {} },
    linearEvent("issue", {
      action: "update",
      issue: { ...linearIssue, delegateId: "app-user" },
      updatedFrom: { delegateId: null },
    }),
  ];
  const before = await database.scanRunPayloads(null, CUTOFF, 100, true);
  for (const event of unresolvedEvents) {
    const receipt = await seedReceipt(database, seedEvidence, project.id, event, [
      workflow("linear.issue_assigned", linearActor),
    ]);
    const id = await persistBranch(database, receipt, "primary");
    assert.equal(await database.expireRunPayloadChunk(id, CUTOFF, NOW), "skipped");
  }
  const count = await new RunPayloadRetention(database, {
    mode: "count",
    retentionDays: 30,
    maxRunsPerPass: 100,
  }).runBatch(NOW);
  assert.equal(count.complete, true);
  assert.deepEqual(count.counts.fan_out_unresolved, {
    count:
      before.filter(({ disposition }) => disposition === "fan_out_unresolved").length +
      unresolvedEvents.length,
    oldestAgeMs: NOW.getTime() - OLD.getTime(),
  });
}

it("proves pinned provider fan-out in memory", async () => {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION] });
  await verifyMatrix(database, async (id, event) => {
    const receipt = await database.findProviderEventReceiptById(id);
    assert.ok(receipt);
    Object.assign(receipt, event);
  });
});

it("proves pinned provider fan-out in PostgreSQL", async () => {
  const harness = await createTimelinePostgresHarness();
  try {
    await verifyMatrix(harness.database, async (id, event) => {
      await harness.runtime.query(
        "update provider_event_receipts set provider = $2, source = $3 where id = $1",
        [id, event.provider, event.source],
      );
    });
  } finally {
    await harness.close();
  }
}, 120_000);

it("uses an indexed revision lookup for 50 candidates among 12,001 revisions", async () => {
  const harness = await createTimelinePostgresHarness();
  const { database, runtime } = harness;
  try {
    const project = await database.createProject({
      organizationId: ORGANIZATION,
      name: "Fan-out plan",
      slug: "fan-out-plan",
      createdByUserId: null,
    });
    const normalized = configuration([issueCreated]);
    const pinned = await insertRevision(database, project.id, normalized);
    const route = {
      projectId: project.id,
      configurationRevisionId: pinned.id,
      connectionId: null,
      resourceId: null,
    };
    await runtime.query(
      `insert into project_configuration_revisions
         (project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
       select $1, $2, n + 1, 'manual', '{}', $3, md5(n::text) from generate_series(1,12000) n`,
      [project.id, ORGANIZATION, normalized],
    );
    await runtime.query(
      `with receipts as (
         insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload, accepted_routes)
         select $1, 'github', 'plan-' || n, 'github.issues', $2, $3
         from generate_series(1,50) n returning id
       )
       insert into trigger_runs (
         organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
         configured_trigger_name, status, completed_at, prompt, deadline_at
       )
       select $1, $4, $5, id, 'primary', 'succeeded', $6, '', $6 from receipts`,
      [
        ORGANIZATION,
        receipts[0]!.event.payload,
        JSON.stringify([route]),
        project.id,
        pinned.id,
        OLD,
      ],
    );
    await runtime.query("analyze project_configuration_revisions");
    await runtime.query("analyze trigger_runs");

    const plans: string[] = [];
    const observed: QueryHandle = {
      async query(sql, params) {
        const result = await runtime.query<{ "QUERY PLAN": string }>(
          "explain (analyze, buffers, timing off) " + sql,
          params,
        );
        plans.push(result.rows.map((row) => row["QUERY PLAN"]).join("\n"));
        return runtime.query(sql, params);
      },
    };
    const candidatePage = await scanRunPayloads(observed, null, CUTOFF, 50, false);
    assert.equal(candidatePage.length, 50);
    assert.ok(candidatePage.every((candidate) => candidate.disposition === "eligible"));
    const revisionPlan = plans.find((plan) => plan.includes("project_configuration_revisions"));
    assert.match(revisionPlan ?? "", /Index Scan using project_configuration_revisions_\w+/);
    const timings = plans.flatMap((plan) => plan.match(/Execution Time: [\d.]+ ms/g) ?? []);
    process.stdout.write(
      `Fan-out revision lookup plan:\n${revisionPlan}\nPage query execution times: ${timings.join(", ")}\n`,
    );
  } finally {
    await harness.close();
  }
}, 120_000);
