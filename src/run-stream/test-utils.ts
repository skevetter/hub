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
  let runtime: DatabaseRuntime | undefined;
  let database: Database;
  let credentials: OperationAuthenticator;
  let apiKeys: OrganizationApiKeys | undefined;
  let cliCredentials: OrganizationCliCredentials | undefined;
  const cleanup: (() => Promise<unknown>)[] = [];
  const memberships = [
    {
      userId: "stream-member",
      organizationId: ORGANIZATION,
      organizationName: "Stream",
      organizationSlug: "stream",
      membershipId: "stream-member-row",
      role: "member" as const,
    },
  ];
  if (backend === "memory") {
    database = createMemoryDatabase({ organizationIds: [ORGANIZATION, FOREIGN], memberships });
    credentials = {
      authorize: async (request, scope) => {
        assert.equal(scope, "runs:read");
        return request.headers.get("authorization") === "Bearer synthetic-key"
          ? { status: "authorized", access }
          : { status: "unauthorized" };
      },
      reauthorize: async () => true,
    };
  } else {
    const bundle =
      backend === "embedded"
        ? await (async () => {
            const root = await mkdtemp(join(tmpdir(), "hub-run-stream-"));
            cleanup.push(() => rm(root, { recursive: true, force: true }));
            return embeddedDatabaseRuntime(join(root, "database"));
          })()
        : await (async () => {
            const container = await new PostgreSqlContainer("postgres:17-alpine").start();
            cleanup.push(() => container.stop());
            return postgresDatabaseRuntime(container.getConnectionUri(), { max: 8 });
          })();
    runtime = bundle.runtime;
    cleanup.push(() => bundle.runtime.close());
    await runtime.migrate();
    for (const sql of [
      `insert into organization (id, name, slug) values
       ('stream-organization', 'Stream', 'stream'), ('foreign-organization', 'Foreign', 'foreign')`,
      `insert into "user" (id, name, email) values
       ('stream-member', 'Member', 'member@stream.test'), ('stream-owner', 'Owner', 'owner@stream.test')`,
      `insert into member (id, organization_id, user_id, role) values
       ('stream-member-row', 'stream-organization', 'stream-member', 'member'),
       ('stream-owner-row', 'stream-organization', 'stream-owner', 'owner')`,
    ])
      await runtime.query(sql);
    database = createDatabase(runtime, bundle.locks);
    apiKeys = new OrganizationApiKeys(runtime, bundle.locks);
    cliCredentials = new OrganizationCliCredentials(runtime);
    credentials = new PublicCredentialAuthenticator(apiKeys, cliCredentials);
  }
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
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Stream",
    slug: "stream-project",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "stream-test",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
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
  const streams: RunStream[] = [];
  const stream = (
    overrides: Partial<RunProgressSettings> = {},
    overridesCredentials = credentials,
    overridesDatabase = database,
  ) => {
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
  const key =
    backend === "memory"
      ? "synthetic-key"
      : (await apiKeys!.create(ORGANIZATION, "stream-owner", "reader", ["runs:read"])).secret;
  return {
    database,
    runtime,
    auth,
    credentials,
    apiKeys,
    cliCredentials,
    bus,
    timeline,
    reconciler,
    stream,
    key,
    setSessionActive(value: boolean) {
      sessionActive = value;
    },
    async removeMember() {
      if (runtime) await runtime.query("delete from member where id = 'stream-member-row'");
      else memberships.splice(0);
    },
    async createRun(stepIds = ["work"], organizationId = ORGANIZATION) {
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
    },
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
    async close() {
      for (const service of streams) {
        await service.beginShutdown();
        assert.equal(service.activeStreamCount(), 0);
        assert.equal(service.notifierCount(), 0);
      }
      reconciler.stopAdmission();
      await timeline.stop();
      await reconciler.stop();
      for (const action of cleanup.toReversed()) await action();
    },
  };
}

export function streamRequest(
  runId: string,
  key = "synthetic-key",
  query = "",
  headers: Record<string, string> = {},
  signal?: AbortSignal,
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
      assert.notEqual(frame, undefined, `Stream ended before ${kind}`);
      if (!frame!.includes(`event: ${kind}\n`)) continue;
      const data = frame!
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6);
      return { frame: frame!, data: z.record(z.string(), z.unknown()).parse(JSON.parse(data)) };
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
