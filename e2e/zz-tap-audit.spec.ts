import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";
import { TriggerSteps } from "./helpers/trigger-steps.js";

const PHASE = process.env["TAP_PHASE"] ?? "before";
const OUT = join("/tmp/tap-targets", PHASE);
const AGENT = "opencode/gateway/vendor/model-v1";
const owner = { name: "Tap Owner", email: "tap-owner@example.com", password: "tap-owner-password" };

test("tap target audit and screenshots", async ({ hub, page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
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
  await steps.addStep();
  await steps.rename(1, "review");
  await steps.rename(2, "fix");
  await steps.fillAgent(2, { agent: AGENT, mode: "full-access", prompt: "Fix it." });
  await steps.addStep();
  await steps.useScript(3, "npm test");
  await page.addStyleTag({
    content:
      "*, *::before, *::after { transition: none !important; } .sticky { position: static !important; }",
  });
  const orgBase = new URL(/\/o\/[^/]+\//u.exec(page.url())?.[0] ?? "/", page.url()).toString();
  const report: Record<string, unknown[]> = {};
  async function visit(name: string) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: join(OUT, `${name}-${String(width)}.png`),
        fullPage: true,
        animations: "disabled",
      });
      if (width !== 390) continue;
      report[name] = await page.evaluate(() => {
        const visible = (element: Element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.visibility !== "hidden" &&
            !element.closest("[hidden],[aria-hidden='true']")
          );
        };
        return [
          ...document.querySelectorAll(
            "button, a[href], [role='button'], [role='menuitem'], [role='tab'], [role='radio'], input:not([type=hidden]), select, summary",
          ),
        ]
          .filter(visible)
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              slot: element.getAttribute("data-slot"),
              size: element.getAttribute("data-size"),
              name: (element.getAttribute("aria-label") ?? element.textContent ?? "")
                .trim()
                .slice(0, 40),
              w: Math.round(box.width),
              h: Math.round(box.height),
            };
          })
          .filter(({ w, h }) => w < 44 || h < 44);
      });
    }
  }
  await visit("trigger-editor-steps");
  await page.goto(new URL("triggers", orgBase).toString());
  await page.waitForLoadState("networkidle");
  await visit("triggers-list");
  for (const path of ["./home", "./activity", "./connections", "./daemons", "./settings/team"]) {
    await page.goto(new URL(path.slice(2), orgBase).toString());
    await page.waitForLoadState("networkidle");
    await visit(path.slice(2).replaceAll("/", "-"));
  }
  writeFileSync(join(OUT, "audit.json"), JSON.stringify(report, null, 1));
});
