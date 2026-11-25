import type { Page } from "@playwright/test";

export function attentionEntry(page: Page, count?: number) {
  const name =
    count === undefined
      ? /^Attention(?:,|$)/u
      : count === 0
        ? "Attention"
        : `Attention, ${count} ${count === 1 ? "item" : "items"}`;
  return page.getByRole("button", { name, exact: true });
}

export function attentionDialog(page: Page) {
  return page.getByRole("dialog", { name: "Attention", exact: true });
}

export async function openAttention(page: Page, count?: number) {
  await attentionEntry(page, count).click();
  return attentionDialog(page);
}
