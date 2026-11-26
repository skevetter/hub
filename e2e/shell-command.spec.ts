import { expect } from "@playwright/test";
import { test } from "./app.js";

const owner = {
  name: "Alice",
  email: "alice-shell-command@example.com",
  password: "alice-shell-command-password",
};

test("the command menu navigates, switches organization, and applies theme without a reload", async ({
  hub,
  page,
  context,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await expect(page).toHaveURL(/\/o\/[^/]+\/home$/u);
  const activity = new URL("activity", page.url()).href;
  await hub.createAnotherOrganization("owner", "Orbit");
  await expect(page).toHaveURL(/\/o\/[^/]+\/home$/u);
  const orbitHome = page.url();
  await hub.chooseOrganization("owner", "Acme");
  const documentStart = await page.evaluate(() => performance.timeOrigin);
  const dialog = page.getByRole("dialog", { name: "Command menu" });
  const search = page.getByRole("button", { name: "Search", exact: true });
  const input = dialog.getByRole("combobox", { name: "Search commands" });

  await search.focus();
  await page.keyboard.press("Meta+k");
  await expect(input).toBeFocused();
  await expect(dialog.getByRole("option", { name: "Apps", exact: true })).toHaveCount(0);
  await input.fill("Activity");
  await input.press("Enter");
  await expect(page).toHaveURL(activity);
  await expect(dialog).toBeHidden();
  await expect(search).toBeFocused();

  await page.keyboard.press("Control+k");
  await input.fill("theme dark");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/u);
  expect((await context.cookies()).find(({ name }) => name === "theme")?.value).toBe("dark");

  await search.click();
  await input.fill("Orbit");
  await input.press("Enter");
  await expect(page).toHaveURL(orbitHome);
  await expect(dialog).toBeHidden();
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart);
});

test("the command menu finds settings and actions by name", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const dialog = page.getByRole("dialog", { name: "Command menu" });
  const input = dialog.getByRole("combobox", { name: "Search commands" });
  const base = page.url().replace(/\/home$/u, "");

  await page.keyboard.press("Control+k");
  await input.fill("webhook");
  await expect(dialog.getByRole("option", { name: "Triggers", exact: true })).toBeVisible();
  await expect(dialog.getByRole("option", { name: "New trigger", exact: true })).toBeVisible();
  await expect(dialog.getByRole("option", { name: "Create API key", exact: true })).toBeVisible();
  await expect(dialog.getByRole("option", { name: "Activity", exact: true })).toHaveCount(0);

  await input.fill("api key");
  await expect(dialog.getByRole("option", { name: "API keys", exact: true })).toBeVisible();
  await input.fill("Create API key");
  await input.press("Enter");
  await expect(page).toHaveURL(`${base}/settings/api-keys`);
  await expect(dialog).toBeHidden();

  await page.keyboard.press("Control+k");
  await input.fill("New trigger");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/triggers\/new\/edit/u);
});

test("the account menu offers System, Light, and Dark", async ({ hub, page, context }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await page.emulateMedia({ colorScheme: "dark" });
  const account = page.getByRole("button", { name: owner.email });
  const menu = page.getByRole("menu");
  const html = page.locator("html");

  await account.click();
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText("System");
  await expect(menu.getByRole("menuitemradio")).toHaveText(["System", "Light", "Dark"]);
  await menu.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(html).toHaveClass(/\blight\b/u);
  expect((await context.cookies()).find(({ name }) => name === "theme")?.value).toBe("light");

  await account.click();
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText("Light");
  await menu.getByRole("menuitemradio", { name: "System" }).click();
  await expect(html).toHaveClass(/\bdark\b/u);
  expect((await context.cookies()).find(({ name }) => name === "theme")?.value).toBe("system");
});

test("desktop rail focus uses the light outline in both themes", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const search = page.getByRole("button", { name: "Search", exact: true });

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`, "u"));
    await expect(search).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("outline-color", "rgb(247, 247, 244)");
    await expect(search).toHaveCSS("outline-width", "2px");
  }
});
