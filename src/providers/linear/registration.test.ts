import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OrganizationAccessValue } from "../../auth/organization-access.js";
import type { AuthServer } from "../../auth/server.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { StartConnectionAttemptInput } from "../../db/types.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../../triggers/index.js";
import type { LinearApiClient, LinearConnectionClient } from "./client.js";
import { createLinearRegistration } from "./index.js";

describe("Linear registration", () => {
  it("constructs the complete Linear slice and starts OAuth with a protected state", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user",
          organizationId: "org",
          organizationName: "Org",
          organizationSlug: "org",
          membershipId: "membership",
          role: "owner",
        },
      ],
    });
    let attempt: StartConnectionAttemptInput | undefined;
    database.startConnectionAttempt = (input) => {
      attempt = input;
      return Promise.resolve();
    };
    const registration = createLinearRegistration({
      database,
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
      connectionClient: new LinearConnectionFake(),
    });

    assert.equal(registration.connection.name, "linear");
    assert.equal(registration.progressProvider?.name, "linear");
    assert.equal(registration.sources.length, 1);
    assert.equal(registration.triggerProviders.length, 1);
    assert.deepEqual(
      registration.outputs.map((output) => output.type),
      ["linear.reply"],
    );
    assert.deepEqual(
      registration.requests.map((request) => request.name),
      ["linear.events"],
    );

    const response = await registration.connection.actions["start"]!(
      new Request("https://hub.test/start?organizationSlug=org", { method: "POST" }),
    );
    assert.equal(response.status, 200);
    assert.equal(attempt?.provider, "linear");
    assert.equal(attempt?.providerApplicationId, "client");
    assert.deepEqual(attempt?.configurationSnapshot, {
      provider: "linear",
      ...linearConfiguration(),
    });
    const body = z.object({ url: z.string() }).parse(await response.json());
    const state = new URL(body.url).searchParams.get("state");
    assert(state !== null && state.length > 20);
    assert.notEqual(attempt?.stateVerifier, state);
  });

  it("does not construct partial behavior when Linear is not configured", () => {
    const registration = createLinearRegistration({
      database: createMemoryDatabase(),
      auth: new RegistrationAuth(),
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: null,
    });

    assert.deepEqual(
      registration.connection.status({ github: [], discord: [], slack: [], linear: [] }),
      { status: "notConfigured" },
    );
    assert.equal(registration.progressProvider, undefined);
    assert.deepEqual(registration.sources, []);
    assert.deepEqual(registration.outputs, []);
    assert.deepEqual(registration.requests, []);
  });

  it("rejects an insecure direct connection start before auth or attempt persistence", async () => {
    const database = createMemoryDatabase();
    let attempts = 0;
    database.startConnectionAttempt = () => {
      attempts += 1;
      return Promise.resolve();
    };
    const auth = new RegistrationAuth();
    const registration = createLinearRegistration({
      database,
      auth,
      applicationBaseUrl: "http://hub.test",
      publicBaseUrl: "http://hub.test",
      configuration: linearConfiguration(),
      connectionClient: new LinearConnectionFake(),
    });

    const response = await registration.connection.actions["start"]!(
      new Request("http://hub.test/start?organizationSlug=org", { method: "POST" }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "https_required" });
    assert.equal(attempts, 0);
    assert.equal(auth.cookieMutationChecks, 0);
    assert.equal(auth.organizationAccessReads, 0);
  });

  it("requires reconnection for missing authority or an expired non-refreshable token", () => {
    const registration = createLinearRegistration({
      database: createMemoryDatabase(),
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
    });

    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [
          {
            id: "linear-connection",
            organizationId: "org",
            slug: "acme-linear",
            providerApplicationId: "client",
            linearOrganizationId: "linear-org",
            linearOrganizationName: "Acme",
            appUserId: "app-user",
            accessToken: "token",
            refreshToken: "refresh-token",
            accessTokenExpiresAt: null,
            scopes: ["read"],
          },
        ],
      }),
      { status: "requiresReauthorization" },
    );

    const expired = {
      id: "linear-connection",
      organizationId: "org",
      slug: "acme-linear",
      providerApplicationId: "client",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: null,
      accessTokenExpiresAt: new Date(0),
      scopes: ["read", "comments:create", "app:assignable", "app:mentionable"],
    };
    assert.deepEqual(
      registration.connection.status({ github: [], discord: [], slack: [], linear: [expired] }),
      { status: "requiresReauthorization" },
    );
    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [{ ...expired, refreshToken: "refresh-token" }],
      }),
      { status: "connected" },
    );
    assert.deepEqual(
      registration.connection.status({
        github: [],
        discord: [],
        slack: [],
        linear: [
          { ...expired, scopes: ["read", "comments:create"], refreshToken: "refresh-token" },
        ],
      }),
      { status: "requiresReauthorization" },
    );
  });

  it("deduplicates a repeated delegated webhook delivery into one run", async () => {
    const database = createMemoryDatabase();
    database.findLinearConnection = async () => ({
      id: "linear-connection",
      organizationId: "org",
      slug: "workspace",
      providerApplicationId: "client",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Workspace",
      appUserId: "installed-app",
      accessToken: "token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: null,
      scopes: ["read", "comments:create", "app:assignable", "app:mentionable"],
    });
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      {
        environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
        triggers: [
          {
            name: "assignment",
            on: "linear.issue_assigned",
            max_runtime: "1h",
            filters: { project: "linear-project", from_users: ["operator"] },
            steps: [
              {
                id: "work",
                environment: "runner",
                max_runtime: "1h",
                idle_timeout: "5m",
                agent: { provider: "codex" },
                prompt: [{ text: "Work from ${{ paseo.context }}" }],
              },
            ],
          },
        ],
      },
      { organizationId: "org" },
    );
    await database.activateProjectConfigurationRevision(project.id, revision.id, [
      {
        provider: "linear",
        connectionId: "linear-connection",
        resourceId: "linear-project",
        triggerName: "assignment",
      },
    ]);
    const registration = createLinearRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
    });
    const provider = registration.triggerProviders[0]!({
      configurationStoreForProject: () => store,
      connectionsForProject: () => () => {
        throw new Error("delegation must not resolve configuration connection values");
      },
    });
    assert(provider !== undefined);
    const runs: Array<{ id: string; created: boolean; receiptId: string; prompt: string }> = [];
    await registration.sources[0]!.start(async (event) => {
      const matches = await provider.match(event);
      assert.notEqual(typeof matches, "string");
      if (typeof matches === "string") throw new Error(matches);
      for (const match of matches) {
        if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected an accepted match");
        const accepted = await database.createAcceptedTriggerRun({
          organizationId: event.organizationId,
          projectId: event.projectId,
          configurationRevisionId: event.configurationRevisionId,
          providerEventReceiptId: event.providerEventReceiptId,
          configuredTriggerName: match.triggerName,
          prompt: match.invocation.prompt,
          inputs: match.invocation.inputs,
          triggerContext: match.triggerContext,
          outputContext: match.outputContext,
          deadlineAt: new Date(Date.now() + 3_600_000),
          stepIds: ["work"],
        });
        runs.push({
          id: accepted.run.id,
          created: accepted.created,
          receiptId: event.providerEventReceiptId,
          prompt: accepted.run.prompt,
        });
      }
    });
    const endpoint = registration.requests[0]!;
    assert.equal((await endpoint.handle(delegatedIssueRequest("Original issue"))).status, 200);
    assert.equal((await endpoint.handle(delegatedIssueRequest("Changed retry body"))).status, 200);
    assert.equal(runs.length, 2);
    assert.deepEqual(
      runs.map((run) => run.created),
      [true, false],
    );
    assert.equal(runs[0]?.id, runs[1]?.id);
    assert.equal(runs[0]?.receiptId, runs[1]?.receiptId);
    assert.deepEqual(
      runs.map((run) => run.prompt),
      ["Original issue", "Original issue"],
    );
    await registration.sources[0]!.stop();
  });

  it("drops an under-scoped compact event before attempting issue hydration", async () => {
    const database = createMemoryDatabase();
    database.findLinearConnection = async (linearOrganizationId) =>
      linearOrganizationId === "linear-org"
        ? {
            id: "linear-connection",
            organizationId: "org",
            slug: "acme-linear",
            providerApplicationId: "client",
            linearOrganizationId,
            linearOrganizationName: "Acme",
            appUserId: "app-user",
            accessToken: "under-scoped-token",
            refreshToken: "refresh-token",
            accessTokenExpiresAt: null,
            scopes: ["comments:create"],
          }
        : undefined;
    let accepts = 0;
    let acceptedProjectId: string | undefined;
    database.acceptLinearEvent = async (input) => {
      accepts += 1;
      acceptedProjectId = input.projectId;
      return {
        status: "dropped",
        receiptId: input.deliveryId,
        reason: "configuration_unavailable",
      };
    };
    let issueReads = 0;
    const apiClient: LinearApiClient = {
      readIssue: async () => {
        issueReads += 1;
        throw new Error("under-scoped token must not hydrate");
      },
      readIssueComments: async () => ({ comments: [], complete: true }),
      readComment: async () => null,
      createComment: async () => "comment-id",
      updateComment: async () => {},
    };
    const registration = createLinearRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: linearConfiguration(),
      apiClient,
    });

    const response = await registration.requests[0]!.handle(linearCommentRequest());

    assert.equal(response.status, 200);
    assert.equal(issueReads, 0);
    assert.equal(accepts, 1);
    assert.equal(acceptedProjectId, undefined);
  });
});

