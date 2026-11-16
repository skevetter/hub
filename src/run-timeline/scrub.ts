import { redact } from "../logger.js";
import type { TimelineScrubber } from "./capture-types.js";

const INPUT_LIMIT = 8192;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const PREFIX_TOKEN =
  /(?:paseo_(?:pk|cli)_|gh[pousr]_|github_pat_|xox[abprs]-|xapp-|lin_(?:api|oauth)_|AKIA|ASIA|sk-|AIza|sk_live_|rk_live_|whsec_)[A-Za-z0-9_+/-]*/gu;
const JWT = /(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2})/gu;
const ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/gu;
const ARMORED_START = /-{3,}\s*BEGIN\b/iu;
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

function hasUserinfo(value: string): boolean {
  const detection = value.replace(/[\t\n\r]/gu, "");
  let authority = false;
  let prefix = false;
  let schemeToken = false;
  let sawSlash = false;
  for (let index = 0; index < detection.length; index += 1) {
    const character = detection[index]!;
    const encodedSlash = character === "%" && hasEncodedUrlSlash(detection, index);
    const slash = character === "/" || character === "\\" || encodedSlash;
    if (authority) {
      if (prefix && (slash || character === " ")) {
        if (character === "%") index += 2;
        continue;
      }
      prefix = false;
      if (character === "@" || detection.startsWith("%40", index)) return true;
      if (!URL_BOUNDARY.test(character)) {
        if (encodedSlash) index += 2;
        continue;
      }
      authority = false;
      sawSlash = false;
    }
    if (character === ":" && schemeToken) {
      authority = true;
      prefix = true;
      schemeToken = false;
      sawSlash = false;
      continue;
    }
    if (slash) {
      authority = sawSlash;
      prefix = authority;
      sawSlash = !authority;
      schemeToken = false;
      if (encodedSlash) index += 2;
      continue;
    }
    sawSlash = false;
    schemeToken =
      URL_SCHEME_START.test(character) || (schemeToken && URL_SCHEME_PART.test(character));
  }
  return false;
}

function decode(value: string): string {
  return value
    .replace(
      /\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([0-7]{1,3})|([\s\S]))/giu,
      (_match, point: string, unicode: string, hex: string, octal: string, literal: string) => {
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
        return Object.hasOwn(ENTITIES, key) ? ENTITIES[key]! : entity;
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
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
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

export function createTimelineScrubber(
  options: { scrubValues?: readonly string[] } = {},
): TimelineScrubber {
  const known = new Set<string>();
  const fragments = new Set<string>();
  let invalidConfiguration = false;
  try {
    for (const value of options.scrubValues ?? []) {
      if (value.length === 0) continue;
      for (const variant of [value, normalize(value)]) {
        if (variant.length === 0) continue;
        known.add(variant);
        for (let index = 0; index <= variant.length - 8; index += 1) {
          fragments.add(variant.slice(index, index + 8));
        }
      }
    }
  } catch {
    invalidConfiguration = true;
  }
  const scrubValues = [...known];
  const containsSensitive = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
      if (fragments.has(value.slice(index, index + 8))) return true;
      for (let length = 1; length <= 7 && index + length <= value.length; length += 1) {
        if (known.has(value.slice(index, index + length))) return true;
      }
    }
    return false;
  };
  const marker = containsSensitive("[redacted]") ? "" : "[redacted]";
  const unsafeField = (value: string): boolean => {
    let canonical = value;
    for (let pass = 0; pass <= 3; pass += 1) {
      const labels = canonical
        .toUpperCase()
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, "");
      if (
        SENSITIVE_LABEL.test(labels) ||
        (/[?&]/u.test(canonical) && labels.includes("code")) ||
        hasUserinfo(canonical) ||
        ARMORED_START.test(canonical) ||
        (canonical !== value && scrub(canonical) !== canonical)
      ) {
        return true;
      }
      if (!ENCODED.test(canonical)) return false;
      if (pass === 3) return true;
      canonical = normalize(decode(canonical));
      if (Buffer.byteLength(canonical, "utf8") > INPUT_LIMIT) return true;
    }
    return true;
  };
  const tooLong = containsSensitive("[too long]") ? marker : "[too long]";
  const protectFragments = (value: string): string => {
    const masked = new Uint8Array(value.length);
    let found = false;
    for (let index = 0; index <= value.length - 8; index += 1) {
      if (!fragments.has(value.slice(index, index + 8))) continue;
      const first = value.charCodeAt(index);
      const last = value.charCodeAt(index + 7);
      const start = first >= 0xdc00 && first <= 0xdfff ? index - 1 : index;
      const end = last >= 0xd800 && last <= 0xdbff ? index + 9 : index + 8;
      masked.fill(1, Math.max(0, start), end);
      found = true;
    }
    if (!found) return value;
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
  };
  const scrub = (value: string): string => {
    let safe = protectFragments(value);
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
    );
  };
  const fallback = (value: string, limit: number): string => {
    const safe = cut(value, limit);
    return containsSensitive(safe) ? "" : safe;
  };
  return (value, maxBytes) => {
    const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
    try {
      if (invalidConfiguration) return fallback(marker, limit);
      if (typeof value !== "string") return fallback(marker, limit);
      if (value.length > INPUT_LIMIT || Buffer.byteLength(value, "utf8") > INPUT_LIMIT) {
        return fallback(tooLong, limit);
      }
      const normalized = normalize(value);
      if (Buffer.byteLength(normalized, "utf8") > INPUT_LIMIT) return fallback(tooLong, limit);
      if (unsafeField(normalized)) return fallback(marker, limit);
      const safe = cut(scrub(cut(scrub(normalized), limit)), limit);
      return containsSensitive(safe) ? "" : safe;
    } catch {
      return fallback(marker, limit);
    }
  };
}
