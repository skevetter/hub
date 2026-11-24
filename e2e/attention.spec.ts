import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import { attentionDialog, attentionEntry, openAttention } from "./helpers/attention.js";
import type { BuiltApplication, PaseoHub } from "./helpers/hub.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const owner = {
  name: "Ada Park",
  email: "ada@example.com",
  password: "ada-example-password",
};
const ORGANIZATION = "Acme";
const TRIGGER = "deploy";
const CONNECTION_TITLE = "GitHub needs authorization";
const LOAD_FAILURE = "Attention could not load.";

test.describe("desktop Attention", () => {
  test.skip(({ isMobile }) => isMobile, "Desktop rail only");

  test("opens Attention with the keyboard and follows the connection action", async ({
    hub,
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.seedSuspendedGitHubConnection("Acme");
    await page.reload();

    const entry = page.getByRole("button", { name: "Attention, 1 item", exact: true });
    await expect(entry).toBeVisible();
    await entry.press("Enter");
    const panel = attentionDialog(page);
    await expect(panel.getByRole("heading", { name: "Attention" })).toBeFocused();
    await checkAttentionThemes(page, '[data-slot="popover-content"]', "desktop");

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

  test("fits five tabs and opens a keyboard-accessible sheet", async ({ hub, page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.seedSuspendedGitHubConnection("Acme");
    const quick = page.getByRole("navigation", { name: "Quick navigation" });
    await page.reload();

    const entry = quick.getByRole("button", { name: "Attention, 1 item", exact: true });
    await expect(entry).toBeVisible();
    await expectTabsFit(quick);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await entry.press("Enter");

    const sheet = page.getByRole("dialog", { name: "Attention" });
    await expect(sheet.getByRole("heading", { name: "Attention" })).toBeFocused();
    await expect(sheet.getByText("GitHub needs authorization")).toBeVisible();
    await expectSheetFit(sheet);
    await checkAttentionThemes(page, '[data-slot="sheet-content"]', "phone");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(entry).toBeFocused();
  });
});

test.describe("Attention behavior", () => {
  test.beforeEach(async ({ hub, page, isMobile }) => {
    await page.setViewportSize({ width: isMobile ? 390 : 1280, height: 844 });
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", ORGANIZATION);
  });

  test("orders connection and failed run items, links to both, and keeps runs marked seen", async ({
    hub,
    page,
    isMobile,
  }) => {
    await seedFailedRun(hub, page, isMobile);
    await hub.seedSuspendedGitHubConnection(ORGANIZATION);
    await page.reload();

    await expectOnlyToastLiveRegion(page);
    const dialog = await openAttention(page, 2);
    const rows = dialog.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(CONNECTION_TITLE);
    await expect(rows.nth(1)).toContainText("3 runs failed");
    await expect(rows.nth(1)).toContainText(`Newest: ${TRIGGER}`);
    await expectOnlyToastLiveRegion(page);
    await dialog.getByRole("link", { name: "Open connections" }).click();
    await expect(page).toHaveURL(/\/connections$/u);
    await expect(dialog).toBeHidden();

    await openAttention(page, 2);
    await dialog.getByRole("link", { name: "Review runs" }).click();
    await expect(page).toHaveURL(/\/activity\?/u);
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
      status: "unsuccessful",
      range: "7d",
    });
    const runs = page.getByRole("table", { name: "Trigger activity" });
    await expect(runs.getByRole("link", { name: TRIGGER, exact: true })).toHaveCount(3);
    await expect(runs.getByText("Timed out", { exact: true })).toBeVisible();
    await expect(runs.getByText("Rejected", { exact: true })).toBeVisible();
    await expect(dialog).toBeHidden();
    await markSeenAndReload(hub.primaryApplication(), page);
  });

  test("refreshes the count after a connection is revoked without reloading", async ({
    hub,
    page,
  }) => {
    await hub.seedSuspendedGitHubConnection(ORGANIZATION);
    await page.reload();
    const dialog = await openAttention(page, 1);
    await dialog.getByRole("link", { name: "Open connections" }).click();
    await expect(page).toHaveURL(/\/connections$/u);
    await page.getByRole("button", { name: "Actions for suspended-inc" }).click();
    await page.getByRole("menuitem", { name: "Revoke", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke connection" }).click();
    await expect(attentionEntry(page, 0)).toBeVisible({ timeout: 10_000 });
    await openAttention(page, 0);
    await expect(dialog.getByText("Nothing needs you.")).toBeVisible();
  });

  test("never reuses Attention items from another organization when the new read fails", async ({
    hub,
    page,
    isMobile,
  }) => {
    if (isMobile) await moreButton(page).click();
    await hub.createAnotherOrganization("owner", "Orbit");
    await hub.seedSuspendedGitHubConnection("Orbit");
    await page.reload();
    const dialog = await openAttention(page, 1);
    await expect(dialog.getByText(CONNECTION_TITLE)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    const app = hub.primaryApplication();
    await interruptAttention(app);
    try {
      await selectOrganization(hub, page, { isMobile, name: ORGANIZATION });
      await expect(attentionEntry(page, 0)).toBeVisible({ timeout: 6_000 });
      await openAttention(page, 0);
      await expect(dialog.getByText(LOAD_FAILURE)).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByText(CONNECTION_TITLE)).toHaveCount(0);
    } finally {
      await restoreAttention(app);
    }
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.getByText("Nothing needs you.")).toBeVisible();
  });

  test("keeps Attention items on background failure and offers a retry on first-load failure", async ({
    hub,
    page,
  }) => {
    await hub.seedSuspendedGitHubConnection(ORGANIZATION);
    await page.reload();
    const dialog = await openAttention(page, 1);
    await expect(dialog.getByText(CONNECTION_TITLE)).toBeVisible();
    const app = hub.primaryApplication();
    const failedRefresh = countAttentionFailures(page);
    await interruptAttention(app);
    try {
      await returnToAttentionTab(page);
      await expect.poll(failedRefresh, { timeout: 10_000 }).toBe(3);
      await expect(dialog.getByText(CONNECTION_TITLE)).toBeVisible();
      await expect(dialog.getByText(LOAD_FAILURE)).toHaveCount(0);

      await page.reload();
      await openAttention(page, 0);
      await expect(dialog.getByText(LOAD_FAILURE)).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByText(CONNECTION_TITLE)).toHaveCount(0);
    } finally {
      await restoreAttention(app);
    }
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog.getByText(CONNECTION_TITLE)).toBeVisible();
  });

  test("groups dropped events in order and qualifies counts at the cap", async ({ hub, page }) => {
    const app = hub.primaryApplication();
    await seedDroppedEvents(app);
    await page.reload();
    const dialog = await openAttention(page, 4);
    await expectDroppedRows(dialog, false);
    await insertLastDroppedEvent(app);
    await page.reload();
    await openAttention(page, 4);
    await expectDroppedRows(dialog, true);
    await dialog.getByRole("link", { name: /^View dropped events: Events arrived/u }).click();
    await expect(page).toHaveURL(/\/activity\?/u);
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
      view: "dropped",
      reason: "routing",
      range: "7d",
    });
    await expect(page.getByRole("table", { name: "Dropped events" })).toBeVisible();
  });
});

