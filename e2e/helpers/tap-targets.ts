import { expect, type Locator, type Page } from "@playwright/test";

const FIELDS =
  "main input:not([type=checkbox]):not([type=radio]):not([type=hidden]), main select, main [role=combobox]";

export interface Size {
  name: string;
  width: number;
  height: number;
}

/** Every text field, native select, Select and combobox on the page, as drawn at the current width. */
export async function fieldSizes(page: Page): Promise<Size[]> {
  return page.locator(FIELDS).evaluateAll((elements) =>
    elements
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const box = element.getBoundingClientRect();
        const slot = element.getAttribute("data-slot") ?? element.getAttribute("type") ?? "";
        return {
          name: `${element.tagName.toLowerCase()}:${slot}`,
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      }),
  );
}

/**
 * How far a link answers to a pointer, walking out from its centre in half-pixel steps. A box that
 * a sibling paints over, or that sticks out past what the page draws, is shorter than it measures.
 */
export async function hitExtent(link: Locator): Promise<{ width: number; height: number }> {
  await link.scrollIntoViewIfNeeded();
  return link.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const owns = (x: number, y: number) => {
      const found = document.elementFromPoint(x, y);
      return found !== null && element.contains(found);
    };
    const reach = (horizontal: boolean, sign: number) => {
      let distance = 0;
      for (; distance < 60; distance += 0.5) {
        const x = box.x + box.width / 2 + (horizontal ? sign * distance : 0);
        const y = box.y + box.height / 2 + (horizontal ? 0 : sign * distance);
        if (!owns(x, y)) break;
      }
      return distance;
    };
    return {
      width: reach(true, -1) + reach(true, 1),
      height: reach(false, -1) + reach(false, 1),
    };
  });
}

export async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
