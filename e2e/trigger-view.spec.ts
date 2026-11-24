import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./app.js";
import type { PaseoHub } from "./helpers/hub.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "/tmp/hub-ui/trigger-view-shots";
const NAME = "review-queue";
const owner = {
  name: "Trigger Owner",
  email: "trigger-view-owner@example.test",
  password: "trigger-view-owner-password",
};

test("reads, edits, and starts a trigger as a verified user", async ({ hub, page }) => {
  const daemon = await createManualTrigger(hub, page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectReadView(page, daemon);
  await captureThemes(page, { width: 1280, height: 800 });
  await captureThemes(page, { width: 390, height: 844 });
  await expectReadView(page, daemon);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expectLegacyEditorRedirect(page);

  const runNow = page.getByRole("button", { name: "Run now" });
  await runNow.click();
  const status = page.getByRole("status").filter({ hasText: "Run started." });
  await expect(status).toBeVisible();
  const run = status.getByRole("link", { name: "View run" });
  const href = await run.getAttribute("href");
  expect(href).toMatch(/\/activity\/[0-9a-f-]+$/u);
  await run.click();
  await expect(page).toHaveURL(/\/activity\/[0-9a-f-]+$/u);
  await expect(page.getByText(`manual - ${NAME}`, { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("list", { name: "Recent runs" }).getByRole("link")).toHaveAttribute(
    "href",
    href ?? "",
  );
  await expect(
    page.getByText("Last 24 hours: 1 total, 0 succeeded, 0 failed or timed out."),
  ).toBeVisible();
});

test("shows the verified-email refusal without creating a run", async ({ hub, page }) => {
  await createManualTrigger(hub, page);
  const app = hub.primaryApplication();
  await app.query('update "user" set email_verified = false where email = $1', [owner.email]);
  const runNow = page.getByRole("button", { name: "Run now" });
  const refusal = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.startsWith("/_serverFn/") &&
      response.request().method() === "POST" &&
      response.status() === 403,
  );
  await runNow.click();
  await refusal;
  await expect(
    page.getByRole("status").filter({ hasText: "Verify your email to run this trigger." }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("No runs yet", { exact: true })).toBeVisible();
  expect(await app.query("select id from trigger_runs")).toEqual([]);
});

async function createManualTrigger(hub: PaseoHub, page: Page): Promise<string> {
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
  await triggers.openReadView(NAME);
  return daemon;
}

async function expectReadView(page: Page, daemon: string): Promise<void> {
  await expect(page.getByRole("heading", { name: NAME, level: 1 })).toBeVisible();
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      `When a manual or webhook request arrives from ${owner.email}, run codex/gpt-5.4 on host ${daemon}.`,
    ),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveAttribute(
    "href",
    /\/edit$/u,
  );
  await expect(page.getByText("No runs yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to invoke" })).toBeVisible();
  await expect(page.getByText("Webhook URL", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Facts" })).toBeVisible();
}

async function expectLegacyEditorRedirect(page: Page): Promise<void> {
  const readUrl = page.url();
  const legacy = new URL(readUrl);
  legacy.search = "?state=enabled&provider=manual&q=review&size=25&cursor=old-position";
  await page.goto(legacy.href);
  await expect(page).toHaveURL(
    ({ pathname, search }) => pathname.endsWith("/edit") && search === legacy.search,
  );
  await expect(page.locator("#trigger-editor-form")).toBeVisible();
  await page.goto(readUrl);
  await expect(page.getByRole("button", { name: "Run now" })).toBeEnabled();
}

async function captureThemes(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`, "u"));
    await page.screenshot({
      path: join(SHOTS, `${viewport.width}x${viewport.height}-${colorScheme}.png`),
    });
  }
}
