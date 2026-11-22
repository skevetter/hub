import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import { holdConnectionRefresh } from "./helpers/projects/connections.js";
import { projectApp } from "./helpers/projects/index.js";

test.describe.configure({ timeout: 90_000 });

const owner = {
  name: "Connections Owner",
  email: "connections-owner@example.com",
  password: "connections-browser-fixture-password",
};
const providers = ["Linear", "GitHub", "Slack", "Discord"] as const;
const wide = { width: 1280, height: 900 };
const narrow = { width: 390, height: 900 };

test("shows the four cards and opens provider-filtered dropped events from the keyboard", async ({
  hub,
  page,
}) => {
  await page.setViewportSize(wide);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const { navigation, connections } = projectApp(page);
  await navigation.openOrganizationSection("Connections");

  const main = page.getByRole("main");
  const github = connections.card("GitHub");
  const discord = connections.card("Discord");
  await expect(main.getByRole("heading", { level: 2 })).toHaveText([...providers]);
  for (const provider of providers) {
    const card = connections.card(provider);
    await expect(card.getByText("Not set up", { exact: true })).toHaveCount(1);
  }
  await expect(main.getByRole("link", { name: /dropped events/iu })).toHaveCount(0);
  await tabThrough(page, [
    github.getByRole("button", { name: "Connect GitHub" }),
    discord.getByRole("button", { name: "Connect Discord" }),
  ]);
  await captureWidths(page, "empty");

  await hub.connectGitHub("owner");
  await hub.connectDiscord("owner");
  await expect(github.getByText("Connected", { exact: true })).toHaveCount(1);
  await hub
    .primaryApplication()
    .query(
      "update github_connections set status = 'suspended' where account_login = 'acme-inc'",
      [],
    );
  await hub.primaryApplication().query(
    `insert into provider_event_receipts
       (organization_id, provider, delivery_id, source, repo, payload, received_at, dropped_reason)
     select id, 'github', 'connections-drop-' || n, 'github.issue_comment', 'acme-inc/demo',
            '{}'::jsonb, now() - n * interval '4 days', 'no_project_route'
     from organization cross join generate_series(0, 2) n where name = 'Acme'`,
    [],
  );
  await page.reload();

  await expect(github.getByText("Needs authorization", { exact: true })).toHaveCount(1);
  await expect(github.getByRole("listitem")).toContainText("installation 42");
  await expect(discord.getByText("Connected", { exact: true })).toHaveCount(1);
  await expect(discord.getByRole("listitem")).toContainText("Acme Guild");
  const dropped = github.getByRole("link", { name: "Dropped events in the last 7 days" });
  await expect(dropped).toBeVisible();
  await captureWidths(page, "mixed");

  const cards = main.getByRole("region");
  await tabThrough(page, await cards.getByRole("button").or(cards.getByRole("link")).all());
  const rowActions = github.getByRole("button", { name: "Actions for acme-inc" });
  await tabThrough(page, [rowActions]);
  await page.keyboard.press("Enter");
  const revoke = page.getByRole("menuitem", { name: "Revoke" });
  await expect(revoke).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rowActions).toBeFocused();

  await tabThrough(page, [dropped]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/activity\?/u);
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
    view: "dropped",
    range: "7d",
    provider: "github",
  });
  const table = main.getByRole("table", { name: "Dropped events" });
  await expect(table.locator("tbody tr")).toHaveCount(2);
});

for (const fail of [false, true]) {
  test(`reconciles a revoked installation when the refresh ${fail ? "fails" : "succeeds"}`, async ({
    hub,
    page,
  }) => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.connectGitHub("owner");
    const github = projectApp(page).connections.card("GitHub");
    await expect(github.getByText("Connected", { exact: true })).toBeVisible();

    const refresh = await holdConnectionRefresh(page);
    const revokeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/_serverFn/"),
    );
    try {
      await github.getByRole("button", { name: "Actions for acme-inc" }).click();
      await page.getByRole("menuitem", { name: "Revoke" }).click();
      await page.getByRole("button", { name: "Revoke connection" }).click();
      expect((await revokeResponse).ok()).toBe(true);
      await refresh.started;
      if (!fail) {
        const row = github.getByRole("listitem");
        await expect(page.getByText("GitHub disconnected.")).toHaveCount(0);
        await expect(row).toContainText("Being removed");
        await expect(row).toHaveAttribute("aria-busy", "true");
        await expect(row.getByRole("button")).toHaveCount(0);
      }
    } finally {
      refresh.release(fail);
    }

    if (fail) {
      await expect(page.getByRole("alert")).toContainText(
        /(?:Organization|Connections) unavailable/u,
      );
      await expect(github).toHaveCount(0);
      await expect(page.getByText("GitHub disconnected.")).toHaveCount(0);
      refresh.release();
      await page.getByRole("button", { name: "Try again" }).click();
    }

    await expect(github.getByText("Not set up", { exact: true })).toBeVisible();
    await expect(github.getByRole("listitem")).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "GitHub disconnected." }),
    ).toBeVisible();
  });
}

