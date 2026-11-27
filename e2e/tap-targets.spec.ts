import { expect, type Page } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";
import { expectNoSidewaysScroll, fieldSizes, hitExtent } from "./helpers/tap-targets.js";

const AGENT = "opencode/gateway/vendor/model-v1";
const owner = { name: "Tap Owner", email: "tap-owner@example.com", password: "tap-owner-password" };

test("fields are 44 px on a phone and keep their desktop size above it", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  const triggers = new OrganizationTriggers(page);
  await triggers.open();

  await test.step("the list filters, search and page size", async () => {
    await expectFieldHeights(page, 3);
  });

  await triggers.startNew();
  await triggers.configureSlackMention({
    name: "tap-targets",
    connection: "company-slack",
    daemon,
    cwd: "/workspace/acme",
    users: "U123",
    agent: AGENT,
    mode: "full-access",
    thinking: "low",
    providerOptions: "{}",
    prompt: "Review the request.",
  });

  await test.step("the trigger form: inputs, Select and comboboxes line up", async () => {
    await expectFieldHeights(page, 8);
  });

  await test.step("the form fits a 320 px phone", async () => {
    await page.setViewportSize({ width: 320, height: 800 });
    await expectNoSidewaysScroll(page);
  });
});

async function expectFieldHeights(page: Page, atLeast: number) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const desktop = await fieldSizes(page);
  expect(desktop.length).toBeGreaterThanOrEqual(atLeast);
  for (const { name, height } of desktop) expect(height, name).toBeLessThanOrEqual(32);
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await fieldSizes(page);
  expect(phone.map(({ name }) => name)).toEqual(desktop.map(({ name }) => name));
  for (const { name, height } of phone) expect(height, name).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("breadcrumb and settings tab links have 44 px hit areas on a phone and look the same", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const org = /\/o\/[^/]+\//u.exec(page.url())?.[0] ?? "/";
  await page.goto(new URL(`${org}settings/team`, page.url()).toString());
  const tab = page.getByRole("link", { name: "API keys", exact: true });
  const trail = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link");

  await test.step("above a phone the tab keeps its 36 px box and answers only inside it", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    expect((await tab.boundingBox())?.height).toBe(36);
    expect((await hitExtent(tab)).height).toBeLessThanOrEqual(37);
  });

  await test.step("on a phone the tab answers over 44 px without moving", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await tab.boundingBox())?.height).toBe(36);
    const reach = await hitExtent(tab);
    expect(Math.round(reach.height)).toBeGreaterThanOrEqual(44);
    expect(Math.round(reach.width)).toBeGreaterThanOrEqual(44);
  });

  await test.step("on a phone each breadcrumb link answers over 44 px and the header stays 48 px", async () => {
    expect(await trail.count()).toBeGreaterThanOrEqual(2);
    for (const link of await trail.all()) {
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(Math.round((await hitExtent(link)).height)).toBeGreaterThanOrEqual(44);
    }
    const header = await page.locator("header").first().boundingBox();
    expect(header?.height).toBe(48);
  });
});
