import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHubApplication } from "../app.js";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { TriggerDashboard, type TriggerDashboardOptions } from "./dashboard.js";
import { createManualRunProvider } from "./manual/provider.js";
import { OrganizationTriggerStore } from "./store.js";

const { getRequest, setResponseStatus, getApplication } = vi.hoisted(() => ({
  getRequest: vi.fn(() => new Request("https://hub.test", { method: "POST" })),
  setResponseStatus: vi.fn(),
  getApplication: vi.fn<() => Promise<{ triggerDashboard: TriggerDashboard }>>(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator: () => ({
      handler: (_rpc: unknown, handler: unknown) => ({ __executeServer: handler }),
    }),
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest, setResponseStatus }));
vi.mock("../server/runtime.js", () => ({ getApplication }));

type RunHandler = (request: { data: object }) => Promise<unknown>;
let runManualTrigger: RunHandler;

function isRunHandler(value: unknown): value is RunHandler {
  return typeof value === "function";
}

beforeAll(async () => {
  const split = "./functions.ts?tss-serverfn-split";
  const loaded: unknown = await import(split);
  if (typeof loaded !== "object" || loaded === null) throw new Error("Missing Start handlers");
  const handler: unknown = Reflect.get(loaded, "runManualTrigger_createServerFn_handler");
  if (!isRunHandler(handler)) throw new Error("Missing Run now server handler");
  runManualTrigger = handler;
});

const memberId = "member-1";
const organizationId = "org-1";
const email = "member@example.test";
const validator = acceptingAgentValidator();

function accountAuth(userId: string, accountEmail: string): AuthServer {
  return {
    handle: async () => new Response(),
    resources: async () => {
      throw new Error("unused");
    },
    resolveOrganizationAccess: async () => {
      throw new Error("unused");
    },
    resolveAccount: async () => ({
      account: { id: userId, name: "Member", email: accountEmail },
      session: { id: "session-1", activeOrganizationId: organizationId },
      isInstanceOperator: false,
    }),
    rejectCookieMutation: () => undefined,
    close: async () => {},
  };
}

function harness() {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: memberId,
        organizationId,
        organizationSlug: "acme",
        organizationName: "Acme",
        membershipId: "membership-1",
        role: "member",
      },
    ],
  });
  const application = createHubApplication({
    database,
    publicApi: { status: "unavailable" },
    entitlements: createUnlimitedEntitlementsService(),
  });
  return { database, application };
}

function triggerYaml(options: { actor?: string; script?: boolean; scheduled?: boolean }) {
  const event = options.scheduled
    ? "  schedule.tick:\n    recurrence: { start: '2099-01-01T00:00:00', rule: FREQ=DAILY, timezone: UTC }"
    : `  manual.run:\n    filters: { from_users: [${JSON.stringify(options.actor ?? "*")}] }`;
  const action = options.script
    ? "  script: printf ok"
    : "  agent: { provider: codex, mode: full-access }\n  prompt: Run it";
  return `name: manual-task\non:\n${event}\ninputs:\n  count: { type: number }\nrun:\n  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }\n${action}\n`;
}

