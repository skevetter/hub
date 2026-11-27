// Build 17 behavior reference, kept in source parity with the production scrubber.
import { redact } from "../../logger.js";
import type { TimelineScrubber } from "../capture-types.js";

const INPUT_LIMIT = 8192;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const PREFIX_TOKEN =
  /(?:paseo_(?:pk|cli)_|gh[pousr]_|github_pat_|xox[abprs]-|xapp-|lin_(?:api|oauth)_|AKIA|ASIA|sk-|AIza|sk_live_|rk_live_|whsec_)[A-Za-z0-9_+/-]*/gu;
const JWT = /(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2})/gu;
const ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/gu;
const ARMORED_START = /(?<!-)-{3,}\s*BEGIN\b/iu;
const SENSITIVE_LABEL = /pass|pwd|secret|token|key|auth|basic|bearer|cred|session|cookie|sig/iu;
const ENCODED = /\\|%|&(?:#|[a-z][a-z0-9]*;)/iu;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  sol: "/",
  bsol: "\\",
  colon: ":",
  commat: "@",
  percnt: "%",
  lowbar: "_",
  hyphen: "-",
  equals: "=",
  tab: "\t",
  newline: "\n",
};
const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
};

const URL_SCHEME_START = /[A-Za-z]/u;
const URL_SCHEME_PART = /[0-9+.-]/u;
const URL_BOUNDARY = /[/?#]/u;

function hasEncodedUrlSlash(value: string, index: number): boolean {
  return (
    value.startsWith("%2f", index) ||
    value.startsWith("%2F", index) ||
    value.startsWith("%5c", index) ||
    value.startsWith("%5C", index)
  );
}

interface UrlScan {
  detection: string;
  authority: boolean;
  prefix: boolean;
  schemeToken: boolean;
  sawSlash: boolean;
}

function scanAuthority(
  scan: UrlScan,
  character: string,
  slash: boolean,
  index: number,
): "stay" | "found" | "exit" {
  if (scan.prefix && (slash || character === " ")) return "stay";
  scan.prefix = false;
  if (character === "@" || scan.detection.startsWith("%40", index)) return "found";
  if (!URL_BOUNDARY.test(character)) return "stay";
  scan.authority = false;
  scan.sawSlash = false;
  return "exit";
}

function scanUrlCharacter(scan: UrlScan, character: string, slash: boolean): void {
  if (character === ":" && scan.schemeToken) {
    scan.authority = true;
    scan.prefix = true;
    scan.schemeToken = false;
    scan.sawSlash = false;
  } else if (slash) {
    scan.authority = scan.sawSlash;
    scan.prefix = scan.authority;
    scan.sawSlash = !scan.authority;
    scan.schemeToken = false;
  } else {
    scan.sawSlash = false;
    scan.schemeToken =
      URL_SCHEME_START.test(character) || (scan.schemeToken && URL_SCHEME_PART.test(character));
  }
}

function hasUserinfo(value: string): boolean {
  const detection = value.replace(/[\t\n\r]/gu, "");
  const scan = { detection, authority: false, prefix: false, schemeToken: false, sawSlash: false };
  for (let index = 0; index < detection.length; index += 1) {
    const character = detection.charAt(index);
    const encodedSlash = character === "%" && hasEncodedUrlSlash(detection, index);
    const slash = character === "/" || character === "\\" || encodedSlash;
    const skip = encodedSlash ? 2 : 0;
    if (scan.authority) {
      const result = scanAuthority(scan, character, slash, index);
      if (result === "found") return true;
      if (result === "stay") {
        index += skip;
        continue;
      }
    }
    scanUrlCharacter(scan, character, slash);
    index += skip;
  }
  return false;
}

function decode(value: string): string {
  return value
    .replace(
      /\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([0-7]{1,3})|([\s\S]))/giu,
      (
        _match,
        ...[point, unicode, hex, octal, literal]: [string, string, string, string, string]
      ) => {
        if (point) return String.fromCodePoint(Number.parseInt(point, 16));
        if (unicode || hex) return String.fromCharCode(Number.parseInt(unicode || hex, 16));
        if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
        if (/^[ux]$/iu.test(literal)) throw new Error("ambiguous escape");
        return ESCAPES[literal] ?? literal;
      },
    )
    .replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => decodeURIComponent(encoded))
    .replace(
      /&(?:#(x[0-9a-f]+|[0-9]+)|([a-z][a-z0-9]*));/giu,
      (entity, numeric: string, name: string) => {
        if (numeric)
          return String.fromCodePoint(
            Number.parseInt(numeric.replace(/^x/iu, ""), /^x/iu.test(numeric) ? 16 : 10),
          );
        const key = name.toLowerCase();
        return Object.hasOwn(ENTITIES, key) ? String(ENTITIES[key]) : entity;
      },
    );
}

function normalize(value: string): string {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) {
      throw new Error("invalid unicode");
    }
  }
  return value
    .normalize("NFKC")
    .replace(INVISIBLE, (character) => (character === "\t" || character === "\n" ? character : ""));
}

function cut(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  if (maxBytes < 3) return ".".repeat(maxBytes);
  const bytes = Buffer.from(value, "utf8");
  let end = maxBytes - 3;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + "...";
}

function highEntropy(value: string): boolean {
  if (/^[a-f0-9]{40}$/u.test(value)) return false;
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)) return false;
  if (!/[A-Za-z]/u.test(value) || !/[0-9]/u.test(value)) return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4;
}

