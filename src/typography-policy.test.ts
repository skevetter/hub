import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

/*
 * Mechanical half of docs/design.md: what a regular expression or a token table can see. Density,
 * hierarchy and which component owns which shape stay on review.
 */

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const sourceExtensions = new Set([".css", ".ts", ".tsx"]);

/* The strong weight is a component's voice; a screen composes components and never sets it. */
const strongOwners = ["components/", "shell/"];

/* The only files allowed to decide which theme class sits on <html>. */
const themeOwners = ["routes/__root.tsx", "theme/"];

/*
 * A weight utility, never a fragment of a longer name. `--scalar-font-normal` is a vendor's weight
 * token and ends in the same letters as a class; the lookbehind keeps the scan on class names.
 */
const weightClass =
  /(?<![\w-])font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|title|strong|[1-9]00)\b/g;

interface Rule {
  rule: string;
  pattern: RegExp;
  extensions?: Set<string>;
}

const tsx = new Set([".tsx"]);
const code = new Set([".ts", ".tsx"]);

const forbidden: Rule[] = [
  { rule: "letter-spacing utility", pattern: /\btracking-/g, extensions: code },
  { rule: "uppercase", pattern: /\buppercase\b/g },
  { rule: "text-transform", pattern: /\btext-transform\b/g },
  {
    // A bracket that reads a CSS variable is a primitive sizing itself from Radix, not an off-scale value.
    rule: "arbitrary value",
    pattern:
      /(?<![\w-])(?:text|font|bg|border|p[xytrbl]?|m[xytrbl]?|w|h|gap|rounded|shadow|leading)-\[(?![^\]]*(?:var\(|--))/g,
    extensions: code,
  },
  { rule: "dark: variant", pattern: /\bdark:/g },
  { rule: "inline font weight", pattern: /\bfontWeight\b/g },
  { rule: "bold element", pattern: /<(?:strong|b)[\s>]/g },
  { rule: "hex colour", pattern: /#[0-9a-f]{3,8}\b/gi, extensions: tsx },
  { rule: "removed token", pattern: /extra-muted-foreground/g },
  { rule: "corner rounder than the scale", pattern: /\brounded-(?:md|lg|xl|2xl|3xl)\b/g },
  {
    rule: "shadow on flat content",
    pattern: /(?<![\w-])shadow-(?!floating\b|none\b)[\w-]+/g,
    extensions: code,
  },
];

const themeWrites: RegExp[] = [
  /className=["'`](?:dark|light)["'`]/g,
  /classList\.(?:add|remove|toggle)\(\s*["'`](?:dark|light)["'`]/g,
  /documentElement\.className\s*=/g,
];

const weightTokens = new Set(["--font-weight-*", "--font-weight-normal", "--font-weight-strong"]);
const legalWeights = new Set([
  "400",
  "600",
  "var(--font-weight-normal)",
  "var(--font-weight-strong)",
]);

/*
 * The property, not a name that ends in it. `--scalar-sidebar-font-weight` is a vendor token that
 * contains `font-weight`; only a declaration that starts one is scanned.
 */
const weightDeclaration = /(?<![\w-])(--)?font-weight([\w*-]*)\s*:\s*([^;}]+)/g;

/* Tracking is a property of the title and figure sizes, declared next to them and nowhere else. */
const spacingDeclaration = /(?<![\w-])(--[\w-]+)?letter-spacing\s*:/g;
const spacingToken = /^--text-[\w-]+--$/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!sourceExtensions.has(extname(entry.name)) || entry.name.includes(".test.")) return [];
    return [path];
  });
}

const ownedBy = (name: string, owners: string[]) => owners.some((owner) => name.startsWith(owner));

function weightViolations(name: string, source: string): string[] {
  return [...source.matchAll(weightClass)].flatMap((match) => {
    if (match[0] === "font-normal") return [];
    if (match[0] === "font-strong" && ownedBy(name, strongOwners)) return [];
    return [`${name}: ${match[0]}`];
  });
}

function ruleViolations(name: string, source: string, extension: string): string[] {
  return forbidden.flatMap(({ rule, pattern, extensions }) => {
    if (extensions && !extensions.has(extension)) return [];
    return [...source.matchAll(pattern)].map((match) => `${name}: ${rule} (${match[0].trim()})`);
  });
}

