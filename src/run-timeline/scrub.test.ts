import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createTimelineScrubber } from "./scrub.js";

const PAYLOAD = ["aBcD0192", "EfGh3456", "IjKl7890", "MnOpQrSt", "UvWxYz"].join("");
const PREFIXES = [
  ["paseo", "_pk_"],
  ["paseo", "_cli_"],
  ...["p", "o", "u", "s", "r"].map((letter) => ["gh", letter, "_"]),
  ["github", "_pat_"],
  ...["a", "b", "p", "r", "s"].map((letter) => ["xox", letter, "-"]),
  ["xapp", "-"],
  ["lin", "_api_"],
  ["lin", "_oauth_"],
  ["AK", "IA"],
  ["AS", "IA"],
  ["sk", "-"],
  ["AI", "za"],
  ["sk", "_live_"],
  ["rk", "_live_"],
  ["wh", "sec_"],
].map((parts) => parts.join(""));

const CORPUS = [
  ...PREFIXES.map((prefix) => ({
    family: prefix,
    input: prefix + PAYLOAD,
    secret: prefix + PAYLOAD,
  })),
  ...["Bearer", "Basic", "Token"].map((scheme) => ({
    family: `authorization ${scheme}`,
    input: `Authorization: ${scheme} ${PAYLOAD}`,
    secret: PAYLOAD,
  })),
  { family: "bare bearer", input: `Bearer ${PAYLOAD}`, secret: PAYLOAD },
  {
    family: "jwt",
    input: ["ey", "J", PAYLOAD, ".", PAYLOAD, ".", PAYLOAD].join(""),
    secret: PAYLOAD,
  },
  ...["RSA ", "EC ", "OPENSSH ", ""].map((kind) => ({
    family: `private key ${kind}`,
    input: `-----BEGIN ${kind}PRIVATE KEY-----\n${PAYLOAD}\n-----END ${kind}PRIVATE KEY-----`,
    secret: PAYLOAD,
  })),
  {
    family: "unfinished private key",
    input: `-----BEGIN PRIVATE KEY-----\n${PAYLOAD}`,
    secret: PAYLOAD,
  },
  {
    family: "url credentials",
    input: `https://user:${PAYLOAD}@example.test/path`,
    secret: PAYLOAD,
  },
  ...[
    "token",
    "key",
    "secret",
    "password",
    "sig",
    "signature",
    "code",
    "auth",
    "api_key",
    "access_token",
  ].map((key) => ({
    family: `query ${key}`,
    input: `https://example.test/path?${key}=${PAYLOAD}&page=2`,
    secret: PAYLOAD,
  })),
  ...[
    "TOKEN",
    "client_SECRET",
    "PASSWORD",
    "PASSWD",
    "API_KEY",
    "API-KEY",
    "PRIVATE_KEY",
    "CREDENTIAL",
  ].map((name, index) => ({
    family: `assignment ${name}`,
    input: `${name}${index % 2 === 0 ? "=" : ": "}${PAYLOAD}`,
    secret: PAYLOAD,
  })),
  ...["token", "password", "secret", "api-key"].map((flag, index) => ({
    family: `flag ${flag}`,
    input: `--${flag}${index % 2 === 0 ? "=" : " "}${PAYLOAD}`,
    secret: PAYLOAD,
  })),
  { family: "entropy", input: PAYLOAD, secret: PAYLOAD },
];

function eightGrams(value: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index <= value.length - 8; index += 1)
    result.add(value.slice(index, index + 8));
  return result;
}

function assertPrivate(value: string, forbidden: ReadonlySet<string>, maxBytes: number): void {
  expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(maxBytes);
  expect(value).not.toContain("\ufffd");
  expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
  for (let index = 0; index <= value.length - 8; index += 1) {
    expect(forbidden.has(value.slice(index, index + 8))).toBe(false);
  }
}

function context(seed: number): string {
  let value = seed + 1;
  const words = ["quiet", "ordinary", "brown", "village", "morning", "window", "garden"];
  return (
    Array.from({ length: 7 }, () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return words[value % words.length];
    }).join(" ") + " "
  );
}

