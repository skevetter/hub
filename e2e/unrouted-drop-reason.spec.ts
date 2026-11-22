import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

test.use({ providerScenario: "slack-only" });

const ownerEmail = "alice-unrouted-reason@example.com";

for (const width of [1280, 390]) {
  test(`finds dropped events and their next steps at ${width}px`, async ({ hub, page }) => {
    await hub.signUpAs("owner", {
      name: "Alice",
      email: ownerEmail,
      password: "alice-unrouted-reason-password",
    });
    await hub.createOrganization("owner", "Acme");
    await hub.deliverSignedUnroutedSlackEvent("owner");
    await hub.primaryApplication().query(
      `with target as (
         select member.organization_id from member join "user" on "user".id = member.user_id
         where lower("user".email) = $1 limit 1
       )
       insert into provider_event_receipts
         (organization_id, provider, delivery_id, source, repo, payload, received_at, dropped_reason)
       select organization_id, 'github', gen_random_uuid()::text,
              'github.issue_comment', 'example/workspace', '{"private":"PRIVATE-EVENT-BODY"}'::jsonb,
              now() - n * interval '30 minutes', 'no_project_route'
       from target cross join generate_series(1, 21) n`,
      [ownerEmail],
    );
    await page.setViewportSize({ width, height: 900 });
    const { navigation } = projectApp(page);
    const openSection = (section: "Activity" | "Home" | "Connections") =>
      width === 390
        ? navigation.openMobileOrganizationSection(section)
        : navigation.openOrganizationSection(section);
    await openSection("Activity");
    await expect(page.getByText("No activity", { exact: true })).toBeVisible();
    const view = page.getByRole("radiogroup", { name: "Activity view" });
    await expect(view).toBeVisible();
    await view.getByRole("radio", { name: "Dropped" }).click();
    await expect(page).toHaveURL(/[?&]view=dropped/u);
    const table = page.getByRole("table", { name: "Dropped events" });
    const rows = table.locator("tbody tr");
    const pager = page.getByRole("navigation", { name: "Dropped event pages" });
    const filters = page.getByRole("group", { name: "Filters", exact: true });
    await expect(rows).toHaveCount(15);
    await expect(pager.getByRole("combobox", { name: "Rows per page" })).toHaveValue("15");
    await expect(table).toContainText("example/workspace");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(
      await table.evaluate(
        ({ parentElement }) =>
          parentElement !== null && parentElement.scrollWidth === parentElement.clientWidth,
      ),
    ).toBe(true);
    const screenshots = process.env["HUB_DROPPED_SCREEN_DIR"];
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, `dropped-${width}.png`), fullPage: true });
    }

    await pager.getByRole("link", { name: "Older" }).click();
    await expect(rows).toHaveCount(7);
    await expect(pager.getByRole("status")).toContainText("Rows 16 to 22");
    await pager.getByRole("link", { name: "Newer" }).click();
    await expect(rows).toHaveCount(15);
    await page.getByRole("combobox", { name: "Provider" }).selectOption("slack");
    await expect(rows).toHaveCount(1);
    await expect(table).toContainText("The event did not pass the configured trigger filters.");
    await expect(table).not.toContainText(
      /PRIVATE-EVENT-(BODY|SENDER-ID|CHANNEL-ID|ATTACHMENT-ID|ATTACHMENT-NAME)|PRIVATE-SLACK-TOKEN/u,
    );
    await page.getByRole("combobox", { name: "Drop reason" }).selectOption("routing");
    await expect(
      page.getByText("No dropped events match these filters", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).press("Enter");
    await expect(rows).toHaveCount(15);
    await expect(filters).toBeFocused();
    await page.getByRole("textbox", { name: "Source" }).fill("github.issue_comment");
    await page.getByRole("textbox", { name: "Source" }).press("Enter");
    await expect(page).toHaveURL(/[?&]source=github.issue_comment/u);
    await page.getByRole("combobox", { name: "Time range" }).selectOption("24h");
    await expect(page).toHaveURL(/[?&]range=24h/u);
    await rows.first().getByRole("link", { name: "Create one" }).click();
    await expect(page).toHaveURL(/\/triggers\/new$/u);

    await openSection("Home");
    const rejected = page
      .locator('[data-slot="alert"]')
      .filter({ hasText: "Trigger filters rejected events" });
    await rejected.getByRole("link", { name: "View dropped events" }).click();
    await expect(page).toHaveURL(/[?&]reason=trigger_filters_rejected/u);
    await expect(page).toHaveURL(/[?&]range=7d/u);
    await expect(rows).toHaveCount(1);

    await openSection("Connections");
    await page.getByRole("link", { name: "View dropped events in Activity" }).click();
    await expect(page).toHaveURL(/\/activity\?view=dropped$/u);
    await expect(rows).toHaveCount(15);
    await view.getByRole("radio", { name: "Runs" }).click();
    await expect(page).toHaveURL(/\/activity$/u);
    await expect(page.getByText("No activity", { exact: true })).toBeVisible();
  });
}
