import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { test as browserTest } from "./app.js";
import { OrganizationDaemons, seedDaemonProfile } from "./helpers/hx-daemons.js";

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

const owner = {
  name: "Device Owner",
  email: "device-owner@example.com",
  password: "device-owner-password",
};

test("shows daemon devices and supports keyboard filters at phone width", async ({ hub, page }) => {
  test.setTimeout(120_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemons = new OrganizationDaemons(page);

  await daemons.open();
  await expect(page.getByText("No daemons connected", { exact: true })).toBeVisible();
  await expect(page.getByText(`paseo hub login ${hub.primaryApplication().origin}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "How to connect a daemon" })).toBeVisible();
  await daemons.capture("empty");

  const connected = await hub.connectProviderDaemon("owner", "Acme");
  const offline = "build-runner-eu-west-primary";
  await hub.seedConnectedOnlyDaemon("owner", offline);
  const profile = "Web review";
  await seedDaemonProfile(hub.primaryApplication(), "Acme", connected, profile);
  await page.reload();

  const active = daemons.device(connected);
  await expect(active.getByText("Connected", { exact: true })).toBeVisible();
  await expect(active.getByText(/OpenCode.*Codex|Codex.*OpenCode/u)).toBeVisible();
  await expect(active.getByText("Can run Hub automations")).toBeVisible();
  const profileLink = active.getByRole("link", { name: profile, exact: true });
  await expect(profileLink).toHaveAttribute("href", /\/o\/[^/]+\/sessions\/profiles$/u);
  const inactive = daemons.device(offline);
  await expect(inactive.getByText("Offline", { exact: true })).toBeVisible();
  await expect(
    inactive.getByText("Providers are available when this daemon connects."),
  ).toBeVisible();
  await expect(inactive.getByText("Connected only: Hub cannot start agents here")).toBeVisible();
  await expect(inactive.getByRole("button", { name: "Copy grant command" })).toBeVisible();
  await expect(inactive.getByText("No profiles use this daemon.")).toBeVisible();
  const announcement = page.getByRole("status").filter({ hasText: /daemon.*shown/u });
  await expect(announcement).toHaveCount(0);
  await daemons.capture("populated");

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await daemons.search().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "All" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Connected", exact: true })).toBeChecked();
  await expect(active).toBeVisible();
  await expect(inactive).toHaveCount(0);
  await expect(announcement).toHaveText("1 daemon shown");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Offline", exact: true })).toBeChecked();
  await expect(inactive).toBeVisible();
  await expect(active).toHaveCount(0);
  await daemons.capture("filtered");

  await page.keyboard.press("Shift+Tab");
  await expect(daemons.search()).toBeFocused();
  await page.keyboard.type("BUILD-RUNNER");
  await expect(inactive).toBeVisible();
  await expect(announcement).toHaveText("1 daemon shown");
  await page.keyboard.press("End");
  await page.keyboard.type("-no-such-device");
  await expect(page.getByText("No daemons match", { exact: true })).toBeVisible();
  await expect(announcement).toHaveText("0 daemons shown");
  const clear = page.getByRole("button", { name: "Clear filters", exact: true });
  await clear.focus();
  await page.keyboard.press("Enter");
  await expect(daemons.search()).toBeFocused();
  await expect(daemons.list().getByRole("listitem")).toHaveCount(2);
  await expect(announcement).toHaveText("2 daemons shown");
  await profileLink.click();
  await expect(page.getByRole("heading", { name: "Session profiles", level: 1 })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: profile })).toBeVisible();
});

const member = {
  name: "Device Member",
  email: "device-member@example.com",
  password: "device-member-password",
};

function profileRead(url: URL) {
  return (
    url.pathname.includes("/_serverFn/") &&
    url.searchParams.get("payload")?.includes('"manage"') === true
  );
}

test("uses the permissions for the organization in the Daemons URL", async ({
  hub,
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const target = new URL("daemons", page.url()).href;
  await hub.seedConnectedOnlyDaemon("owner", "acme-device");
  const existingContexts = new Set(browser.contexts());
  await hub.addNewMember("owner", "member", member);
  await hub.createAnotherOrganization("member", "Studio");
  const memberPage = newMemberPage(browser, existingContexts);
  await expect(memberPage).toHaveURL(/\/o\/studio-[^/]+\/home$/u);
  await memberPage.setViewportSize({ width: 390, height: 900 });
  let reads = 0;
  await memberPage.route(profileRead, async (route) => {
    reads++;
    await route.continue();
  });

  await memberPage.goto(target);
  const device = new OrganizationDaemons(memberPage).device("acme-device");
  await expect(device).toBeVisible();
  await expect(device.getByRole("button", { name: "Actions for acme-device" })).toHaveCount(0);
  await expect.soft(device.getByText("Session profiles", { exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
});

test("hides cached management profiles after the daemon list confirms demotion", async ({
  hub,
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const target = new URL("daemons", page.url()).href;
  await hub.seedDaemonSlug("owner", "acme-device");
  const name = "Disabled build profile";
  await seedDaemonProfile(hub.primaryApplication(), "Acme", "acme-device", name);
  await hub
    .primaryApplication()
    .query("update interactive_session_profiles set status = 'disabled' where name = $1", [name]);
  const existingContexts = new Set(browser.contexts());
  await hub.addNewMember("owner", "member", member);
  await hub.changeMemberRole("owner", member.name, "admin");
  await hub.createAnotherOrganization("member", "Studio");
  const memberPage = newMemberPage(browser, existingContexts);
  await expect(memberPage).toHaveURL(/\/o\/studio-[^/]+\/home$/u);
  await memberPage.goto(target);
  const daemons = new OrganizationDaemons(memberPage);
  const device = daemons.device("acme-device");
  const profile = device.getByRole("link", { name, exact: true });
  await expect(profile).toBeVisible();
  await memberPage.getByRole("link", { name: "Home", exact: true }).click();
  await expect(memberPage).toHaveURL(new URL("home", target).href);
  await hub.changeMemberRole("owner", member.name, "member");

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await memberPage.route(profileRead, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await daemons.open();
    await expect(device).toBeVisible();
    await expect(device.getByRole("button", { name: "Actions for acme-device" })).toHaveCount(0);
    await expect.soft(profile).toHaveCount(0, { timeout: 1_000 });
    await expect(device.getByText("Session profiles", { exact: true })).toHaveCount(0);

    await memberPage.getByRole("link", { name: "Home", exact: true }).click();
    await expect(memberPage).toHaveURL(new URL("home", target).href);
    await hub.changeMemberRole("owner", member.name, "admin");
    await daemons.open();
    await expect(device.getByRole("button", { name: "Actions for acme-device" })).toBeVisible();
    await expect(device.getByText("Loading session profiles...")).toBeVisible();
    await expect(profile).toHaveCount(0);
  } finally {
    release();
  }
  await expect(profile).toBeVisible();
});

test("limits outstanding provider requests to four in list order", async ({ hub, page }) => {
  test.setTimeout(90_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const ids = new Map<string, string>();
  for (let index = 0; index < 24; index++) {
    const slug = `fleet-device-${index}`;
    ids.set(slug, await hub.seedDaemonSlug("owner", slug));
  }
  await hub
    .primaryApplication()
    .query(
      "update daemons set presence = 'connected', connected_at = now() where slug like 'fleet-device-%'",
      [],
    );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fifth!: () => void;
  const overLimit = new Promise<boolean>((resolve) => {
    fifth = () => resolve(true);
  });
  const requests: string[] = [];
  await page.route("**/_serverFn/**", async (route) => {
    const url = decodeURIComponent(route.request().url());
    const id = [...ids.values()].find((candidate) => url.includes(candidate));
    if (id === undefined) return route.continue();
    requests.push(id);
    if (requests.length === 5) fifth();
    await held;
    return route.abort();
  });
  try {
    const daemons = new OrganizationDaemons(page);
    await daemons.open();
    await expect(daemons.list().getByRole("listitem")).toHaveCount(24);
    const headings = await daemons.list().getByRole("heading").allTextContents();
    await expect.poll(() => requests.length).toBeGreaterThanOrEqual(4);
    const observed = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000));
    expect(await Promise.race([overLimit, observed])).toBe(false);
    expect(requests).toHaveLength(4);
    expect(new Set(requests)).toEqual(new Set(headings.slice(0, 4).map((name) => ids.get(name))));
  } finally {
    release();
  }
});

test("announces result counts after rename and revoke change the filtered list", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedDaemonSlug("owner", "old-device-name");
  const daemons = new OrganizationDaemons(page);
  await daemons.open();
  const announcement = page.getByRole("status").filter({ hasText: /daemon.*shown/u });
  await expect(announcement).toHaveCount(0);
  await daemons.search().fill("old-device-name");
  await expect(announcement).toHaveText("1 daemon shown");

  await renameDevice(page, daemons, "old-device-name", "new-device-name");
  await expect(page.getByText("No daemons match", { exact: true })).toBeVisible();
  await expect.soft(announcement).toHaveText("0 daemons shown", { timeout: 1_000 });

  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("radio", { name: "Offline", exact: true }).click();
  await expect(announcement).toHaveText("1 daemon shown");
  await revokeDevice(page, daemons, "new-device-name");
  await expect(page.getByText("No daemons match", { exact: true })).toBeVisible();
  await expect(announcement).toHaveText("0 daemons shown", { timeout: 1_000 });
});

function newMemberPage(browser: Browser, existingContexts: ReadonlySet<BrowserContext>) {
  const page = browser
    .contexts()
    .find((context) => !existingContexts.has(context))
    ?.pages()[0];
  if (page === undefined) throw new Error("Missing member page");
  return page;
}

function actions(daemons: OrganizationDaemons, name: string) {
  return daemons.device(name).getByRole("button", { name: `Actions for ${name}`, exact: true });
}

async function renameDevice(page: Page, daemons: OrganizationDaemons, from: string, to: string) {
  await actions(daemons, from).press("Enter");
  await page.getByRole("menuitem", { name: "Rename", exact: true }).press("Enter");
  const form = page.getByRole("form", { name: `Rename ${from}` });
  await form.getByLabel("Daemon slug").fill(to);
  await form.getByRole("button", { name: "Rename", exact: true }).press("Enter");
  await expect(form).toHaveCount(0);
}

async function revokeDevice(page: Page, daemons: OrganizationDaemons, name: string) {
  await actions(daemons, name).press("Enter");
  await page.getByRole("menuitem", { name: "Revoke", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Revoke daemon", exact: true }).press("Enter");
}
