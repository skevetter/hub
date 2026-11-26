import { expect, type Page } from "@playwright/test";
import { test as browserTest } from "./app.js";
import { OrganizationHome } from "./helpers/home.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

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
    if (failHome && body.includes("triggerRuns")) {
      await route.fulfill({ status: 500, body: "Home test failure" });
    } else {
      await route.fulfill({ response, body });
    }
  });
  try {
    await page.reload();
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    failHome = false;
    await retry.press("Enter");
    await expect(page.getByText("triggers failing", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeFocused();
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const width of [390, 1280])
  test(`Home reserves the loaded figure heights at ${String(width)} px`, async ({ hub, page }) => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await hub.connectProviderDaemon("owner", "Acme");
    await page.setViewportSize({ width, height: 844 });
    let releaseSnapshot = () => {};
    const heldSnapshot = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    await page.route("**/_serverFn/**", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (body.includes("triggerRuns")) await heldSnapshot;
      await route.fulfill({ response, body });
    });
    await page.reload();
    const dimensions = (figures: ReturnType<typeof page.locator>) =>
      figures.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height),
      );
    const loading = page.getByRole("group", { name: "Loading Home" });
    let loadingHeights: number[];
    try {
      await expect(loading).toBeVisible();
      loadingHeights = await dimensions(loading.locator("div.grid-cols-2 > div"));
      expect(loadingHeights).toHaveLength(4);
    } finally {
      releaseSnapshot();
    }
    await expect(page.getByText("triggers failing", { exact: true })).toBeVisible();
    const needsYou = page.getByRole("group", { name: "Needs you", exact: true });
    expect(await dimensions(needsYou.locator("[data-slot=figure]"))).toEqual(loadingHeights);
  });

async function saveGitHubCommentTrigger(page: Page, name: string, daemon: string) {
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureManual({
    name,
    daemon,
    cwd: "/workspace",
    agent: "codex/gpt-5.4",
    mode: "full-access",
    thinking: "high",
    prompt: "Review this.",
  });
  await triggers.switchToYaml();
  await triggers.replaceYaml(`
name: ${name}
on:
  github.pull_request_comment_created:
    filters: { from_users: ["octocat"] }
run:
  target: { daemon: ${daemon}, cwd: /workspace }
  agent: { provider: codex, model: gpt-5.4, mode: full-access }
  prompt: Review this.
`);
  await triggers.save(name);
}

const WEEK_MINUTES = 7 * 24 * 60;
const HOME_SHOTS = "/tmp/hub-ui/home-shots";

test("Home counts each thing that needs a person and links to it", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.connectGitHub("owner");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedConnectedOnlyDaemon("owner", "laptop");
  await hub.seedSlackConnection("owner", "slack", "Acme Slack");
  await hub.primaryApplication().query("update slack_connections set scopes = '[]'::jsonb");
  await saveGitHubCommentTrigger(page, "reviewer", daemon);
  await hub.seedTriggerRun("reviewer", {
    minutesAgo: WEEK_MINUTES + 3 * 24 * 60,
    status: "succeeded",
    provider: "github",
  });
  await hub.seedTriggerRun("reviewer", { minutesAgo: 1, status: "failed" });
  await hub.seedProviderReceipt("reviewer", { minutesAgo: 60, provider: "github" });
  const home = new OrganizationHome(page);
  await home.open();

  await test.step("each figure counts its thing and says what it found", async () => {
    await home.expectNeedsYou("failing", 1);
    await home.expectNeedsYou("app to authorize", 1);
    await home.expectNeedsYouCaption("app to authorize", "Acme Slack.");
    await home.expectNeedsYou("daemon to check", 1);
    await home.expectNeedsYou("stopped matching", 1);
    await home.expectNeedsYouCaption(
      "stopped matching",
      "reviewer matched 1 the week before and none since.",
    );
    await home.expectRuns(2, 1);
    await expect(home.runsChart()).toHaveAttribute("aria-label", /1 run, 1 did not finish/u);
    await home.expectRemovedSurfacesAbsent();
  });

  await test.step("each figure has one link to where the person acts", async () => {
    const links = [
      ["failing", "Review runs", /\/activity\?.*status=unsuccessful/u],
      ["app to authorize", "Open connections", /\/connections$/u],
      ["daemon to check", "View daemons", /\/daemons$/u],
      ["stopped matching", "Open trigger", /\/triggers\/[0-9a-f-]{36}$/u],
    ] as const;
    for (const [unit, name, url] of links) {
      await home.followNeedsYouLink(unit, name);
      await expect(page).toHaveURL(url);
      await page.goBack();
      await home.expectOpen();
    }
  });

  await test.step("the figures fit a 390 px phone with touch-sized links", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await home.expectNoHorizontalScroll();
    const links = await home.needsYou().getByRole("link").all();
    expect(links).toHaveLength(4);
    for (const link of links) {
      const height = await link.evaluate((element) => element.getBoundingClientRect().height);
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });

  await test.step("both themes at both widths read cleanly", async () => {
    await home.captureThemes(HOME_SHOTS, "needs-you");
  });
});

