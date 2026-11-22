import { AxeBuilder } from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { test as browserTest } from "./app.js";
import { OrganizationDaemons, seedDaemonProfile } from "./helpers/hx-daemons.js";

const test = browserTest.extend<{ interactiveSessions: boolean; sessionRuntime: void }>({
  interactiveSessions: [true, { option: true }],
  sessionRuntime: [
    async ({ interactiveSessions }, run) => {
      const flag = "PASEO_HUB_INTERACTIVE_SESSIONS";
      const previous = process.env[flag];
      process.env[flag] = String(interactiveSessions);
      try {
        await run();
      } finally {
        if (previous === undefined) delete process.env[flag];
        else process.env[flag] = previous;
      }
    },
    { auto: true },
  ],
});

const owner = {
  name: "Device Owner",
  email: "device-owner@example.com",
  password: "device-owner-password",
};

test("shows daemon devices and supports keyboard filters at phone width", async ({ hub, page }) => {
  test.setTimeout(120_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemons = new OrganizationDaemons(page);

  await daemons.open();
  await expect(page.getByText("No daemons connected", { exact: true })).toBeVisible();
  await expect(page.getByText(`paseo hub login ${hub.primaryApplication().origin}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "How to connect a daemon" })).toBeVisible();
  await daemons.capture("empty");

  const connected = await hub.connectProviderDaemon("owner", "Acme");
  const offline = "build-runner-eu-west-primary";
  await hub.seedConnectedOnlyDaemon("owner", offline);
  const profile = "Web review";
  await seedDaemonProfile(hub.primaryApplication(), "Acme", connected, profile);
  await page.reload();

  const active = daemons.device(connected);
  await expect(active.getByText("Connected", { exact: true })).toBeVisible();
  await expect(active.getByText(/OpenCode.*Codex|Codex.*OpenCode/u)).toBeVisible();
  await expect(active.getByText("Can run Hub automations")).toBeVisible();
  const profileLink = active.getByRole("link", { name: profile, exact: true });
  await expect(profileLink).toHaveAttribute("href", /\/o\/[^/]+\/sessions\/profiles$/u);
  const inactive = daemons.device(offline);
  await expect(inactive.getByText("Offline", { exact: true })).toBeVisible();
  await expect(
    inactive.getByText("Providers are available when this daemon connects."),
  ).toBeVisible();
  await expect(inactive.getByText("Connected only: Hub cannot start agents here")).toBeVisible();
  await expect(inactive.getByRole("button", { name: "Copy grant command" })).toBeVisible();
  await expect(inactive.getByText("No profiles use this daemon.")).toBeVisible();
  const announcement = page.getByRole("status").filter({ hasText: /daemon.*shown/u });
  await expect(announcement).toHaveCount(0);
  await daemons.capture("populated");

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await daemons.search().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "All" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Connected", exact: true })).toBeChecked();
  await expect(active).toBeVisible();
  await expect(inactive).toHaveCount(0);
  await expect(announcement).toHaveText("1 daemon shown");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Offline", exact: true })).toBeChecked();
  await expect(inactive).toBeVisible();
  await expect(active).toHaveCount(0);
  await daemons.capture("filtered");

  await page.keyboard.press("Shift+Tab");
  await expect(daemons.search()).toBeFocused();
  await page.keyboard.type("BUILD-RUNNER");
  await expect(inactive).toBeVisible();
  await expect(announcement).toHaveText("1 daemon shown");
  await page.keyboard.press("End");
  await page.keyboard.type("-no-such-device");
  await expect(page.getByText("No daemons match", { exact: true })).toBeVisible();
  await expect(announcement).toHaveText("0 daemons shown");
  const clear = page.getByRole("button", { name: "Clear filters", exact: true });
  await clear.focus();
  await page.keyboard.press("Enter");
  await expect(daemons.search()).toBeFocused();
  await expect(daemons.list().getByRole("listitem")).toHaveCount(2);
  await expect(announcement).toHaveText("2 daemons shown");
  await profileLink.click();
  await expect(page.getByRole("heading", { name: "Session profiles", level: 1 })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: profile })).toBeVisible();
});
