import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { compileHubConfig } from "../../config/compiler.js";
import { notificationDeliveryId } from "../../triggers/github-notifications/notification.js";
import { bearerWebhookDeliveryId, signedWebhookDeliveryId } from "../../webhooks/delivery-id.js";
import type { ReceiptDisposition } from "../../run-payload-retention/receipt-proof.js";
import type {
  CreateAcceptedTriggerRunInput,
  Database,
  ProviderEventReceiptRecord,
  ProviderEventRouteSnapshot,
} from "../types.js";
import type { QueryHandle } from "../runtime/index.js";

export const MATRIX_ORG = "receipt-proof";
export const CUTOFF = new Date("2026-06-02T00:00:00Z");
export const OLD = new Date(CUTOFF.getTime() - 1);
export const NOW = new Date("2026-07-02T00:00:00Z");
export const CONNECTION_ID = randomUUID();

type ReceiptProvider = ProviderEventReceiptRecord["provider"];
type FixtureOutcome = "accepted" | "rejected";
type FixtureState = "expired" | "expiring" | "intact";

const runner = { name: "runner", kind: "daemon" as const, daemon: "runner", cwd: "/repo" };
export function compiledFixture(on: string, filters?: object, required = false) {
  const compiled = compileHubConfig({
    environments: [runner],
    triggers: [
      {
        name: "target",
        on,
        max_runtime: "2h",
        filters,
        ...(required ? { inputs: { required: { type: "string", required: true } } } : {}),
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Handle it" }],
          },
        ],
      },
    ],
  });
  return { ...compiled, environments: [{ ...runner, daemonId: "runner" }] };
}

export async function createRevision(
  database: Database,
  on: string,
  filters?: object,
  options: { required?: boolean; triggerId?: string; projectId?: string } = {},
) {
  const projectId =
    options.projectId ??
    (
      await database.createProject({
        organizationId: MATRIX_ORG,
        name: "Receipt fixture",
        slug: randomUUID(),
        createdByUserId: null,
      })
    ).id;
  const revision = await database.insertProjectConfigurationRevision({
    projectId,
    sourceKind: "manual",
    sourceEvidence:
      options.triggerId === undefined
        ? {}
        : { kind: "organization_trigger_adapter", triggerId: options.triggerId },
    normalizedConfiguration: compiledFixture(on, filters, options.required),
    contentHash: randomUUID(),
  });
  await database.activateProjectConfigurationRevision(projectId, revision.id, []);
  return {
    projectId,
    configurationRevisionId: revision.id,
    connectionId: null,
    resourceId: null,
  } satisfies ProviderEventRouteSnapshot;
}

interface SeedInput {
  key: string;
  provider: ReceiptProvider;
  source: string;
  payload: object;
  route: ProviderEventRouteSnapshot;
  additionalRoutes?: readonly ProviderEventRouteSnapshot[];
  noRoutes?: boolean;
  droppedReason?: string;
  preRoutingDrop?: ProviderEventReceiptRecord["preRoutingDrop"];
  repo?: string;
  deliveryId?: string;
  receivedAt?: Date;
  references?: readonly {
    route?: ProviderEventRouteSnapshot;
    outcome?: FixtureOutcome;
    state?: FixtureState;
    name?: string;
  }[];
  disposition: ReceiptDisposition;
}