describe("Run now", () => {
  let hub: ReturnType<typeof harness>;

  beforeEach(async () => {
    hub = harness();
    useAccount(memberId, email);
    setResponseStatus.mockClear();
    await hub.application.hub.start();
  });

  afterEach(async () => {
    await hub.application.hub.stop();
  });

  function useAccount(userId: string, accountEmail: string, options?: TriggerDashboardOptions) {
    const triggerDashboard = new TriggerDashboard(
      hub.database,
      accountAuth(userId, accountEmail),
      validator,
      {
        dispatchManualRun: hub.application.hub.dispatchManualRun,
        ...options,
      },
    );
    getApplication.mockResolvedValue({ triggerDashboard });
  }

  async function save(options: Parameters<typeof triggerYaml>[0] & { organization?: string } = {}) {
    const org = options.organization ?? organizationId;
    await enrollTestDaemon(hub.database, org);
    return new OrganizationTriggerStore(hub.database, org, validator).save({
      yaml: triggerYaml(options),
      userId: memberId,
    });
  }

  function run(triggerId: string, data: { deliveryKey?: string; input?: unknown } = {}) {
    return runManualTrigger({
      data: { organizationSlug: "acme", triggerId, deliveryKey: randomUUID(), ...data },
    });
  }

  it.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ])("checks browser email when mail is %s and verification is %s", async (mail, verified) => {
    const query = vi
      .fn<NonNullable<TriggerDashboardOptions["databaseQuery"]>["query"]>()
      .mockResolvedValue({
        rows: [{ email_verified: verified }],
        rowCount: 1,
      });
    useAccount(memberId, email, {
      verifiedActorEmailRequired: mail,
      databaseQuery: { query },
    });
    const trigger = await save({ actor: email });
    const deliveryKey = randomUUID();
    const result = await run(trigger.id, { deliveryKey });
    const hash = createHash("sha256")
      .update(
        [organizationId, trigger.runtimeProjectId, deliveryKey, memberId]
          .map((part) => JSON.stringify(part))
          .join(":"),
      )
      .digest("base64url");
    const receipt = await hub.database.findProviderEventReceiptByDeliveryId(
      `browser-manual-${hash}`,
      organizationId,
    );
    expect(query).toHaveBeenCalledTimes(mail ? 1 : 0);
    if (mail)
      expect(query).toHaveBeenCalledWith(expect.stringContaining("email_verified"), [
        memberId,
        email,
      ]);
    if (mail && !verified) {
      expect(result).toStrictEqual({
        status: "error",
        error: { code: "actor_forbidden", message: "Verify your email to run this trigger." },
      });
      expect(setResponseStatus).toHaveBeenCalledWith(403);
      expect(receipt).toBeUndefined();
    } else {
      expect(result).toMatchObject({ status: "ok" });
      expect(receipt).toBeDefined();
    }
  });

  it.each([
    ["*", email],
    [email, email],
    [email, "MEMBER@Example.Test"],
  ])("allows %s for %s and attributes one run per delivery", async (actor, accountEmail) => {
    useAccount(memberId, accountEmail);
    const trigger = await save({ actor });
    const deliveryKey = randomUUID();
    const result = await run(trigger.id, { deliveryKey });
    const duplicate = await run(trigger.id, { deliveryKey });
    const runs = await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10);
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;
    expect(result).toStrictEqual({ status: "ok", data: { runId } });
    expect(duplicate).toStrictEqual(result);
    expect(await hub.database.findTriggerRunForOrganization(organizationId, runId)).toMatchObject({
      startedByUserId: memberId,
      triggerContext: { event: { manual: { actor: email } } },
    });
  });

  it.each([
    [{ actor: "someone-else" }, "actor_forbidden", "This trigger doesn't allow your account."],
    [
      { actor: "script-key", script: true },
      "key_actor_required",
      "This trigger requires an API key with a bound actor.",
    ],
  ] as const)("denies unauthorized runs for %j", async (options, code, message) => {
    const trigger = await save(options);
    expect(await run(trigger.id)).toStrictEqual({ status: "error", error: { code, message } });
    expect(setResponseStatus).toHaveBeenCalledWith(403);
    expect(await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10)).toEqual([]);
  });

  it.each(["other organization", "scheduled trigger", "non-member"])(
    "returns not found for %s",
    async (reason) => {
      const organization = reason === "other organization" ? "org-2" : organizationId;
      const trigger = await save({ organization, scheduled: reason === "scheduled trigger" });
      if (reason === "non-member") useAccount("outsider", email);
      expect(await run(trigger.id)).toStrictEqual({
        status: "error",
        error: { code: "trigger_not_found", message: "This trigger is unavailable." },
      });
      expect(setResponseStatus).toHaveBeenCalledWith(404);
    },
  );

  it("returns issues for invalid typed input without creating a run", async () => {
    const trigger = await save();
    expect(await run(trigger.id, { input: { count: "many" } })).toStrictEqual({
      status: "error",
      error: {
        code: "invalid_input",
        message: "Check the trigger inputs and try again.",
        issues: [{ path: ["input", "count"], message: "input count must be a number" }],
      },
    });
    expect(setResponseStatus).toHaveBeenCalledWith(422);
    expect(await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10)).toEqual([]);
  });

  it.each([
    [email, "cli-credential", email, true],
    [email, "cli-credential", null, false],
    [email, "api-key", email, false],
    [email, undefined, null, false],
    ["legacy-actor", undefined, null, true],
  ] as const)(
    "authorizes persisted actor %s with %s authentication bound to %s",
    async (actor, kind, boundActor, allowed) => {
      const trigger = await save({ actor });
      const projectId = trigger.runtimeProjectId;
      const revision = await hub.database.findActiveProjectConfiguration(projectId);
      expect(revision).toBeDefined();
      const provider = createManualRunProvider((id) => hub.application.configurationForProject(id));
      const event = {
        providerEventReceiptId: randomUUID(),
        organizationId,
        projectId,
        configurationRevisionId: revision!.id,
        source: "manual.run",
        deliveryId: randomUUID(),
        receivedAt: new Date(),
        payload: {
          trigger: trigger.name,
          actor,
          input: "",
          ...(kind === undefined
            ? {}
            : { authenticatedBy: { kind, credentialId: "credential", boundActor } }),
        },
      };
      if (allowed) {
        await expect(provider.match(event)).resolves.toHaveLength(1);
        return;
      }
      await expect(provider.match(event)).rejects.toMatchObject({ code: "actor_forbidden" });
      await expect(
        provider.match({
          ...event,
          manualRetryAuthorization: {
            actor: email,
            authenticatedBy: { kind: "browser-session", credentialId: memberId, boundActor: null },
          },
        }),
      ).rejects.toMatchObject({ code: "actor_forbidden" });
    },
  );
});
