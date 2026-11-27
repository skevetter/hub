import { expect } from "@playwright/test";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";
import { TriggerSteps } from "./helpers/trigger-steps.js";

const SHOTS = "e2e/screenshots/steps-ui";
const owner = {
  name: "Steps Owner",
  email: "steps-owner@example.com",
  password: "steps-owner-password",
};
const AGENT = "opencode/gateway/vendor/model-v1";
const SCHEMA = '{"type":"object","properties":{"verdict":{"enum":["ok","fix"]}}}';
const CONDITION = "${{ steps.review.outputs.verdict == 'fix' }}";

test("builds a step list in the form, flags a stale condition, and saves it as written", async ({
  hub,
  page,
}) => {
  test.setTimeout(90_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  const triggers = new OrganizationTriggers(page);
  const steps = new TriggerSteps(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureSlackMention({
    name: "triage-chain",
    connection: "company-slack",
    daemon,
    cwd: "/workspace/acme",
    users: "U123",
    agent: AGENT,
    mode: "full-access",
    thinking: "low",
    providerOptions: "{}",
    prompt: "Review the request.",
  });

  await test.step("a second step turns the card into a list and keeps what was typed", async () => {
    await expect(page.getByRole("region", { name: /^Step \d+:/u })).toHaveCount(0);
    await steps.addStep();
    await steps.expectOrder(["run", "step-2"]);
    await expect(steps.step(2).getByLabel("Step ID", { exact: true })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Step added" })).toHaveText(
      "Step added. 2 steps.",
    );
    await steps.expectSummary(1, "Agent: Gateway Model v1");
    await steps.edit(1);
    await expect(steps.step(1).getByLabel("Instructions", { exact: true })).toHaveValue(
      "Review the request.",
    );
    await steps.rename(1, "review");
    await steps.setOutputSchema(1, SCHEMA);
    await steps.rename(2, "fix");
    await steps.fillAgent(2, {
      agent: AGENT,
      mode: "full-access",
      prompt: "Fix what the review found.",
    });
    await expect(
      steps.step(2).getByRole("radio", { name: "New agent", exact: true }),
    ).toBeChecked();
    await steps.setCondition(2, CONDITION);
    await expect(
      steps.step(2).getByLabel("Run only if", { exact: true }),
    ).toHaveAccessibleDescription(/steps\.review\.outputs\.verdict/u);
    await steps.addStep();
    await steps.useScript(3, "npm test");
    await steps.openRunLimit("3h");
    await steps.expectOrder(["review", "fix", "step-3"]);
  });

  await test.step("only the step being edited is open; the others are one line", async () => {
    await steps.expectSummary(1, "Agent: Gateway Model v1");
    await steps.expectSummary(2, "Agent: Gateway Model v1", true);
    await expect(steps.step(3).getByLabel("Script", { exact: true })).toHaveValue("npm test");
    await steps.edit(1);
    await steps.expectSummary(3, "Script: npm test");
    await expect(steps.step(1).getByLabel("Step ID", { exact: true })).toBeFocused();
    await steps.edit(3);
  });

  await test.step("moving a step above the one its condition reads flags the condition and keeps its text", async () => {
    await steps.move(2, "up");
    await steps.expectOrder(["fix", "review", "step-3"]);
    await expect(steps.step(1).getByRole("button", { name: "Actions for step 1" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Step moved" })).toHaveText(
      "Step moved to position 1 of 3.",
    );
    await expect(steps.step(1).getByLabel("Run only if", { exact: true })).toHaveValue(CONDITION);
    await expect(steps.step(1)).toContainText(
      'Step "review" does not run before this step, so its outputs are not available.',
    );
    const editorUrl = page.url();
    await steps.submit();
    await expect(
      page.getByRole("alert").filter({ hasText: "This trigger is not ready to save" }),
    ).toBeVisible();
    await expect(steps.step(1).getByLabel("Run only if", { exact: true })).toHaveValue(CONDITION);
    expect(page.url()).toBe(editorUrl);
    await steps.move(1, "down");
    await steps.expectOrder(["review", "fix", "step-3"]);
    await expect(steps.step(2)).not.toContainText("does not run before this step");
    await expect(steps.step(2).getByLabel("Run only if", { exact: true })).toHaveValue(CONDITION);
  });

  await test.step("an ID the form refuses is flagged on its step and stops the save", async () => {
    const editorUrl = page.url();
    await steps.rename(3, "constructor");
    await expect(steps.step(3)).toContainText('"constructor" is reserved. Choose another ID.');
    await steps.submit();
    await expect(
      page.getByRole("alert").filter({ hasText: "This trigger is not ready to save" }),
    ).toBeVisible();
    expect(page.url()).toBe(editorUrl);
    await steps.rename(3, "step-3");
    await expect(steps.step(3)).not.toContainText("is reserved");
  });

  await test.step("the cards read cleanly at desktop and phone width in both themes", async () => {
    await steps.captureThemes(SHOTS, "steps");
  });

  await test.step("the row controls are 44 px on a phone and keep their desktop size above it", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const desktop = await steps.rowControlSizes();
    expect(desktop.length).toBeGreaterThanOrEqual(4);
    for (const { name, height } of desktop) expect(height, name).toBeLessThan(36);
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = await steps.rowControlSizes();
    expect(phone.map(({ name }) => name)).toEqual(desktop.map(({ name }) => name));
    for (const { name, width, height } of phone) {
      expect(width, name).toBeGreaterThanOrEqual(44);
      expect(height, name).toBeGreaterThanOrEqual(44);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await test.step("a collapsed row with a long ID and a condition still holds both 44 px buttons", async () => {
    await steps.rename(2, "a-step-id-that-is-much-too-long-for-one-line");
    await steps.edit(1);
    await steps.expectSummary(2, "Agent: Gateway Model v1", true);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await steps.expectRowControlsFit(2);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await steps.rename(2, "fix");
  });

  await test.step("a conversation that two steps cannot share is marked on the step the save check names", async () => {
    await steps.chooseContinuity(2, "Same conversation");
    await steps.submit();
    await expect(steps.step(2).getByRole("alert")).toContainText(
      'Step "fix" continues the same conversation as step "review"',
    );
    await expect(steps.step(1).getByRole("alert")).toHaveCount(0);
    await steps.chooseContinuity(2, "New agent");
    await expect(steps.step(2).getByRole("alert")).toHaveCount(0);
  });

  await test.step("a refusal that arrives after the form changed is not put on a step", async () => {
    await steps.chooseContinuity(2, "Same conversation");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/_serverFn/**", async (route) => {
      await held;
      await route.continue();
    });
    await steps.submit();
    await steps.edit(1);
    await steps.step(1).getByLabel("Instructions", { exact: true }).fill("Review it again.");
    release();
    await expect(page.getByRole("alert").filter({ hasText: "Trigger not saved" })).toContainText(
      "continues the same conversation as step",
    );
    await expect(page.getByRole("region", { name: /^Step \d+:/u }).getByRole("alert")).toHaveCount(
      0,
    );
    await page.unroute("**/_serverFn/**");
    await steps.chooseContinuity(2, "New agent");
  });

  await test.step("the list saves in order and opens again as it was written", async () => {
    await triggers.save("triage-chain");
    await triggers.openTrigger("triage-chain");
    await steps.expectOrder(["review", "fix", "step-3"]);
    await expect(steps.step(1).getByLabel("Step ID", { exact: true })).toHaveValue("review");
    await steps.expectSummary(2, "Agent: Gateway Model v1", true);
    await steps.expectSummary(3, "Script: npm test");
    await steps.edit(2);
    await expect(steps.step(2).getByLabel("Run only if", { exact: true })).toHaveValue(CONDITION);
    await expect(
      steps.step(2).getByRole("radio", { name: "New agent", exact: true }),
    ).toBeChecked();
    await steps.edit(1);
    const saved = await steps
      .step(1)
      .getByLabel("Output schema (JSON)", { exact: true })
      .inputValue();
    expect(JSON.parse(saved)).toEqual(JSON.parse(SCHEMA));
    await steps.edit(3);
    await expect(steps.step(3).getByLabel("Script", { exact: true })).toHaveValue("npm test");
    await expect(page.getByLabel("Run time limit", { exact: true })).toHaveValue("3h");
    await triggers.switchToYaml();
    await triggers.expectYamlContains("steps:", "id: review", "id: fix", "max_runtime: 3h");
    await triggers.switchToForm();
  });

  await test.step("switching a step to Script and back keeps its output schema", async () => {
    const schema = steps.step(1).getByLabel("Output schema (JSON)", { exact: true });
    await steps.openConditions(1);
    const before = await schema.inputValue();
    await steps.chooseAction(1, "Script");
    await expect(steps.step(1).getByLabel("Script", { exact: true })).toBeVisible();
    await steps.chooseAction(1, "Prompt");
    await steps.openConditions(1);
    await expect(schema).toHaveValue(before);
    await triggers.save("triage-chain");
    await triggers.openTrigger("triage-chain");
    await steps.edit(1);
    await steps.openConditions(1);
    expect(JSON.parse(await schema.inputValue())).toEqual(JSON.parse(SCHEMA));
  });

  await test.step("a script step saved with a kept schema writes no output schema", async () => {
    await steps.setCondition(2, "");
    await steps.chooseAction(1, "Script");
    await steps.step(1).getByLabel("Script", { exact: true }).fill("npm run check");
    await triggers.save("triage-chain");
    await triggers.openTrigger("triage-chain");
    await steps.edit(1);
    await expect(steps.step(1).getByLabel("Script", { exact: true })).toHaveValue("npm run check");
    await triggers.switchToYaml();
    await expect(page.getByRole("textbox", { name: "Trigger YAML" })).not.toContainText("schema");
    await page.getByRole("radio", { name: "Form" }).click();
    await steps.chooseAction(1, "Prompt");
    await steps.fillAgent(1, { agent: AGENT, mode: "full-access", prompt: "Review the request." });
    await steps.setOutputSchema(1, SCHEMA);
  });

  await test.step("a step is removed after confirming, and the last one cannot be", async () => {
    await steps.remove(3);
    await expect(steps.step(2).getByRole("button", { name: "Actions for step 2" })).toBeFocused();
    await steps.remove(2);
    await steps.expectOrder(["review"]);
    await expect(steps.step(1).getByRole("button", { name: "Actions for step 1" })).toBeFocused();
    await steps.expectRemovalRefused(1);
    await expect(page.getByRole("button", { name: "Add step", exact: true })).toBeVisible();
  });

  await test.step("one step with its own ID and output schema stays a list", async () => {
    await triggers.save("triage-chain");
    await triggers.openTrigger("triage-chain");
    await steps.expectOrder(["review"]);
    await triggers.switchToYaml();
    await triggers.expectYamlContains("steps:", "id: review");
    await expect(page.getByRole("textbox", { name: "Trigger YAML" })).not.toContainText(/^run:/mu);
  });
});

test("a list with aliases says why a step cannot move, and why a combined edit is refused", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  const triggers = new OrganizationTriggers(page);
  const steps = new TriggerSteps(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureManual({
    name: "alias-steps",
    daemon,
    cwd: "/workspace/acme",
    agent: AGENT,
    mode: "full-access",
    thinking: "low",
    prompt: "Plan it.",
  });
  const agent = `agent: { provider: opencode, model: gateway/vendor/model-v1, mode: full-access, thinkingOptionId: low }`;

  await test.step("an alias cannot be put before its anchor", async () => {
    await triggers.switchToYaml();
    await triggers.replaceYaml(`name: alias-steps
on:
  manual.run: {}
target: { daemon: ${daemon}, cwd: /workspace/acme }
steps:
  - id: plan
    ${agent}
    prompt: &p Plan it.
  - id: build
    ${agent}
    prompt: *p
`);
    await triggers.switchToForm();
    await steps.expectOrder(["plan", "build"]);
    await steps.move(1, "down");
    await expect(page.getByRole("alert").filter({ hasText: "Steps not changed" })).toContainText(
      "This change would break a YAML alias.",
    );
    await steps.expectOrder(["plan", "build"]);
  });

  await test.step("a one-step list written in YAML keeps its step controls", async () => {
    await triggers.switchToYaml();
    await triggers.replaceYaml(`name: alias-steps
on:
  manual.run: {}
target: { daemon: ${daemon}, cwd: /workspace/acme }
steps:
  - id: run
    ${agent}
    prompt: Plan it.
`);
    await triggers.switchToForm();
    await steps.expectOrder(["run"]);
    await expect(steps.step(1).getByLabel("Step ID", { exact: true })).toHaveValue("run");
  });

  await test.step("a run whose alias would move cannot gain a step in the same save", async () => {
    await triggers.switchToYaml();
    await triggers.replaceYaml(`name: &p alias-convert
run:
  target: { daemon: ${daemon}, cwd: /workspace/acme }
  ${agent}
  prompt: *p
on:
  slack.mention:
    connection: &p company-slack
    filters:
      from_users: [U123]
`);
    await triggers.switchToForm();
    await steps.addStep();
    await steps.fillAgent(2, { agent: AGENT, mode: "full-access", prompt: "Then this." });
    await triggers.expectRefusedOnSubmit("This change would break a YAML alias.");
  });
});

test("a field flagged inside a section is visible when its collapsed step opens again", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  const triggers = new OrganizationTriggers(page);
  const steps = new TriggerSteps(page);
  await triggers.open();
  await triggers.startNew();
  await triggers.configureManual({
    name: "options-steps",
    daemon,
    cwd: "/workspace/acme",
    agent: AGENT,
    mode: "full-access",
    thinking: "low",
    prompt: "Plan it.",
  });
  await page.getByRole("button", { name: /^Advanced provider options/u }).click();
  await page.getByLabel("Provider options (JSON)", { exact: true }).fill("{not json");
  await steps.addStep();
  await steps.expectSummary(1, "Agent: Gateway Model v1");
  await steps.submit();
  const options = steps.step(1).getByLabel("Provider options (JSON)", { exact: true });
  await expect(options).toBeVisible();
  await expect(steps.step(1).getByRole("alert")).toBeVisible();
  await options.fill("{}");
  await expect(steps.step(1).getByRole("alert")).toHaveCount(0);
});
