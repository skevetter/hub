import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { BuiltApplication } from "./hub.js";
import { projectApp } from "./projects/index.js";

const screenshots = process.env["HUB_DAEMONS_SCREENSHOT_DIR"];

export class OrganizationDaemons {
  constructor(private readonly page: Page) {}

  async open() {
    await projectApp(this.page).navigation.openOrganizationSection("Daemons");
    await expect(this.page.getByRole("heading", { name: "Daemons", level: 1 })).toBeVisible();
  }

  list() {
    return this.page.getByRole("list", { name: "Daemons", exact: true });
  }

  device(name: string) {
    return this.list()
      .getByRole("listitem")
      .filter({
        has: this.page.getByRole("heading", { name, exact: true }),
      });
  }

  search() {
    return this.page.getByLabel("Search daemons", { exact: true });
  }

  async capture(state: "empty" | "populated" | "filtered") {
    for (const width of [1280, 390]) {
      await this.page.setViewportSize({ width, height: 900 });
      expect(
        await this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (screenshots !== undefined && screenshots !== "") {
        await this.page.screenshot({
          path: `${screenshots}/${state}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
  }
}

export async function seedDaemonProfile(
  application: BuiltApplication,
  organizationName: string,
  daemonSlug: string,
  name: string,
) {
  const rows = await application.query(
    `insert into interactive_session_profiles (id, organization_id, name, daemon_id, cwd, provider, status)
     select $1, organization.id, $4, daemons.id, '/workspace/review', 'opencode', 'active'
     from organization join daemons on daemons.organization_id = organization.id
     where organization.name = $2 and daemons.slug = $3
     returning name`,
    [randomUUID(), organizationName, daemonSlug, name],
  );
  expect(rows).toEqual([{ name }]);
}
