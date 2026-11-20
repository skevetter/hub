import { redact } from "../logger.js";
import type { TimelineScrubber } from "./capture-types.js";

const INPUT_LIMIT = 8192;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const TOKEN_PREFIXES = [
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
const PREFIX_TOKEN = new RegExp(`(?:${TOKEN_PREFIXES.join("|")})[A-Za-z0-9_+/-]*`, "gu");
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
const URL_PART = /%2f|%5c|%40|[\s\S]/giu;
const URL_SLASH = /^(?:[/\\]|%2f|%5c)$/iu;
const STRUCTURED_URL_BOUNDARY = /[/?#]/u;
const PROSE_URL_BOUNDARY = /[/?#\s]/u;

interface CredentialSpan {
  start: number;
  end: number;
}

function urlUserinfo(value: string, prose = false): CredentialSpan[] {
  if (!value.includes("@") && !value.includes("%40")) return [];
  if (prose) return scanUrlUserinfo(value, PROSE_URL_BOUNDARY, false);
  const offsets: number[] = [];
  let compact = "";
  for (let index = 0; index < value.length; index += 1) {
    if (/[\t\n\r]/u.test(value[index]!)) continue;
    offsets.push(index);
    compact += value[index];
  }
  return scanUrlUserinfo(compact, STRUCTURED_URL_BOUNDARY, true).map(({ start, end }) => ({
    start: offsets[start]!,
    end: offsets[end - 1]! + 1,
  }));
}

function scanUrlUserinfo(
  value: string,
  boundary: RegExp,
  allowImplicitAuthority: boolean,
): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  let authority = false;
  let prefix = false;
  let schemeToken = false;
  let sawSlash = false;
  let start = 0;
  for (const part of value.matchAll(URL_PART)) {
    const token = part[0];
    const end = part.index + token.length;
    const slash = URL_SLASH.test(token);
    if (authority) {
      if (prefix && (slash || token === " ")) {
        start = end;
        continue;
      }
      prefix = false;
      if (token === "@" || token === "%40") {
        spans.push({ start, end });
        authority = sawSlash = schemeToken = false;
        continue;
      }
      if (!boundary.test(token)) continue;
      authority = sawSlash = false;
    }
    if ((allowImplicitAuthority && token === ":" && schemeToken) || slash) {
      authority = !slash || sawSlash;
      prefix = authority;
      start = end;
      sawSlash = !authority;
      schemeToken = false;
      continue;
    }
    sawSlash = false;
    schemeToken = URL_SCHEME_START.test(token) || (schemeToken && URL_SCHEME_PART.test(token));
  }
  return spans;
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
        urlUserinfo(canonical).length > 0 ||
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

const BEARER_VALUE = String.raw`\bBearer[ \t]+([A-Za-z0-9._~+/-]{4,}={0,2})`;
const ASSIGNMENT_LABEL = String.raw`\b(?:[a-z0-9]+[-_])*(?:key|token|secret|password)\b["']?[ \t]*[:=][ \t]*["']?`;
const PROSE_VALUES = [
  new RegExp(BEARER_VALUE, "giu"),
  new RegExp(ASSIGNMENT_LABEL + String.raw`([a-z0-9+/_-]{24,}={0,2})`, "giu"),
];
const ARMORED_END = /-{3,}\s*END\b[^\r\n]*?-{3,}/giu;
const ARMORED_PREFIX = "-----BEGIN";
const OPEN_VALUE = new RegExp(
  String.raw`(?:\bBearer[ \t]+` + "|" + ASSIGNMENT_LABEL + String.raw`)[A-Za-z0-9._~+/=-]*$`,
  "iu",
);
const URL_BODY = String.raw`(?:[/\\]{2}|(?:%2f|%5c){2})[^\s"'<>]*`;
const PROSE_URL = new RegExp(URL_BODY, "giu");
const OPEN_URL = new RegExp(`${URL_BODY}$`, "iu");
const URL_QUERY_VALUE = /[?&#]([a-z0-9_.~-]+)=([^#&]+)/giu;
const CREDENTIAL_CHARACTER = /[A-Za-z0-9+/_=.%~:-]/u;
const TEXT_LOOKAHEAD = 64;

interface SecretPrefix {
  value: string;
  fallback: number[];
}

function secretPrefix(value: string): SecretPrefix {
  const fallback = [0];
  let match = 0;
  for (let index = 1; index < value.length; index += 1) {
    while (match && value[index] !== value[match]) match = fallback[match - 1]!;
    if (value[index] === value[match]) match += 1;
    fallback.push(match);
  }
  return { value, fallback };
}

function pendingSecret(text: string, { value, fallback }: SecretPrefix): number {
  let match = 0;
  for (let index = Math.max(0, text.length - value.length + 1); index < text.length; index += 1) {
    while (match && text[index] !== value[match]) match = fallback[match - 1]!;
    if (text[index] === value[match]) match += 1;
  }
  return text.length - match;
}

function armoredSpans(text: string): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  const startPattern = new RegExp(ARMORED_START.source, "giu");
  for (const start of text.matchAll(startPattern)) {
    ARMORED_END.lastIndex = start.index + start[0].length;
    const end = ARMORED_END.exec(text);
    spans.push({ start: start.index, end: end ? end.index + end[0].length : text.length });
  }
  return spans;
}

function patternSpans(text: string, pattern: RegExp, capture = false): CredentialSpan[] {
  return [...text.matchAll(pattern)].map((match) => {
    const end = match.index + match[0].length;
    return { start: end - match[capture ? 1 : 0]!.length, end };
  });
}

function urlQuerySpans(text: string): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  for (const url of text.matchAll(PROSE_URL)) {
    for (const parameter of url[0].matchAll(URL_QUERY_VALUE)) {
      const label = parameter[1]!.toLowerCase();
      if (label !== "code" && !SENSITIVE_LABEL.test(label)) continue;
      const end = url.index + parameter.index + parameter[0].length;
      spans.push({ start: end - parameter[2]!.length, end });
    }
  }
  return spans;
}

function redactParts(parts: readonly string[], spans: CredentialSpan[]): string[] {
  spans.sort((left, right) => left.start - right.start);
  const merged: CredentialSpan[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  let offset = 0;
  let match = 0;
  return parts.map((part) => {
    let from = offset;
    let safe = "";
    const end = offset + part.length;
    for (let span = merged[match]; span && span.start < end; span = merged[++match]) {
      if (span.start >= from) safe += part.slice(from - offset, span.start - offset) + "[redacted]";
      from = span.end;
      if (from > end) break;
    }
    const result = safe + part.slice(from - offset);
    offset = end;
    return result;
  });
}

/** Replaces credential spans without applying the structured field's label or size rules. */
export function createTimelineSpanScrubber(scrubValues: readonly string[]) {
  const known = [...new Set(scrubValues.filter(Boolean))].map(secretPrefix);
  function spans(text: string): CredentialSpan[] {
    const assigned = PROSE_VALUES.flatMap((pattern) => patternSpans(text, pattern, true));
    const result = [
      ...patternSpans(text, PREFIX_TOKEN),
      ...patternSpans(text, JWT, true),
      ...assigned,
      ...urlUserinfo(text, true),
      ...urlQuerySpans(text),
      ...armoredSpans(text),
    ];
    for (const match of text.matchAll(ENTROPY_RUN)) {
      const end = match.index + match[0].length;
      const value = assigned.find((span) => match.index < span.start && span.start < end);
      const start = value?.start ?? match.index;
      if (highEntropy(text.slice(start, end))) result.push({ start, end });
    }
    for (const { value } of known) {
      for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1))
        result.push({ start, end: start + value.length });
    }
    return result;
  }

  function pendingStart(text: string, boundary: boolean): number {
    let end = boundary ? text.length : Math.max(0, text.length - TEXT_LOOKAHEAD);
    for (const secret of known) end = Math.min(end, pendingSecret(text, secret));
    const open = [OPEN_VALUE.exec(text), OPEN_URL.exec(text)];
    for (const match of open) if (match) end = Math.min(end, match.index);

    const armor = armoredSpans(text).at(-1);
    if (armor?.end === text.length) end = Math.min(end, armor.start);
    const armorTail = text.slice(-ARMORED_PREFIX.length).toUpperCase();
    for (let size = 1; size < ARMORED_PREFIX.length; size += 1) {
      if (armorTail.endsWith(ARMORED_PREFIX.slice(0, size)))
        end = Math.min(end, text.length - size);
    }

    const trailing = /[A-Za-z0-9+/_=.%~:-]+$/u.exec(text);
    if (trailing) end = Math.min(end, pendingTokenStart(trailing[0], boundary) + trailing.index);
    if (!boundary) {
      while (end > 0 && CREDENTIAL_CHARACTER.test(text[end - 1]!)) end -= 1;
    }
    if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
    return end;
  }

  return {
    redact(text: string): string {
      return redactParts([text], spans(text))[0]!;
    },
    redactParts(parts: readonly string[]): string[] {
      return redactParts(parts, spans(parts.join("")));
    },
    take(text: string, boundary: boolean): { text: string; remaining: string } {
      const matches = spans(text);
      let end = pendingStart(text, boundary);
      matches.sort((left, right) => right.start - left.start);
      for (const match of matches) {
        if (match.start < end && match.end > end) end = match.start;
      }
      return { text: redactParts([text.slice(0, end)], matches)[0]!, remaining: text.slice(end) };
    },
  };
}

function pendingTokenStart(token: string, boundary: boolean): number {
  if (!boundary) return 0;
  if (/^[A-Za-z0-9+/_=-]+$/u.test(token)) return 0;
  for (const prefix of [...TOKEN_PREFIXES, "eyJ"]) {
    if (token.includes(prefix)) return 0;
    for (let size = 1; size < prefix.length; size += 1) {
      if (token.endsWith(prefix.slice(0, size))) return token.length - size;
    }
  }
  return token.length;
}
