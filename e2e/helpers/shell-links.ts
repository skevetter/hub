import type { Locator, Page } from "@playwright/test";

/**
 * A destination link in the shell's own navigation. Breadcrumbs repeat the same names on deeper
 * pages, so a locator by name alone matches two links there.
 */
export function shellLink(page: Page, name: string): Locator {
  return page
    .locator('nav:not([aria-label="Breadcrumb"])')
    .getByRole("link", { name, exact: true });
}
