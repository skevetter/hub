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

const REVIEW_SECRET = ["aBcD0192", "EfGh3456", "IjKl7890"].join("");
const SHORT_SECRET = ["aB3d", "Ef8h", "Q2"].join("");
const FIELD_CORPUS = [
  {
    name: "URL-like custom authority",
    input: `custom_scheme://user:${SHORT_SECRET}@host/db`,
    secret: SHORT_SECRET,
  },
  {
    name: "protocol-relative authority",
    input: `//user:${SHORT_SECRET}@host/db`,
    secret: SHORT_SECRET,
  },
  {
    name: "credential query code",
    input: `https://example.test/?code=${SHORT_SECRET}`,
    secret: SHORT_SECRET,
  },
  {
    name: "expanded Unicode case label",
    input: `pa\u00dfword=${SHORT_SECRET}`,
    secret: SHORT_SECRET,
  },
  {
    name: "nested JSON",
    input: JSON.stringify({ err: JSON.stringify({ PASSWORD: REVIEW_SECRET }) }),
    secret: REVIEW_SECRET,
  },
  { name: "env wrapper", input: `env=PASSWORD=${SHORT_SECRET}`, secret: SHORT_SECRET },
  { name: "bracket assignment", input: `[DB_PASSWORD=${SHORT_SECRET}]`, secret: SHORT_SECRET },
  {
    name: "parenthesized assignment",
    input: `connect(password=${SHORT_SECRET})`,
    secret: SHORT_SECRET,
  },
  {
    name: "escaped CLI space",
    input: `--password=${REVIEW_SECRET.slice(0, 8)}\\ ${REVIEW_SECRET.slice(8)}`,
    secret: REVIEW_SECRET,
  },
  {
    name: "escaped env space",
    input: `PASSWORD=${REVIEW_SECRET.slice(0, 8)}\\ ${REVIEW_SECRET.slice(8)}`,
    secret: REVIEW_SECRET,
  },
  {
    name: "YAML scalar",
    input: `password: ${REVIEW_SECRET.slice(0, 8)} ${REVIEW_SECRET.slice(8)}`,
    secret: REVIEW_SECRET,
  },
  { name: "YAML block", input: `password: |\n  ${REVIEW_SECRET}`, secret: REVIEW_SECRET },
  {
    name: "embedded userinfo at sign",
    input: `postgres://user:ab@${["cd1234", "5678"].join("")}@host/db`,
    secret: ["ab@", "cd1234", "5678"].join(""),
  },
  ...["=", " "].map((separator) => ({
    name: `CLI ${separator === "=" ? "equals" : "space"}`,
    input: `--password${separator}${REVIEW_SECRET}`,
    secret: REVIEW_SECRET,
  })),
  {
    name: "env file",
    input: `NORMAL=value\nexport PASSWORD=${REVIEW_SECRET}\nNEXT=value`,
    secret: REVIEW_SECRET,
  },
  ...["postgres", "redis", "amqp", "ftp", "mongodb+srv", "https", "custom+app"].map((scheme) => ({
    name: `${scheme} userinfo`,
    input: `before ${scheme}://user:${SHORT_SECRET}@inside@host/db after`,
    secret: SHORT_SECRET,
  })),
  ...["PRIVATE KEY", "PGP MESSAGE", "CERTIFICATE", "OPENSSH PRIVATE KEY"].map((kind) => ({
    name: `${kind} armor`,
    input: `before\n-----BEGIN ${kind}-----\n${SHORT_SECRET}\n-----END ${kind}-----\nafter`,
    secret: SHORT_SECRET,
  })),
  {
    name: "encoded authority with an encoded slash in the password",
    input: `%63ustom%3a%2f%2fuser%3a${SHORT_SECRET}%2fpart%40host/db`,
    secret: SHORT_SECRET,
  },
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

describe("stored-text privacy contract: whole fields redact on sensitive labels or userinfo; known normalized secrets lose every 8-code-unit fragment across cuts; arbitrary unlabeled base64/hex secrets and unknown unlabeled passwords are explicit non-guarantees", () => {
  it("states limits: arbitrary unlabeled base64/hex secrets, unknown unlabeled passwords and personal data are not guaranteed; benign sensitive-label mentions intentionally redact whole fields", () => {
    const scrub = createTimelineScrubber();
    const secret = ["quiet ", "orchard"].join("");
    for (const value of [
      secret,
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("hex"),
      "person@example.test",
    ])
      expect(scrub(value, 240)).toBe(value);
    for (const value of [
      "a short password",
      "token count is zero",
      "reset your password",
      "keyframe: ordinary",
      "Basic concepts only",
      "credit is available",
    ])
      expect(scrub(value, 240)).toBe("[redacted]");
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(FIELD_CORPUS)(
    "redacts the whole $name field before any partial rewrite",
    ({ input, secret }) => {
      const safe = createTimelineScrubber()(input, 240);
      expect(safe).toBe("[redacted]");
      assertPrivate(safe, eightGrams(secret), 240);
    },
  );

  it("detects case-insensitive sensitive labels anywhere after removing separators and decoding JSON/JS, percent and HTML entities", () => {
    const scrub = createTimelineScrubber();
    const labels = [
      "password",
      "passwd",
      "pwd",
      "passphrase",
      "secret",
      "token",
      "api key",
      "apikey",
      "auth",
      "authorization",
      "basic",
      "bearer",
      "credentials",
      "private key",
      "key",
      "session",
      "cookie",
      "signature",
      "sig",
      "cred",
    ];
    for (const label of labels) {
      const variants = [
        label.toUpperCase(),
        label.replaceAll("i", "\u0130"),
        label.split("").join("._- \n"),
        label
          .split("")
          .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
        label
          .split("")
          .map((character) => `\\x${character.charCodeAt(0).toString(16)}`)
          .join(""),
        label
          .split("")
          .map((character) => `\\u{${character.charCodeAt(0).toString(16)}}`)
          .join(""),
        label
          .split("")
          .map((character) => `%${character.charCodeAt(0).toString(16)}`)
          .join(""),
        label
          .split("")
          .map((character) => `&#${character.charCodeAt(0)};`)
          .join(""),
        label
          .split("")
          .map((character) => `&#x${character.charCodeAt(0).toString(16)};`)
          .join(""),
      ];
      for (const variant of variants) {
        const input = `ordinary ${variant}=${SHORT_SECRET} trailing`;
        const safe = scrub(input, 240);
        expect(safe).toBe("[redacted]");
        assertPrivate(safe, eightGrams(SHORT_SECRET), 240);
      }
    }
    for (const input of [
      JSON.stringify(JSON.stringify({ PASSWORD: REVIEW_SECRET })),
      `custom&colon;&sol;&sol;user&colon;${SHORT_SECRET}&commat;inside&commat;host/path`,
      `custom%3A%2F%2Fuser%3A${SHORT_SECRET}%40inside%40host/path`,
      `custom\\x3a\\u002f\\u{2f}user:${SHORT_SECRET}\\x40host/path`,
    ]) {
      expect(scrub(input, 240)).toBe("[redacted]");
    }
  });

  it("retains prefix, JWT and entropy protection after canonicalization without extracting credential tails", () => {
    const scrub = createTimelineScrubber();
    for (const secret of [
      ["gh", "p_", PAYLOAD].join(""),
      ["ey", "JhbGci.fixtureA1.fixtureB2"].join(""),
      PAYLOAD,
    ]) {
      const encoded = secret
        .split("")
        .map((character) => `%${character.charCodeAt(0).toString(16)}`)
        .join("");
      expect(scrub(encoded, 240)).toBe("[redacted]");
      assertPrivate(scrub(encoded, 240), eightGrams(secret), 240);
    }
  });

  it("bounds canonicalization to three passes and fails closed on unresolved or ambiguous encodings", () => {
    const scrub = createTimelineScrubber();
    const encode = (value: string) =>
      value
        .split("")
        .map((character) => `%${character.charCodeAt(0).toString(16)}`)
        .join("");
    let ordinary = "ordinary";
    for (let pass = 0; pass < 3; pass += 1) ordinary = encode(ordinary);
    expect(scrub(ordinary, 240)).toBe(ordinary);
    expect(scrub(encode(ordinary), 240)).toBe("[redacted]");
    for (const input of [
      "%zz",
      "%e0%80",
      "\\u12",
      "\\xq0",
      "&unknown;",
      "&constructor;",
      "&#x110000;",
      "trailing\\",
    ])
      expect(scrub(input, 240)).toBe("[redacted]");
    expect(scrub("https://host/path@ordinary", 240)).toBe("https://host/path@ordinary");
  });

  it("applies whole-field markers within every byte budget without introducing startup-known eight-grams", () => {
    for (const known of [[], ["[redacted]"], ["[reda...", "[redacte"]]) {
      const scrub = createTimelineScrubber({ scrubValues: known });
      const forbidden = new Set<string>();
      for (const { secret } of FIELD_CORPUS)
        for (const fragment of eightGrams(secret)) forbidden.add(fragment);
      for (const value of known) for (const fragment of eightGrams(value)) forbidden.add(fragment);
      for (const { input } of FIELD_CORPUS) {
        for (let budget = 0; budget <= 16; budget += 1) {
          const safe = scrub(input, budget);
          assertPrivate(safe, forbidden, budget);
          expect(
            safe === "" || safe === "[redacted]" || safe.endsWith("...") || /^\.*$/u.test(safe),
          ).toBe(true);
        }
      }
    }
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
    expect(scrub("ftp://user:tiny@example.test/path", 120)).toBe("[redacted]");
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
            expect(safe).toBe("[redacted]");
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
      const safe = scrub(`${scheme} ${JSON.stringify(secret)} tail`, 240);
      assertPrivate(safe, forbidden, 240);
      expect(safe).toContain("[redacted]");
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
