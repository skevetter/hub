import { expect, type Page } from "@playwright/test";
import type { BuiltApplication } from "./hub.js";

type ReadEndpoint = "triggers" | "tenant" | "daemons" | "usage";

/** Real database faults in the isolated application, with no intercepted server responses. */
export class SnapshotRecovery {
  private readonly readPaths = new Map<string, ReadEndpoint>();
  private readonly failures = new Map<ReadEndpoint, number>();

  constructor(
    private readonly page: Page,
    private readonly app: BuiltApplication,
  ) {
    page.on("response", async (response) => {
      const endpoint = this.readPaths.get(new URL(response.url()).pathname);
      if (endpoint === undefined) return;
      const body = await response.text().catch(() => "");
      if (body.includes("quote reference"))
        this.failures.set(endpoint, this.failureCount(endpoint) + 1);
    });
  }

  private async watchRead(endpoint: ReadEndpoint, payloadMarker: string) {
    // Discover the built function path so unrelated reads cannot affect counts.
    const response = await this.page.waitForResponse(async (candidate) => {
      if (!new URL(candidate.url()).pathname.startsWith("/_serverFn/")) return false;
      if (candidate.request().method() !== "GET" || !candidate.ok()) return false;
      const body = await candidate.text().catch(() => "");
      return body.includes(payloadMarker);
    });
    this.readPaths.set(new URL(response.url()).pathname, endpoint);
  }

  async visitTriggers() {
    await this.page.getByRole("link", { name: "Triggers", exact: true }).click();
  }

  async openTriggers() {
    await Promise.all([this.watchRead("triggers", '"Existing trigger"'), this.visitTriggers()]);
    await expect(this.page.getByRole("table", { name: "Triggers", exact: true })).toBeVisible();
  }

  async seedTrigger() {
    const [project] = await this.app.query(
      `insert into projects (organization_id, name, slug)
       select id, 'Snapshot trigger', 'snapshot-trigger' from organization where name = 'Snapshot test'
       returning id, organization_id`,
    );
    const [trigger] = await this.app.query(
      `insert into organization_triggers (organization_id, name, format, runtime_project_id)
       values ($1, 'Existing trigger', 'legacy_multistep', $2) returning id`,
      [project!["organization_id"], project!["id"]],
    );
    const [revision] = await this.app.query(
      `insert into organization_trigger_revisions
         (trigger_id, organization_id, version, yaml, normalized_configuration, content_hash, source_kind, source_evidence)
       values ($1, $2, 1, 'on: manual.run', '{}', 'snapshot-test', 'manual', '{}') returning id`,
      [trigger!["id"], project!["organization_id"]],
    );
    await this.app.query(`update organization_triggers set active_revision_id = $1 where id = $2`, [
      revision!["id"],
      trigger!["id"],
    ]);
  }

  async interruptTriggers() {
    await this.app.query(
      "alter table organization_triggers rename column active_revision_id to unavailable_revision",
    );
  }

  async restoreTriggers() {
    await this.app.query(
      "alter table organization_triggers rename column unavailable_revision to active_revision_id",
    );
  }

  async renameTrigger() {
    await this.app.query("update organization_triggers set name = 'Updated trigger'");
  }

  async returnToTab() {
    // Headless Chromium has no OS tab switch. Deliver the same document visibility transition.
    await this.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      window.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      window.dispatchEvent(new Event("visibilitychange"));
    });
  }

  failureCount(endpoint: ReadEndpoint) {
    return this.failures.get(endpoint) ?? 0;
  }

  async expectFailures(count: number, endpoint: ReadEndpoint, baseline: number) {
    await expect
      .poll(() => this.failureCount(endpoint) - baseline, {
        message: `${endpoint} read failures since fault`,
        timeout: 10_000,
      })
      .toBe(count);
  }

  async expectTriggerRetriesStopped(baseline: number) {
    await this.expectFailures(3, "triggers", baseline);
    // Exceed the next default exponential retry delay to prove the retry budget is exhausted.
    await this.page.waitForTimeout(4_500);
    expect(this.failureCount("triggers") - baseline).toBe(3);
  }

  async expectTrigger(name = "Existing trigger") {
    await expect(this.page.getByRole("table", { name: "Triggers", exact: true })).toContainText(
      name,
    );
    await expect(
      this.page.getByRole("alert").filter({ hasText: "Triggers unavailable" }),
    ).toHaveCount(0);
  }

  async expectInitialFailure() {
    await expect(
      this.page.getByRole("alert").filter({ hasText: "Triggers unavailable" }),
    ).toContainText(/quote reference [0-9a-f-]{36} when reporting it\./u);
    await expect(this.page.getByRole("table", { name: "Triggers", exact: true })).toHaveCount(0);
  }

  async reload() {
    await this.page.reload();
  }

  async capture(name: string) {
    await this.page.screenshot({
      path: `e2e/screenshots/snapshot-recovery/${name}.png`,
      fullPage: true,
    });
  }

  async watchTenant() {
    await Promise.all([
      this.watchRead("tenant", '"capabilities","project","projects"'),
      this.returnToTab(),
    ]);
  }

  async expectOrganization(name: string) {
    await expect(
      this.page.getByRole("button", { name: "Organization", exact: true }),
    ).toContainText(name);
  }

  async interruptTenant() {
    // The shared tenant lookup selects this column even on organization-only routes.
    await this.app.query(
      "alter table projects rename column archived_at to unavailable_archived_at",
    );
  }

  async restoreTenant() {
    await this.app.query(
      "alter table projects rename column unavailable_archived_at to archived_at",
    );
  }

  async renameOrganization() {
    await this.app.query(
      "update organization set name = 'Updated organization' where name = 'Snapshot test'",
    );
  }

  async openDaemons() {
    await Promise.all([
      this.watchRead("daemons", '"daemons","canManage"'),
      this.page.getByRole("link", { name: "Daemons", exact: true }).click(),
    ]);
    await this.expectDaemons();
  }

  async expectDaemons() {
    await expect(this.page.getByText("No daemons connected", { exact: true })).toBeVisible();
    await expect(this.page.getByRole("alert")).toHaveCount(0);
  }

  async interruptDaemons() {
    await this.app.query("alter table daemons rename column slug to unavailable_slug");
  }

  async restoreDaemons() {
    await this.app.query("alter table daemons rename column unavailable_slug to slug");
  }

  async openUsage() {
    await this.page.getByRole("link", { name: "Settings", exact: true }).click();
    await Promise.all([
      this.watchRead("usage", '"organization","limits","history"'),
      this.page.getByRole("link", { name: "Usage", exact: true }).click(),
    ]);
    await this.expectUsage();
  }

  async expectUsage() {
    await expect(this.page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
    await expect(this.page.getByRole("table", { name: "Limits", exact: true })).toBeVisible();
    await expect(this.page.getByRole("alert")).toHaveCount(0);
  }

  async interruptUsage() {
    await this.app.query(
      "alter table entitlement_changes rename column reason to unavailable_reason",
    );
  }

  async restoreUsage() {
    await this.app.query(
      "alter table entitlement_changes rename column unavailable_reason to reason",
    );
  }
}