async function seedFailedRun(hub: PaseoHub, page: Page, isMobile: boolean) {
  if (isMobile) await page.setViewportSize({ width: 1280, height: 844 });
  const daemon = await hub.connectProviderDaemon("owner", ORGANIZATION);
  const triggers = new OrganizationTriggers(page);
  await triggers.startNew();
  await triggers.configureManual({
    name: TRIGGER,
    daemon,
    cwd: "/workspace",
    agent: "codex/gpt-5.4",
    mode: "full-access",
    thinking: "high",
    prompt: "Run it.",
  });
  await triggers.save(TRIGGER);
  await hub.seedTriggerRun(TRIGGER, { minutesAgo: 1, status: "failed" });
  await hub.seedTriggerRun(TRIGGER, { minutesAgo: 2, status: "timed_out" });
  await hub.seedTriggerRun(TRIGGER, { minutesAgo: 3, status: "rejected" });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
}

async function markSeenAndReload(app: BuiltApplication, page: Page) {
  const dialog = await openAttention(page, 2);
  const held = Promise.withResolvers<void>();
  const serverFunctions = "**/_serverFn/**";
  await page.route(serverFunctions, async (route) => {
    if (route.request().method() === "POST") await held.promise;
    await route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Mark seen" }).click();
    await expect(dialog.getByText("3 runs failed")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(attentionEntry(page, 1)).toBeVisible();
  } finally {
    held.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect
    .poll(async () => (await app.query("select 1 from account_attention_state")).length)
    .toBe(1);
  await page.reload();
  await openAttention(page, 1);
  await expect(dialog.getByText(CONNECTION_TITLE)).toBeVisible();
  await expect(dialog.getByText("3 runs failed")).toHaveCount(0);
}

async function expectOnlyToastLiveRegion(page: Page) {
  await expect(page.getByRole("log", { name: "Notifications", includeHidden: true })).toHaveCount(
    1,
  );
  await expect(page.locator(':not(main *)[aria-live]:not([aria-live="off"])')).toHaveAttribute(
    "role",
    "log",
  );
  await expect(page.locator(':not(main *)[role="status"]')).toHaveCount(0);
}

function moreButton(page: Page) {
  return page
    .getByRole("navigation", { name: "Quick navigation" })
    .getByRole("button", { name: "More", exact: true });
}

async function selectOrganization(
  hub: PaseoHub,
  page: Page,
  scope: { isMobile: boolean; name: string },
) {
  if (scope.isMobile) await switchFromMore(page, moreButton(page), scope.name);
  else await hub.chooseOrganization("owner", scope.name);
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
}

function interruptAttention(app: BuiltApplication) {
  return app.query("alter table account_attention_state rename to unavailable_attention_state");
}

function restoreAttention(app: BuiltApplication) {
  return app.query("alter table unavailable_attention_state rename to account_attention_state");
}

function countAttentionFailures(page: Page) {
  let failures = 0;
  page.on("response", async (response) => {
    if (!response.url().includes("/_serverFn/")) return;
    const body = await response.text().catch(() => "");
    if (body.includes(LOAD_FAILURE)) failures++;
  });
  return () => failures;
}

async function returnToAttentionTab(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    window.dispatchEvent(new Event("visibilitychange"));
  });
}

function seedDroppedEvents(app: BuiltApplication) {
  return app.query(
    `insert into provider_event_receipts
       (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
     select id, provider, gen_random_uuid()::text, source, '{}'::jsonb, now(), reason
     from organization cross join (values
       ('github', 'github.issue_comment', 'no_project_route', 2415),
       ('linear', 'linear.comment', 'no_trigger_for_source', 46),
       ('linear', 'linear.comment', 'trigger_filters_rejected', 26),
       ('linear', 'linear.comment', 'unsupported_event', 1),
       ('linear', 'linear.comment', 'legacy_other', 11)
     ) as batch(provider, source, reason, count)
     cross join lateral generate_series(1, batch.count)
     where name = $1`,
    [ORGANIZATION],
  );
}

function insertLastDroppedEvent(app: BuiltApplication) {
  return app.query(
    `insert into provider_event_receipts
       (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
     select id, 'linear', gen_random_uuid()::text, 'linear.comment', '{}'::jsonb, now(), 'legacy_other'
     from organization where name = $1`,
    [ORGANIZATION],
  );
}

async function expectDroppedRows(dialog: Locator, capped: boolean) {
  const rows = dialog.getByRole("listitem");
  const prefix = capped ? "At least " : "";
  const title = [
    "Events arrived without a route or matching trigger",
    "Trigger filters rejected events",
    "Linear sent unsupported events",
    "Hub dropped events for other reasons",
  ];
  const detail = [
    `${prefix}2461 events in the last 7 days (2415 from GitHub, 46 from Linear).`,
    `${prefix}26 events in the last 7 days (26 from Linear).`,
    `${prefix}1 event in the last 7 days (1 from Linear).`,
    `${prefix}${capped ? 12 : 11} events in the last 7 days (${capped ? 12 : 11} from Linear).`,
  ];
  await expect(rows).toHaveCount(title.length);
  for (const [index, name] of title.entries()) {
    await expect(rows.nth(index).getByText(name, { exact: true })).toBeVisible();
    await expect(rows.nth(index).getByText(detail[index] ?? "", { exact: true })).toBeVisible();
  }
}

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

async function expectSheetFit(sheet: Locator) {
  expect(await sheet.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  const action = sheet.getByRole("link", { name: "Open connections" });
  expect(
    await action.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
}

async function checkAttentionThemes(page: Page, selector: string, surface: "desktop" | "phone") {
  const output = process.env["HUB_ATTENTION_SCREEN_DIR"];
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`, "u"));
    const results = await new AxeBuilder({ page })
      .include(selector)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    if (output !== undefined) {
      await page.screenshot({
        path: join(output, `${surface}-${colorScheme}.png`),
        animations: "disabled",
      });
    }
  }
}
