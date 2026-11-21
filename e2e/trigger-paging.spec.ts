import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

test("Trigger filters and page survive opening and saving the editor", async ({ hub, page }) => {
  test.setTimeout(120_000);
  await hub.signUpAs("owner", {
    name: "Trigger Owner",
    email: "paged-trigger-owner@example.com",
    password: "trigger-owner-password",
  });
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  for (let index = 0; index < 19; index += 1) {
    const name = `sample-${String(index).padStart(2, "0")}`;
    await hub.seedLegacyTrigger("owner", name, `name: ${name}\non: manual.run\n`);
  }
  await hub.seedLegacyTrigger("owner", "clock", "name: clock\non: schedule.tick\n");
  await page.setViewportSize({ width: 1280, height: 900 });
  const app = new OrganizationTriggers(page);
  await app.open();
  const table = page.getByRole("table", { name: "Triggers" });
  const rows = table.locator("tbody tr");
  const pager = page.getByRole("navigation", { name: "Trigger pages" });
  const size = pager.getByRole("combobox", { name: "Rows per page" });
  const announcement = pager.getByRole("status");
  const filters = page.getByRole("group", { name: "Filters", exact: true });
  await expect(rows).toHaveCount(15);
  await expect(size).toHaveValue("15");
  const shots = process.env["HUB_PAGING_SCREEN_DIR"];
  if (shots !== undefined)
    await page.screenshot({ path: join(shots, "triggers-1280.png"), fullPage: true });
  await size.selectOption("25");
  await expect(rows).toHaveCount(20);
  await expect(page).toHaveURL(/[?&]size=25/u);
  await expect.soft(announcement).toHaveAttribute("aria-live", "polite", { timeout: 1000 });
  await expect.soft(announcement).toContainText("20 triggers", { timeout: 1000 });
  await size.selectOption("15");
  await expect(rows).toHaveCount(15);

  await page.getByRole("combobox", { name: "State" }).selectOption("disabled");
  await expect(page.getByText("No triggers match these filters", { exact: true })).toBeVisible();
  await expect
    .soft(announcement)
    .toContainText("No triggers match these filters", { timeout: 1000 });
  await page.getByRole("link", { name: "Clear filters" }).press("Enter");
  await expect(rows).toHaveCount(15);
  await expect.soft(filters).toBeFocused({ timeout: 1000 });
  const search = page.getByRole("textbox", { name: "Search triggers" });
  await search.fill("SAMPLE");
  await search.press("Enter");
  await expect(page).toHaveURL(/[?&]q=sample/u);
  await expect.soft(announcement).toContainText("Name contains sample", { timeout: 1000 });
  await pager.getByRole("link", { name: "Next" }).click();
  await expect(rows).toHaveCount(4);
  await expect(page).toHaveURL(/[?&]cursor=/u);
  await page.goBack();
  await expect(rows).toHaveCount(15);
  await expect(search).toHaveValue("sample");
  await pager.getByRole("link", { name: "Next" }).click();
  await expect(rows).toHaveCount(4);
  const list = new URL(page.url());

  await app.startNew();
  await app.configureManual({
    name: "sample-99",
    daemon,
    cwd: "/workspace/acme",
    agent: "opencode/gateway/vendor/model-v1",
    mode: "full-access",
    thinking: "low",
    prompt: "Handle the event.",
  });
  const form = page.locator("#trigger-editor-form");
  await form.getByRole("button", { name: "Create trigger" }).click();
  const created = table.getByRole("row", { name: /sample-99/u });
  await expect(created).toBeVisible();
  await expect(rows).toHaveCount(5);
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    Object.fromEntries(list.searchParams),
  );

  await app.openTrigger("sample-99");
  await form.getByRole("checkbox", { name: "Enabled" }).uncheck();
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(created).toContainText("Disabled");
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    Object.fromEntries(list.searchParams),
  );
  await app.openTrigger("sample-99");
  await form.getByRole("checkbox", { name: "Enabled" }).check();
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(created).toContainText("Enabled");
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(
    Object.fromEntries(list.searchParams),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(size).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(
    await table.evaluate((element) => {
      const container = element.parentElement;
      return container !== null && container.scrollWidth === container.clientWidth;
    }),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  if (shots !== undefined)
    await page.screenshot({ path: join(shots, "triggers-390.png"), fullPage: true });
  await page.getByRole("combobox", { name: "Provider" }).selectOption("webhook");
  await expect(page).toHaveURL(/[?&]provider=webhook/u);
  await expect(rows).toHaveCount(1);
  await expect(created).toBeVisible();
});