describe("stored-text privacy contract: known normalized secrets lose every 8-code-unit fragment across every input and UTF-8 output cut; unknown prefix families are conservatively removed even below historical minima", () => {
  it("states limits: unlabeled unknown short passwords, dictionary secrets and personal data are not detected; rare benign over-redaction and dropping text after a private-key header are intentional; this is not an outbound-content boundary", () => {
    const scrub = createTimelineScrubber();
    for (const value of ["a short password", "dictionary", "person@example.test"])
      expect(scrub(value, 240)).toBe(value);
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CORPUS)(
    "removes the unknown $family family without relying on exact known values",
    ({ input, secret }) => {
      const safe = createTimelineScrubber()(input, 240);
      assertPrivate(safe, eightGrams(secret), 240);
      expect(safe).not.toBe(input);
    },
  );

  it.each(CORPUS)(
    "protects known $family at start, middle and end, every prefix/suffix input cut and every output byte budget",
    ({ input, secret }) => {
      const scrub = createTimelineScrubber({ scrubValues: [secret] });
      const forbidden = eightGrams(secret);
      const surrounding = context(input.length);
      for (const embedded of [
        input + " " + surrounding,
        surrounding + input + " " + surrounding,
        surrounding + input,
      ]) {
        for (let boundary = 0; boundary <= embedded.length; boundary += 1) {
          assertPrivate(scrub(embedded.slice(0, boundary), 240), forbidden, 240);
          assertPrivate(scrub(embedded.slice(boundary), 240), forbidden, 240);
        }
        for (let budget = 0; budget <= Buffer.byteLength(embedded, "utf8") + 3; budget += 1) {
          assertPrivate(scrub(embedded, budget), forbidden, budget);
        }
      }
    },
    30000,
  );

  it.each(PREFIXES)(
    "removes unknown short prefix-family %s fragments without an entropy threshold",
    (prefix) => {
      const scrub = createTimelineScrubber();
      for (let length = 0; length < 20; length += 1) {
        expect(scrub(prefix + "a".repeat(length), 64)).toBe("[redacted]");
      }
    },
  );

  it("preserves SHA-1, UUIDs, plain paths, ordinary sentences and version strings", () => {
    const scrub = createTimelineScrubber();
    const negatives = [
      "0123456789abcdef0123456789abcdef01234567",
      "7bc1a4e6-5b08-4af2-9a63-d3e9c85f0b12",
      "/home/worker/project/src/index.ts",
      "src/run-timeline/project.ts",
      "v1.24.3-beta.2",
      "The build completed with 12 files and 4 warnings.",
      "name=ordinary",
      "keyframe: ordinary",
    ];
    for (const value of negatives) expect(scrub(value, 240)).toBe(value);
    expect(scrub("0123456789abcdef".repeat(4), 240)).toBe("[redacted]");
  });

  it("redacts short labeled values, authorization values, URL credentials and CLI arguments without entropy assistance", () => {
    const scrub = createTimelineScrubber();
    for (const label of [
      "TOKEN",
      "client_secret",
      "password",
      "PASSWD",
      "API_KEY",
      "API-KEY",
      "PRIVATE_KEY",
      "CREDENTIAL",
    ]) {
      for (const separator of ["=", ": "])
        expect(scrub(`${label}${separator}tiny`, 120)).not.toContain("tiny");
    }
    for (const flag of ["token", "password", "secret", "api-key"]) {
      for (const separator of ["=", " "])
        expect(scrub(`--${flag}${separator}"tiny quoted value"`, 120)).not.toContain("tiny");
    }
    for (const scheme of ["Bearer", "Basic", "Token"])
      expect(scrub(`Authorization: ${scheme} tiny`, 120)).toBe("[redacted]");
    expect(scrub("Bearer tiny", 120)).toBe("[redacted]");
    expect(scrub("ftp://user:tiny@example.test/path", 120)).toBe(
      "ftp://[redacted]@example.test/path",
    );
    expect(scrub("custom://example.test/path?token=tiny", 120)).not.toContain("tiny");
    expect(scrub("-----BEGIN PRIVATE KEY-----\ntiny", 120)).toBe("[redacted]");
  });

  it("consumes escaped quoted assignments and flags through the closing quote without known values or entropy", () => {
    const scrub = createTimelineScrubber();
    for (const quote of ['"', "'"]) {
      for (const escape of ["", "\\"]) {
        const secret = ["aBcD0192", escape, quote, " ", "EfGh3456", "IjKl7890"].join("");
        const encoded = secret.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
        expect(scrub(secret, 240)).toBe(secret);
        const forbidden = new Set([...eightGrams(secret), ...eightGrams(encoded)]);
        for (const label of ["TOKEN", "PASSWORD", "SECRET", "API_KEY", "Authorization"]) {
          for (const separator of ["=", ": "]) {
            const input = `${label}${separator}${quote}${encoded}${quote} tail`;
            const safe = scrub(input, 240);
            expect(safe).toBe(`${label}=[redacted] tail`);
            assertPrivate(safe, forbidden, 240);
          }
        }
        for (const flag of ["token", "password", "secret", "api-key"]) {
          for (const separator of ["=", " "]) {
            const input = `--${flag}${separator}${quote}${encoded}${quote} tail`;
            const safe = scrub(input, 240);
            assertPrivate(safe, forbidden, 240);
            assertPrivate(scrub(input.slice(0, -6), 240), forbidden, 240);
          }
        }
      }
    }
  });

  it.each(["Bearer", "Basic", "Token"])(
    "removes quoted Authorization assignments and escaped quoted %s values without known values or entropy",
    (scheme) => {
      const scrub = createTimelineScrubber();
      const secret = ["aBcD0192", '" ', "EfGh3456", "IjKl7890"].join("");
      const plain = ["aBcD0192", "EfGh3456", "IjKl7890"].join("");
      expect(scrub(secret, 240)).toBe(secret);
      expect(scrub(plain, 240)).toBe(plain);
      const forbidden = new Set([...eightGrams(secret), ...eightGrams(plain)]);
      for (const input of [
        JSON.stringify({ Authorization: `${scheme} ${plain}` }),
        JSON.stringify({ Authorization: `${scheme} ${secret}` }),
        `{'Authorization':'${scheme} ${plain}'}`,
        `"Authorization" = "${scheme} ${plain}"`,
        `Authorization: ${scheme} ${JSON.stringify(secret)} tail`,
        `${scheme} ${JSON.stringify(secret)} tail`,
      ]) {
        const safe = scrub(input, 240);
        assertPrivate(safe, forbidden, 240);
        expect(safe).not.toBe(input);
      }
      expect(scrub(`${scheme} ${JSON.stringify(secret)} tail`, 240)).toBe("[redacted] tail");
    },
  );

  it("normalizes NFKC, removes controls, zero-width and variation characters, and retains tabs and newlines", () => {
    const scrub = createTimelineScrubber();
    const obfuscated = ["\uff53\uff4b", "\u200b", "-", "a\u0000b\u2060c\ufe0f"].join("");
    expect(scrub(obfuscated, 64)).toBe("[redacted]");
    expect(scrub("line\ttext\nnext\r\u034f\u200d", 64)).toBe("line\ttext\nnext");
    const known = createTimelineScrubber({
      scrubValues: [
        "\uff46\uff49\uff58\uff54\uff55\uff52\uff45\uff53\uff45\uff43\uff52\uff45\uff54",
      ],
    });
    expect(known("fixturesecret", 64)).toBe("[redacted]");
  });

  it("removes exact unconventional known values with the existing logger redactor and protects their normalized partial suffixes", () => {
    const secret = ["quiet horse ", "battery orchard"].join("");
    const scrub = createTimelineScrubber({ scrubValues: ["", secret, "tiny"] });
    expect(scrub("tiny", 64)).toBe("[redacted]");
    for (let index = 0; index <= secret.length; index += 1) {
      assertPrivate(scrub(secret.slice(index), 64), eightGrams(secret), 64);
    }
    expect(scrub(secret, 64)).toBe("[redacted]");
  });

  it("extends known-fragment masks to whole surrogate pairs, including different code points sharing a low surrogate", () => {
    const secret = "\ud83d\ude00abcdefghi";
    const scrub = createTimelineScrubber({ scrubValues: [secret] });
    const input = "\ud83e\ude00abcdefg";
    for (let budget = 0; budget <= 30; budget += 1) {
      assertPrivate(scrub(input, budget), eightGrams(secret), budget);
    }
  });

  it("never lets markers, fallback markers or their byte cuts introduce a known 8-gram", () => {
    const secrets = ["[redacted]", "[Redacted]", "[too long]", "[reda...", "[too ..."];
    const scrub = createTimelineScrubber({ scrubValues: secrets });
    const forbidden = new Set<string>();
    for (const secret of secrets) for (const gram of eightGrams(secret)) forbidden.add(gram);
    for (let budget = 0; budget <= 20; budget += 1) {
      for (const value of [PREFIXES[0]! + PAYLOAD, "a".repeat(8193), "\ud800"]) {
        assertPrivate(scrub(value, budget), forbidden, budget);
      }
    }
  });

  it("fails closed above 8 KiB measured in UTF-8 bytes, including NFKC expansion", () => {
    const scrub = createTimelineScrubber();
    expect(scrub("a".repeat(8193), 240)).toBe("[too long]");
    expect(scrub("\u00e9".repeat(4097), 240)).toBe("[too long]");
    expect(scrub("\ufdfa".repeat(1000), 240)).toBe("[too long]");
    expect(scrub("a".repeat(8192), 12)).toBe("a".repeat(9) + "...");
  });

  it("fails closed on malformed Unicode, invalid known-value configuration and thrown normalization", () => {
    const scrub = createTimelineScrubber();
    for (const value of ["\ud800", "\udc00", "before\ud800after"])
      expect(scrub(value, 64)).toBe("[redacted]");
    expect(createTimelineScrubber({ scrubValues: ["\ud800"] })("benign", 64)).toBe("[redacted]");
    const normalization = vi.spyOn(String.prototype, "normalize").mockImplementation(() => {
      throw new Error("normalization unavailable");
    });
    try {
      expect(scrub("private input", 64)).toBe("[redacted]");
    } finally {
      normalization.mockRestore();
    }
  });

  it("cuts at every UTF-8 boundary with three ASCII dots and never splits a code point", () => {
    const scrub = createTimelineScrubber();
    const value = "\u00e9\u4e2d\ud83d\ude00".repeat(20);
    for (let budget = 0; budget <= Buffer.byteLength(value, "utf8"); budget += 1) {
      const safe = scrub(value, budget);
      assertPrivate(safe, new Set(), budget);
      if (budget >= 3 && budget < Buffer.byteLength(value, "utf8"))
        expect(safe.endsWith("...")).toBe(true);
    }
    expect(scrub(value, 10)).toBe("\u00e9\u4e2d...");
  });

  it("keeps median warmed adversarial 8 KiB calls below 20 ms without quadratic regex retries", () => {
    const scrub = createTimelineScrubber({ scrubValues: [PAYLOAD] });
    const adversarial = [
      "A".repeat(8192),
      "'\"=".repeat(2730) + "==",
      "=".repeat(8192),
      "\u4e2d".repeat(2730) + "aa",
      "a".repeat(8190) + ": ",
      " ".repeat(8191) + "=",
      "eyJ".repeat(2730) + "..",
      "-----BEGIN".repeat(819).slice(0, 8192),
      "custom://" + ":".repeat(8183),
      "custom://" + "a".repeat(8183),
      'PASSWORD="' + '\\" '.repeat(2727),
      '--password="' + '\\" '.repeat(2726),
      'Authorization: Token "' + '\\" '.repeat(2723),
    ];
    for (const value of adversarial) {
      for (let warmup = 0; warmup < 50; warmup += 1) scrub(value, 240);
      const elapsed: number[] = [];
      for (let sample = 0; sample < 25; sample += 1) {
        const start = performance.now();
        const safe = scrub(value, 240);
        elapsed.push(performance.now() - start);
        expect(Buffer.byteLength(safe, "utf8")).toBeLessThanOrEqual(240);
      }
      elapsed.sort((left, right) => left - right);
      expect(elapsed[12]).toBeLessThan(20);
    }
  });
});