function themeViolations(name: string, source: string): string[] {
  if (ownedBy(name, themeOwners)) return [];
  return themeWrites.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => `${name}: theme class write (${match[0]})`),
  );
}

function weightDeclarationViolations(source: string): string[] {
  return [...source.matchAll(weightDeclaration)].flatMap((declaration) => {
    const property = `${declaration[1] ?? ""}font-weight${declaration[2] ?? ""}`;
    if (property.startsWith("--")) return weightTokens.has(property) ? [] : [property];
    const value = (declaration[3] ?? "").replace(/!important/g, "").trim();
    return legalWeights.has(value) ? [] : [`font-weight: ${value}`];
  });
}

function spacingDeclarationViolations(source: string): string[] {
  return [...source.matchAll(spacingDeclaration)].flatMap((declaration) =>
    declaration[1] && spacingToken.test(declaration[1]) ? [] : ["letter-spacing"],
  );
}

function violationsIn(name: string, source: string, extension: string): string[] {
  return [
    ...weightViolations(name, source),
    ...ruleViolations(name, source, extension),
    ...themeViolations(name, source),
    ...[...weightDeclarationViolations(source), ...spacingDeclarationViolations(source)].map(
      (found) => `${name}: ${found}`,
    ),
  ];
}

/* Token table. A value that aliases another token resolves through the cascade in both themes. */
function tokenBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `missing ${selector} block in styles.css`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  return tokens;
}

function parityViolations(light: Map<string, string>, dark: Map<string, string>): string[] {
  const missingDark = [...light].filter(
    ([key, value]) => !dark.has(key) && !value.startsWith("var("),
  );
  const missingLight = [...dark.keys()].filter((key) => !light.has(key));
  return [
    ...missingDark.map(([key]) => `${key} has no dark value`),
    ...missingLight.map((key) => `${key} has no light value`),
  ];
}

