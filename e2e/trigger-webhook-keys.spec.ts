import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import type { PaseoHub } from "./helpers/hub.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "/tmp/hub-ui/webhook-keys-shots";
const NAME = "deploy-hook";
const KEY_NAME = `webhook:${NAME}`;
const owner = {
  name: "Hook Owner",
  email: "hook-owner@example.test",
  password: "hook-owner-password",
};
const member = {
  name: "Hook Member",
  email: "hook-member@example.test",
  password: "hook-member-password",
};

test("an owner creates, rotates and revokes a webhook key, and a member sees none of it", async ({
  hub,
  page,
}) => {
  await createManualTrigger(hub, page);
  const triggerUrl = page.url();
  const keys = page.getByRole("table", { name: "Webhook keys" });
  await expect(page.getByRole("heading", { name: "Webhook keys" })).toBeVisible();
  await expect(page.getByText("No webhook keys", { exact: true })).toBeVisible();

  const secret = await createKey(page, "ci-bot");
  expect(secret).toMatch(/\S{20,}/u);
  await expect(page).not.toHaveURL(new RegExp(escape(secret), "u"));
  await expect(keys.getByRole("row").filter({ hasText: "ci-bot" })).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);

  await captureSection(page, { width: 1280, height: 800 }, "desktop");
  await captureSection(page, { width: 390, height: 844 }, "phone");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 1280, height: 800 });

  const rotated = await rotateKey(page, KEY_NAME);
  expect(rotated).not.toBe(secret);
  await expect(keys.getByRole("row").filter({ hasText: "Expiring" })).toHaveCount(1);
  await expect(page.getByText(rotated)).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(rotated)).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);

  await revokeKey(page, keys.getByRole("row").filter({ hasText: "Expiring" }));
  await expect(keys.getByRole("row").filter({ hasText: "Expiring" })).toHaveCount(0);
  await expect(keys.getByRole("row").filter({ hasText: "Revoked" })).toHaveCount(1);

  await hub.addNewMember("owner", "member", member);
  const memberPage = hub.browserPage("member");
  await memberPage.goto(triggerUrl);
  await expect(memberPage.getByRole("heading", { name: NAME, level: 1 })).toBeVisible();
  await expect(memberPage.getByRole("heading", { name: "How to invoke" })).toBeVisible();
  await expect(memberPage.getByRole("heading", { name: "Webhook keys" })).toHaveCount(0);
  await expect(memberPage.getByRole("button", { name: "Create webhook key" })).toHaveCount(0);
});

test("a key whose actor the trigger refuses is created with a warning and the request never carries the key in the URL", async ({
  hub,
  page,
}) => {
  await createManualTrigger(hub, page);
  await page.getByRole("button", { name: "Create webhook key" }).click();
  const form = page.getByRole("dialog", { name: "Create webhook key" });
  await form.getByLabel("Actor").fill("ci-bot");
  await form.getByRole("button", { name: "Create webhook key" }).click();

  const reveal = page.getByRole("dialog", { name: "Copy your webhook key" });
  await expect(reveal).toBeVisible();
  await expect(reveal.getByText("This key's actor is not allowed")).toBeVisible();
  await expect(reveal.getByText(/does not allow ci-bot/u)).toBeVisible();
  const secret = await reveal.getByLabel("Webhook key", { exact: true }).inputValue();
  const request = await reveal.getByRole("textbox", { name: "Webhook request value" }).innerText();
  expect(request).toContain("Authorization");
  expect(request).toContain("/api/v1/hooks/" + NAME);
  expect(request).not.toContain(secret);
  await expect(reveal.getByText("never in the URL")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(reveal).toBeVisible();
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(reveal).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);
});

test("a rotation overlap outside the allowed range is refused before any request", async ({
  hub,
  page,
}) => {
  await createManualTrigger(hub, page);
  await createKey(page, "owner-bot");
  await page.getByRole("button", { name: /^Actions for/u }).click();
  await page.getByRole("menuitem", { name: "Rotate key" }).click();
  const form = page.getByRole("dialog", { name: "Rotate webhook key" });
  await form.getByLabel("Overlap in minutes").fill("1441");
  await form.getByRole("button", { name: "Rotate key" }).click();
  await expect(form.getByText(/Use a whole number of minutes/u)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Copy your new webhook key" })).toHaveCount(0);
  await form.getByLabel("Overlap in minutes").fill("0");
  await expect(form.getByText("Immediate cutover")).toBeVisible();
});

async function createKey(page: Page, actor: string): Promise<string> {
  await page.getByRole("button", { name: "Create webhook key" }).click();
  const form = page.getByRole("dialog", { name: "Create webhook key" });
  await form.getByLabel("Actor").fill(actor);
  await form.getByRole("button", { name: "Create webhook key" }).click();
  return closeReveal(page, "Copy your webhook key");
}

async function rotateKey(page: Page, name: string): Promise<string> {
  await page
    .getByRole("button", { name: `Actions for ${name}` })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Rotate key" }).click();
  const form = page.getByRole("dialog", { name: "Rotate webhook key" });
  await form.getByRole("button", { name: "Rotate key" }).click();
  return closeReveal(page, "Copy your new webhook key");
}

async function revokeKey(page: Page, row: Locator): Promise<void> {
  await row.getByRole("button", { name: /^Actions for/u }).click();
  await page.getByRole("menuitem", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
}

async function closeReveal(page: Page, title: string): Promise<string> {
  const reveal = page.getByRole("dialog", { name: title });
  await expect(reveal).toBeVisible();
  const secret = await reveal.getByLabel("Webhook key", { exact: true }).inputValue();
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(reveal).toHaveCount(0);
  return secret;
}

async function captureSection(
  page: Page,
  size: { width: number; height: number },
  label: string,
): Promise<void> {
  await page.setViewportSize(size);
  const section = page.getByRole("heading", { name: "Webhook keys" });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${label}.png`, fullPage: true });
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function createManualTrigger(hub: PaseoHub, page: Page): Promise<void> {
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
    prompt: "Deploy.",
  });
  await triggers.allowManualActor(owner.email);
  await triggers.save(NAME);
  await triggers.openReadView(NAME);
}
