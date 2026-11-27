import assert from "node:assert/strict";
import { describe, it, expect } from "vitest";
import {
  activateProviderApplicationsAtStartup,
  createProviderApplications,
  ProviderApplicationError,
  ProviderVerificationError,
  type ProviderApplicationStore,
  type ProviderRuntimeCandidate,
} from "./index.js";

const github = {
  provider: "github" as const,
  appId: "42",
  appSlug: "paseo",
  clientId: "client",
  clientSecret: "secret",
  privateKey: "key",
};
const identity = { provider: "github" as const, id: "42", name: "App", ownerLogin: "acme" };

function fixture() {
  const trace: string[] = [];
  const candidate: ProviderRuntimeCandidate = {
    start: () => Promise.resolve(void trace.push("start")),
    publish: () => void trace.push("publish"),
    close: () => Promise.resolve(void trace.push("close")),
    beginConnection() {
      assert.equal(this, candidate);
      return Promise.resolve({ url: "https://github.test/start" });
    },
  };
  const store: ProviderApplicationStore = {
    read: () => Promise.resolve(undefined),
    readAll: () => Promise.resolve([]),
    activate: () => Promise.resolve(void trace.push("activate")),
    save: () => Promise.reject(new Error("save failed")),
    completeSlackInstallation: () => Promise.reject(new Error("not expected")),
    completeLinearInstallation: () => Promise.reject(new Error("not expected")),
    completeSlackSocketApplication: () => Promise.reject(new Error("not expected")),
  };
  const options: Parameters<typeof createProviderApplications>[0] = {
    auth: {
      resolveAccount: () =>
        Promise.resolve({
          session: { id: "session", activeOrganizationId: "org" },
          account: { id: "operator", name: "Operator", email: "operator@example.test" },
          isInstanceOperator: true,
        }),
      rejectCookieMutation: () => undefined,
    },
    environment: {},
    inventory: {
      connectedIdentities: () => Promise.resolve([]),
      claimLegacyConnections: () => Promise.resolve(false),
      lastEventAt: () => Promise.resolve(null),
    },
    runtime: { prepare: () => Promise.resolve(candidate), identity: () => identity },
    store,
    verifier: { verify: () => Promise.resolve(identity) },
    callbackOrigin: () => "https://hub.test",
    beginCandidateConnection: (request, org, route, begin) => {
      trace.push(`${org}:${route}`);
      return begin(request);
    },
  };
  return { options, trace, candidate };
}

function post(): Request {
  return new Request("https://hub.test/apps", { method: "POST" });
}

describe("provider application activation", () => {
  it("uses the original receiver for a prepared connection and closes the candidate", async () => {
    const { options, trace } = fixture();
    options.environment.github = github;
    assert.deepEqual(
      await createProviderApplications(options).beginConnection(
        post(),
        "github",
        "org",
        "appSetup",
      ),
      { url: "https://github.test/start" },
    );
    expect(trace).toEqual(["org:/", "close"]);
  });

  it("reports a disappearing candidate method as an internal TypeError and closes the candidate", async () => {
    const { options, trace, candidate } = fixture();
    options.environment.github = github;
    options.beginCandidateConnection = (request, _org, _route, begin) => {
      delete candidate.beginConnection;
      return begin(request);
    };
    await assert.rejects(
      createProviderApplications(options).beginConnection(post(), "github", "org"),
      (error: unknown) =>
        error instanceof ProviderApplicationError &&
        error.message === "internal" &&
        error.cause instanceof TypeError &&
        error.cause.message === "candidate.beginConnection is not a function",
    );
    assert.deepEqual(trace, ["close"]);
  });

  it("leaves a failed legacy claim unpublished and closes the candidate", async () => {
    const { options, trace } = fixture();
    options.environment.github = github;
    options.inventory.connectedIdentities = () =>
      Promise.resolve([{ id: "1", name: "Legacy", applicationId: null, status: "connected" }]);
    options.inventory.claimLegacyConnections = () => {
      trace.push("claim");
      return Promise.resolve(false);
    };
    const failures = await activateProviderApplicationsAtStartup({
      ...options,
      callbackOrigin: "https://hub.test",
    });
    assert.deepEqual(
      failures.map(({ provider, error }) => [provider, String(error)]),
      [["github", "ProviderApplicationError: identityConflict"]],
    );
    assert.deepEqual(trace, ["start", "claim", "close"]);
  });

  it("maps verification errors without preparing a candidate or touching its store", async () => {
    const { options, trace } = fixture();
    const cause = new ProviderVerificationError("credentialsRejected", 401, {
      subject: "privateKey",
    });
    options.verifier.verify = () => Promise.reject(cause);
    options.store.read = () => {
      throw new Error("unexpected read");
    };
    await assert.rejects(
      createProviderApplications(options).verifyAndSave(post(), "github", github),
      {
        name: "ProviderApplicationError",
        message: "credentialsRejected",
        safeContext: "privateKey",
        cause,
      },
    );
    assert.deepEqual(trace, []);
  });
});
