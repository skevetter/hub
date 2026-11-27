import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { createTimelineScrubber } from "./scrub.js";

const SAMPLE = "aBcD0192EfGh3456IjKl7890MnOpQrStUvWxYz";
const INVENTORIES = [
  [],
  [SAMPLE, "quiet orchard", "tiny", "\u200b", ""],
  ["[redacte", "[too ...", "\ud83d\ude00abcdefghij", "abcdefghijklm"],
  ["\ud800"],
  ["\uff46\uff4f\uff4f", "\ud83e\ude00abcdefghij", "abcdefghijk", "bcdefghijklmnop"],
];
const BUDGETS = [0, 1, 2, 3, 7, 8, 9, 11, 16, 64, 240, 8192, Infinity, -1, 2.5, NaN];

function encodedCases(): string[] {
  let nested = "ordinary";
  const cases = [];
  for (let pass = 0; pass < 4; pass += 1) {
    nested = Array.from(nested, (character) => `%${character.charCodeAt(0).toString(16)}`).join("");
    cases.push(nested);
  }
  return [
    ...cases,
    "\\u{1f600}",
    "\\u002f",
    "\\x2f",
    "\\057",
    "\\u12",
    "\\xq",
    "\\n",
    "\\r",
    "\\t",
    "\\b",
    "\\f",
    "\\v",
    "\\q",
    "trailing\\",
    "%zz",
    "%e0%80",
    "&#47;",
    "&#x2f;",
    "&#x110000;",
    "&unknown;",
    "&constructor;",
    "&colon;&sol;&sol;q&commat;host",
    "&amp; &quot; &apos; &lt; &gt; &bsol; &percnt; &lowbar; &hyphen; &equals; &tab; &newline;",
    "\\u{110000}",
    "\\ud800",
    "%EF%B7%BA".repeat(900),
  ];
}

const PREFIXES = [
  "paseo_pk_",
  "paseo_cli_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "xoxa-",
  "xoxb-",
  "xoxp-",
  "xoxr-",
  "xoxs-",
  "xapp-",
  "lin_api_",
  "lin_oauth_",
  "AKIA",
  "ASIA",
  "sk-",
  "AIza",
  "sk_live_",
  "rk_live_",
  "whsec_",
];

const FIXTURES = [
  ...encodedCases(),
  ...PREFIXES.flatMap((prefix) => [prefix, prefix + SAMPLE, `a ${prefix}${SAMPLE} z`]),
  ...[
    "pass",
    "pwd",
    "secret",
    "token",
    "key",
    "auth",
    "basic",
    "bearer",
    "cred",
    "session",
    "cookie",
    "sig",
  ].map((label) => `${label.toUpperCase()}=${SAMPLE}`),
  "",
  "tiny",
  "\u200b",
  "\u00e9\u4e2d\ud83d\ude00".repeat(20),
  "\ud800",
  "\udc00",
  "\ud83e\ude00abcdefg",
  "bcdefghijkl",
  "zzabcdefghijkmnop",
  "[Redacted]",
  "[redacted]",
  "a".repeat(8192),
  "a".repeat(8193),
  "\u00e9".repeat(4097),
  "\ufdfa".repeat(1000),
  "-".repeat(8192),
  "ordinary \u0000\t\n\r\u2060\uff4f",
  "-----BEGIN THING-----",
  "-----BEGINX",
  "?code=x",
  "x&code=x",
  "decode ordinary",
  `eyJ${SAMPLE}.x.z`,
  "aeyJx",
  "!eyJ.b.",
  "eyJ",
  SAMPLE,
  "A".repeat(40),
  "1".repeat(40),
  "0123456789abcdef0123456789abcdef01234567",
  "7bc1a4e6-5b08-4af2-9a63-d3e9c85f0b12",
  "a0".repeat(32),
  "https://host/path@ordinary",
  "//u@host",
  "https:%2F%5c u%40host",
  "https://u%2fp@host",
  "a%40:x@y",
  "https://u%2Fp%40host",
  "https://u@host",
  "a+1.b-2:\\\\u@host",
  "//host?x@y",
  "//host#x@y",
  "//host/%2f@x",
  "https://u%4\n0host",
  "person@example.test",
];

const PARTS = [
  "quiet ",
  "orchard",
  "tiny",
  SAMPLE,
  "\ud83d\ude00",
  "\ud83e\ude00",
  "\ud800",
  "\u200b",
  "\u00e9",
  "\uff4f",
  "%40",
  "@",
  "\\",
  "%2f",
  "%5c",
  "/",
  ":",
  "?",
  "#",
  "&",
  "a",
  "5",
  "eyJ",
  "sk-",
  "\t",
  "\n",
  " ",
  "abcdefghij",
  "bcdefghijkl",
  "&#47;",
  "[Redacted]",
];

function seeded(): string[] {
  let state = 0x24b938;
  function roll(size: number): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 12) % size;
  }
  return Array.from({ length: 1536 }, () =>
    Array.from({ length: 1 + roll(24) }, () => PARTS[roll(PARTS.length)]).join(""),
  );
}

test("matches frozen stored-text scrubbing output across fixtures, seeded combinations and byte cuts", () => {
  const hash = createHash("sha256");
  const inputs = [...FIXTURES, ...seeded()];
  for (const scrubValues of INVENTORIES) {
    const scrub = createTimelineScrubber({ scrubValues });
    for (const input of inputs) {
      for (const budget of BUDGETS) {
        hash.update(JSON.stringify(scrub(input, budget)) + "\n");
      }
    }
  }
  assert.equal(
    hash.digest("hex"),
    "b577318d3baeefb3745dfbf397ed69244292417aeb4dd1158862761435eb7e4b",
  );
}, 60_000);
