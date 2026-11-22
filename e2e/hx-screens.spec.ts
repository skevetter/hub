import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test as browserTest } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

/**
 * Captures every organization screen at desktop and phone width with seeded records. It only
 * runs when HX_SHOTS names a directory, so the ordinary suite does not pay for it.
 */
const SHOTS = process.env["HX_SHOTS"];

const test = browserTest.extend<{ sessionRuntime: void }>({
  sessionRuntime: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
    async ({}, run) => {
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

test.describe.configure({ timeout: 240_000 });

async function capture(page: Page, name: string) {
  if (SHOTS === undefined) return;
  await mkdir(SHOTS, { recursive: true });
  for (const [label, width, height] of [
    ["1280", 1280, 800],
    ["390", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

test("captures the organization screens", async ({ hub, page }) => {
  test.skip(SHOTS === undefined, "set HX_SHOTS to a directory to capture screens");
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const origin = hub.primaryApplication().origin;
  const [row] = await hub
    .primaryApplication()
    .query("select slug from organization where name = $1", ["Acme"]);
  const base = `${origin}/o/${String(row?.["slug"])}`;
  const open = async (path: string, heading: string) => {
    await page.goto(`${base}/${path}`);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  };

  await open("home", "Home");
  await capture(page, "home-fresh");
  await open("daemons", "Daemons");
  await capture(page, "daemons-empty");
  await open("connections", "Connections");
  await capture(page, "connections-empty");

  await hub.seedSlackConnection("owner", "slack", "Acme");
  await hub.seedGitHubConnection("Acme", "acme-inc");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedConnectedOnlyDaemon("owner", "laptop");
  const triggers = new OrganizationTriggers(page);
  await open("triggers", "Triggers");
  await triggers.startNew();
  await triggers.configureManual({
    name: "deploy",
    daemon,
    cwd: "/workspace",
    agent: "codex/gpt-5.4",
    mode: "full-access",
    thinking: "high",
    prompt: "Run it",
  });
  await triggers.save("deploy");
  await hub.seedTriggerRun("deploy", { minutesAgo: 3, status: "running" });
  await hub.seedTriggerRun("deploy", { minutesAgo: 42, status: "succeeded" });
  await hub.seedTriggerRun("deploy", { minutesAgo: 60 * 5, status: "failed" });
  await hub.seedTriggerRun("deploy", { minutesAgo: 60 * 30, status: "succeeded" });

  await open("home", "Home");
  await capture(page, "home-populated");
  await open("daemons", "Daemons");
  await capture(page, "daemons-populated");
  await open("connections", "Connections");
  await capture(page, "connections-populated");
  await open("triggers", "Triggers");
  await capture(page, "triggers");
  await open("activity", "Activity");
  await capture(page, "activity");
  await open("sessions", "Sessions");
  await capture(page, "sessions");
  await page.goto(`${base}/settings`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await capture(page, "settings");
});
