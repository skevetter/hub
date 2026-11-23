import { expect, type Page } from "@playwright/test";

export type OrganizationSection =
  | "Home"
  | "Triggers"
  | "Activity"
  | "Daemons"
  | "Connections"
  | "Settings";
export type OrganizationSettingsSection = "Team" | "API keys" | "Usage" | "Billing";
export type ProjectSection = "Overview" | "Configuration" | "Activity" | "Settings";
export type InstanceSection = "Apps" | "Operator";

export class ProjectNavigation {
  constructor(private readonly page: Page) {}

  async expectProjects() {
    await expect(this.page.getByRole("heading", { name: "Projects" })).toBeVisible();
  }

  async openProject(name: string) {
    await this.page.getByRole("link", { name }).click();
    await expect(this.page.getByRole("heading", { name: "Overview" })).toBeVisible();
  }

  async openOrganizationSection(name: OrganizationSection) {
    const link = this.page
      .getByRole("navigation", { name: "Organization", exact: true })
      .getByRole("link", { name });
    const href = await link.getAttribute("href");
    if (href === null) throw new Error(`Organization navigation link ${name} has no destination`);
    const destination = new URL(href, this.page.url()).toString();
    await Promise.all([this.page.waitForURL(destination), link.click()]);
  }

  /** Administration is two hops now: the Settings entry, then the section's tab. */
  async openOrganizationSettings(name: OrganizationSettingsSection) {
    await this.openOrganizationSection("Settings");
    await this.page
      .getByRole("navigation", { name: "Organization settings" })
      .getByRole("link", { name })
      .click();
  }

  async openProjectSection(name: ProjectSection) {
    await this.page
      .getByRole("navigation", { name: "Project", exact: true })
      .getByRole("link", { name })
      .click();
  }

  /** The project sidebar's way back out to organization scope. */
  async leaveProject() {
    await this.page
      .getByRole("navigation", { name: "Project", exact: true })
      .getByRole("link", { name: "All projects" })
      .click();
  }

  async openInstanceSection(name: InstanceSection) {
    await this.openOrganizationSection("Settings");
    await this.enterInstanceScope(name);
  }

  async openMobileInstanceSection(name: InstanceSection) {
    await this.openMobileOrganizationSection("Settings");
    await this.enterInstanceScope(name);
  }

  async leaveInstance() {
    const mobile = this.page.getByRole("navigation", { name: "Quick navigation" });
    if (await mobile.isVisible()) {
      await mobile.getByRole("link", { name: "Home", exact: true }).click();
    } else {
      await this.openOrganizationSection("Home");
    }
  }

  /** The footer account menu — everything that belongs to the person, not to a tenant. */
  async openAccountMenu(account: string) {
    await this.page.getByRole("button", { name: account }).click();
    const menu = this.page.getByRole("menu");
    await expect(menu).toBeVisible();
    return menu;
  }

  private async enterInstanceScope(name: InstanceSection) {
    await this.page
      .getByRole("navigation", { name: "Organization settings" })
      .getByRole("link", { name: "Instance", exact: true })
      .click();
    const instance = this.page.getByRole("navigation", { name: "Instance settings" });
    if (name !== "Apps") await instance.getByRole("link", { name, exact: true }).click();
  }

  /** On a phone every destination outside the bottom bar lives in the More sheet. */
  private async toggleMobileSidebar() {
    await this.page
      .getByRole("navigation", { name: "Quick navigation" })
      .getByRole("button", { name: "More", exact: true })
      .click();
    await expect(this.page.getByRole("dialog", { name: "More", exact: true })).toBeVisible();
  }

  async openMobileProjectSection(name: ProjectSection) {
    await this.toggleMobileSidebar();
    await this.openProjectSection(name);
  }

  async openMobileOrganizationSection(name: OrganizationSection) {
    await this.toggleMobileSidebar();
    await this.openOrganizationSection(name);
  }

  async openMobileOrganizationSettings(name: OrganizationSettingsSection) {
    await this.toggleMobileSidebar();
    await this.openOrganizationSettings(name);
  }

  async switchProject(name: string) {
    await this.page.getByRole("button", { name: "Project", exact: true }).click();
    await this.page.getByRole("menuitem", { name, exact: true }).click();
  }

  async expectBreadcrumb(...parts: string[]) {
    const breadcrumb = this.page.getByRole("navigation", { name: "Breadcrumb" });
    for (const part of parts)
      await expect(breadcrumb.getByText(part, { exact: true })).toBeVisible();
  }

  async organizationHref(name: string) {
    await this.page.getByRole("button", { name: "Organization" }).click();
    const href = await this.page.getByRole("menuitem", { name, exact: true }).getAttribute("href");
    await this.page.keyboard.press("Escape");
    expect(href).not.toBeNull();
    return href!;
  }

  async visit(path: string) {
    await this.page.goto(new URL(path, this.page.url()).toString());
  }

  async createOrganizationLandingHint(name: string) {
    await this.page.getByRole("button", { name: "Organization", exact: true }).click();
    await this.page.getByRole("menuitem", { name: "New organization" }).click();
    const form = this.page.getByRole("form", { name: "Create organization" });
    await form.getByLabel("Organization name").fill(name);
    await form.getByRole("button", { name: "Create organization" }).click();
    await expect(
      this.page.getByRole("button", { name: "Organization", exact: true }),
    ).toContainText(name);
  }

  async proveDeepLinkAuthorityWithMismatchedLandingHint(organization: string, project: string) {
    const projectsPath = new URL(this.page.url()).pathname;
    await this.createOrganizationLandingHint("Orbit");
    await this.visit(`${projectsPath}/${project.toLowerCase()}/overview`);
    await this.expectBreadcrumb(organization, project, "Overview");
  }

  async expectUnavailable(kind: "Organization" | "Project") {
    await expect(this.page.getByRole("alert")).toContainText(`${kind} unavailable`);
  }
}
