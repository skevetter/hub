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

async function enroll(hub: PaseoHub) {
  const app = hub.primaryApplication();
  const token = randomUUID();
  await app.query(
    `insert into daemon_enrollment_tokens (id, verifier, organization_id, expires_at)
     select $1, $2, id, now() + interval '10 minutes' from organization where name = $3`,
    [randomUUID(), createHash("sha256").update(token).digest("base64url"), organization],
  );
  const daemon = TestDaemon.create(app.origin);
  await daemon.connect(await daemon.enroll(token, "devbox"));
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
});

test.describe("interactive sessions", () => {
  test.use({ interactiveSessions: true });

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

async function expectPageWidth(page: Page, width: number) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
}

async function capture(page: Page, screen: string, width: number) {
  await expectPageWidth(page, width);
  const directory = process.env["HUB_SESSION_SCREENSHOTS"];
  if (directory)
    await page.screenshot({ path: join(directory, `${screen}-${width}.png`), fullPage: true });
}
