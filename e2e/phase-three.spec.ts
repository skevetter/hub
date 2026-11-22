import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const alice = {
  name: "Alice",
  email: "alice@example.com",
  password: "alice-phase-three-password",
};

const bob = {
  name: "Bob",
  email: "bob@example.com",
  password: "bob-phase-three-password",
};

test("connects verified providers per organization and disconnects through confirmation", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.expectConnections("alice");
  await hub.connectGitHub("alice");
  await hub.connectDiscord("alice");
  await hub.expectConnectedProviders("alice", {
    github: "acme-inc",
    installationId: "42",
    discord: "Acme Guild",
    guildId: "100",
  });

  await hub.addNewMember("alice", "bob", bob);
  await hub.expectMemberConnectedProviders("bob", {
    github: "acme-inc",
    installationId: "42",
    discord: "Acme Guild",
    guildId: "100",
  });
  await hub.expectMemberConnectionMutationDenied("bob");

  await hub.createAnotherOrganization("alice", "Orbit");
  await hub.chooseOrganization("alice", "Orbit");
  await hub.connectGitHub("alice");
  await hub.connectDiscord("alice");
  await hub.expectConnectedProviders("alice", {
    github: "orbit-inc",
    installationId: "84",
    discord: "Orbit Guild",
    guildId: "200",
  });
  await hub.proveTenantProviderDispatch("alice");

  await hub.chooseOrganization("alice", "Acme");
  await hub.expectConnectedProviders("alice", {
    github: "acme-inc",
    installationId: "42",
    discord: "Acme Guild",
    guildId: "100",
  });
  await hub.disconnectProviders("alice");
  await hub.proveDisconnectedProvidersDrop();
});

test("locks organization switching while a provider disconnect is pending", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.connectGitHub("alice");
  await hub.createAnotherOrganization("alice", "Orbit");
  await hub.connectGitHub("alice");
  await hub.chooseOrganization("alice", "Acme");
  await hub.proveConnectionDisconnectLocksOrganizationSwitch("alice", "Orbit");
});

test.describe("without provider credentials", () => {
  test.use({ providerScenario: "not-configured" });

  test("shows the four provider states and hides instance setup from the organization owner", async ({
    hub,
    page,
  }) => {
    await hub.signUpAs("alice", alice);
    await hub.createOrganization("alice", "Unconfigured");
    await projectApp(page).navigation.openOrganizationSection("Connections");
    const main = page.getByRole("main");
    await expect(main.getByText("Not set up", { exact: true })).toHaveCount(4);
    await expect(main.getByRole("button", { name: /Connect|Revoke/u })).toHaveCount(0);
    await expect(main.getByRole("link", { name: /Set up the/u })).toHaveCount(0);
    await expectAccessible(page);
  });
});

test("keeps GitHub owner approval terminal and retryable", async ({ hub }) => {
  await hub.proveGitHubApprovalRequired(alice);
});

test("fails closed for forged, expired, and replayed connection state", async ({ hub }) => {
  await hub.proveConnectionStateBoundaries({
    name: "State Alice",
    email: "state-alice@example.com",
    password: "state-boundaries-phase-three-password",
  });
});

test("returns a callback without a session to Connections", async ({ hub }) => {
  await hub.proveSignedOutConnectionReturn({
    name: "Signed-out Alice",
    email: "signed-out-alice@example.com",
    password: "signed-out-return-phase-three-password",
  });
});

test("keeps provider installation and guild conflicts unavailable", async ({ hub }) => {
  await hub.proveProviderConnectionConflicts({
    name: "Conflict Alice",
    email: "conflict-alice@example.com",
    password: "conflict-phase-three-password",
  });
});

test("keeps URL scope across organization switches and rejects replaced accounts", async ({
  hub,
}) => {
  await hub.proveStaleConnectionScopeReplacement(
    {
      name: "Stale Alice",
      email: "stale-alice@example.com",
      password: "stale-phase-three-password",
    },
    {
      name: "Replacement Alice",
      email: "replacement-alice@example.com",
      password: "replacement-phase-three-password",
    },
  );
});

test("locks account context while provider starts are pending", async ({ hub }) => {
  await hub.proveProviderStartLocksAccountContext({
    name: "Redirect Alice",
    email: "redirect-alice@example.com",
    password: "redirect-phase-three-password",
  });
});

test("shows a suspended GitHub connection", async ({ hub, page }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Connection states");
  await hub.seedSuspendedGitHubConnection("Connection states");
  const { navigation, connections } = projectApp(page);
  await navigation.openOrganizationSection("Connections");
  const github = connections.card("GitHub");
  await expect(github.getByText("Needs authorization", { exact: true })).toBeVisible();
  await expect(github.getByRole("button", { name: "Reconnect GitHub" })).toBeVisible();
  await github.getByRole("button", { name: /^Actions for /u }).click();
  await page.getByRole("menuitem", { name: "Revoke" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Revoke connection" }).click();
  await expect(github.getByRole("listitem")).toHaveCount(0);
  await expect(github.getByText("Not set up", { exact: true })).toBeVisible();
  await expectAccessible(page);
});

async function expectAccessible(page: Page) {
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}
