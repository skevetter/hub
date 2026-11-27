import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "./app.js";
import { OrganizationTriggers } from "./helpers/triggers.js";
import { TriggerSteps } from "./helpers/trigger-steps.js";

const PHASE = process.env["TAP_PHASE"] ?? "before";
const OUT = join("/tmp/tap-targets/round2", PHASE);
const AGENT = "opencode/gateway/vendor/model-v1";
const owner = { name: "Tap Owner", email: "tap-owner@example.com", password: "tap-owner-password" };

function overflowReport() {
  const width = window.innerWidth;
  const dx = window.scrollX;
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return {
      left: Math.round(box.left + dx),
      right: Math.round(box.right + dx),
      w: Math.round(box.width),
    };
  };
  const label = (element: Element) =>
    `${element.tagName.toLowerCase()}${element.getAttribute("data-slot") === null ? "" : `[${element.getAttribute("data-slot") ?? ""}]`}.${String(element.getAttribute("class") ?? "").slice(0, 70)}`;
  const card = document.querySelector("section[aria-label^='Step 1']");
  const chain: unknown[] = [];
  for (let node: Element | null = card; node !== null; node = node.parentElement) {
    chain.push({ el: label(node), ...rect(node), display: getComputedStyle(node).display });
  }
  const offenders = [...document.querySelectorAll("body *")]
    .filter((element) => element.getBoundingClientRect().right + dx > width + 1)
    .slice(-40)
    .map((element) => ({ el: label(element), ...rect(element) }));
  const wide: unknown[] = [];
  const probe = (element: HTMLElement, depth: number) => {
    const before = element.style.width;
    element.style.width = "min-content";
    const min = Math.round(element.getBoundingClientRect().width);
    element.style.width = before;
    if (min > 205) wide.push({ depth, el: label(element), min });
    if (depth < 5) for (const child of element.children) probe(child as HTMLElement, depth + 1);
  };
  if (card instanceof HTMLElement)
    for (const child of card.children) probe(child as HTMLElement, 1);
  return [
    {
      wide,
      innerWidth: width,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth - width,
      chain,
      offenders,
    },
  ];
}

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
    for (const width of name === "trigger-editor-steps" ? [1280, 390, 320] : [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 320) await steps.edit(1);
      await page.waitForTimeout(400);
      await page.screenshot({
        path: join(OUT, `${name}-${String(width)}.png`),
        fullPage: true,
        animations: "disabled",
      });
      if (width === 320) {
        report["overflow-320"] = await page.evaluate(overflowReport);
        continue;
      }
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
            element.scrollIntoView({ block: "center" });
            const box = element.getBoundingClientRect();
            const hit = (horizontal: boolean) => {
              const cx = box.x + box.width / 2;
              const cy = box.y + box.height / 2;
              const owns = (x: number, y: number) => {
                const found = document.elementFromPoint(x, y);
                return found !== null && (found === element || element.contains(found));
              };
              let count = 0;
              for (let d = -80; d <= 80; d++) {
                const x = horizontal ? cx + d : cx;
                const y = horizontal ? cy : cy + d;
                if (owns(x, y)) count++;
              }
              return count;
            };
            return {
              hitW: element.tagName === "A" ? hit(true) : undefined,
              hitH: element.tagName === "A" ? hit(false) : undefined,
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
          .filter(({ w, h, hitW, hitH }) => (hitW ?? w) < 44 || (hitH ?? h) < 44);
      });
    }
  }
  await visit("trigger-editor-steps");
  await page.goto(new URL("triggers", orgBase).toString());
  await page.waitForLoadState("networkidle");
  await visit("triggers-list");
  for (const path of [
    "./home",
    "./activity",
    "./connections",
    "./daemons",
    "./settings/team",
    "./settings/api-keys",
    "./sessions/new",
  ]) {
    await page.goto(new URL(path.slice(2), orgBase).toString());
    await page.waitForLoadState("networkidle");
    await visit(path.slice(2).replaceAll("/", "-"));
  }
  writeFileSync(join(OUT, "audit.json"), JSON.stringify(report, null, 1));
});