export async function seedProofReceipt(
  database: Database,
  runtime: QueryHandle | undefined,
  input: SeedInput,
) {
  const marker = "receipt-body-" + input.key + "-marker";
  const metadata = proofReceiptMetadata(input);
  const { provider, route } = metadata;
  const deliveryId = input.deliveryId ?? input.key;
  const receivedAt = input.receivedAt ?? OLD;
  const payload = proofReceiptPayload(input, marker);
  const signatureHash =
    provider === "github" || provider === "linear" ? "signature-" + input.key : null;
  const received = await database.persistManualEvent({
    organizationId: MATRIX_ORG,
    projectId: route.projectId,
    source: metadata.source,
    deliveryId,
    signatureHash,
    payload,
    receivedAt,
  });
  assert.equal(received.status, "accepted");
  const id = received.event.providerEventReceiptId;
  const routeMarker = input.noRoutes === true ? null : "receipt-route-" + input.key + "-marker";
  const acceptedRoutes =
    routeMarker === null
      ? null
      : [{ ...route, fixture: routeMarker }, ...(input.additionalRoutes ?? [])];
  await updateProofReceipt(database, runtime, metadata, { id, acceptedRoutes });
  const runs: string[] = [];
  for (const reference of input.references ?? []) {
    runs.push(await seedProofBranch(database, runtime, { id, route, reference }));
  }
  return {
    id,
    key: input.key,
    marker,
    routeMarker,
    deliveryId,
    signatureHash,
    disposition: input.disposition,
    route,
    runs,
  };
}

function proofReceiptMetadata(input: SeedInput) {
  const {
    provider,
    source,
    route,
    repo = null,
    droppedReason = null,
    preRoutingDrop = null,
  } = input;
  return { provider, source, route, repo, droppedReason, preRoutingDrop };
}

function proofReceiptPayload(input: SeedInput, marker: string) {
  return {
    ...input.payload,
    sentinel: marker,
    fixture: {
      actor: marker + "-actor",
      data: { content: marker + "-content", deliveryKey: marker + "-key" },
    },
  };
}

async function updateProofReceipt(
  database: Database,
  runtime: QueryHandle | undefined,
  metadata: ReturnType<typeof proofReceiptMetadata>,
  { id, acceptedRoutes }: { id: string; acceptedRoutes: ProviderEventRouteSnapshot[] | null },
) {
  const { provider, route, repo, droppedReason, preRoutingDrop } = metadata;
  if (runtime !== undefined) {
    await runtime.query(
      `update provider_event_receipts set provider = $2, connection_id = $3, resource_id = $4, repo = $5,
        dropped_reason = $6, pre_routing_drop = $7, accepted_routes = $8 where id = $1`,
      [
        id,
        provider,
        route.connectionId,
        route.resourceId,
        repo,
        droppedReason,
        preRoutingDrop,
        acceptedRoutes === null ? null : JSON.stringify(acceptedRoutes),
      ],
    );
  } else {
    const receipt = await database.findProviderEventReceiptById(id);
    assert.ok(receipt);
    Object.assign(receipt, {
      provider,
      connectionId: route.connectionId,
      resourceId: route.resourceId,
      repo,
      droppedReason,
      preRoutingDrop,
      acceptedRoutes,
    });
  }
}

async function seedProofBranch(
  database: Database,
  runtime: QueryHandle | undefined,
  {
    id,
    route,
    reference,
  }: {
    id: string;
    route: ProviderEventRouteSnapshot;
    reference: NonNullable<SeedInput["references"]>[number];
  },
) {
  const branch = reference.route ?? route;
  const runInput = {
    organizationId: MATRIX_ORG,
    projectId: branch.projectId,
    configurationRevisionId: branch.configurationRevisionId,
    providerEventReceiptId: id,
    configuredTriggerName: reference.name ?? "target",
    prompt: "",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: NOW,
    stepIds: [],
  } satisfies CreateAcceptedTriggerRunInput;
  const { run } =
    reference.outcome === "rejected"
      ? await database.createRejectedTriggerRun({
          ...runInput,
          rejection: { code: "missing_required", inputName: "required" },
        })
      : await database.createAcceptedTriggerRun(runInput);
  await finishProofBranch(database, runtime, run, reference.state ?? "expired");
  return run.id;
}

