import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { z } from "zod";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../db/runtime/index.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import type { AuthServer } from "../auth/server.js";
import { OrganizationApiKeys, type OperationAuthorization } from "../auth/api-keys.js";
import { cliCredentialParts, OrganizationCliCredentials } from "../auth/cli-credentials.js";
import { PublicCredentialAuthenticator } from "../auth/public-credentials.js";
import { ProductRequestError } from "../auth/organization-access.js";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { readRunProgressSettings, type RunProgressSettings } from "../run-progress/settings.js";
import { RunTimelineBus } from "../run-timeline/bus.js";
import { RunTimeline } from "../run-timeline/index.js";
import { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { RunStream } from "./index.js";

export const ORGANIZATION = "stream-organization";
export const FOREIGN = "foreign-organization";
export const settings = readRunProgressSettings({
  PASEO_HUB_RUN_TIMELINE: "true",
  PASEO_HUB_RUN_STREAM: "true",
});
export const access: OperationAuthorization = {
  kind: "apiKey",
  credentialId: "synthetic-key",
  organizationId: ORGANIZATION,
  scopes: ["runs:read"],
};

export interface StreamHarness {
  database: Database;
  runtime: DatabaseRuntime | undefined;
  auth: AuthServer;
  credentials: OperationAuthenticator;
  apiKeys: OrganizationApiKeys | undefined;
  cliCredentials: OrganizationCliCredentials | undefined;
  bus: RunTimelineBus;
  timeline: RunTimeline;
  reconciler: RunTimelineReconciler;
  key: string;
  stream(
    settings?: Partial<RunProgressSettings>,
    credentials?: OperationAuthenticator,
    database?: Database,
  ): RunStream;
  setSessionActive(value: boolean): void;
  removeMember(): Promise<void>;
  createRun(stepIds?: string[], organizationId?: string): Promise<AcceptedTriggerRunRecord>;
  append(runId: string, kind?: "turn_started" | "turn_ended"): Promise<number>;
  cli(): Promise<{ id: string; token: string }>;
  close(): Promise<void>;
}

export async function createStreamHarness(
  backend: "memory" | "embedded" | "pooled",
): Promise<StreamHarness> {
  const cleanup: (() => Promise<unknown>)[] = [];
  const memberships = streamMemberships();
  let storage: StreamStorage;
  if (backend === "memory") {
    storage = memoryStreamStorage(memberships);
  } else {
    const bundle =
      backend === "embedded"
        ? await embeddedStreamBundle(cleanup)
        : await pooledStreamBundle(cleanup);
    const { runtime } = bundle;
    cleanup.push(() => runtime.close());
    await runtime.migrate();
    for (const sql of streamSeedSql) await runtime.query(sql);
    storage = postgresStreamStorage(bundle);
  }
  const { database, credentials, apiKeys } = storage;
  const session = streamSession(credentials);
  const project = await createStreamProject(database);
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "stream-test",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const services = streamServices(database);
  const streams: RunStream[] = [];
  const stream = streamFactory({ ...storage, ...services, auth: session.auth, streams });
  const key = backend === "memory" ? "synthetic-key" : (await createReaderKey(apiKeys)).secret;
  return {
    database,
    runtime: storage.runtime,
    auth: session.auth,
    credentials,
    apiKeys,
    cliCredentials: storage.cliCredentials,
    ...services,
    stream,
    key,
    setSessionActive: session.setSessionActive,
    removeMember: memberRemover(storage.runtime, memberships),
    createRun: runCreator(database, project, revision),
    ...streamActions(database, storage.runtime),
    close: streamCloser({ ...services, streams, cleanup }),
  };
}

type StreamStorage = Pick<
  StreamHarness,
  "database" | "runtime" | "credentials" | "apiKeys" | "cliCredentials"
>;

function createStreamProject(database: Database) {
  return database.createProject({
    organizationId: ORGANIZATION,
    name: "Stream",
    slug: "stream-project",
    createdByUserId: null,
  });
}

function streamMemberships() {
  return [
    {
      userId: "stream-member",
      organizationId: ORGANIZATION,
      organizationName: "Stream",
      organizationSlug: "stream",
      membershipId: "stream-member-row",
      role: "member" as const,
    },
  ];
}

function memoryStreamStorage(memberships: ReturnType<typeof streamMemberships>): StreamStorage {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION, FOREIGN], memberships });
  const credentials: OperationAuthenticator = {
    authorize: async (request, scope) => {
      assert.equal(scope, "runs:read");
      return request.headers.get("authorization") === "Bearer synthetic-key"
        ? { status: "authorized", access }
        : { status: "unauthorized" };
    },
    reauthorize: async () => true,
  };
  return {
    database,
    credentials,
    runtime: undefined,
    apiKeys: undefined,
    cliCredentials: undefined,
  };
}

