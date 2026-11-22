import { expect, type Page } from "@playwright/test";

export class ProjectConnections {
  constructor(private readonly page: Page) {}

  card(provider: string) {
    return this.page.getByRole("region", { name: provider, exact: true });
  }

  async connectGitHub() {
    await this.page.getByRole("button", { name: "Connect GitHub" }).click();
    await expect(this.page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
    await expect(
      this.page.getByRole("list", { name: "GitHub connections" }).getByRole("listitem"),
    ).toContainText(/acme-inc.*installation/u);
  }
}

export async function holdConnectionRefresh(page: Page, readPath?: string) {
  const serverFunctions = "**/_serverFn/**";
  let notifyRefresh = () => {};
  const started = new Promise<void>((resolve) => {
    notifyRefresh = resolve;
  });
  let releaseReads = () => {};
  const released = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let failReads = false;
  await page.route(serverFunctions, async (route) => {
    const request = route.request();
    if (
      request.method() !== "GET" ||
      (readPath !== undefined && new URL(request.url()).pathname !== readPath)
    ) {
      await route.continue();
      return;
    }
    notifyRefresh();
    await released;
    if (failReads) await route.abort();
    else await route.continue();
  });
  return {
    started,
    release(fail = false) {
      failReads = fail;
      releaseReads();
    },
  };
}
