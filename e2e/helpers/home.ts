import { expect, type Locator, type Page } from "@playwright/test";
import { openAttention } from "./attention.js";

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

  async openRoutingAttention() {
    await expect(this.page.getByRole("main").getByText(ROUTING_ATTENTION_TITLE)).toHaveCount(0);
    const dialog = await openAttention(this.page, 0);
    return dialog.getByRole("region", { name: "For information" }).getByRole("listitem");
  }

  async followRoutingAttention(item: Locator) {
    const link = item.getByRole("link", { name: "View dropped events", exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await expect(this.page).toHaveURL(/[?&]view=dropped/u);
    await this.page
      .getByRole("table", { name: "Dropped events" })
      .getByRole("link", { name: "Create one", exact: true })
      .first()
      .click();
    await expect(this.page).toHaveURL(/\/triggers\/new\/edit$/u);
  }

  figures() {
    return this.page.getByRole("group", { name: "Overview", exact: true });
  }

  /** The figure that counts the unit, for example "triggers failing", read as its numeral. */
  async expectFigure(unit: string, value: number) {
    const figure = this.figures().locator("[data-slot=figure]").filter({ hasText: unit });
    await expect(figure.locator("span").first()).toHaveText(String(value));
  }

  triggerRow(triggerName: string): Locator {
    return this.page
      .getByRole("list", { name: "Trigger health" })
      .getByRole("listitem")
      .filter({ hasText: triggerName });
  }

  async expectTrigger(triggerName: string, state: string) {
    await expect(this.triggerRow(triggerName)).toContainText(state);
  }

  /** Home keeps no run list; this link under the triggers is the way to Activity. */
  recentRunsLink(): Locator {
    return this.page
      .getByRole("main")
      .getByRole("link", { name: "Recent runs", exact: true })
      .and(this.page.locator('a[href$="/activity"]'));
  }

  async followRecentRuns() {
    await this.recentRunsLink().click();
    await expect(this.page).toHaveURL(/\/o\/[^/]+\/activity$/u);
    await expect(this.page.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  }

  async capture(path: string) {
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path, fullPage: true });
  }
}