function luminance(hex: string): number {
  const channels = hex.replace("#", "").match(/\w\w/g) ?? [];
  const [r = 0, g = 0, b = 0] = channels.map((pair) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/* Text pairs need 4.5:1, control borders 3:1, in both themes. */
const contrastPairs: [string, string, number][] = [
  ["--foreground", "--background", 4.5],
  ["--foreground", "--card", 4.5],
  ["--muted-foreground", "--background", 4.5],
  ["--muted-foreground", "--card", 4.5],
  ["--muted-foreground", "--accent", 4.5],
  ["--primary-foreground", "--primary", 4.5],
  ["--destructive", "--background", 4.5],
  ["--destructive-foreground", "--destructive", 4.5],
  ["--attention-foreground", "--attention", 4.5],
  ["--attention-text", "--background", 4.5],
  ["--live-foreground", "--live", 4.5],
  ["--live-text", "--background", 4.5],
  ["--done-foreground", "--done", 4.5],
  ["--off-foreground", "--off", 4.5],
  ["--off-text", "--background", 4.5],
  ["--rail-foreground", "--rail", 4.5],
  ["--rail-muted", "--rail", 4.5],
  ["--rail-foreground", "--rail-accent", 4.5],
  ["--input", "--background", 3],
];

function resolve(tokens: Map<string, string>, value: string | undefined): string | undefined {
  const alias = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return alias ? resolve(tokens, tokens.get(alias)) : value;
}

function contrastViolations(theme: string, tokens: Map<string, string>): string[] {
  return contrastPairs.flatMap(([text, ground, minimum]) => {
    const [a, b] = [resolve(tokens, tokens.get(text)), resolve(tokens, tokens.get(ground))];
    if (!a?.startsWith("#") || !b?.startsWith("#")) {
      return [`${theme}: ${text} on ${ground} is not a hex pair`];
    }
    const ratio = contrast(a, b);
    return ratio >= minimum ? [] : [`${theme}: ${text} on ${ground} is ${ratio.toFixed(2)}:1`];
  });
}

describe("design contract", () => {
  it("holds everywhere a regex can see it", () => {
    const violations = sourceFiles(sourceRoot).flatMap((path) =>
      violationsIn(
        relative(sourceRoot, path).split(sep).join("/"),
        readFileSync(path, "utf8"),
        extname(path),
      ),
    );
    assert.deepEqual(violations, []);
  });

  it("defines every token in both themes, at AA", () => {
    const css = readFileSync(join(sourceRoot, "styles.css"), "utf8");
    const light = tokenBlock(css, ":root");
    const darkOnly = tokenBlock(css, ".dark");
    const dark = new Map([...light, ...darkOnly]);
    assert.deepEqual(
      [
        ...parityViolations(light, darkOnly),
        ...contrastViolations("light", light),
        ...contrastViolations("dark", dark),
      ],
      [],
    );
  });
});

describe("what the scan reads", () => {
  it("lets components and the shell use the strong weight and keeps it out of screens", () => {
    assert.deepEqual(
      violationsIn("components/app/section.tsx", '<h2 className="font-strong" />', ".tsx"),
      [],
    );
    assert.deepEqual(violationsIn("home/panel.tsx", '<p className="font-strong" />', ".tsx"), [
      "home/panel.tsx: font-strong",
    ]);
    assert.deepEqual(
      violationsIn("components/app/x.tsx", '<p className="font-semibold font-title" />', ".tsx"),
      ["components/app/x.tsx: font-semibold", "components/app/x.tsx: font-title"],
    );
  });

  it("catches a weight declaration and accepts the scale's own tokens", () => {
    assert.deepEqual(violationsIn("styles.css", "h1 { font-weight: 700; }", ".css"), [
      "styles.css: font-weight: 700",
    ]);
    assert.deepEqual(
      violationsIn("styles.css", "h1 { font-weight: var(--font-weight-strong); }", ".css"),
      [],
    );
  });

  it("reads vendor weight tokens as names, not as utilities or declarations", () => {
    assert.deepEqual(
      violationsIn(
        "reference.tsx",
        "--scalar-sidebar-font-weight: var(--font-weight-normal);",
        ".tsx",
      ),
      [],
    );
    assert.deepEqual(violationsIn("reference.tsx", "--scalar-font-normal: 400;", ".tsx"), []);
    assert.deepEqual(violationsIn("reference.tsx", "--scalar-font-bold: 500;", ".tsx"), []);
  });

  it("allows tracking only as a size token", () => {
    assert.deepEqual(
      violationsIn("styles.css", "--text-xl--letter-spacing: -0.015em;", ".css"),
      [],
    );
    assert.deepEqual(violationsIn("styles.css", "h1 { letter-spacing: -0.015em; }", ".css"), [
      "styles.css: letter-spacing",
    ]);
  });

  it("keeps theme class writes in the theme module", () => {
    assert.deepEqual(violationsIn("theme/apply.ts", 'root.classList.add("dark")', ".ts"), []);
    assert.deepEqual(violationsIn("shell/x.tsx", 'root.classList.add("dark")', ".tsx"), [
      'shell/x.tsx: theme class write (classList.add("dark")',
    ]);
  });

  it("reads off-scale arbitrary values but not variants or CSS variables", () => {
    assert.deepEqual(
      violationsIn("x.tsx", '<div className="data-[state=open]:bg-card" />', ".tsx"),
      [],
    );
    assert.deepEqual(
      violationsIn("x.tsx", '<div className="h-[var(--radix-select-trigger-height)]" />', ".tsx"),
      [],
    );
    assert.deepEqual(violationsIn("x.tsx", '<div className="p-[3px]" />', ".tsx"), [
      "x.tsx: arbitrary value (p-[)",
    ]);
  });

  it("finds a missing dark token, follows aliases, and finds a pair below AA", () => {
    const light = new Map([
      ["--a", "#111111"],
      ["--alias", "var(--a)"],
    ]);
    assert.deepEqual(parityViolations(light, new Map()), ["--a has no dark value"]);
    assert.equal(resolve(light, "var(--alias)"), "#111111");
    assert.ok(contrast("#62666d", "#08090a") < 4.5);
    assert.ok(contrast("#5a5a55", "#f7f7f4") >= 4.5);
  });
});
