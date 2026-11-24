import { mkdir } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { test } from "./app.js";

const shots = "/tmp/hub-ui/step2-shots";
const owner = {
  name: "Alice",
  email: "alice-route-states@example.com",
  password: "alice-route-states-password",
};

for (const width of [390, 1280]) {
  test(`route states inside the shell at ${width}px`, async ({ hub, page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    const home = page.url();
    const missing = home.replace(/\/home$/u, "/does-not-exist");
    await page.goto(missing);
    await expect(page.getByRole("heading", { name: "Page not found", level: 1 })).toBeVisible();
    await expectShell(page, width);
    await capture(page, "not-found", width);
    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page).toHaveURL(home);
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
    await page.goto(home.replace(/\/home$/u, "/settings/billing"));
    await expect(page.getByRole("heading", { name: "Page not found", level: 1 })).toBeVisible();
    await expectShell(page, width);
    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();

    await page.route("**/_serverFn/**", (route) => route.abort());
    await page.getByRole("link", { name: "Triggers", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Page unavailable", level: 1 })).toBeVisible();
    await expectShell(page, width);
    await capture(page, "error", width);
    await page.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Triggers", level: 1 })).toBeVisible();
  });
}

test("unknown signed-out paths use the root not found page", async ({ hub, page }) => {
  await page.goto(`${hub.primaryApplication().origin}/unknown-route`);
  await expect(page.getByRole("heading", { name: "Page not found", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
});

async function expectShell(page: Page, width: number) {
  const name = width === 390 ? "Quick navigation" : "Organization";
  await expect(page.getByRole("navigation", { name, exact: true })).toBeVisible();
}

async function capture(page: Page, state: string, width: number) {
  await mkdir(shots, { recursive: true });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    if (width === 390) {
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: `${shots}/${state}-${width}-${colorScheme}.png` });
  }
}
