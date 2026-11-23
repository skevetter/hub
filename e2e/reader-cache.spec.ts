import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test as browserTest } from "./app.js";
import { seedDaemonProfile } from "./helpers/hx-daemons.js";
import type { PaseoHub } from "./helpers/hub.js";

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
  name: "Cache Owner",
  email: "cache-owner@example.com",
  password: "cache-owner-password",
};
const member = {
  name: "Cache Member",
  email: "cache-member@example.com",
  password: "cache-member-password",
};
const organization = "Acme Studio";
const sessionTitle = "Private deployment review";

for (const screen of ["list", "detail"] as const) {
  test(`same-tab reader change does not expose a private session on the ${screen}`, async ({
    hub,
    page,
  }) => {
    test.setTimeout(90_000);
    await watchSessionTitle(page);
    const { list, detail } = await seedPrivateSession(hub);
    const url = screen === "list" ? list : detail;
    await page.goto(url);
    await expect(page.getByText(sessionTitle, { exact: true }).first()).toBeVisible();
    await capture(page, screen, "01-reader-a");

    const initialDocument = await page.evaluate(() => {
      sessionStorage.setItem("watchPrivateSession", "true");
      return sessionStorage.getItem("readerDocument");
    });
    await expectOldDocumentCleared(page, url, initialDocument);
    await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(url);
    await expect.poll(() => documentId(page)).not.toBe(initialDocument);
    const signedOutDocument = await documentId(page);
    await capture(page, screen, "02-signed-out");

    await signInMember(hub, page);
    await expect(page).toHaveURL(url);
    await expect.poll(() => documentId(page)).not.toBe(signedOutDocument);
    await expect(
      page.getByText(screen === "list" ? "No sessions yet" : "Session unavailable", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(sessionTitle, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("privateSessionSeen"))).toBeNull();
    await capture(page, screen, "03-reader-b");
  });
}

async function expectOldDocumentCleared(page: Page, url: string, initialDocument: string | null) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let navigationHeld = false;
  await page.route(url, async (route) => {
    if (route.request().isNavigationRequest()) {
      navigationHeld = true;
      await released;
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: owner.email, exact: true }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click({ noWaitAfter: true });
    await expect.poll(() => navigationHeld).toBe(true);
    expect(await documentId(page)).toBe(initialDocument);
    await expect(page.getByRole("main", { name: "Loading Paseo Hub" })).toBeVisible();
    await expect(page.getByText(sessionTitle, { exact: true })).toHaveCount(0);
  } finally {
    release();
    await page.unroute(url);
  }
}

async function seedPrivateSession(hub: PaseoHub) {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", organization);
  await hub.addNewMember("owner", "member", member);
  await hub.seedConnectedOnlyDaemon("owner", "study-device");
  const app = hub.primaryApplication();
  await seedDaemonProfile(app, organization, "study-device", "Study profile");
  const session = randomUUID();
  await app.query(
    `insert into interactive_sessions
       (id, organization_id, profile_id, profile_version, launch, daemon_id, title, state,
        started_by_user_id, start_idempotency_key, start_request_hash)
     select $1, profile.organization_id, profile.id, profile.version,
       jsonb_build_object('daemonId', profile.daemon_id, 'cwd', profile.cwd, 'worktree', null,
         'provider', profile.provider, 'model', null, 'mode', null, 'thinkingOptionId', null,
         'providerOptions', '{}'::jsonb),
       profile.daemon_id, $2, 'idle', "user".id, $3, 'reader-cache-fixture'
     from interactive_session_profiles profile join organization on organization.id = profile.organization_id
     cross join "user" where organization.name = $4 and "user".email = $5`,
    [session, sessionTitle, randomUUID(), organization, owner.email],
  );
  const rows = await app.query(
    `insert into interactive_session_participants (session_id, organization_id, user_id, role)
     select id, organization_id, started_by_user_id, 'controller' from interactive_sessions
     where id = $1 returning session_id`,
    [session],
  );
  expect(rows).toEqual([{ session_id: session }]);
  const [org] = await app.query("select slug from organization where name = $1", [organization]);
  const slug = org?.["slug"];
  if (typeof slug !== "string") throw new Error("Organization slug unavailable");
  const list = `${app.origin}/o/${slug}/sessions`;
  return { list, detail: `${list}/${session}` };
}

async function watchSessionTitle(page: Page) {
  await page.addInitScript((title) => {
    sessionStorage.setItem("readerDocument", crypto.randomUUID());
    const containsTitle = (node: Node) => {
      if (node instanceof Element && node.matches("script, style")) return false;
      if (node.parentElement?.closest("script, style") != null) return false;
      return node.textContent?.includes(title) === true;
    };
    const observer = new MutationObserver((records) => {
      if (sessionStorage.getItem("watchPrivateSession") !== "true") return;
      const appeared = records.some((record) =>
        record.type === "characterData"
          ? containsTitle(record.target)
          : Array.from(record.addedNodes).some(containsTitle),
      );
      if (appeared) sessionStorage.setItem("privateSessionSeen", "true");
    });
    observer.observe(document, { childList: true, characterData: true, subtree: true });
  }, sessionTitle);
}

async function signInMember(hub: PaseoHub, page: Page) {
  const serverFunctions = "**/_serverFn/**";
  let signingIn = true;
  await page.route(serverFunctions, async (route) => {
    if (!signingIn || route.request().method() !== "POST") return route.continue();
    signingIn = false;
    const response = await route.fetch();
    // Keep the target route across sign-in instead of leaving through the organization chooser.
    await hub.primaryApplication().query(
      `update session set active_organization_id = member.organization_id
       from "user" join member on member.user_id = "user".id
       where session.user_id = "user".id and session.active_organization_id is null
       and "user".email = $1`,
      [member.email],
    );
    await route.fulfill({ response });
  });
  const form = page.getByRole("form", { name: "Sign in" });
  await form.getByLabel("Email").fill(member.email);
  await form.getByLabel("Password").fill(member.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: member.email, exact: true })).toBeVisible();
}

function documentId(page: Page) {
  return page.evaluate(() => sessionStorage.getItem("readerDocument"));
}

async function capture(page: Page, screen: string, name: string) {
  const directory = process.env["HX_CACHE_SHOTS"];
  if (directory) await page.screenshot({ path: join(directory, `${name}-${screen}.png`) });
}
