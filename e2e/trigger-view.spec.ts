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
  await captureThemes(page, { width: 1280, height: 800 }, "empty");
  await captureThemes(page, { width: 390, height: 844 }, "empty");
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
  await expectPhoneLayout(page);
  await captureThemes(page, { width: 390, height: 844 }, "with-run");
  await expectDesktopLayout(page);
  await captureThemes(page, { width: 1280, height: 800 }, "with-run");
});

test("follows a legacy editor link on the client with the same editor state as a direct link", async ({
  hub,
  page,
}) => {
  await createManualTrigger(hub, page);
  const readPath = new URL(page.url()).pathname;
  await page.evaluate(() => {
    Object.assign(window, { keptAcrossNavigation: true });
  });
  const search = "?state=disabled&provider=manual&q=a%20b&cursor=x%2By&size=50&unknown=1";
  const legacy = await clientNavigate(page, `${readPath}${search}`, "editor");
  expect(legacy.pathname).toBe(`${readPath}/edit`);
  await clientNavigate(page, readPath, "read");
  const direct = await clientNavigate(page, `${readPath}/edit${search}`, "editor");
  expect(Object.fromEntries(legacy.searchParams)).toEqual({
    state: "disabled",
    provider: "manual",
    q: "a b",
    cursor: "x+y",
    size: "50",
    unknown: "1",
  });
  expect(Object.fromEntries(legacy.searchParams)).toEqual(Object.fromEntries(direct.searchParams));
  await clientNavigate(page, readPath, "read");
  const plain = await clientNavigate(page, `${readPath}?extra=1`, "read");
  expect(plain.pathname).toBe(readPath);
  expect(await page.evaluate(() => Reflect.get(window, "keptAcrossNavigation"))).toBe(true);
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

/** Moves the router without a page load, as a pasted pushState and a popstate would. */
async function clientNavigate(page: Page, href: string, expected: "editor" | "read"): Promise<URL> {
  await page.evaluate((target) => {
    window.history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, href);
  if (expected === "editor") await expect(page.locator("#trigger-editor-form")).toBeVisible();
  else await expect(page.getByRole("heading", { name: NAME, level: 1 })).toBeVisible();
  return new URL(page.url());
}

async function expectPhoneLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  const bar = page.locator('[data-slot="sticky-actions"]');
  const runNow = bar.getByRole("button", { name: "Run now" });
  await expect(runNow).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(1);
  const nav = await page.getByRole("navigation", { name: "Quick navigation" }).boundingBox();
  const box = await bar.boundingBox();
  const viewport = page.viewportSize();
  if (nav === null || box === null || viewport === null) throw new Error("layout not measurable");
  expect(box.y + box.height).toBeCloseTo(nav.y, 0);
  expect(box.x).toBe(0);
  expect(box.width).toBe(viewport.width);
  const rowBlock = page.locator('[data-slot="state-block"]').first();
  const rowLink = page.getByRole("list", { name: "Recent runs" }).getByRole("link");
  const block = await rowBlock.boundingBox();
  const link = await rowLink.boundingBox();
  if (block === null || link === null) throw new Error("run row not measurable");
  expect(block.height).toBe(28);
  expect(block.width).toBeLessThan(viewport.width / 2);
  expect(block.y + block.height).toBeLessThanOrEqual(link.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
}

async function expectDesktopLayout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('[data-slot="sticky-actions"]')).toBeHidden();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(1);
  const block = await page.locator('[data-slot="state-block"]').first().boundingBox();
  const link = await page
    .getByRole("list", { name: "Recent runs" })
    .getByRole("link")
    .boundingBox();
  if (block === null || link === null) throw new Error("run row not measurable");
  expect(block.x + block.width).toBeLessThanOrEqual(link.x);
  expect(Math.abs(block.y + block.height / 2 - (link.y + link.height / 2))).toBeLessThan(24);
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
  name: string,
): Promise<void> {
  await page.setViewportSize(viewport);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`, "u"));
    await page.screenshot({
      path: join(SHOTS, `${name}-${viewport.width}x${viewport.height}-${colorScheme}.png`),
      animations: "disabled",
    });
  }
}