async function embeddedStreamBundle(cleanup: (() => Promise<unknown>)[]) {
  const root = await mkdtemp(join(tmpdir(), "hub-run-stream-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return embeddedDatabaseRuntime(join(root, "database"));
}

async function pooledStreamBundle(cleanup: (() => Promise<unknown>)[]) {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  cleanup.push(() => container.stop());
  return postgresDatabaseRuntime(container.getConnectionUri(), { max: 8 });
}

const streamSeedSql = [
  `insert into organization (id, name, slug) values
   ('stream-organization', 'Stream', 'stream'), ('foreign-organization', 'Foreign', 'foreign')`,
  `insert into "user" (id, name, email) values
   ('stream-member', 'Member', 'member@stream.test'), ('stream-owner', 'Owner', 'owner@stream.test')`,
  `insert into member (id, organization_id, user_id, role) values
   ('stream-member-row', 'stream-organization', 'stream-member', 'member'),
   ('stream-owner-row', 'stream-organization', 'stream-owner', 'owner')`,
];

function postgresStreamStorage({ runtime, locks }: DatabaseRuntimeBundle): StreamStorage {
  const database = createDatabase(runtime, locks);
  const apiKeys = new OrganizationApiKeys(runtime, locks);
  const cliCredentials = new OrganizationCliCredentials(runtime);
  const credentials = new PublicCredentialAuthenticator(apiKeys, cliCredentials);
  return { database, runtime, apiKeys, cliCredentials, credentials };
}

function createReaderKey(apiKeys: OrganizationApiKeys | undefined) {
  if (apiKeys === undefined) throw new Error("Stream API keys are missing");
  return apiKeys.create({
    organizationId: ORGANIZATION,
    createdByUserId: "stream-owner",
    name: "reader",
    scopes: ["runs:read"],
  });
}

function streamSession(credentials: OperationAuthenticator) {
  let sessionActive = true;
  const auth: AuthServer = {
    handle: async () => new Response(null, { status: 404 }),
    resolveAccount: async (request) => {
      if (!sessionActive || request.headers.get("cookie") !== "session=member")
        throw new ProductRequestError(401, "unauthenticated");
      return {
        account: { id: "stream-member", name: "Member", email: "member@stream.test" },
        session: { id: "session-member", activeOrganizationId: ORGANIZATION },
        isInstanceOperator: false,
      };
    },
    resolveOrganizationAccess: async () => {
      throw new Error("Not used by stream authentication");
    },
    resources: async () => {
      throw new Error("Not used by stream authentication");
    },
    rejectCookieMutation: () => undefined,
    close: async () => undefined,
    ...(credentials instanceof PublicCredentialAuthenticator
      ? { publicCredentials: credentials }
      : {}),
  };
  return {
    auth,
    setSessionActive: (value: boolean) => {
      sessionActive = value;
    },
  };
}

function streamServices(database: Database) {
  const bus = new RunTimelineBus({ maxSubscriptions: 2000 });
  const scrub = createTimelineScrubber({ scrubValues: ["synthetic-known-private-value"] });
  const timeline = new RunTimeline(database, { ...settings, maxEvents: 5000, scrub, bus });
  const reconciler = new RunTimelineReconciler(database, {
    ...settings,
    maxEvents: 5000,
    scrub,
    bus,
    queue: timeline,
  });
  return { bus, timeline, reconciler };
}

interface StreamFactoryOptions extends Pick<
  StreamHarness,
  "database" | "credentials" | "auth" | "bus" | "reconciler"
> {
  streams: RunStream[];
}

function streamFactory({
  database,
  credentials,
  auth,
  bus,
  reconciler,
  streams,
}: StreamFactoryOptions): StreamHarness["stream"] {
  return function stream(
    overrides: Partial<RunProgressSettings> = {},
    overridesCredentials = credentials,
    overridesDatabase = database,
  ) {
    const service = new RunStream({
      database: overridesDatabase,
      credentials: overridesCredentials,
      auth,
      bus,
      reconciler,
      settings: { ...settings, ...overrides },
      logger: { info: () => undefined },
    });
    streams.push(service);
    return service;
  };
}

function memberRemover(
  runtime: DatabaseRuntime | undefined,
  memberships: ReturnType<typeof streamMemberships>,
) {
  return async function removeMember() {
    if (runtime) await runtime.query("delete from member where id = 'stream-member-row'");
    else memberships.splice(0);
  };
}

function runCreator(
  database: Database,
  project: Pick<Awaited<ReturnType<Database["createProject"]>>, "id">,
  revision: Pick<Awaited<ReturnType<Database["insertProjectConfigurationRevision"]>>, "id">,
): StreamHarness["createRun"] {
  return async function createRun(stepIds = ["work"], organizationId = ORGANIZATION) {
    const selectedProject =
      organizationId === ORGANIZATION
        ? project
        : await database.createProject({
            organizationId,
            name: "Foreign run",
            slug: `foreign-${randomUUID()}`,
            createdByUserId: null,
          });
    const selectedRevision =
      organizationId === ORGANIZATION
        ? revision
        : await database.insertProjectConfigurationRevision({
            projectId: selectedProject.id,
            sourceKind: "manual",
            sourceEvidence: {},
            normalizedConfiguration: { environments: [], triggers: [] },
            contentHash: "foreign-stream",
          });
    if (organizationId !== ORGANIZATION)
      await database.activateProjectConfigurationRevision(
        selectedProject.id,
        selectedRevision.id,
        [],
      );
    const receipt = await database.persistManualEvent({
      organizationId,
      projectId: selectedProject.id,
      deliveryId: randomUUID(),
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") throw new Error("Receipt was not accepted");
    return (
      await database.createAcceptedTriggerRun({
        organizationId,
        projectId: selectedProject.id,
        configurationRevisionId: selectedRevision.id,
        providerEventReceiptId: receipt.event.providerEventReceiptId,
        configuredTriggerName: "stream",
        prompt: "",
        inputs: {},
        triggerContext: {},
        outputContext: {},
        deadlineAt: new Date(Date.now() + 3600000),
        stepIds,
      })
    ).run;
  };
}

function streamActions(database: Database, runtime: DatabaseRuntime | undefined) {
  return {
    async append(runId: string, kind: "turn_started" | "turn_ended" = "turn_started") {
      const result = await database.appendRunTimelineEvent({
        triggerRunId: runId,
        organizationId: ORGANIZATION,
        kind,
        origin: "captured",
        at: new Date(),
        data: {},
        maxEvents: 5000,
      });
      assert.ok(result && "seq" in result);
      return result.seq;
    },
    async cli() {
      assert.ok(runtime);
      const id = randomUUID();
      const token = `paseo_cli_${randomUUID().replaceAll("-", "").slice(0, 12)}_synthetic-only-${randomUUID()}`;
      const parts = cliCredentialParts(token);
      await runtime.query(
        `insert into organization_cli_credentials (id, organization_id, prefix, verifier, created_by_user_id) values ($1, $2, $3, $4, 'stream-owner')`,
        [id, ORGANIZATION, parts.prefix, parts.verifier],
      );
      return { id, token };
    },
  };
}

interface StreamCloserOptions extends Pick<StreamHarness, "timeline" | "reconciler"> {
  streams: RunStream[];
  cleanup: (() => Promise<unknown>)[];
}

function streamCloser({ streams, timeline, reconciler, cleanup }: StreamCloserOptions) {
  return async function close() {
    for (const service of streams) {
      await service.beginShutdown();
      assert.equal(service.activeStreamCount(), 0);
      assert.equal(service.notifierCount(), 0);
    }
    reconciler.stopAdmission();
    await timeline.stop();
    await reconciler.stop();
    for (const action of cleanup.toReversed()) await action();
  };
}

interface StreamRequestOptions {
  query?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function streamRequest(
  runId: string,
  key = "synthetic-key",
  { query = "", headers = {}, signal }: StreamRequestOptions = {},
) {
  return new Request(`http://localhost/api/v1/runs/${runId}/events${query}`, {
    headers: { authorization: `Bearer ${key}`, "x-request-id": "stream-request", ...headers },
    ...(signal ? { signal } : {}),
  });
}

export class StreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pending = "";
  text = "";
  constructor(response: Response) {
    assert.equal(response.status, 200);
    assert.ok(response.body);
    this.reader = response.body.getReader();
  }
  async frame(): Promise<string | undefined> {
    for (;;) {
      const end = this.pending.indexOf("\n\n");
      if (end >= 0) {
        const frame = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + 2);
        return frame;
      }
      const value = await this.reader.read();
      if (value.done) return undefined;
      const text = this.decoder.decode(value.value, { stream: true });
      this.text += text;
      this.pending += text;
    }
  }
  async event(kind: string) {
    for (;;) {
      const frame = await this.frame();
      if (frame === undefined) throw new Error(`Stream frame is missing for ${kind}`);
      if (!frame.includes(`event: ${kind}\n`)) continue;
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data === undefined) throw new Error(`Stream event data is missing for ${kind}`);
      return { frame, data: z.record(z.string(), z.unknown()).parse(JSON.parse(data.slice(6))) };
    }
  }
  async all(): Promise<string> {
    while ((await this.frame()) !== undefined) {}
    return this.text;
  }
  async cancel() {
    await this.reader.cancel();
  }
}