test("keeps the initial failure passive and announces the result of retrying", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const { navigation, connections } = projectApp(page);
  const statusRead = page.waitForResponse(async (response) => {
    if (
      response.request().method() !== "GET" ||
      !response.ok() ||
      !response.url().includes("/_serverFn/")
    ) {
      return false;
    }
    return (await response.text()).includes('"canManage"');
  });
  await navigation.openOrganizationSection("Connections");
  await expect(connections.card("GitHub")).toBeVisible();
  const statusPath = new URL((await statusRead).url()).pathname;
  const refresh = await holdConnectionRefresh(page, statusPath);
  refresh.release(true);
  await page.reload();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await retry.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("unavailable");
  refresh.release();
  await retry.click();
  await expect(connections.card("GitHub")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Connections loaded." })).toBeVisible();
});

test.describe("Slack authorization", () => {
  test.use({ providerScenario: "slack-only" });

  test("shows the actual grants on a connection that needs reauthorization", async ({
    hub,
    page,
  }) => {
    await page.setViewportSize(wide);
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.seedSlackConnection("owner", "fixture-slack", "Acme Slack");
    const { navigation, connections } = projectApp(page);
    await navigation.openOrganizationSection("Connections");

    const slack = connections.card("Slack");
    await expect(slack.getByText("Needs authorization", { exact: true })).toHaveCount(1);
    await expect(slack.getByRole("listitem")).toContainText("Acme Slack");
    await expect(slack.getByRole("listitem")).toContainText("Workspace needs authorization");
    await expect(slack.getByRole("listitem")).toContainText("read app mentions");
    await expect(slack.getByRole("listitem")).toContainText("post messages");
    await tabThrough(page, [slack.getByRole("button", { name: "Reauthorize Slack" })]);
  });
});

test("lets an instance operator reach every app setup link from the keyboard", async ({ hub }) => {
  test.setTimeout(150_000);
  const session = await hub.openAppSetup({ account: owner });
  try {
    const { page, surface } = session;
    await page.setViewportSize(wide);
    await surface.leave("Do this later");
    const { navigation, connections } = projectApp(page);
    await navigation.openOrganizationSection("Connections");

    const setupLinks = providers.map((provider) =>
      connections.card(provider).getByRole("link", { name: `Set up the ${provider} app` }),
    );
    for (const link of setupLinks) await expect(link).toBeVisible();
    await tabThrough(page, setupLinks);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/apps$/u);
  } finally {
    await session.close();
  }
});

async function tabThrough(page: Page, controls: Locator[]) {
  expect(controls.length).toBeGreaterThan(0);
  const remaining = new Set(controls);
  const focused = page.locator(":focus");
  for (let step = 0; step < 36 && remaining.size > 0; step++) {
    await page.keyboard.press("Tab");
    for (const control of remaining) {
      if ((await focused.and(control).count()) > 0) remaining.delete(control);
    }
  }
  expect([...remaining].map(String)).toEqual([]);
}

async function captureWidths(page: Page, state: "empty" | "mixed") {
  const screenshotDirectory = process.env["HUB_CONNECTIONS_SCREEN_DIR"];
  for (const viewport of [wide, narrow]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .include("main")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    if (screenshotDirectory !== undefined) {
      await page.screenshot({
        path: join(screenshotDirectory, `${state}-${viewport.width}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize(wide);
  await expect(page.getByRole("navigation", { name: "Organization", exact: true })).toBeVisible();
}
