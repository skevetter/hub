import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";

const owner = {
  name: "Ada Park",
  email: "ada@example.com",
  password: "ada-example-password",
};

test.describe("desktop Attention", () => {
  test.skip(({ isMobile }) => isMobile, "Desktop rail only");

  test("opens Attention with the keyboard and follows the connection action", async ({
    hub,
    page,
  }) => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.seedSuspendedGitHubConnection("Acme");
    await page.reload();

    const entry = page.getByRole("button", { name: "Attention, 1 item", exact: true });
    await expect(entry).toBeVisible();
    await entry.press("Enter");
    const panel = page.getByRole("dialog", { name: "Attention" });
    await expect(panel.getByRole("heading", { name: "Attention" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(entry).toBeFocused();

    await entry.press("Enter");
    await panel.getByRole("link", { name: "Open connections" }).click();
    await expect(page).toHaveURL(/\/connections$/u);
    await expect(panel).toBeHidden();
  });
});

test.describe("phone Attention", () => {
  test.skip(({ isMobile }) => !isMobile, "Phone tab only");

  test("fits five tabs and opens a keyboard-accessible, organization-scoped sheet", async ({
    hub,
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.seedSuspendedGitHubConnection("Acme");
    const quick = page.getByRole("navigation", { name: "Quick navigation" });
    const more = quick.getByRole("button", { name: "More", exact: true });
    await more.click();
    await hub.createAnotherOrganization("owner", "Orbit");
    await switchFromMore(page, more, "Acme");

    const entry = quick.getByRole("button", { name: "Attention, 1 item", exact: true });
    await expect(entry).toBeVisible();
    await expectTabsFit(quick);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await entry.press("Enter");

    const sheet = page.getByRole("dialog", { name: "Attention" });
    await expect(sheet.getByRole("heading", { name: "Attention" })).toBeFocused();
    await expect(sheet.getByText("GitHub needs authorization")).toBeVisible();
    await expectSheetAccessible(page, sheet);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(entry).toBeFocused();

    await switchFromMore(page, more, "Orbit");
    await quick.getByRole("button", { name: "Attention", exact: true }).click();
    await expect(sheet.getByText("Nothing needs you.")).toBeVisible();
    await expect(sheet.getByText("GitHub needs authorization")).toHaveCount(0);
  });
});

async function switchFromMore(page: Page, more: Locator, name: string) {
  await more.click();
  await page
    .getByRole("dialog", { name: "More" })
    .getByRole("button", { name: "Organization" })
    .click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(name);
}

async function expectTabsFit(quick: Locator) {
  const labels = quick.locator(":scope > :is(a, button) > span:last-child");
  await expect(labels).toHaveText(["Home", "Activity", "Triggers", "Attention", "More"]);
  const fits = await labels.evaluateAll((elements) =>
    elements.map((label) => {
      const box = label.getBoundingClientRect();
      const tab = label.parentElement?.getBoundingClientRect();
      return tab !== undefined && box.width > 0 && box.left >= tab.left && box.right <= tab.right;
    }),
  );
  expect(fits).toEqual([true, true, true, true, true]);
}

async function expectSheetAccessible(page: Page, sheet: Locator) {
  expect(await sheet.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  const action = sheet.getByRole("link", { name: "Open connections" });
  expect(
    await action.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  const results = await new AxeBuilder({ page })
    .include('[data-slot="sheet-content"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}
