import { expect } from "@playwright/test";
import { test } from "./app.js";

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

test.describe("instance scope", () => {
  test("enters instance scope through the More account menu", async ({ hub, page }) => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.grantOperator("owner");
    const sheet = page.getByRole("dialog", { name: "More" });
    const more = page.getByRole("button", { name: "More", exact: true });
    const instanceNav = sheet.getByRole("navigation", { name: "Instance", exact: true });

    await more.click();
    await sheet.getByRole("button", { name: owner.email }).click();
    await page.getByRole("menuitem", { name: "Instance administration" }).click();
    await expect(page).toHaveURL(/\/apps$/u);
    await expect(sheet).toBeHidden();
    await more.click();
    await instanceNav.getByRole("link", { name: "Operator" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("heading", { name: "Operator", exact: true })).toBeVisible();

    await more.click();
    await expect(instanceNav.getByRole("link")).toHaveText(["Back to Acme", "Apps", "Operator"]);
    await expect(sheet.getByRole("button", { name: "Organization" })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/03-instance-scope.png`, animations: "disabled" });

    await instanceNav.getByRole("link", { name: "Back to Acme" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  });
});
