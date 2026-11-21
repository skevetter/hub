import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "vite";

test("Activity pager only announces the committed action across changed and unchanged polls", async ({
  page,
}) => {
  const bundle = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      rollupOptions: {
        input: resolve("e2e/fixtures/activity-pager.tsx"),
        output: { inlineDynamicImports: true },
      },
    },
    esbuild: { jsx: "automatic" },
  });
  if (Array.isArray(bundle) || !("output" in bundle)) throw new Error("Expected a fixture bundle");
  const script = bundle.output.find((entry) => entry.type === "chunk");
  if (script === undefined || script.type !== "chunk") throw new Error("Missing fixture script");
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ type: "module", content: script.code });
  const pager = page.getByRole("navigation", { name: "Activity pages" });
  const live = pager.getByRole("status");
  const reads = page.getByTestId("poll-reads");
  await expect(pager).toContainText("1 visible");
  await expect(live).toBeEmpty();
  await page.getByRole("button", { name: "Filter runs" }).click();
  await expect(live).toHaveText("1 run");

  const before = Number(await reads.textContent());
  await expect.poll(async () => Number(await reads.textContent())).toBeGreaterThan(before);
  await expect(live).toHaveText("1 run");
  await page.getByRole("button", { name: "Add run before next poll" }).click();
  await expect(pager).toContainText("2 visible");
  await expect(live).toHaveText("1 run");
});
