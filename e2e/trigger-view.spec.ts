import { join } from "node:path";
import { expect, type ElementHandle, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import type { PaseoHub } from "./helpers/hub.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "/tmp/hub-ui/trigger-view-shots";
const NAME = "review-queue";
const PHONE = { width: 390, height: 844 };
const TOAST_MS = 9000;
const REFUSAL = "Verify your email to run this trigger.";
const LONG_REFUSAL = `${REFUSAL} We could not confirm the address on this account, so Hub did not start the run. Open the verification message in your inbox, follow its link, then come back to this page and try again. If the message is missing, request a new one from your account settings (reference trace-0123456789abcdef0123456789abcdef).`;
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

test("announces the run result in the bar's live region at phone width", async ({ hub, page }) => {
  await createManualTrigger(hub, page);
  await page.setViewportSize(PHONE);
  const bar = page.locator('[data-slot="sticky-actions"]');
  const region = await readyLiveRegion(bar);
  await bar.getByRole("button", { name: "Run now" }).click();
  await expectAnnounced(region, "Run started.");
  await expect(bar.getByRole("status").getByRole("link", { name: "View run" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Run started." })).toHaveCount(1);
});

test("wraps a long refusal inside the bar without covering the navigation", async ({
  hub,
  page,
}) => {
  await createManualTrigger(hub, page);
  const app = hub.primaryApplication();
  await app.query('update "user" set email_verified = false where email = $1', [owner.email]);
  await page.setViewportSize(PHONE);
  await lengthenRefusal(page);
  const bar = page.locator('[data-slot="sticky-actions"]');
  const region = await readyLiveRegion(bar);
  await bar.getByRole("button", { name: "Run now" }).click();
  await expectAnnounced(region, LONG_REFUSAL);
  await expect(bar.getByRole("status")).toBeVisible();
  for (const where of ["top", "bottom"] as const) {
    await scrollTo(bar, where);
    await expectBarFlushAboveNavigation(page);
    await expectBarContained(page, bar);
  }
  const lastFact = page.getByText("/workspace", { exact: true });
  const [fact, barBox] = await Promise.all([lastFact.boundingBox(), bar.boundingBox()]);
  if (fact === null || barBox === null) throw new Error("layout not measurable");
  expect(fact.y + fact.height).toBeLessThanOrEqual(barBox.y);
});

test("confirms a saved trigger with a toast that holds, links and dismisses", async ({
  hub,
  page,
}) => {
  await createManualTrigger(hub, page);
  const log = page.getByRole("log", { name: "Notifications" });
  await expect(log).toHaveAttribute("aria-live", "polite");
  await expect(log).toContainText("Trigger saved");
  await dismissAllToasts(log);
  await expect(log).toHaveText("");
  const region = await log.elementHandle();
  if (region === null) throw new Error("notification region missing");
  await page.clock.install();
  await saveEdit(page);
  await expectAnnounced(region, "Trigger saved");
  const toast = log.locator('[data-slot="toast"]');
  await expect(toast.getByRole("link", { name: "View trigger" })).toBeVisible();
  await toast.hover();
  await page.clock.fastForward(TOAST_MS);
  await expect(toast).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(TOAST_MS);
  await expect(toast).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Triggers" })).toBeVisible();
});

test("places a toast clear of the phone bars and returns focus when it is dismissed", async ({
  hub,
  page,
}) => {
  await createManualTrigger(hub, page);
  await page.setViewportSize(PHONE);
  const log = page.getByRole("log", { name: "Notifications" });
  await dismissAllToasts(log);
  await saveEdit(page);
  const toast = log.locator('[data-slot="toast"]');
  await expect(toast).toBeVisible();
  await expectToastClearOfBars(page, toast);
  const dismiss = toast.getByRole("button", { name: "Dismiss: Trigger saved" });
  const target = await dismiss.boundingBox();
  expect(target?.width).toBeGreaterThanOrEqual(44);
  expect(target?.height).toBeGreaterThanOrEqual(44);
  await toast.getByRole("link", { name: "View trigger" }).click();
  await expect(page.getByRole("heading", { name: NAME, level: 1 })).toBeVisible();
  await expect(toast).toBeVisible();
  await dismiss.click();
  await expect(toast).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("content");
});

async function dismissAllToasts(log: Locator): Promise<void> {
  const dismiss = log.getByRole("button", { name: /^Dismiss/u });
  while ((await dismiss.count()) > 0) await dismiss.first().click();
}

async function saveEdit(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  const form = page.locator("#trigger-editor-form");
  await form.getByRole("checkbox", { name: "Enabled" }).uncheck();
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/triggers$/u);
}

async function expectToastClearOfBars(page: Page, toast: Locator): Promise<void> {
  const [box, header, nav] = await Promise.all([
    toast.boundingBox(),
    page.locator("header:visible").first().boundingBox(),
    page.getByRole("navigation", { name: "Quick navigation" }).boundingBox(),
  ]);
  if (box === null || header === null || nav === null) throw new Error("layout not measurable");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(box.y + box.height).toBeLessThanOrEqual(nav.y);
}

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
  await expect(bar.getByRole("button", { name: "Run now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run now" })).toHaveCount(1);
  await scrollTo(bar, "top");
  expect(await overflows(page)).toBe(true);
  await expectBarFlushAboveNavigation(page);
  await scrollTo(bar, "bottom");
  await expectBarFlushAboveNavigation(page);
  const block = await page.locator('[data-slot="state-block"]').first().boundingBox();
  const link = await page
    .getByRole("list", { name: "Recent runs" })
    .getByRole("link")
    .boundingBox();
  if (block === null || link === null) throw new Error("run row not measurable");
  expect(block.height).toBe(28);
  expect(block.width).toBeGreaterThanOrEqual(96);
  expect(block.width).toBeLessThan(390 / 2);
  expect(block.y + block.height).toBeLessThanOrEqual(link.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
}

/** The live region must already be on the page, empty, so a screen reader sees its text change. */
async function readyLiveRegion(bar: Locator): Promise<ElementHandle> {
  const region = bar.getByRole("status");
  await expect(region).toBeVisible();
  await expect(region).toHaveText("");
  await expect(region).toHaveAttribute("aria-live", "polite");
  const handle = await region.elementHandle();
  if (handle === null) throw new Error("live region missing");
  return handle;
}

/** The same node gains the text, which is what makes a polite region announce it. */
async function expectAnnounced(region: ElementHandle, text: string): Promise<void> {
  await expect
    .poll(async () => region.evaluate((node) => (node.isConnected ? node.textContent : "")))
    .toContain(text);
}

/** Answers the refusal with a message long enough to wrap onto several lines on a phone. */
async function lengthenRefusal(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/_serverFn/"),
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replaceAll(REFUSAL, LONG_REFUSAL);
      const headers = Object.fromEntries(
        Object.entries(response.headers()).filter(([name]) => name !== "content-length"),
      );
      return route.fulfill({ response, headers, body });
    },
  );
}

async function expectBarContained(page: Page, bar: Locator): Promise<void> {
  const [barBox, statusBox, buttonBox, navBox] = await Promise.all([
    bar.boundingBox(),
    bar.getByRole("status").boundingBox(),
    bar.getByRole("button", { name: "Run now" }).boundingBox(),
    page.getByRole("navigation", { name: "Quick navigation" }).boundingBox(),
  ]);
  if (barBox === null || statusBox === null || buttonBox === null || navBox === null) {
    throw new Error("layout not measurable");
  }
  expect(statusBox.x).toBeGreaterThanOrEqual(0);
  expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(PHONE.width);
  expect(statusBox.y).toBeGreaterThanOrEqual(barBox.y);
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(navBox.y);
  expect(statusBox.height).toBeGreaterThan(40);
  expect(barBox.y).toBeGreaterThan(PHONE.height / 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(PHONE.width);
  const covered = await bar.getByRole("button", { name: "Run now" }).evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return top !== button && !button.contains(top);
  });
  expect(covered).toBe(false);
}