async function finishProofBranch(
  database: Database,
  runtime: QueryHandle | undefined,
  run: { id: string },
  state: FixtureState,
) {
  const expiryState = state === "intact" ? null : state;
  const expiredAt = state === "intact" ? null : NOW;
  if (runtime !== undefined) {
    await runtime.query("delete from workflow_wakeups where trigger_run_id = $1", [run.id]);
    await runtime.query(
      `update trigger_runs set status = case when outcome = 'rejected' then 'rejected' else 'succeeded' end,
            completed_at = $2, payload_expiry_state = $3, payload_expired_at = $4, payload_summary = $5 where id = $1`,
      [
        run.id,
        NOW,
        expiryState,
        expiredAt,
        state === "intact"
          ? null
          : { stepCounts: {}, repository: null, links: [], completion: null },
      ],
    );
  } else {
    const record = await database.findTriggerRunById(run.id);
    assert.ok(record);
    if (record.outcome === "accepted") await database.succeedTriggerRun(record.id);
    const complete = await database.findTriggerRunById(run.id);
    assert.ok(complete);
    Object.assign(complete, {
      payloadExpiryState: expiryState,
      payloadExpiredAt: expiredAt,
      terminalNotificationPendingAt: null,
    });
  }
}

export function githubBody(id: string, actor = "sender", type = "issues") {
  return {
    id,
    type,
    repo: "owner/repo",
    repositoryId: 1,
    installationId: 1,
    createdAt: OLD.toISOString(),
    payload: { action: "opened", sender: { login: actor }, issue: { number: 1, title: "Issue" } },
  };
}

export async function seedProofMatrix(database: Database, runtime?: QueryHandle) {
  const seed = (input: SeedInput) => seedProofReceipt(database, runtime, input);
  const sender = { from_users: ["sender"] };
  const githubCases = await seedGithubCases(database, seed, sender);
  const linearCases = await seedLinearCases(database, seed, sender);
  const manualCases = await seedManualCases(database, seed, sender);
  const lastCases = await seedRemainingCases(database, seed);
  return [...githubCases, ...linearCases, ...manualCases, ...lastCases];
}

type SeedReceipt = (input: SeedInput) => ReturnType<typeof seedProofReceipt>;
interface SenderFilter {
  from_users: string[];
}
interface GithubRoutes {
  github: ProviderEventRouteSnapshot;
  githubRejected: ProviderEventRouteSnapshot;
  githubOther: ProviderEventRouteSnapshot;
}

async function seedGithubCases(database: Database, seed: SeedReceipt, sender: SenderFilter) {
  const github = {
    ...(await createRevision(database, "github.issue_created", sender)),
    connectionId: CONNECTION_ID,
    resourceId: "1",
  };
  const githubRejected = {
    ...(await createRevision(database, "github.issue_created", sender, { required: true })),
    connectionId: CONNECTION_ID,
    resourceId: "1",
  };
  const githubOther = {
    ...(await createRevision(database, "github.issue_created", { from_users: ["another"] })),
    connectionId: CONNECTION_ID,
    resourceId: "1",
  };
  const routes = { github, githubRejected, githubOther };
  const githubCases = await Promise.all([
    ...seedGithubMatchCases(seed, routes),
    ...seedGithubRevisionCases(seed, routes),
    ...seedGithubDropCases(seed, routes),
  ]);
  await createRevision(database, "github.pull_request_created", sender, {
    projectId: github.projectId,
  });

  return githubCases;
}

const githubBase = { provider: "github", source: "github.issues", repo: "owner/repo" } as const;

function seedGithubMatchCases(
  seed: SeedReceipt,
  { github, githubRejected, githubOther }: GithubRoutes,
) {
  return [
    seed({
      ...githubBase,
      key: "github-accepted",
      payload: githubBody("github-accepted"),
      route: github,
      references: [{}],
      disposition: "eligible",
    }),
    seed({
      ...githubBase,
      key: "github-rejected",
      payload: githubBody("github-rejected"),
      route: githubRejected,
      references: [{ outcome: "rejected" }],
      disposition: "eligible",
    }),
    seed({
      ...githubBase,
      key: "github-wrong-outcome",
      payload: githubBody("github-wrong-outcome"),
      route: githubRejected,
      references: [{}],
      disposition: "fan_out_unresolved",
    }),
    seed({
      ...githubBase,
      key: "github-zero",
      payload: githubBody("github-zero"),
      route: githubOther,
      droppedReason: "trigger_filters_rejected",
      disposition: "eligible",
    }),
    seed({
      ...githubBase,
      key: "github-partial",
      payload: githubBody("github-partial"),
      route: githubOther,
      additionalRoutes: [github],
      droppedReason: "trigger_filters_rejected",
      disposition: "fan_out_unresolved",
    }),
    seed({
      ...githubBase,
      key: "github-expiring-sibling",
      payload: githubBody("github-expiring-sibling"),
      route: github,
      additionalRoutes: [githubRejected],
      references: [{}, { route: githubRejected, state: "expiring", outcome: "rejected" }],
      disposition: "run_payload_pending",
    }),
  ];
}