function addVariant(variant: string, known: Set<string>, fragments: Set<string>): void {
  if (variant.length === 0) return;
  known.add(variant);
  for (let index = 0; index <= variant.length - 8; index += 1) {
    fragments.add(variant.slice(index, index + 8));
  }
}

function readScrubValues(
  options: { scrubValues?: readonly string[] },
  known: Set<string>,
  fragments: Set<string>,
): boolean {
  try {
    for (const value of options.scrubValues ?? []) {
      if (value.length === 0) continue;
      for (const variant of [value, normalize(value)]) addVariant(variant, known, fragments);
    }
    return true;
  } catch {
    return false;
  }
}

function containsSensitive(value: string, known: Set<string>, fragments: Set<string>): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (fragments.has(value.slice(index, index + 8))) return true;
    for (let length = 1; length <= 7 && index + length <= value.length; length += 1) {
      if (known.has(value.slice(index, index + length))) return true;
    }
  }
  return false;
}

function hasSensitiveShape(canonical: string): boolean {
  const labels = canonical
    .toUpperCase()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  return (
    SENSITIVE_LABEL.test(labels) ||
    (/[?&]/u.test(canonical) && labels.includes("code")) ||
    hasUserinfo(canonical) ||
    ARMORED_START.test(canonical)
  );
}

function unsafeField(value: string, scrub: (value: string) => string): boolean {
  let canonical = value;
  const isUnsafe = () =>
    hasSensitiveShape(canonical) || (canonical !== value && scrub(canonical) !== canonical);
  for (let pass = 0; pass <= 3; pass += 1) {
    if (isUnsafe()) break;
    if (!ENCODED.test(canonical)) return false;
    if (pass === 3) break;
    canonical = normalize(decode(canonical));
    if (Buffer.byteLength(canonical, "utf8") > INPUT_LIMIT) break;
  }
  return true;
}

function maskFragment(value: string, masked: Uint8Array, index: number): void {
  const first = value.charCodeAt(index);
  const last = value.charCodeAt(index + 7);
  const start = first >= 0xdc00 && first <= 0xdfff ? index - 1 : index;
  const end = last >= 0xd800 && last <= 0xdbff ? index + 9 : index + 8;
  masked.fill(1, Math.max(0, start), end);
}

function replaceMasked(value: string, masked: Uint8Array, marker: string): string {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < value.length) {
    if (masked[index] === 0) {
      index += 1;
      continue;
    }
    parts.push(value.slice(start, index), marker);
    while (index < value.length && masked[index] === 1) index += 1;
    start = index;
  }
  parts.push(value.slice(start));
  return parts.join("");
}

function protectFragments(value: string, fragments: Set<string>, marker: string): string {
  const masked = new Uint8Array(value.length);
  let found = false;
  for (let index = 0; index <= value.length - 8; index += 1) {
    if (!fragments.has(value.slice(index, index + 8))) continue;
    maskFragment(value, masked, index);
    found = true;
  }
  return found ? replaceMasked(value, masked, marker) : value;
}

function scrubText(
  value: string,
  scrubValues: string[],
  fragments: Set<string>,
  marker: string,
): string {
  let safe = protectFragments(value, fragments, marker);
  const exact = redact(safe, { scrubValues });
  if (typeof exact !== "string") throw new Error("invalid redaction");
  safe = exact.replaceAll("[Redacted]", marker);
  safe = safe.replace(PREFIX_TOKEN, marker);
  safe = safe.replace(
    JWT,
    (match: string, token: string) => match.slice(0, -token.length) + marker,
  );
  return protectFragments(
    safe.replace(ENTROPY_RUN, (candidate) => (highEntropy(candidate) ? marker : candidate)),
    fragments,
    marker,
  );
}

interface ScrubContext {
  validConfiguration: boolean;
  marker: string;
  tooLong: string;
  scrub: (value: string) => string;
}

function scrubWithinLimit(value: string, limit: number, context: ScrubContext): string {
  const { validConfiguration, marker, tooLong, scrub } = context;
  if (!validConfiguration || typeof value !== "string") return cut(marker, limit);
  if (value.length > INPUT_LIMIT || Buffer.byteLength(value, "utf8") > INPUT_LIMIT) {
    return cut(tooLong, limit);
  }
  const normalized = normalize(value);
  if (Buffer.byteLength(normalized, "utf8") > INPUT_LIMIT) return cut(tooLong, limit);
  const safe = unsafeField(normalized, scrub) ? marker : scrub(cut(scrub(normalized), limit));
  return cut(safe, limit);
}

export function createTimelineScrubber(
  options: { scrubValues?: readonly string[] } = {},
): TimelineScrubber {
  const known = new Set<string>();
  const fragments = new Set<string>();
  const validConfiguration = readScrubValues(options, known, fragments);
  const scrubValues = [...known];
  const sensitive = (value: string) => containsSensitive(value, known, fragments);
  const marker = sensitive("[redacted]") ? "" : "[redacted]";
  const tooLong = sensitive("[too long]") ? marker : "[too long]";
  const scrub = (value: string) => scrubText(value, scrubValues, fragments, marker);
  const context = { validConfiguration, marker, tooLong, scrub };
  return (value, maxBytes) => {
    const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
    try {
      const safe = scrubWithinLimit(value, limit, context);
      return sensitive(safe) ? "" : safe;
    } catch {
      const safe = cut(marker, limit);
      return sensitive(safe) ? "" : safe;
    }
  };
}
