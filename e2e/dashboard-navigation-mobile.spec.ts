import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const SHOTS = "e2e/screenshots/dashboard-navigation-mobile";

const owner = {
  name: "Alice",
  email: "alice-navigation-mobile@example.com",
  password: "alice-navigation-mobile-password",
};

test("shows quick destinations and the full organization navigation under More", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const quick = page.getByRole("navigation", { name: "Quick navigation" });
  const sheet = page.getByRole("dialog", { name: "More" });
  const more = quick.getByRole("button", { name: "More" });
  const header = page
    .getByRole("main")
    .locator("header")
    .filter({ has: page.getByRole("img", { name: "Paseo" }) });
  await expect(header).toHaveText("Home");
  await expect(quick.getByRole("link")).toHaveText(["Home", "Activity", "Triggers"]);
  await expect(quick.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Toggle Sidebar" })).toBeHidden();

  await quick.getByRole("link", { name: "Activity" }).click();
  await expect(header).toHaveText("Activity");
  await expect(quick.getByRole("link", { name: "Activity" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await more.focus();
  await page.keyboard.press("Enter");
  const organizationSwitcher = sheet.getByRole("button", { name: "Organization" });
  await expect(organizationSwitcher).toBeFocused();
  const navigation = sheet.getByRole("navigation", { name: "Organization", exact: true });
  await expect(navigation.getByRole("link")).toHaveText([
    "Home",
    "Activity",
    "Triggers",
    "Daemons",
    "Connections",
    "Settings",
  ]);
  await expect(organizationSwitcher).toContainText("Acme");
  await expect(navigation.getByText("Setup", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("navigation", { name: "Project", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Project", exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/01-organization-scope.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  await more.click();
  await navigation.getByRole("link", { name: "Daemons" }).click();
  await expect(header).toHaveText("Daemons");
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();
});

test("opens instance settings through More on a phone", async ({ hub, page }) => {
  const { navigation } = projectApp(page);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.grantOperator("owner");
  await navigation.openMobileInstanceSection("Operator");
  await expect(page.getByRole("dialog", { name: "More" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Operator", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Instance settings" }).getByRole("link"),
  ).toHaveText(["Apps", "Operator"]);
  await page.screenshot({ path: `${SHOTS}/03-instance-scope.png`, animations: "disabled" });

  await navigation.leaveInstance();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
});

test("phone navigation uses the rail outline in both themes", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const quick = page.getByRole("navigation", { name: "Quick navigation" });
  const more = quick.getByRole("button", { name: "More", exact: true });
  const organization = page.getByRole("dialog", { name: "More" }).getByRole("button", {
    name: "Organization",
  });
  const railOutline = "rgb(247, 247, 244)";

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`, "u"));
    await page.keyboard.press("Tab");
    for (const control of [
      page.getByRole("button", { name: "Search", exact: true }),
      quick.getByRole("link", { name: "Home" }),
      more,
    ]) {
      await control.focus();
      await expect(control).toHaveCSS("outline-color", railOutline);
      await expect(control).toHaveCSS("outline-width", "2px");
    }
    await more.press("Enter");
    await expect(organization).toBeFocused();
    await expect(organization).toHaveCSS("outline-color", railOutline);
  }
});

test("switching organization closes More and returns focus to its trigger", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await expect(page).toHaveURL(/\/o\/[^/]+\/home$/u);
  const acmeHome = page.url();
  const more = page
    .getByRole("navigation", { name: "Quick navigation" })
    .getByRole("button", { name: "More", exact: true });
  const sheet = page.getByRole("dialog", { name: "More" });
  const organization = sheet.getByRole("button", { name: "Organization" });
  await more.click();
  await hub.createAnotherOrganization("owner", "Orbit");
  await expect(sheet).toBeHidden();

  await more.press("Enter");
  await expect(organization).toBeFocused();
  await expect(organization).toContainText("Orbit");
  await organization.press("Enter");
  await page.getByRole("menuitem", { name: "Acme", exact: true }).press("Enter");
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(acmeHome);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  await expect(more).toBeFocused();
});