function seedGithubRevisionCases(
  seed: SeedReceipt,
  { github, githubRejected, githubOther }: GithubRoutes,
) {
  return [
    seed({
      ...githubBase,
      key: "github-young-sibling",
      payload: githubBody("github-young-sibling"),
      route: github,
      additionalRoutes: [githubRejected],
      references: [{}, { route: githubRejected, state: "intact", outcome: "rejected" }],
      disposition: "run_payload_pending",
    }),
    seed({
      ...githubBase,
      key: "github-extra-branch",
      payload: githubBody("github-extra-branch"),
      route: github,
      references: [{}, { name: "extra" }],
      disposition: "fan_out_unresolved",
    }),
    seed({
      ...githubBase,
      key: "github-missing-revision",
      payload: githubBody("github-missing-revision"),
      route: { ...github, configurationRevisionId: randomUUID() },
      disposition: "fan_out_unresolved",
    }),
    seed({
      ...githubBase,
      key: "github-foreign-revision",
      payload: githubBody("github-foreign-revision"),
      route: { ...github, configurationRevisionId: githubOther.configurationRevisionId },
      disposition: "fan_out_unresolved",
    }),
    seed({
      ...githubBase,
      key: "github-cutoff",
      payload: githubBody("github-cutoff"),
      route: github,
      receivedAt: CUTOFF,
      references: [{}],
      disposition: "not_old_enough",
    }),
  ];
}

function seedGithubDropCases(seed: SeedReceipt, { github }: GithubRoutes) {
  return [
    seed({
      ...githubBase,
      key: "github-push",
      source: "github.push",
      payload: githubBody("github-push", "sender", "push"),
      route: github,
      droppedReason: "no_trigger_for_source",
      preRoutingDrop: "no_trigger_for_source",
      noRoutes: true,
      disposition: "push_sync_unproven",
    }),
    seed({
      ...githubBase,
      key: "github-unrouted",
      route: github,
      source: "github.unknown",
      payload: {},
      droppedReason: "no_trigger_for_source",
      preRoutingDrop: "no_trigger_for_source",
      noRoutes: true,
      disposition: "eligible",
    }),
    seed({
      ...githubBase,
      key: "github-legacy-unrouted",
      route: github,
      payload: {},
      noRoutes: true,
      droppedReason: "no_project_route",
      disposition: "eligible",
    }),
    seed({
      ...githubBase,
      key: "github-legacy-binding-missing",
      route: { ...github, connectionId: randomUUID() },
      payload: {},
      noRoutes: true,
      droppedReason: "no_project_route",
      disposition: "drop_unproven",
    }),
    seed({
      ...githubBase,
      key: "github-drop-unproven",
      source: "github.unknown",
      route: github,
      payload: {},
      droppedReason: "no_trigger_for_source",
      noRoutes: true,
      disposition: "drop_unproven",
    }),
  ];
}

