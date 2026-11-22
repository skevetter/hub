import { expect, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { TestDaemon } from "../src/daemons/test-utils/hub-harness.js";
import { test as browserTest } from "./app.js";

const test = browserTest.extend<{ interactiveSessions: boolean; sessionRuntime: void }>({
  interactiveSessions: [true, { option: true }],
  sessionRuntime: [
    async ({ interactiveSessions }, run) => {
      const flag = "PASEO_HUB_INTERACTIVE_SESSIONS";
      const previous = process.env[flag];
      process.env[flag] = String(interactiveSessions);
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

const organization = "Preview Workshop";
const profile = "Web workspace";

async function capture(page: Page, name: string, height = 900) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height });
    if (width === 390) {
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
    const directory = process.env["HX_SHOTS"];
    if (directory) {
      await page.screenshot({
        path: join(directory, `${name}-${width}.png`),
        animations: "disabled",
      });
    }
  }
}

test("Sessions screens fit a phone and can be captured with fake data", async ({ hub, page }) => {
  await hub.signUpAs("owner", {
    name: "Ada Park",
    email: "ada-preview@example.com",
    password: "preview-fixture-password",
  });
  await hub.createOrganization("owner", organization);
  const app = hub.primaryApplication();
  const [org] = await app.query("select slug from organization where name = $1", [organization]);
  const slug = org?.["slug"];
  if (typeof slug !== "string") throw new Error("Organization slug unavailable");
  const url = `${app.origin}/o/${slug}/sessions`;

  await page.goto(url);
  await expect(page.getByText("No sessions yet", { exact: true })).toBeVisible();
  await capture(page, "list-empty");

  const token = randomUUID();
  const credential = randomUUID();
  await app.query(
    `insert into organization_cli_credentials (id, organization_id, prefix, verifier, created_by_user_id)
     select $1, organization.id, $2, $2, "user".id from organization, "user"
     where organization.name = $3 and "user".email = 'ada-preview@example.com'`,
    [credential, randomUUID(), organization],
  );
  await app.query(
    `insert into daemon_enrollment_tokens (id, verifier, organization_id, expires_at, issued_by_cli_credential_id)
     select $1, $2, id, now() + interval '10 minutes', $4 from organization where name = $3`,
    [
      randomUUID(),
      createHash("sha256").update(token).digest("base64url"),
      organization,
      credential,
    ],
  );
  const daemon = TestDaemon.create(app.origin);
  daemon.providerSnapshotEntries = [
    { provider: "opencode", label: "OpenCode", status: "ready", enabled: true },
  ];
  await daemon.connect(await daemon.enroll(token, "devbox"));
  try {
    await app.query(
      `insert into interactive_session_profiles (id, organization_id, name, daemon_id, cwd, provider, status)
       select $1, id, $2, $3, '/workspace/web', 'opencode', 'active' from organization where name = $4`,
      [randomUUID(), profile, daemon.daemonId, organization],
    );
    await page.goto(url + "/profiles");
    await expect(page.getByRole("row").filter({ hasText: profile })).toBeVisible();
    await capture(page, "profiles");
    await page.getByRole("button", { name: `Actions for ${profile}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit profile" });
    await expect(dialog.getByRole("combobox", { name: "Provider", exact: true })).toBeEnabled();
    await capture(page, "profile-form", 1100);

    await page.goto(url + "/new");
    await expect(page.getByRole("textbox", { name: "First message" })).toBeVisible();
    await capture(page, "new-session", 1100);
    await start(page, "Check the release notes for broken links.");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Close session" }).click();
    await expect(page.getByText("The transcript remains readable.")).toBeVisible();
    const closed = new URL(page.url()).pathname;

    await page.goto(url + "/new");
    const prompt = "Inspect the login flow for redirects.";
    await start(page, prompt);
    const running = new URL(page.url()).pathname;
    const sessionId = running.split("/").at(-1);
    const agent = `agent-isession:${sessionId}:1`;
    const [first] = await app.query(
      "select id from interactive_session_commands where session_id = $1 and ordinal = 1",
      [sessionId],
    );
    const messageId = first?.["id"];
    if (typeof messageId !== "string") throw new Error("First message unavailable");
    daemon.emitTimeline(agent, { type: "user_message", messageId, text: prompt });
    daemon.emitTimeline(agent, {
      type: "tool_call",
      callId: "inspect-login",
      name: "read_file",
      status: "completed",
    });
    const reply =
      "The login page restores the previous URL after sign-in. I am checking what happens when the link has expired.";
    daemon.emitTimeline(agent, { type: "assistant_message", text: reply + " ".repeat(64) });
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    await expect(page.getByText("read_file", { exact: true })).toBeVisible();
    await capture(page, "session-detail");
    const lastMessage = page.getByText(reply, { exact: true });
    await lastMessage.scrollIntoViewIfNeeded();
    const messageBox = await lastMessage.boundingBox();
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const composerBox = await composer.boundingBox();
    expect(messageBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(composerBox!.y);
    await expect(page.getByRole("button", { name: "Steer now" })).toBeInViewport();

    await page.goto(url + "?filter=all");
    for (const path of [running, closed]) {
      await expect(page.locator(`a[href="${path}"]`)).toBeVisible();
    }
    await capture(page, "list-populated");
  } finally {
    await daemon.disconnect();
  }
});

async function start(page: Page, message: string) {
  await page.getByRole("textbox", { name: "First message" }).fill(message);
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/[a-f0-9-]{36}$/u);
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
}