test("Home wraps long record names at 390 px", async ({ hub, page }) => {
  const name = "w".repeat(60);
  const connection = "C".repeat(60);
  const daemonName = "d".repeat(60);
  const organization = "O".repeat(60);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", organization);
  await hub.connectGitHub("owner");
  const daemon = await hub.connectProviderDaemon("owner", organization);
  await hub.seedSlackConnection("owner", "slack", connection);
  const daemonId = await hub.seedDaemonSlug("owner", daemonName);
  await hub
    .primaryApplication()
    .query("update daemons set scopes = $1::jsonb where id = $2", [
      JSON.stringify(["hub.execute"]),
      daemonId,
    ]);
  await saveGitHubCommentTrigger(page, name, daemon);
  await hub.seedTriggerRun(name, { minutesAgo: 1, status: "succeeded" });
  await hub.seedTriggerRun(name, {
    minutesAgo: WEEK_MINUTES + 24 * 60,
    status: "succeeded",
    provider: "github",
  });
  await hub.seedProviderReceipt(name, { minutesAgo: 60, provider: "github" });
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: "GitHub" }).click();
  await expect(
    page.getByText(`${name} only starts for comments that match its filters.`),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByText(`Review authorization for ${connection} in Connections.`),
  ).toHaveCount(0);
  const home = new OrganizationHome(page);
  await home.expectStep("Enroll a daemon", daemonName);
  await home.expectStep("Create a trigger", name);
  const needsYou = page.getByRole("group", { name: "Needs you", exact: true });
  const stoppedLink = needsYou.getByRole("link", { name: "Open trigger", exact: true });
  await expect(needsYou).toContainText(name);
  expect(
    await stoppedLink.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(organization);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await stoppedLink.click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
});

test("Home names the expired run as the only remaining setup step", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.connectGitHub("owner");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureManual({
    name: "deploy",
    daemon,
    cwd: "/workspace",
    agent: "codex/gpt-5.4",
    mode: "full-access",
    thinking: "high",
    prompt: "Run it.",
  });
  await triggers.save("deploy");
  await hub.seedTriggerRun("deploy", { minutesAgo: 1, status: "succeeded" });
  await hub.grantOperator("owner");
  const home = new OrganizationHome(page);
  await home.open();
  const checklist = page.getByRole("list", { name: "Getting started" });
  for (const title of ["Create a session profile", "Start a session"]) {
    await expect(checklist.getByRole("listitem").filter({ hasText: title })).toContainText("To do");
  }

  await hub
    .primaryApplication()
    .query("update trigger_runs set created_at = now() - interval '8 days'");
  await expect(home.finishSetup()).toBeVisible();
  await home.finishSetup().press("Enter");
  const alert = page.getByRole("alert").filter({ hasText: "Setup could not be finished" });
  await expect(alert).toContainText(
    "Complete the remaining organization step to finish setup. Record a run.",
  );
  await expect(alert).toBeFocused();
});

test("Home gets the profile step from one fetch", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const slug = await hub.connectProviderDaemon("owner", "Acme");
  await hub.primaryApplication().query(
    `insert into interactive_session_profiles (id, organization_id, name, daemon_id, cwd, provider, status)
     select gen_random_uuid(), organization_id, 'Shared Home profile', id, '/workspace', 'codex', 'active'
     from daemons where slug = $1`,
    [slug],
  );
  let releaseProfiles = () => {};
  const heldProfiles = new Promise<void>((resolve) => {
    releaseProfiles = resolve;
  });
  let profileRequests = 0;
  await page.route("**/_serverFn/**", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("Shared Home profile")) {
      profileRequests += 1;
      await heldProfiles;
    }
    await route.fulfill({ response, body });
  });
  await page.reload();
  const row = page.getByRole("listitem").filter({ hasText: "Create a session profile" });
  try {
    await expect(row).toContainText("Checking profiles");
    await expect(row).not.toContainText("To do");
  } finally {
    releaseProfiles();
  }
  await expect(row).toContainText("Done");
  expect(profileRequests).toBe(1);
});

test("reads Home as needs-you figures, run counts, a checklist the member can put away, and prompts to try", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

  await test.step("a fresh organization shows four zeroes and nothing to worry about", async () => {
    const home = new OrganizationHome(page);
    await home.expectAllClear();
    await home.expectRuns(0, 0);
    await expect(home.runsChart()).toBeVisible();
    await home.expectRemovedSurfacesAbsent();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await home.captureThemes(HOME_SHOTS, "all-clear");
  });

  const checklist = page.getByRole("button", { name: /Getting started/u });
  const steps = page.getByRole("list", { name: "Getting started" });
  await test.step("the checklist leads with the daemon and counts six steps with sessions on", async () => {
    await expect(checklist).toContainText("0 of 6 done");
    await expect(
      page.getByRole("progressbar", { name: "Getting started progress" }),
    ).toHaveAttribute("aria-valuetext", "0 of 6 done");
    await expect(steps.getByRole("listitem").first()).toContainText("Enroll a daemon");
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