function linearConfiguration() {
  return { clientId: "client", clientSecret: "secret", webhookSecret: "webhook-secret" };
}

function delegatedIssueRequest(title: string): Request {
  const body = JSON.stringify({
    action: "update",
    type: "Issue",
    organizationId: "linear-org",
    actor: { id: "operator" },
    webhookTimestamp: Date.now(),
    data: {
      id: "issue",
      title,
      projectId: "linear-project",
      assigneeId: null,
      delegate: { id: "installed-app" },
    },
    updatedFrom: { delegateId: null },
  });
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": "delegated-delivery",
      "linear-event": "Issue",
      "linear-signature": createHmac("sha256", linearConfiguration().webhookSecret)
        .update(body)
        .digest("hex"),
    },
    body,
  });
}

function linearCommentRequest(): Request {
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: "linear-org",
    webhookTimestamp: Date.now(),
    data: { id: "comment-1", issueId: "issue-1", body: "Please investigate" },
  });
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": "under-scoped-compact-comment",
      "linear-event": "Comment",
      "linear-signature": createHmac("sha256", linearConfiguration().webhookSecret)
        .update(body)
        .digest("hex"),
    },
    body,
  });
}

class LinearConnectionFake implements LinearConnectionClient {
  authorizationUrl(state: string): string {
    return `https://linear.test/oauth?state=${state}`;
  }

  exchangeCode(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  refresh(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }
}

class RegistrationAuth implements AuthServer {
  cookieMutationChecks = 0;
  organizationAccessReads = 0;

  handle(): Promise<Response> {
    return Promise.resolve(new Response());
  }

  resources(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  resolveOrganizationAccess(): Promise<OrganizationAccessValue> {
    this.organizationAccessReads += 1;
    return Promise.resolve({
      session: { id: "session" },
      account: { id: "user", name: "User", email: "user@example.test" },
      organization: { id: "org", name: "Org" },
      membership: { id: "membership", role: "owner" },
      capabilities: { view: true, manageMembers: true, manageOwners: true, manageResources: true },
    });
  }

  async resolveAccount() {
    const access = await this.resolveOrganizationAccess();
    return {
      session: { id: access.session.id, activeOrganizationId: null },
      account: access.account,
      isInstanceOperator: false,
    };
  }

  rejectCookieMutation(): Response | undefined {
    this.cookieMutationChecks += 1;
    return undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
