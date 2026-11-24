import { expect, type Locator, type Page } from "@playwright/test";
import { attentionDialog } from "./attention.js";

const ROUTING_ATTENTION_TITLE = "Events arrived without a route or matching trigger";

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
    await this.page.getByRole("button", { name: /^Attention, \d+ items?$/u }).click();
    return attentionDialog(this.page).getByRole("listitem").filter({
      hasText: ROUTING_ATTENTION_TITLE,
    });
  }

  async followRoutingAttention(item: Locator) {
    const link = item.getByRole("link", { name: /^View dropped events(?:$|:)/u });
    await expect(link).toBeVisible();
    await link.click();
    await expect(this.page).toHaveURL(/[?&]reason=routing/u);
    await this.page
      .getByRole("table", { name: "Dropped events" })
      .getByRole("link", { name: "Create one", exact: true })
      .first()
      .click();
    await expect(this.page).toHaveURL(/\/triggers\/new\/edit$/u);
  }

  async expectRuns(count: number, outcomes: string) {
    const tile = this.page.getByText("Runs, 24 hours", { exact: true }).locator("..").locator("..");
    await expect(tile).toContainText(String(count));
    await expect(tile).toContainText(outcomes);
  }

  async expectRecentRun(triggerName: string, status: string) {
    const row = this.page
      .getByRole("list", { name: "Recent runs" })
      .getByRole("listitem")
      .filter({ hasText: triggerName });
    await expect(row).toContainText(status);
  }

  async capture(path: string) {
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await this.page.screenshot({ path, fullPage: true });
  }
}