async function seedLinearCases(database: Database, seed: SeedReceipt, sender: SenderFilter) {
  const linear = {
    ...(await createRevision(database, "linear.issue_assigned", sender)),
    connectionId: CONNECTION_ID,
    resourceId: "linear-project",
  };
  const issue = {
    id: "issue",
    title: "Title",
    description: null,
    projectId: "linear-project",
    stateId: "open",
    assigneeId: "user",
    labelIds: [],
  };
  const linearBody = {
    type: "issue",
    id: "issue",
    action: "update",
    organizationId: "linear-org",
    actor: { id: "sender" },
    issue,
    updatedFrom: { assigneeId: null },
  };
  return Promise.all([
    seed({
      key: "linear",
      provider: "linear",
      source: "linear.issue",
      route: linear,
      payload: linearBody,
      references: [{}],
      disposition: "eligible",
    }),
    seed({
      key: "linear-delegate",
      provider: "linear",
      source: "linear.issue",
      route: linear,
      payload: {
        ...linearBody,
        issue: { ...issue, delegateId: "bot" },
        updatedFrom: { delegateId: null },
      },
      disposition: "match_evidence_missing",
    }),
  ]);
}

async function seedManualCases(database: Database, seed: SeedReceipt, sender: SenderFilter) {
  const triggerId = randomUUID();
  const manual = await createRevision(database, "manual.run", sender, { triggerId });
  const manualFilter = await createRevision(
    database,
    "manual.run",
    { ...sender, inputs: { required: "go" } },
    { required: true, triggerId },
  );
  const missingSigner = await createRevision(database, "manual.run", sender);
  const manualBody = { trigger: "target", actor: "sender", input: "body" };
  const identity = {
    ...manualBody,
    authenticatedBy: { kind: "api-key", boundActor: "sender", credentialId: "key" },
  };
  const bearer = (route: ProviderEventRouteSnapshot, key: string) =>
    bearerWebhookDeliveryId(MATRIX_ORG, route.projectId, "target", key);
  const digest = "a".repeat(64);
  const signedId = signedWebhookDeliveryId(MATRIX_ORG, "key", digest);
  const signedBody = { ...identity, publicDeliveryKey: "github-sha256:" + digest };
  const cases = manualCaseInputs({
    manual,
    manualFilter,
    manualBody,
    identity,
    bearer,
    missingSigner,
    digest,
    signedId,
    signedBody,
  });
  const seeded = [];
  for (const input of cases) seeded.push(await seed(input));
  return seeded;
}

interface ManualBody {
  trigger: string;
  actor: string;
  input: string;
}
interface ManualIdentity extends ManualBody {
  authenticatedBy: { kind: string; boundActor: string; credentialId: string };
}
interface ManualCaseInputs {
  manual: ProviderEventRouteSnapshot;
  manualFilter: ProviderEventRouteSnapshot;
  missingSigner: ProviderEventRouteSnapshot;
  manualBody: ManualBody;
  identity: ManualIdentity;
  bearer: (route: ProviderEventRouteSnapshot, key: string) => string;
  digest: string;
  signedId: string;
  signedBody: ManualIdentity & { publicDeliveryKey: string };
}

function* manualCaseInputs(options: ManualCaseInputs): Generator<SeedInput> {
  yield* manualTriggerInputs(options);
  yield* bearerInputs(options);
  yield* signedAndChatInputs(options);
}

function* manualTriggerInputs({ manual, manualBody }: ManualCaseInputs): Generator<SeedInput> {
  yield {
    key: "manual",
    provider: "manual",
    source: "manual.run",
    route: manual,
    payload: manualBody,
    references: [{}],
    disposition: "eligible",
  };
  yield {
    key: "manual-orphan",
    provider: "manual",
    source: "manual.run",
    route: manual,
    payload: manualBody,
    disposition: "pending_admission",
  };
  yield {
    key: "manual-synthetic",
    provider: "manual",
    source: "discord.mention",
    route: manual,
    payload: manualBody,
    disposition: "unknown_shape",
  };
}

