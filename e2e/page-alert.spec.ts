import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";

const SHOTS = "/tmp/hub-ui/page-alert-shots";
const owner = {
  name: "Alert Owner",
  email: "page-alert-owner@example.test",
  password: "page-alert-owner-password",
};
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test.describe.configure({ timeout: 180_000 });

test("a page alert is a heavy rule and a square mark, never a box, in both themes and sizes", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedSlackConnection("owner", "slack", "Acme");
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const alert = page
    .locator('[data-slot="alert"]')
    .filter({ hasText: "Slack needs authorization" });
  await expect(alert).toBeVisible();
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${colorScheme}\\b`, "u"));
      await expectRuleAndMark(alert);
      await expectInsideViewport(page, alert, viewport.width);
      const results = await new AxeBuilder({ page })
        .include('[data-slot="alert"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(results.violations).toEqual([]);
      await page.screenshot({
        path: join(SHOTS, `home-alert-${viewport.width}x${viewport.height}-${colorScheme}.png`),
        animations: "disabled",
      });
    }
  }
  await expectActionPlacement(page, alert);
});

test("a finished connection change is a toast and leaves no alert on the page", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedSlackConnection("owner", "slack", "Acme");
  await projectApp(page).navigation.openOrganizationSection("Connections");
  const row = page.getByRole("listitem").filter({ hasText: "Acme" });
  await row.getByRole("button", { name: /^Actions for /u }).click();
  await page.getByRole("menuitem", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke connection" }).click();
  const log = page.getByRole("log", { name: "Notifications" });
  await expect(log.getByText("Slack disconnected.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="alert"]').filter({ hasText: "disconnected" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("status").filter({ hasText: "disconnected" })).toHaveCount(0);
  await page.screenshot({ path: join(SHOTS, "connections-toast.png"), animations: "disabled" });
});

async function expectRuleAndMark(alert: Locator): Promise<void> {
  const style = await alert.evaluate((node) => {
    const css = getComputedStyle(node);
    const mark = node.querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
    const markBox = mark?.getBoundingClientRect();
    const markCss = mark === null || mark === undefined ? undefined : getComputedStyle(mark);
    return {
      top: css.borderTopWidth,
      topColor: css.borderTopColor,
      right: css.borderRightWidth,
      bottom: css.borderBottomWidth,
      left: css.borderLeftWidth,
      radius: css.borderTopLeftRadius,
      background: css.backgroundColor,
      foreground: getComputedStyle(document.body).color,
      markWidth: markBox?.width,
      markHeight: markBox?.height,
      markRadius: markCss?.borderRadius,
      markColor: markCss?.backgroundColor,
    };
  });
  expect(style.top).toBe("2px");
  expect(style.topColor).toBe(style.foreground);
  expect([style.right, style.bottom, style.left]).toEqual(["0px", "0px", "0px"]);
  expect(style.radius).toBe("0px");
  expect(style.background).toBe("rgba(0, 0, 0, 0)");
  expect(style.markWidth).toBe(style.markHeight);
  expect(style.markRadius).toBe("0px");
  expect(style.markColor).not.toBe("rgba(0, 0, 0, 0)");
}

async function expectInsideViewport(page: Page, alert: Locator, width: number): Promise<void> {
  const box = await alert.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

async function expectActionPlacement(page: Page, alert: Locator): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  const link = alert.getByRole("link", { name: "Open connections", exact: true });
  const [alertBox, linkBox] = await Promise.all([alert.boundingBox(), link.boundingBox()]);
  expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(alertBox!.x + alertBox!.width);
  expect(linkBox!.height).toBeGreaterThanOrEqual(24);
  await page.setViewportSize({ width: 1280, height: 800 });
  const [wideAlert, wideLink] = await Promise.all([alert.boundingBox(), link.boundingBox()]);
  expect(wideLink!.x).toBeGreaterThan(wideAlert!.x + wideAlert!.width / 2);
}
