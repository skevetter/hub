import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";

const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
] as const;

/** The step cards of the trigger form, found by their position and read by what a person sees. */
export class TriggerSteps {
  constructor(private readonly page: Page) {}

  step(position: number): Locator {
    return this.page.getByRole("region", { name: new RegExp(`^Step ${String(position)}:`, "u") });
  }

  async addStep() {
    await this.page.getByRole("button", { name: "Add step", exact: true }).click();
  }

  async expectOrder(ids: readonly string[]) {
    for (const [index, id] of ids.entries()) {
      await expect(this.step(index + 1)).toHaveAccessibleName(`Step ${String(index + 1)}: ${id}`);
    }
    await expect(this.page.getByRole("region", { name: /^Step \d+:/u })).toHaveCount(ids.length);
  }

  /** A step that is not being edited is one line. Opening it closes the one that was open. */
  async edit(position: number) {
    const open = this.step(position).getByRole("button", {
      name: `Edit step ${String(position)}`,
      exact: true,
    });
    if (!(await open.isVisible())) return;
    await open.click();
    await expect(this.step(position).getByLabel("Step ID", { exact: true })).toBeFocused();
  }

  async expectSummary(position: number, summary: string, condition = false) {
    const step = this.step(position);
    await expect(step.getByText(summary, { exact: true })).toBeVisible();
    await expect(step.getByText("Condition", { exact: true })).toHaveCount(condition ? 1 : 0);
    await expect(step.getByLabel("Step ID", { exact: true })).toHaveCount(0);
  }

  async rename(position: number, id: string) {
    await this.edit(position);
    await this.step(position).getByLabel("Step ID", { exact: true }).fill(id);
  }

  async choose(position: number, label: string, value: string) {
    await this.edit(position);
    await this.step(position).getByRole("combobox", { name: label, exact: true }).click();
    await this.page.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
  }

  async fillAgent(position: number, input: { agent: string; mode: string; prompt: string }) {
    await this.choose(position, "Agent", input.agent);
    await this.choose(position, "Execution mode", input.mode);
    await this.step(position).getByLabel("Instructions", { exact: true }).fill(input.prompt);
  }

  async openConditions(position: number) {
    await this.edit(position);
    const header = this.step(position).getByRole("button", { name: /^Condition/u });
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
  }

  async setCondition(position: number, condition: string) {
    await this.openConditions(position);
    await this.step(position).getByLabel("Run only if", { exact: true }).fill(condition);
  }

  async setOutputSchema(position: number, schema: string) {
    await this.openConditions(position);
    await this.step(position).getByLabel("Output schema (JSON)", { exact: true }).fill(schema);
  }

  async useScript(position: number, script: string) {
    await this.edit(position);
    await this.step(position).getByRole("radio", { name: "Script", exact: true }).click();
    await this.step(position).getByLabel("Script", { exact: true }).fill(script);
  }

  async chooseAction(position: number, action: "Prompt" | "Script") {
    await this.edit(position);
    await this.step(position).getByRole("radio", { name: action, exact: true }).click();
  }

  async chooseContinuity(position: number, label: string) {
    await this.edit(position);
    await this.step(position).getByRole("radio", { name: label, exact: true }).click();
  }

  async move(position: number, direction: "up" | "down") {
    await this.openMenu(position);
    await this.page
      .getByRole("menuitem", { name: direction === "up" ? "Move up" : "Move down", exact: true })
      .click();
  }

  async remove(position: number) {
    await this.openMenu(position);
    await this.page.getByRole("menuitem", { name: "Remove step", exact: true }).click();
    await this.page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove step", exact: true })
      .click();
  }

  async expectRemovalRefused(position: number) {
    await this.openMenu(position);
    await expect(
      this.page.getByRole("menuitem", { name: "Remove step", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await this.page.keyboard.press("Escape");
  }

  async openRunLimit(limit: string) {
    const header = this.page.locator("#trigger-run-limit-header");
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await this.page.getByLabel("Run time limit", { exact: true }).fill(limit);
  }

  async submit() {
    await this.page
      .locator("#trigger-editor-form")
      .getByRole("button", { name: /Create trigger|Save changes/u })
      .click();
  }

  /** Each width in light and dark: nothing scrolls sideways, the cards pass axe, one screenshot each. */
  async captureThemes(directory: string, name: string) {
    await this.page.addStyleTag({
      content:
        "*, *::before, *::after { transition: none !important; } .sticky { position: static !important; }",
    });
    await this.edit(2);
    for (const viewport of VIEWPORTS) {
      await this.page.setViewportSize(viewport);
      for (const colorScheme of ["light", "dark"] as const) {
        await this.page.emulateMedia({ colorScheme });
        await expect(this.page.locator("html")).toHaveClass(
          new RegExp(`\\b${colorScheme}\\b`, "u"),
        );
        await this.expectNoHorizontalScroll();
        const results = await new AxeBuilder({ page: this.page })
          .include('[aria-label^="Step "]')
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        expect(results.violations).toEqual([]);
        await this.shoot(directory, `${name}-${String(viewport.width)}-${colorScheme}`, viewport);
      }
    }
    await this.page.setViewportSize(VIEWPORTS[0]);
  }

  /** A viewport tall enough to hold the list, so fixed bars are drawn once instead of per slice. */
  private async shoot(directory: string, name: string, viewport: { width: number }) {
    await this.page.setViewportSize({ width: viewport.width, height: 6000 });
    await this.page
      .locator("ol")
      .filter({ has: this.step(1) })
      .screenshot({ path: join(directory, `${name}-list.png`), animations: "disabled" });
    await this.step(2).screenshot({
      path: join(directory, `${name}-card.png`),
      animations: "disabled",
    });
    await this.page.setViewportSize({ width: viewport.width, height: 900 });
  }

  private async openMenu(position: number) {
    await this.step(position)
      .getByRole("button", { name: `Actions for step ${String(position)}`, exact: true })
      .click();
  }

  private async expectNoHorizontalScroll() {
    const overflow = await this.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
}