function* bearerInputs({
  manual,
  manualFilter,
  identity,
  bearer,
}: ManualCaseInputs): Generator<SeedInput> {
  yield {
    key: "bearer",
    provider: "manual",
    source: "webhook.received",
    route: manual,
    deliveryId: bearer(manual, "bearer-key"),
    payload: { ...identity, publicDeliveryKey: "bearer-key" },
    references: [{}],
    disposition: "eligible",
  };
  yield {
    key: "bearer-pending",
    provider: "manual",
    source: "webhook.received",
    route: manual,
    deliveryId: bearer(manual, "pending-key"),
    payload: { ...identity, publicDeliveryKey: "pending-key" },
    disposition: "pending_admission",
  };
  yield {
    key: "bearer-filtered",
    provider: "manual",
    source: "webhook.received",
    route: manualFilter,
    deliveryId: bearer(manualFilter, "filter-key"),
    payload: {
      ...identity,
      publicDeliveryKey: "filter-key",
      input: { message: "body", required: "skip" },
    },
    droppedReason: "trigger_filters_rejected",
    disposition: "eligible",
  };
}

function* signedAndChatInputs({
  manual,
  missingSigner,
  identity,
  digest,
  signedId,
  signedBody,
}: ManualCaseInputs): Generator<SeedInput> {
  yield {
    key: "signed",
    provider: "manual",
    source: "webhook.received",
    route: manual,
    deliveryId: signedId,
    payload: signedBody,
    references: [{}],
    disposition: "eligible",
  };
  yield {
    key: "signed-unproved",
    provider: "manual",
    source: "webhook.received",
    route: missingSigner,
    deliveryId: signedWebhookDeliveryId(MATRIX_ORG, "other", digest),
    payload: {
      ...signedBody,
      authenticatedBy: { ...identity.authenticatedBy, credentialId: "other" },
    },
    references: [{}],
    disposition: "drop_unproven",
  };
  yield {
    key: "slack",
    provider: "slack",
    source: "slack.mention",
    route: manual,
    payload: {},
    disposition: "match_evidence_missing",
  };
  yield {
    key: "discord",
    provider: "discord",
    source: "discord.mention",
    route: manual,
    payload: {},
    disposition: "match_evidence_missing",
  };
}

async function seedRemainingCases(database: Database, seed: SeedReceipt) {
  const scheduleId = randomUUID();
  const schedule = await createRevision(database, "schedule.tick", undefined, {
    triggerId: scheduleId,
  });
  const notification = await createRevision(database, "github.notification");
  const tickPayload = (time: Date) => ({
    schedule: { trigger_id: scheduleId, scheduled_at: time.toISOString(), timezone: "UTC" },
  });
  const notificationPayload = notificationFixturePayload();
  return Promise.all([
    seed({
      key: "schedule",
      provider: "schedule",
      source: "schedule.tick",
      route: schedule,
      payload: tickPayload(OLD),
      deliveryId: `schedule:${scheduleId}:${OLD.toISOString()}`,
      references: [{}],
      disposition: "eligible",
    }),
    seed({
      key: "schedule-orphan",
      provider: "schedule",
      source: "schedule.tick",
      route: schedule,
      payload: tickPayload(NOW),
      deliveryId: `schedule:${scheduleId}:${NOW.toISOString()}`,
      disposition: "fan_out_unresolved",
    }),
    seed({
      key: "notification",
      provider: "github_notification",
      source: "github.notification",
      route: notification,
      repo: "owner/repo",
      payload: { github_notification: notificationPayload },
      deliveryId: notificationDeliveryId(notificationPayload),
      references: [{}],
      disposition: "eligible",
    }),
    seed({
      key: "notification-inconsistent",
      provider: "github_notification",
      source: "github.notification",
      route: notification,
      repo: "owner/repo",
      payload: { github_notification: { ...notificationPayload, updated_at: NOW.toISOString() } },
      references: [{}],
      disposition: "fan_out_unresolved",
    }),
  ]);
}

function notificationFixturePayload() {
  return {
    repo: "owner/repo",
    thread_id: "thread",
    subject_type: "PullRequest",
    title: "Private title",
    number: 1,
    html_url: "https://github.com/owner/repo/pull/1",
    reason: "mention",
    updated_at: OLD.toISOString(),
  };
}
