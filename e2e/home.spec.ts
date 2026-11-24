import { expect } from "@playwright/test";
import { test } from "./app.js";
import { attentionEntry } from "./helpers/attention.js";
import { OrganizationHome } from "./helpers/home.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "e2e/screenshots/home";
const owner = {
  name: "Home Owner",
  email: "home-owner@example.com",
  password: "home-owner-password",
};

test.describe.configure({ timeout: 180_000 });

/**
 * The hosted journey the funnel loses people on, step by step: each step is done by the real
 * thing — a provider connection, a daemon over the wire, a saved trigger, a dispatched run — and
 * Home reflects those records before the operator finishes setup.
 */
test("walks a hosted organization from sign-in to its first run", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const home = new OrganizationHome(page);
  const triggers = new OrganizationTriggers(page);

  await test.step("a fresh organization lands on Home with every step to do", async () => {
    await home.expectOpen();
    await home.expectProgress("0 of 4 done");
    await home.expectStep("Connect an app", "To do");
    await home.expectStep("Enroll a daemon", "To do");
    await expect(home.command("Enroll a daemon")).toHaveText(
      `paseo hub login ${hub.primaryApplication().origin}`,
    );
    await home.expectStep("Create a trigger", "To do");
    await home.expectStep("Record a run", "To do");
    await expect(attentionEntry(page, 0)).toBeVisible();
    await home.expectRuns(0, "0 succeeded · 0 failed");
    await home.capture(`${SHOTS}/01-fresh.png`);
  });

  await test.step("connecting GitHub completes the first step", async () => {
    await home.followStepAction("Connect an app", "Connect an app");
    await hub.connectGitHub("owner");
    await home.open();
    await home.expectStep("Connect an app", "Done");
    await home.expectStep("Connect an app", "acme-inc");
  });

  await test.step("a daemon enrolled without execute permission is connected but cannot run agents", async () => {
    await hub.seedConnectedOnlyDaemon("owner", "laptop");
    await home.reload();
    await home.expectStep("Enroll a daemon", "Cannot run agents");
    await expect(home.command("Enroll a daemon")).toHaveText(
      "paseo hub permissions grant hub.execute",
    );
    await home.capture(`${SHOTS}/02-cannot-run.png`);
  });

  let daemon = "";
  await test.step("a daemon that can run agents completes the second step", async () => {
    daemon = await hub.connectProviderDaemon("owner", "Acme");
    await home.reload();
    await home.expectStep("Enroll a daemon", "Done");
    await home.expectProgress("2 of 4 done");
  });

  await test.step("Attention links unrouted events to the trigger editor", async () => {
    await hub.deliverUnroutedGitHubEvent("home-unrouted-1");
    await hub.deliverUnroutedGitHubEvent("home-unrouted-2");
    await home.reload();
    const item = await home.openRoutingAttention();
    await expect(item).toContainText("2 events in the last 7 days");
    await expect(item).toContainText("2 from GitHub");
    await page.screenshot({ path: `${SHOTS}/03-unrouted-attention.png` });
    await home.followRoutingAttention(item);
  });

  await test.step("the editor starts from the connected daemon, and saving completes the third step", async () => {
    await triggers.expectDaemonPreselected(daemon);
    await triggers.configureManual({
      name: "deploy",
      daemon,
      cwd: "/workspace",
      agent: "codex/gpt-5.4",
      mode: "full-access",
      thinking: "high",
      prompt: "${{ paseo.prompt }}",
    });
    await triggers.allowManualActor("phase-two-runner");
    await triggers.save("deploy");
    await home.open();
    await home.expectStep("Create a trigger", "Done");
    await home.expectStep("Record a run", "To do");
    await home.expectStep("Record a run", "POST /api/v1/manual-runs");
    await home.expectProgress("3 of 4 done");
  });

  await test.step("the first run makes setup ready for an instance operator to finish", async () => {
    const apiKey = await hub.createRunApiKey("owner");
    const run = await page.request.post(`${hub.primaryApplication().origin}/api/v1/manual-runs`, {
      headers: { authorization: `Bearer ${apiKey}` },
      data: {
        projectSlug: "default",
        trigger: "deploy",
        deliveryKey: "home-first-run",
        input: "run it",
      },
    });
    await expect(run).toBeOK();
    expect(await run.json()).toMatchObject({ workflowStatus: "running" });
    await home.open();
    await expect(home.allSet()).toBeVisible();
    await expect(home.finishSetup()).toHaveCount(0);
    await home.expectRuns(1, "0 succeeded · 0 failed");
    await home.expectRecentRun("deploy", "Running");

    await hub.grantOperator("owner");
    await home.expectOpen();
    await expect(home.finishSetup()).toBeVisible();
    await home.capture(`${SHOTS}/04-complete.png`);
    await home.finishSetup().focus();
    await page.keyboard.press("Space");
    await home.expectChecklistHidden();
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeFocused();
    await home.reload();
    await home.expectRecentRun("deploy", "Running");
    await home.expectChecklistHidden();
  });
});

test("returns to the checklist when the last run ages out before Finish setup", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedSlackConnection("owner", "slack", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);
  await triggers.startNew();
  await triggers.configureManual({
    name: "deploy",
    daemon,
    cwd: "/workspace",
    agent: "codex/gpt-5.4",
    mode: "full-access",
    thinking: "high",
    prompt: "Run it",
  });
  await triggers.save("deploy");
  await hub.seedTriggerRun("deploy", { minutesAgo: 1, status: "succeeded" });
  const home = new OrganizationHome(page);
  await home.open();
  await hub.grantOperator("owner");
  await expect(home.finishSetup()).toBeVisible();

  await hub
    .primaryApplication()
    .query(
      "update trigger_runs set created_at = now() - interval '8 days' where configured_trigger_name = $1",
      ["deploy"],
    );
  await home.finishSetup().press("Enter");

  const alert = page.getByRole("alert").filter({ hasText: "Setup could not be finished" });
  await expect(alert).toContainText(
    "Complete the remaining organization step to finish setup. Record a run.",
  );
  await expect(home.allSet()).toHaveCount(0);
  await home.expectProgress("2 of 4 done");
  await home.expectStep("Record a run", "To do");
  await expect(alert).toBeFocused();
});

/** A self-hosted operator who deferred app setup is sent back to it from the first step. */
test("sends a self-hosted operator with no provider app to app setup", async ({ hub }) => {
  const session = await hub.openAppSetup({
    account: owner,
    providerScenario: "not-configured",
  });
  try {
    await session.surface.leave("Do this later");
    const home = new OrganizationHome(session.page);
    await home.expectOpen();
    await home.expectStep("Connect an app", "Needs setup");
    await home.capture(`${SHOTS}/05-self-hosted-setup.png`);
    await home.followStepAction("Connect an app", "Set up apps");
    await expect(session.page).toHaveURL(/\/apps$/u);
    await session.surface.expectManagement();
  } finally {
    await session.close();
  }
});
