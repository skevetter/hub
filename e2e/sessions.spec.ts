import { expect, type Locator, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { TestDaemon } from "../src/daemons/test-utils/hub-harness.js";
import { test as browserTest } from "./app.js";
import type { PaseoHub } from "./helpers/hub.js";

const test = browserTest.extend<{ interactiveSessions: boolean; sessionRuntime: void }>({
  interactiveSessions: [false, { option: true }],
  sessionRuntime: [
    async ({ interactiveSessions }, run) => {
      // The browser fixture inherits the worker environment when it spawns the local Hub.
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

const owner = {
  name: "Session Owner",
  email: "session-owner@example.com",
  password: "session-owner-password",
};
const viewer = {
  name: "Session Viewer",
  email: "session-viewer@example.com",
  password: "session-viewer-password",
};
const admin = {
  name: "Session Admin",
  email: "session-admin@example.com",
  password: "session-admin-password",
};
const organization = "Acme Sessions";
const prompt = "Inspect the login flow";

async function setup(hub: PaseoHub) {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", organization);
  const app = hub.primaryApplication();
  const [row] = await app.query("select slug from organization where name = $1", [organization]);
  const slug = row?.["slug"];
  if (typeof slug !== "string") throw new Error("Organization slug unavailable");
  return { origin: app.origin, base: `/o/${slug}` };
}

async function enroll(hub: PaseoHub, profileAdmin?: string) {
  const app = hub.primaryApplication();
  const token = randomUUID();
  const credentialId = profileAdmin === undefined ? null : randomUUID();
  if (profileAdmin !== undefined) {
    await app.query(
      `insert into organization_cli_credentials (id, organization_id, prefix, verifier, created_by_user_id)
       select $1, organization.id, $2, $2, "user".id from organization, "user"
       where organization.name = $3 and "user".email = $4`,
      [credentialId, randomUUID(), organization, profileAdmin],
    );
  }
  await app.query(
    `insert into daemon_enrollment_tokens (id, verifier, organization_id, expires_at, issued_by_cli_credential_id)
     select $1, $2, id, now() + interval '10 minutes', $4 from organization where name = $3`,
    [
      randomUUID(),
      createHash("sha256").update(token).digest("base64url"),
      organization,
      credentialId,
    ],
  );
  const daemon = TestDaemon.create(app.origin);
  if (profileAdmin !== undefined) {
    daemon.providerSnapshotEntries = [
      {
        provider: "omp",
        label: "OMP",
        status: "ready",
        enabled: true,
        defaultModeId: "full",
        modes: [{ id: "full", label: "Full" }],
        models: [
          {
            provider: "omp",
            id: "test-model",
            label: "Test model",
            thinkingOptions: [{ id: "high", label: "High" }],
          },
        ],
      },
    ];
  }
  await daemon.connect(await daemon.enroll(token, "devbox"));
  if (profileAdmin === undefined)
    await app.query(
      `insert into interactive_session_profiles (id, organization_id, name, daemon_id, cwd, provider, status)
     select $1, id, 'Web on devbox', $2, '/workspace/web', 'opencode', 'active'
     from organization where name = $3`,
      [randomUUID(), daemon.daemonId, organization],
    );
  return daemon;
}

async function start(page: Page, app: Awaited<ReturnType<typeof setup>>, addViewer = false) {
  await page.goto(app.origin + app.base + "/sessions/new");
  await expect(page.getByRole("heading", { name: "New session", level: 1 })).toBeVisible();
  if (addViewer) {
    await page.getByRole("combobox", { name: "Add a participant" }).click();
    await page.getByRole("option", { name: viewer.name }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "First message" }).fill(prompt);
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/[a-f0-9-]{36}$/u);
  await expect(page.getByRole("button", { name: "Steer now" })).toBeVisible();
  await expect(page.getByText("Delivered", { exact: true }).first()).toBeVisible();
  return "agent-isession:" + new URL(page.url()).pathname.split("/").at(-1) + ":1";
}

function assistant(daemon: TestDaemon, agent: string, text: string) {
  // The live redactor retains a lookahead before releasing the end of a still-open reply.
  daemon.emitTimeline(agent, { type: "assistant_message", text: text + " ".repeat(64) });
}

test("hides Sessions navigation and routes when the flag is off", async ({ hub, page }) => {
  const app = await setup(hub);
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sessions", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Start a session" })).toHaveCount(0);
  await page.goto(app.origin + app.base + "/sessions");
  await expect(page.getByRole("heading", { name: "Sessions unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Profiles", exact: true })).toHaveCount(0);
  await page.goto(app.origin + app.base + "/sessions/profiles");
  await expect(page.getByRole("heading", { name: "Sessions unavailable" })).toBeVisible();
});

test.describe("interactive sessions", () => {
  test.use({ interactiveSessions: true });

  test("an admin creates a profile and starts a session while members cannot manage profiles", async ({
    browser,
    hub,
    page,
  }) => {
    const app = await setup(hub);
    await hub.joinInvitationAs(
      "admin",
      admin,
      await hub.inviteMember("owner", admin.email, "admin"),
    );
    const adminContext = browser.contexts().find((context) => context !== page.context());
    const adminPage = adminContext?.pages()[0];
    if (adminPage === undefined) throw new Error("Admin page unavailable");
    await hub.addNewMember("owner", "viewer", viewer);
    const memberPage = browser
      .contexts()
      .find((context) => context !== page.context() && context !== adminContext)
      ?.pages()[0];
    if (memberPage === undefined) throw new Error("Member page unavailable");
    const daemon = await enroll(hub, admin.email);
    const sessions = app.origin + app.base + "/sessions";
    const profiles = sessions + "/profiles";
    try {
      await memberPage.goto(sessions);
      await expect(
        memberPage.getByRole("heading", { name: "Sessions", exact: true }),
      ).toBeVisible();
      await expect(memberPage.getByRole("link", { name: "Profiles", exact: true })).toHaveCount(0);
      await memberPage.goto(profiles);
      await expect(memberPage.getByRole("heading", { name: "Sessions unavailable" })).toBeVisible();

      await adminPage.setViewportSize({ width: 390, height: 900 });
      await adminPage.goto(sessions);
      await adminPage.getByRole("link", { name: "Profiles", exact: true }).click();
      await expect(adminPage.getByText("No session profiles yet")).toBeVisible();
      await adminPage.getByRole("button", { name: "Create a profile" }).click();
      const dialog = adminPage.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Web on devbox");
      await dialog.getByRole("combobox", { name: "Daemon", exact: true }).click();
      await adminPage.getByRole("option", { name: "devbox", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Working directory" }).fill("/workspace/web");
      await dialog.getByRole("checkbox", { name: "Use a new branch per session" }).check();
      await dialog.getByRole("textbox", { name: "Base branch" }).fill("main");
      await chooseProfileOption(adminPage, "Provider", "OMP");
      await chooseProfileOption(adminPage, "Model", "Test model");
      await chooseProfileOption(adminPage, "Thinking", "High");
      await expect(dialog.getByRole("combobox", { name: "Mode", exact: true })).toHaveText(
        "Select a mode",
      );
      await chooseProfileOption(adminPage, "Mode", "Full");
      const acknowledge = dialog.getByRole("checkbox", { name: "Run every tool without asking" });
      await expect(acknowledge).not.toBeChecked();
      for (const width of [390, 1280]) {
        await adminPage.setViewportSize({ width, height: 1100 });
        await expect.poll(() => horizontalOverflow(dialog)).toBe(0);
        await expect.poll(() => verticalOverflow(dialog)).toBe(0);
        await expect.poll(() => elementWidth(dialog)).toBeLessThanOrEqual(448);
        await dialog.evaluate((node) => node.scrollTo(0, 0));
        await capture(adminPage, "profile-form", width);
      }
      await adminPage.setViewportSize({ width: 390, height: 900 });
      await dialog.getByRole("button", { name: "Create profile" }).click();
      await expect(dialog).toBeVisible();
      await expect(acknowledge).toBeFocused();
      await acknowledge.check();
      await dialog.getByRole("button", { name: "Create profile" }).click();
      const profile = adminPage.getByRole("row").filter({ hasText: "Web on devbox" });
      await expect(profile).toContainText("Enabled");
      for (const width of [390, 1280]) {
        await adminPage.setViewportSize({ width, height: 900 });
        await capture(adminPage, "profiles", width);
      }
      await expect(profile).toContainText("/workspace/web");
      await expect(profile).toContainText("omp / test-model");
      const actions = adminPage.getByRole("button", { name: "Actions for Web on devbox" });
      await actions.click();
      await adminPage.getByRole("menuitem", { name: "Disable", exact: true }).click();
      await expect(profile).toContainText("Disabled");
      await actions.click();
      await adminPage.getByRole("menuitem", { name: "Enable", exact: true }).click();
      await expect(profile).toContainText("Enabled");
      await actions.click();
      await adminPage.getByRole("menuitem", { name: "Edit", exact: true }).click();
      await expect(dialog.getByRole("textbox", { name: "Base branch" })).toHaveValue("main");
      await dialog
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Web on devbox updated");
      await expect(dialog.getByRole("combobox", { name: "Provider", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(profile).toContainText("Web on devbox updated");
      await start(adminPage, app);
      expect(daemon.createdAgent()["provider"]).toBe("omp");
      expect(daemon.createdAgent()["modeId"]).toBe("full");
      expect(daemon.createdAgent()["worktree"]).toBeDefined();
    } finally {
      await daemon.disconnect();
    }
  });

  test("a viewer sees live assistant text and no composer", async ({ browser, hub, page }) => {
    const app = await setup(hub);
    await hub.addNewMember("owner", "viewer", viewer);
    const viewerPage = browser
      .contexts()
      .find((context) => context !== page.context())
      ?.pages()[0];
    if (viewerPage === undefined) throw new Error("Viewer page unavailable");
    const daemon = await enroll(hub);
    try {
      const agent = await start(page, app, true);
      const watching = viewerPage.waitForResponse(/\/interactive-sessions\/[^/]+\/events\?/u);
      await viewerPage.goto(page.url());
      await watching;
      await expect(
        viewerPage.getByText("View only. A controller can send messages."),
      ).toBeVisible();
      await expect(viewerPage.getByRole("textbox", { name: "Message" })).toHaveCount(0);
      assistant(daemon, agent, "The viewer can see this live reply.");
      await expect(viewerPage.getByText("The viewer can see this live reply.")).toBeVisible();
    } finally {
      await daemon.disconnect();
    }
  });

  test("a controller steers during a tool call and sees Delivered", async ({ hub, page }) => {
    const app = await setup(hub);
    const daemon = await enroll(hub);
    try {
      const agent = await start(page, app);
      daemon.emitTimeline(agent, {
        type: "tool_call",
        callId: "tool-1",
        name: "read_file",
        status: "running",
      });
      await expect(page.getByText("read_file", { exact: true })).toBeVisible();
      await page.getByRole("textbox", { name: "Message" }).fill("Look at the parser next");
      await page.getByRole("button", { name: "Steer now" }).click();
      await expect(
        page.getByRole("listitem").filter({ hasText: "Look at the parser next" }),
      ).toContainText("Delivered");
      expect(daemon.createdAgent()["prompt"]).toBe("Look at the parser next");
    } finally {
      await daemon.disconnect();
    }
  });

  test("stop, then queue, then send resumes on the same agent", async ({ hub, page }) => {
    const app = await setup(hub);
    const daemon = await enroll(hub);
    try {
      const agent = await start(page, app);
      const message = page.getByRole("textbox", { name: "Message" });
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Stop agent", exact: true })
        .click();
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
      await daemon.disconnect();
      await expect(page.getByText(/Your messages are kept/u)).toBeVisible();
      await message.fill("Queue after interrupt");
      await page.getByRole("button", { name: "Queue for next turn", exact: true }).click();
      await expect(
        page.getByRole("listitem").filter({ hasText: "Queue after interrupt" }),
      ).toContainText("Queued");
      await daemon.connectExisting();
      await expect(
        page.getByRole("listitem").filter({ hasText: "Queue after interrupt" }),
      ).toContainText("Delivered");
      await daemon.completesTurnWithoutFinishTimeline(agent);
      await message.fill("Continue on this agent");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.getByRole("listitem").filter({ hasText: "Continue on this agent" }),
      ).toContainText("Delivered");
      expect(daemon.createdAgentCount()).toBe(1);
      expect(daemon.createdAgentRequestCount()).toBe(1);
    } finally {
      await daemon.disconnect();
    }
  });

  test("daemon offline keeps human messages and shows the notice", async ({ hub, page }) => {
    const app = await setup(hub);
    const daemon = await enroll(hub);
    try {
      await start(page, app);
      await daemon.disconnect();
      await expect(page.getByText(/Your messages are kept/u)).toBeVisible();
      await expect(page.getByText(prompt, { exact: true })).toBeVisible();
      await expect(page.getByText(/Agent replies load when the daemon reconnects/u)).toBeVisible();
    } finally {
      await daemon.disconnect();
    }
  });

  test("keyboard send returns focus to the composer", async ({ hub, page }) => {
    const app = await setup(hub);
    const daemon = await enroll(hub);
    try {
      await start(page, app);
      const message = page.getByRole("textbox", { name: "Message" });
      await message.fill("A keyboard message");
      await message.press("Enter");
      await expect(message).toHaveValue("A keyboard message\n");
      await message.press("Control+Enter");
      await expect(message).toHaveValue("");
      await expect(message).toBeFocused();
      await expect(
        page.getByRole("listitem").filter({ hasText: "A keyboard message" }),
      ).toContainText("Delivered");
      await message.fill("Another keyboard message");
      await message.press("Meta+Enter");
      await expect(message).toHaveValue("");
      await expect(message).toBeFocused();
    } finally {
      await daemon.disconnect();
    }
  });

  test("reconnect after a dropped stream preserves every assistant chunk once", async ({
    hub,
    page,
  }) => {
    const app = await setup(hub);
    const daemon = await enroll(hub);
    await page.addInitScript(instrumentSessionStream);
    try {
      const agent = await start(page, app);
      assistant(daemon, agent, "Before disconnect. ");
      await expect(page.getByText("Before disconnect.")).toBeVisible();
      await page.getByRole("textbox", { name: "Message" }).fill("Advance Hub cursor");
      await page.getByRole("button", { name: "Steer now" }).click();
      await expect(
        page.getByRole("listitem").filter({ hasText: "Advance Hub cursor" }),
      ).toContainText("Delivered");
      const reconnect = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          url.pathname.endsWith("/events") &&
          /^\d+:1(?:\.\d+)?:test-epoch$/u.test(url.searchParams.get("after") ?? "")
        );
      });
      await page.evaluate(() => window.dispatchEvent(new Event("drop-session-stream")));
      assistant(daemon, agent, "While disconnected. ");
      await reconnect;
      assistant(daemon, agent, "After reconnect.");
      const transcript = page.getByRole("region", { name: "Session transcript" });
      await expect(transcript).toContainText(
        "Before disconnect. While disconnected. After reconnect.",
      );
      for (const phrase of ["Before disconnect.", "While disconnected.", "After reconnect."]) {
        expect((await transcript.innerText()).split(phrase)).toHaveLength(2);
      }
    } finally {
      await daemon.disconnect();
    }
  });

  test("Home, Sessions, New session, detail and Activity fit at 390 and 1280 px", async ({
    hub,
    page,
  }) => {
    const app = await setup(hub);
    await expect(page.getByRole("link", { name: "Sessions", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Start a session" })).toHaveCount(0);
    await hub.addNewMember("owner", "viewer", viewer);
    const daemon = await enroll(hub);
    try {
      const agent = await start(page, app, true);
      const sessionUrl = page.url();
      const sessionId = new URL(sessionUrl).pathname.split("/").at(-1);
      const [first] = await hub
        .primaryApplication()
        .query(
          "select id from interactive_session_commands where session_id = $1 and ordinal = 1",
          [sessionId],
        );
      const firstId = first?.["id"];
      if (typeof firstId !== "string") throw new Error("First message unavailable");
      daemon.emitTimeline(agent, { type: "user_message", messageId: firstId, text: prompt });
      daemon.emitTimeline(agent, {
        type: "tool_call",
        callId: "inspect",
        name: "read_file",
        status: "completed",
      });
      const reply =
        "The login flow keeps the expired token after a redirect. I am tracing where the session is restored.";
      assistant(daemon, agent, reply);
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await capture(page, "session", width);
      }
      const long = "x".repeat(1024);
      daemon.emitTimeline(agent, {
        type: "tool_call",
        callId: "inspect-2",
        name: "read_file",
        status: "running",
      });
      assistant(daemon, agent, long);
      await expect(page.getByText(long, { exact: true })).toBeVisible();
      const transcript = page.getByRole("region", { name: "Session transcript" });
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expectPageWidth(page, width);
        await expect.poll(() => horizontalOverflow(transcript)).toBe(0);
      }
      for (const [screen, title] of [
        ["home", "Home"],
        ["sessions", "Sessions"],
        ["sessions/new", "New session"],
        ["activity", "Activity"],
      ] as const) {
        await page.goto(app.origin + app.base + "/" + screen);
        await expect(
          page.getByRole("heading", { name: title, level: 1, exact: true }),
        ).toBeVisible();
        if (screen === "home")
          await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
        if (screen === "sessions")
          await expect(page.getByRole("link", { name: "Web on devbox" })).toHaveAttribute(
            "href",
            new URL(sessionUrl).pathname,
          );
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await capture(page, screen.replace("/", "-"), width);
        }
      }
      await page.goto(app.origin + app.base + "/home");
      const firstMessage = page.getByRole("textbox", { name: "First message" });
      await firstMessage.fill("Started from Home");
      await firstMessage.press("Control+Enter");
      await expect(page).toHaveURL(/\/sessions\/[a-f0-9-]{36}$/u);
      await expect(page.getByText("Started from Home")).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Close session" }).click();
      await expect(page.getByText("The transcript remains readable.")).toBeVisible();
      await expect(page.getByText("Started from Home")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
    } finally {
      await daemon.disconnect();
    }
  });
});

function instrumentSessionStream() {
  window.EventSource = class extends EventSource {
    constructor(url: string | URL, options?: EventSourceInit) {
      super(url, options);
      if (String(url).includes("/interactive-sessions/")) {
        window.addEventListener(
          "drop-session-stream",
          () => {
            this.close();
            this.dispatchEvent(new Event("error"));
          },
          { once: true },
        );
      }
    }
  };
}

function horizontalOverflow(locator: Locator) {
  return locator.evaluate((element) => element.scrollWidth - element.clientWidth);
}

function verticalOverflow(locator: Locator) {
  return locator.evaluate((element) => element.scrollHeight - element.clientHeight);
}

function elementWidth(locator: Locator) {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

async function chooseProfileOption(page: Page, field: string, option: string) {
  await page.getByRole("dialog").getByRole("combobox", { name: field, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function expectPageWidth(page: Page, width: number) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
}

async function capture(page: Page, screen: string, width: number) {
  await expectPageWidth(page, width);
  const directory = process.env["HUB_SESSION_SCREENSHOTS"];
  if (directory)
    await page.screenshot({ path: join(directory, `${screen}-${width}.png`), fullPage: true });
}
