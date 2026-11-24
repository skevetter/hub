import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const SHOTS = "e2e/screenshots/dashboard-navigation";

const owner = {
  name: "Alice",
  email: "alice-navigation@example.com",
  password: "alice-navigation-password",
};

test("redirects only a reachable organization index to Home", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await expect(page).toHaveURL(/\/o\/[^/]+\/home$/u);
  const home = page.url();
  await page.goto(home.replace(/\/home$/u, ""));
  await expect(page).toHaveURL(home);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  await page.goto(new URL("/o/unknown", page.url()).href);
  // A read that backed off and retried could not show this before about three seconds.
  await expect(page.getByRole("alert")).toContainText("Organization unavailable", {
    timeout: 2_500,
  });
  await expect(page).toHaveURL(/\/o\/unknown$/u);
});

/** Projects are a runtime compatibility detail, not a concept in the hosted product navigation. */
test("keeps every daily surface at organization scope", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");

  const organizationNav = page.getByRole("navigation", { name: "Organization", exact: true });
  const organizationSwitcher = page.getByRole("button", { name: "Organization" });
  await expect(organizationNav.getByRole("link")).toHaveText([
    "Home",
    "Activity",
    "Triggers",
    "Daemons",
    "Connections",
    "Settings",
  ]);
  await expect(organizationNav.getByText("Setup", { exact: true })).toBeVisible();
  await expect(organizationNav.getByRole("link", { name: "Home" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("navigation", { name: "Project", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Project", exact: true })).toHaveCount(0);
  await expect(organizationSwitcher).toContainText("Acme");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-organization-scope.png`, fullPage: true });
});

test("groups organization administration under one Settings entry", async ({ hub, page }) => {
  const app = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");

  const settingsNav = page.getByRole("navigation", { name: "Organization settings" });

  await test.step("Settings lands on Team and shows the sections it owns", async () => {
    await app.navigation.openOrganizationSection("Settings");
    await expect(page).toHaveURL(/\/o\/[^/]+\/settings\/team$/u);
    // Billing is absent: this instance is not billing-configured.
    await expect(settingsNav.getByRole("link")).toHaveText(["Team", "API keys", "Usage"]);
    await expect(page.getByRole("heading", { name: "Team", exact: true, level: 1 })).toBeVisible();
    await app.navigation.expectBreadcrumb("Acme", "Settings", "Team");
    await page.screenshot({ path: `${SHOTS}/03-settings-team.png`, fullPage: true });
  });

  await test.step("Usage is a settings section, not a top-level destination", async () => {
    await expect(
      page
        .getByRole("navigation", { name: "Organization", exact: true })
        .getByRole("link", { name: "Usage" }),
    ).toHaveCount(0);
    await app.navigation.openOrganizationSettings("Usage");
    await expect(page).toHaveURL(/\/o\/[^/]+\/settings\/usage$/u);
    await expect(page.getByRole("heading", { name: "Usage", exact: true, level: 1 })).toBeVisible();
    // Settings stays lit while any section beneath it is open.
    await expect(
      page
        .getByRole("navigation", { name: "Organization", exact: true })
        .getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("aria-current", "page");
    await page.screenshot({ path: `${SHOTS}/04-settings-usage.png`, fullPage: true });
  });
});

test("operators enter instance settings without leaving the organization shell", async ({
  hub,
  page,
}) => {
  const { navigation } = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await expect(page).toHaveURL(/\/o\/[^/]+\/home$/u);
  const home = page.url();
  await hub.grantOperator("owner");

  await navigation.openInstanceSection("Operator");
  await expect(page).toHaveURL(new URL("settings/instance/operator", home).href);
  await navigation.expectBreadcrumb("Acme", "Settings", "Instance", "Operator");
  await expect(
    page.getByRole("navigation", { name: "Instance settings" }).getByRole("link"),
  ).toHaveText(["Apps", "Operator"]);
  await expect(page.getByRole("combobox", { name: "Manage organization" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Organization", exact: true })).toContainText(
    "Acme",
  );
  await page.screenshot({ path: `${SHOTS}/07-instance-scope.png`, fullPage: true });

  await page.goto(new URL("/apps", page.url()).href);
  await expect(page).toHaveURL(new URL("settings/instance/apps", home).href);
  await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible();
  await navigation.leaveInstance();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
});
