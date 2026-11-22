import { expect } from "@playwright/test";
import { test as browserTest } from "./app.js";

const test = browserTest.extend<{ sessionRuntime: void }>({
  sessionRuntime: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
    async ({}, run) => {
      // The browser fixture inherits the worker environment when it spawns the local Hub.
      const flag = "PASEO_HUB_INTERACTIVE_SESSIONS";
      const previous = process.env[flag];
      process.env[flag] = "true";
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
  name: "Ada Park",
  email: "ada@example.com",
  password: "ada-example-password",
};

test.describe.configure({ timeout: 180_000 });

test("Home restores keyboard focus after a retry", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  let failHome = true;
  await page.route("**/_serverFn/**", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (failHome && body.includes("runCounts")) {
      await route.fulfill({ status: 500, body: "Home test failure" });
    } else {
      await route.fulfill({ response, body });
    }
  });
  await page.reload();
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  failHome = false;
  await retry.press("Enter");
  await expect(page.getByText("Runs, 24 hours", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeFocused();
});

test("Home reserves the loaded tile heights on a 390 px viewport", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseSnapshot = () => {};
  const heldSnapshot = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  await page.route("**/_serverFn/**", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("runCounts")) await heldSnapshot;
    await route.fulfill({ response, body });
  });
  await page.reload();
  const dimensions = (container: ReturnType<typeof page.locator>) =>
    container
      .locator("div.grid-cols-2 > section")
      .evaluateAll((tiles) => tiles.map((tile) => tile.getBoundingClientRect().height));
  const loading = page.getByLabel("Loading Home");
  let loadingHeights: number[];
  try {
    await expect(loading).toBeVisible();
    loadingHeights = await dimensions(loading);
    expect(loadingHeights).toHaveLength(5);
  } finally {
    releaseSnapshot();
  }
  await expect(page.getByText("Open sessions", { exact: true })).toBeVisible();
  expect(await dimensions(page.locator("main"))).toEqual(loadingHeights);
});

test("reads Home as figures, a checklist the member can put away, and prompts to try", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  await test.step("a fresh organization shows zeroed figures and nothing to worry about", async () => {
    for (const label of [
      "Runs, 24 hours",
      "Runs, 30 days",
      "Active triggers",
      "Daemons connected",
      "Open sessions",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  const checklist = page.getByRole("button", { name: /Getting started/u });
  const steps = page.getByRole("list", { name: "Getting started" });
  await test.step("the checklist leads with the daemon and counts six steps with sessions on", async () => {
    await expect(checklist).toContainText("0 of 6 done");
    await expect(
      page.getByRole("progressbar", { name: "Getting started progress" }),
    ).toHaveAttribute("aria-valuetext", "0 of 6 done");
    await expect(steps.getByRole("listitem").first()).toContainText("Connect a daemon");
    await expect(steps.getByRole("link", { name: "Create a profile", exact: true })).toBeVisible();
  });

  await test.step("minimizing it with the keyboard is remembered for this member", async () => {
    await checklist.focus();
    await page.keyboard.press("Enter");
    await expect(steps).toBeHidden();
    await expect(checklist).toContainText("0 of 6 done");
    await page.reload();
    await expect(page.getByRole("button", { name: /Getting started/u })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(steps).toBeHidden();
  });

  await test.step("things to try switches surface with the arrow keys and names what is missing", async () => {
    const surfaces = page.getByRole("radiogroup", { name: "Where to try it" });
    await surfaces.getByRole("radio", { name: "Linear" }).focus();
    await expect(
      page.getByRole("list", { name: "Linear examples" }).getByRole("listitem"),
    ).toHaveCount(3);
    await page.keyboard.press("ArrowRight");
    await expect(surfaces.getByRole("radio", { name: "GitHub" })).toBeChecked();
    await expect(page.getByRole("list", { name: "GitHub examples" })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(surfaces.getByRole("radio", { name: "Sessions" })).toBeChecked();
    await expect(page.getByRole("link", { name: "Create a profile", exact: true })).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.getByRole("link", { name: "Connect Linear", exact: true }).click();
    await expect(page).toHaveURL(/\/connections$/u);
  });

  await test.step("a connection that needs authorization is the one alert, with its way out", async () => {
    await hub.seedSlackConnection("owner", "slack", "Acme");
    await page.getByRole("link", { name: "Home", exact: true }).click();
    const alert = page
      .locator('[data-slot="alert"]')
      .filter({ hasText: "Slack needs authorization" });
    await expect(alert).toContainText("Hub cannot use Acme");
    expect(await alert.getAttribute("role")).toBeNull();
    expect(await alert.getAttribute("aria-live")).toBeNull();
    await alert.getByRole("link", { name: "Open connections", exact: true }).click();
    await expect(page).toHaveURL(/\/connections$/u);
  });

  await test.step("Home fits a 390 px phone without scrolling sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /Getting started/u }).click();
    await expect(steps).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
