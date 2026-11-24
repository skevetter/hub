import { expect } from "@playwright/test";
import { test } from "./app.js";

test("opens Attention with the keyboard and follows the connection action", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", {
    name: "Ada Park",
    email: "ada@example.com",
    password: "ada-example-password",
  });
  await hub.createOrganization("owner", "Acme");
  await hub.seedSuspendedGitHubConnection("Acme");
  await page.reload();

  const entry = page.getByRole("button", { name: "Attention, 1 item", exact: true });
  await expect(entry).toBeVisible();
  await entry.press("Enter");
  const panel = page.getByRole("dialog", { name: "Attention" });
  await expect(panel.getByRole("heading", { name: "Attention" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(entry).toBeFocused();

  await entry.press("Enter");
  await panel.getByRole("link", { name: "Open connections" }).click();
  await expect(page).toHaveURL(/\/connections$/u);
  await expect(panel).toBeHidden();
});
