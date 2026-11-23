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
