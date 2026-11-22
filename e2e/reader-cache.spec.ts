import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationDaemons } from "./helpers/hx-daemons.js";

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

test("does not show the prior reader's cached organization after same-tab sign-in", async ({
  hub,
  page,
}) => {
  test.setTimeout(90_000);
  const shots = process.env["HX_CACHE_SHOTS"];
  const capture = async (name: string) => {
    if (shots !== undefined) await page.screenshot({ path: join(shots, name) });
  };
  const previousName = "Acme Studio";
  const currentName = "Acme Labs";
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", previousName);
  await hub.addNewMember("owner", "member", member);
  await hub.seedConnectedOnlyDaemon("owner", "studio-device");
  await hub.signOut("owner");

  const app = hub.primaryApplication();
  let signingIn: string | undefined;
  let holdReads = false;
  let releaseReads = () => {};
  const heldReads = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let organizationReads = 0;
  await page.route("**/_serverFn/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && signingIn !== undefined) {
      const email = signingIn;
      signingIn = undefined;
      const response = await route.fetch();
      // The organization chooser reloads the tab and would discard the cache under test.
      await app.query(
        `update session set active_organization_id = member.organization_id
         from "user" join member on member.user_id = "user".id
         where session.user_id = "user".id and session.active_organization_id is null
         and "user".email = $1`,
        [email],
      );
      await route.fulfill({ response });
      return;
    }
    if (
      holdReads &&
      new URL(request.url()).searchParams.get("payload")?.includes('"organizationSlug"')
    ) {
      organizationReads++;
      await heldReads;
    }
    await route.continue();
  });

  const form = page.getByRole("form", { name: "Sign in" });
  const signIn = async (account: typeof owner) => {
    await form.getByLabel("Email").fill(account.email);
    await form.getByLabel("Password").fill(account.password);
    signingIn = account.email;
    await form.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: account.email, exact: true })).toBeVisible();
  };
  const daemons = new OrganizationDaemons(page);
  try {
    await signIn(owner);
    await daemons.open();
    await expect(daemons.device("studio-device")).toBeVisible();
    await expect(page.getByText(previousName, { exact: true }).first()).toBeVisible();
    await capture("01-reader-a.png");
    await hub.signOut("owner");
    await capture("02-signed-out.png");
    await app.query("update organization set name = $1 where name = $2", [
      currentName,
      previousName,
    ]);

    await page.evaluate((name) => {
      const observer = new MutationObserver(() => {
        if (!document.body.textContent?.includes(name)) return;
        document.body.dataset["previousReaderSeen"] = "true";
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    }, previousName);

    holdReads = true;
    await signIn(member);
    await expect.poll(() => organizationReads).toBeGreaterThan(0);
    releaseReads();
    await expect(daemons.device("studio-device")).toBeVisible();
    await expect(page.getByText(currentName, { exact: true }).first()).toBeVisible();
    await capture("03-reader-b.png");
    expect(
      await page.evaluate(() => document.body.dataset["previousReaderSeen"]),
      "the previous reader's organization name appeared in the DOM",
    ).toBeUndefined();
  } finally {
    releaseReads();
    await page.unrouteAll({ behavior: "wait" });
  }
});
