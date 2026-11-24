import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "/tmp/hub-ui/state-rows-shots";
const NAME = "review-queue";
const owner = {
  name: "State Owner",
  email: "state-rows-owner@example.test",
  password: "state-rows-owner-password",
};
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test.describe.configure({ timeout: 180_000 });

test("a trigger, its runs and its state are blocks that lead their rows, in both themes and sizes", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureManual({
    name: NAME,
    daemon,
    cwd: "/workspace",
    agent: "codex/gpt-5.4",
    mode: "full-access",
    thinking: "high",
    prompt: "Review the queue.",
  });
  await triggers.allowManualActor(owner.email);
  await triggers.save(NAME);
  const list = page.url();
  await triggers.openReadView(NAME);
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Run started." })).toBeVisible();
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`, "u"));
      await expectLeadingBlock(page, await openActivity(page), viewport.width);
      await shoot(page, `activity-${viewport.width}-${colorScheme}`);
      await page.goto(list);
      await expectLeadingBlock(page, page.getByRole("table", { name: "Triggers" }), viewport.width);
      await expect(
        page.getByRole("table", { name: "Triggers" }).getByText("Enabled"),
      ).toBeVisible();
      await shoot(page, `triggers-${viewport.width}-${colorScheme}`);
      await expectNoAxeViolations(page);
    }
  }
});

async function openActivity(page: Page): Promise<Locator> {
  await page.getByRole("link", { name: "Activity", exact: true }).first().click();
  const table = page.getByRole("table", { name: "Trigger activity" });
  await expect(table).toBeVisible();
  return table;
}

async function expectLeadingBlock(page: Page, table: Locator, width: number): Promise<void> {
  const row = table.getByRole("row").nth(1);
  const block = row.locator('[data-slot="state-block"]');
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  const record = await row.getByRole("cell").nth(1).boundingBox();
  if (box === null || record === null) throw new Error("row not measurable");
  expect(box.height).toBe(28);
  expect(box.width).toBeGreaterThanOrEqual(96);
  if (width < 640) {
    expect(box.y + box.height).toBeLessThanOrEqual(record.y);
    expect(box.width).toBeLessThan(width / 2);
  } else {
    expect(box.x + box.width).toBeLessThanOrEqual(record.x);
  }
  const radius = await block.evaluate((node) => getComputedStyle(node).borderRadius);
  expect(radius).toBe("0px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const region = await table
    .locator("xpath=ancestor::*[@data-slot='table-container']")
    .evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(region).toBeLessThanOrEqual(0);
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include("table")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
}