async function overflows(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);
}

/**
 * Scrolls the container that really scrolls (an ancestor with overflow, else the document) to its
 * start or end, and proves it got there, so a geometry check that follows is not made mid-page.
 */
async function scrollTo(bar: Locator, where: "top" | "bottom"): Promise<void> {
  const atEdge = await bar.evaluate((element, target) => {
    let node: HTMLElement | null = element.parentElement;
    while (node !== null && !scrollsVertically(node)) node = node.parentElement;
    const scroller = node ?? document.scrollingElement;
    if (scroller === null) return false;
    scroller.scrollTo(0, target === "top" ? 0 : scroller.scrollHeight);
    if (target === "top") return scroller.scrollTop === 0;
    return Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 1;

    function scrollsVertically(candidate: HTMLElement): boolean {
      const { overflowY } = getComputedStyle(candidate);
      return /(auto|scroll)/u.test(overflowY) && candidate.scrollHeight > candidate.clientHeight;
    }
  }, where);
  expect(atEdge).toBe(true);
}

async function expectBarFlushAboveNavigation(page: Page): Promise<void> {
  const bar = page.locator('[data-slot="sticky-actions"]');
  const navigation = page.getByRole("navigation", { name: "Quick navigation" });
  await expect
    .poll(async () => {
      const [barBox, navBox] = await Promise.all([bar.boundingBox(), navigation.boundingBox()]);
      if (barBox === null || navBox === null) return Number.NaN;
      return (
        Math.abs(barBox.y + barBox.height - navBox.y) +
        Math.abs(barBox.x) +
        Math.abs(barBox.width - 390)
      );
    })
    .toBeLessThanOrEqual(1);
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
