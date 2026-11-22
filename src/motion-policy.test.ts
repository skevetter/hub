import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

describe("motion", () => {
  it("is switched off in one place for a reader who asked for less of it", () => {
    const rule = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n  \}/u.exec(styles)?.[1];
    assert.ok(rule, "styles.css has no reduced-motion rule");
    assert.match(rule, /\*,\s*::before,\s*::after/u);
    assert.match(rule, /animation-duration: 0\.01ms !important/u);
    assert.match(rule, /transition-duration: 0\.01ms !important/u);
    assert.match(rule, /scroll-behavior: auto !important/u);
  });
});
