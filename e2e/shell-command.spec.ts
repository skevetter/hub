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
  await hub.createAnotherOrganization("owner", "Orbit");
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
  await expect(page).toHaveURL(/\/o\/acme\/activity$/u);
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
  await expect(page).toHaveURL(/\/o\/orbit\/home$/u);
  await expect(dialog).toBeHidden();
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart);
});
