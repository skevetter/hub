import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("Activity pages and filters stay in the URL at desktop and phone widths", async ({
  hub,
  page,
}) => {
  test.setTimeout(120_000);
  await hub.signUpAs("owner", {
    name: "Activity Owner",
    email: "activity-owner@example.com",
    password: "activity-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureManual({
    name: "sample-work",
    daemon,
    cwd: "/workspace/acme",
    agent: "opencode/gateway/vendor/model-v1",
    mode: "full-access",
    thinking: "low",
    prompt: "Handle the event.",
  });
  await triggers.save("sample-work");
  for (let minutesAgo = 1; minutesAgo <= 37; minutesAgo += 1) {
    await hub.seedTriggerRun("sample-work", { minutesAgo, status: "succeeded" });
  }
  await hub.seedTriggerRun("sample-work", { minutesAgo: 60 * 48, status: "failed" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await projectApp(page).navigation.openOrganizationSection("Activity");
  const table = page.getByRole("table", { name: "Trigger activity" });
  const rows = table.locator("tbody tr");
  const pager = page.getByRole("navigation", { name: "Activity pages" });
  const size = pager.getByRole("combobox", { name: "Rows per page" });
  const announcement = pager.getByRole("status");
  const filters = page.getByRole("group", { name: "Filters", exact: true });
  await expect(rows).toHaveCount(15);
  await expect(pager).toContainText("1 to 15");
  await expect(size).toHaveValue("15");
  const shots = process.env["HUB_PAGING_SCREEN_DIR"];
  if (shots !== undefined)
    await page.screenshot({ path: join(shots, "activity-1280.png"), fullPage: true });

  await page.getByRole("combobox", { name: "Status" }).selectOption("succeeded");
  await expect(page).toHaveURL(/[?&]status=succeeded/u);
  await expect.soft(announcement).toHaveAttribute("aria-live", "polite", { timeout: 1000 });
  await expect.soft(announcement).toContainText("Status Succeeded", { timeout: 1000 });
  await pager.getByRole("link", { name: "Older" }).click();
  await expect(pager).toContainText("16 to 30");
  await expect(announcement).toContainText("Rows 16 to 30");
  await expect(page).toHaveURL(/[?&]cursor=/u);
  await page.goBack();
  await expect(pager).toContainText("1 to 15");
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("succeeded");
  await pager.getByRole("link", { name: "Older" }).click();
  await expect(pager).toContainText("16 to 30");
  await size.selectOption("25");
  await expect(rows).toHaveCount(25);
  await expect(pager).toContainText("1 to 25");
  await expect(page).toHaveURL(/[?&]size=25/u);
  await expect.soft(announcement).toContainText("25 runs", { timeout: 1000 });
  expect(new URL(page.url()).searchParams.get("cursor")).toBeNull();

  await page.getByRole("combobox", { name: "Status" }).selectOption("failed");
  await expect(page).toHaveURL(/[?&]status=failed/u);
  await expect(announcement).toContainText("1 run.");
  const previousAnnouncement = await announcement.textContent();
  const livePoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/_serverFn/") &&
      response.url().includes("failed"),
  );
  await livePoll;
  await expect(rows).toHaveCount(1);
  await expect(announcement).toHaveText(previousAnnouncement ?? "");
  await hub.seedTriggerRun("sample-work", { minutesAgo: 60 * 49, status: "failed" });
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(announcement).toHaveText(previousAnnouncement ?? "");
  await page.getByRole("combobox", { name: "Time range" }).selectOption("24h");
  await expect(page.getByText("No runs match these filters", { exact: true })).toBeVisible();
  await expect.soft(announcement).toContainText("No runs match these filters", { timeout: 1000 });
  await page.getByRole("link", { name: "Clear filters" }).press("Enter");
  await expect(rows).toHaveCount(25);
  await expect(page).toHaveURL(/\/activity\?size=25$/u);
  await expect.soft(filters).toBeFocused({ timeout: 1000 });

  const plainUrl = new URL(page.url());
  plainUrl.search = "";
  await page.goto(`${plainUrl}?size=20`);
  await expect(size).toHaveValue("15");
  await expect(rows).toHaveCount(15);
  await page.goto(plainUrl.toString());
  await expect(size).toHaveValue("25");
  await expect(rows).toHaveCount(25);
  await page.setViewportSize({ width: 390, height: 844 });
  await size.focus();
  await expect(size).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(
    await table.evaluate((element) => {
      const container = element.parentElement;
      return container !== null && container.scrollWidth === container.clientWidth;
    }),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  if (shots !== undefined)
    await page.screenshot({ path: join(shots, "activity-390.png"), fullPage: true });
});
