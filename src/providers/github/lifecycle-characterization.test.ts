import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createGitHubLifecycle } from "./lifecycle.js";

type Evidence = "absent" | "active" | "suspended" | "read-failed" | "list-failed" | "lost-claim";

function runSync(installationId: number, mode: Evidence, repositoryCount: number) {
  const owner = { providerApplicationId: "42", configurationVersion: 3 };
  const claim = {
    status: "claimed" as const,
    installationSyncId: "claim",
    installationId,
    removeBinding: repositoryCount % 2 === 0,
  };
  const receipt = {
    installationId,
    deliveryId: "delivery",
    signatureHash: "hash",
    source: "github.installation",
    payload: {},
    receivedAt: new Date(0),
  };
  const database = createMemoryDatabase();
  const calls: unknown[] = [];
  let pending = false;
  database.claimGitHubLifecycleReceipt = (input) => {
    calls.push(["receipt", input]);
    pending = true;
    return Promise.resolve(claim);
  };
  database.pendingGitHubInstallationSyncs = (scope, selected) => {
    calls.push(["pending", scope, selected]);
    if (selected === undefined) return Promise.resolve(pending ? [claim] : []);
    pending = false;
    return Promise.resolve(mode === "lost-claim" ? [] : [claim]);
  };
  database.synchronizeGitHubInstallation = (id, operation) => {
    calls.push(["synchronize", id]);
    return operation();
  };
  database.retryGitHubInstallationSync = (scope, id) => {
    calls.push(["retry", scope, id]);
    return Promise.resolve();
  };
  database.applyGitHubInstallationSync = (scope, selected, result) => {
    calls.push(["apply", scope, selected, result]);
    return Promise.resolve();
  };
  return { owner, claim, receipt, database, calls };
}

function installationFixture(installationId: number, mode: Evidence, repositoryCount: number) {
  const { owner, claim, receipt, database, calls } = runSync(installationId, mode, repositoryCount);
  const identity = {
    installationId,
    accountId: "1",
    accountLogin: "acme",
    accountType: "Organization",
    status: mode === "suspended" ? ("suspended" as const) : ("active" as const),
  };
  const repositories = Array.from({ length: repositoryCount }, (_, index) => ({
    repositoryId: index + 1,
    fullName: `acme/repo-${index + 1}`,
    defaultBranch: "main",
  }));
  const lifecycle = createGitHubLifecycle(
    database,
    {
      getInstallation(id) {
        calls.push(["read", id]);
        if (mode === "read-failed") return Promise.reject(new Error("installation unavailable"));
        return Promise.resolve(
          mode === "absent" ? { status: "absent" } : { status: "present", identity },
        );
      },
    },
    {
      listInstallationRepositories(input) {
        calls.push(["list", input]);
        return mode === "list-failed"
          ? Promise.reject(new Error("repository page unavailable"))
          : Promise.resolve(repositories);
      },
    },
    owner,
  );
  return { owner, claim, receipt, calls, identity, repositories, lifecycle };
}

function expectedSync(fixture: ReturnType<typeof installationFixture>, mode: Evidence) {
  const { receipt, owner, claim, identity, repositories } = fixture;
  const id = claim.installationId;
  const expected: unknown[] = [
    ["receipt", { ...receipt, providerApplicationId: owner.providerApplicationId }],
    ["pending", owner, undefined],
    ["synchronize", id],
    ["pending", owner, claim],
  ];
  if (mode !== "lost-claim") expected.push(["read", id]);
  if (mode === "active" || mode === "list-failed") expected.push(["list", { installationId: id }]);
  if (mode === "absent")
    expected.push([
      "apply",
      owner,
      claim,
      { status: "absent", removeBinding: claim.removeBinding },
    ]);
  if (mode === "active" || mode === "suspended") {
    expected.push([
      "apply",
      owner,
      claim,
      { status: "present", identity, repositories: mode === "suspended" ? [] : repositories },
    ]);
  }
  if (mode === "read-failed" || mode === "list-failed")
    expected.push(["retry", owner, claim.installationSyncId]);
  expected.push(["pending", owner, undefined]);
  return expected;
}

function testInstallation(id: number, mode: Evidence, count: number) {
  it(`handles ${mode} installation ${id} with ${count} repositories`, async () => {
    const fixture = installationFixture(id, mode, count);
    await fixture.lifecycle.accept(fixture.receipt);
    await fixture.lifecycle.stop();
    expect(fixture.calls).toEqual(expectedSync(fixture, mode));
  });
}

describe("GitHub lifecycle evidence", () => {
  for (const mode of [
    "absent",
    "active",
    "suspended",
    "read-failed",
    "list-failed",
    "lost-claim",
  ] as const) {
    for (const id of [1, 42, 900]) {
      for (const count of [0, 1, 143]) testInstallation(id, mode, count);
    }
  }

  it("wakes at start and does not start a second drain while already started", async () => {
    const { lifecycle, calls, owner } = installationFixture(42, "active", 1);
    lifecycle.start();
    lifecycle.start();
    await lifecycle.stop();
    expect(calls).toEqual([["pending", owner, undefined]]);
  });
});
