import { describe, expect, it } from "vitest";
import { createAssistantTextRedactor } from "./redact.js";

const redactor = createAssistantTextRedactor(["swordfish", "abaabab", "", "swordfish"]);
const batchCases: [string[], boolean, string[]][] = [
  [[".. swo", "rdfish + abaa", "babab tail"], false, [".. [redacted]", " + [redacted]", "ab tail"]],
  [["known: sword"], false, ["known: sword"]],
  [["known: sword"], true, ["known: [redacted]"]],
  [["x --- BE"], true, ["x [redacted]"]],
  [["a ---BEGIN TEST---\nraw\n---END NO CLOSE\n-----END TEST----- z"], false, ["a [redacted] z"]],
  [["a ------begin TEST--\nraw"], false, ["a [redacted]"]],
  [
    ["https://u:p%40host/path?token=secret&search=okay#code=x https:%2f%5cuser:pass@other/path"],
    false,
    [
      "https://[redacted]host/path?token=[redacted]&search=okay#code=[redacted] https:%2f%5c[redacted]other/path",
    ],
  ],
  [
    [
      "ghp_test eyJabc.def.x Bearer Abc/+== password=aaaaaaaaaaaaaaaaaaaaaaaa token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    ],
    false,
    ["[redacted] [redacted] Bearer [redacted] password=[redacted] token=[redacted]"],
  ],
  [
    [
      "0123456789abcdef0123456789abcdef01234567 123e4567-e89b-12d3-a456-426614174000 ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    ],
    false,
    [
      "0123456789abcdef0123456789abcdef01234567 123e4567-e89b-12d3-a456-426614174000 [redacted] aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    ],
  ],
  [
    ["a ---BEGINNING X ---BEGIN X ---ENDLESS X ---END X--- z"],
    false,
    ["a ---BEGINNING X [redacted] z"],
  ],
];

describe("batch redaction", () => {
  for (const [index, [parts, truncated, expected]] of batchCases.entries()) {
    it(`batch redaction ${index}`, () => {
      expect(redactor.redact(parts, truncated)).toStrictEqual(expected);
    });
  }
});

const streamingCases = [
  ["prefix swo", "rdfish suffix", true, "prefix ", "[redacted] suffix"],
  ["prefix swo", "rdfish suffix", false, "prefix [redacted]", " suffix"],
  ["prefix swo", "rdkite suffix", true, "prefix ", "[redacted]kite suffix"],
  ["x ---BE", "GIN TEST---\nsecret\n---END TEST--- suffix", true, "x ", "[redacted] suffix"],
  ["http://u:pw", "@host/path", false, "http://[redacted]", "/path"],
  ["ghp_ABC", "DE/path rest", false, "[redacted]", " rest"],
  ["---BEGIN TEST---\nprivate", "\n---END TEST--- tail", false, "[redacted]", " tail"],
] as const;

describe("streaming redaction", () => {
  for (const [
    index,
    [first, second, boundary, firstSafe, secondSafe],
  ] of streamingCases.entries()) {
    it(`streaming redaction ${index}`, () => {
      const stream = redactor.open();
      expect(stream(first, [first], first.length, boundary, false)).toStrictEqual([firstSafe]);
      expect(stream("", ["", ""], 0, false, false)).toStrictEqual(["", ""]);
      expect(stream(second, [second], second.length, false, true)).toStrictEqual([secondSafe]);
    });
  }
});
