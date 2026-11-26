import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

const SHOT_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

const ROUTING_ATTENTION_TITLE = "2 events dropped in the last 7 days";

export type ChecklistStepTitle =
  | "Connect an app"
  | "Enroll a daemon"
  | "Create a trigger"
  | "Record a run";

/**
 * The organization landing: the checklist and the overview under it. Rows are addressed by the
 * step's title, and a step's state is the pill beside it, so the DSL reads like the page does.
 */
export class OrganizationHome {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole("link", { name: "Home", exact: true }).click();
    await this.expectOpen();
  }

  async expectOpen() {
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/home$/u);
    await expect(this.page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  }

  async reload() {
    await this.page.reload();
    await this.expectOpen();
  }

  step(title: ChecklistStepTitle): Locator {
    return this.page
      .getByRole("list", { name: "Getting started" })
      .getByRole("listitem")
      .filter({ hasText: title });
  }

  async expectStep(title: ChecklistStepTitle, state: string) {
    await expect(this.step(title)).toContainText(state);
  }

  async expectProgress(progress: string) {
    await expect(this.page.getByRole("button", { name: /Getting started/u })).toContainText(
      progress,
    );
  }

  allSet() {
    return this.page.getByRole("heading", { name: "You are all set", exact: true });
  }

  finishSetup() {
    return this.page.getByRole("button", { name: "Finish setup", exact: true });
  }

  async expectChecklistHidden() {
    await expect(this.page.getByRole("button", { name: /Getting started/u })).toHaveCount(0);
    await expect(this.allSet()).toHaveCount(0);
    await expect(this.finishSetup()).toHaveCount(0);
  }

  /** The command a row tells the reader to run, as rendered. */
  command(title: ChecklistStepTitle): Locator {
    return this.step(title).locator("span.font-mono");
  }

  async followStepAction(title: ChecklistStepTitle, name: string) {
    await this.step(title).getByRole("link", { name, exact: true }).click();
  }

  async expectNoRoutingNotice() {
    await expect(this.page.getByRole("main").getByText(ROUTING_ATTENTION_TITLE)).toHaveCount(0);
  }

  async openDroppedEvents() {
    await this.page.goto(new URL("./activity?view=dropped&range=7d", this.page.url()).toString());
    await expect(this.page.getByRole("table", { name: "Dropped events" })).toBeVisible();
  }

  async createTriggerFromDroppedEvents() {
    await this.page
      .getByRole("table", { name: "Dropped events" })
      .getByRole("link", { name: "Create one", exact: true })
      .first()
      .click();
    await expect(this.page).toHaveURL(/\/triggers\/new\/edit$/u);
  }

  needsYou() {
    return this.page.getByRole("group", { name: "Needs you", exact: true });
  }

  private needsYouFigure(unit: string): Locator {
    return this.needsYou().locator("[data-slot=figure]").filter({ hasText: unit });
  }

  /** The "Needs you" figure whose unit contains the text, read as its numeral. */
  async expectNeedsYou(unit: string, value: number) {
    await expect(this.needsYouFigure(unit).locator("span").first()).toHaveText(String(value));
  }

  async expectNeedsYouCaption(unit: string, caption: string | RegExp) {
    await expect(this.needsYouFigure(unit)).toContainText(caption);
  }

  async followNeedsYouLink(unit: string, name: string) {
    await this.needsYouFigure(unit).getByRole("link", { name, exact: true }).click();
  }

  async expectAllClear() {
    for (const unit of [
      "triggers failing",
      "apps to authorize",
      "daemons to check",
      "stopped matching",
    ]) {
      await this.expectNeedsYou(unit, 0);
      await expect(this.needsYouFigure(unit).getByRole("link")).toHaveCount(0);
    }
  }

  runsFigures() {
    return this.page.getByRole("group", { name: "Runs", exact: true });
  }

  async expectRuns(total: number, didNotFinish: number) {
    const figures = this.runsFigures().locator("[data-slot=figure]");
    await expect(figures.nth(0).locator("span").first()).toHaveText(String(total));
    await expect(figures.nth(1).locator("span").first()).toHaveText(String(didNotFinish));
  }

  runsChart(): Locator {
    return this.page.getByRole("img", { name: /^Runs per day\./u });
  }

  async expectNoHorizontalScroll() {
    const overflow = await this.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  }

  /** Each viewport in light and dark: no sideways scroll, no axe violations in the figures, one screenshot. */
  async captureThemes(directory: string, name: string) {
    await this.page.addStyleTag({
      content: "*, *::before, *::after { transition: none !important; }",
    });
    for (const viewport of SHOT_VIEWPORTS) {
      await this.page.setViewportSize(viewport);
      for (const colorScheme of ["light", "dark"] as const) {
        await this.page.emulateMedia({ colorScheme });
        await expect(this.page.locator("html")).toHaveClass(
          new RegExp(`\\b${colorScheme}\\b`, "u"),
        );
        await this.expectNoHorizontalScroll();
        const results = await new AxeBuilder({ page: this.page })
          .include('[role="group"][aria-label="Needs you"]')
          .include('[role="group"][aria-label="Runs"]')
          .include('[role="img"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(results.violations).toEqual([]);
        await this.page.screenshot({
          path: join(directory, `${name}-${String(viewport.width)}-${colorScheme}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await this.page.setViewportSize({ width: 1280, height: 720 });
    await this.page.emulateMedia({ colorScheme: null });
  }

  async expectRemovedSurfacesAbsent() {
    const main = this.page.getByRole("main");
    await expect(main.getByRole("list", { name: "Trigger health" })).toHaveCount(0);
    await expect(main.getByRole("link", { name: "Recent runs", exact: true })).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "Start a session" })).toHaveCount(0);
    await expect(main.getByText("Where it runs")).toHaveCount(0);
  }

  async capture(path: string) {
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path, fullPage: true });
  }
}
