import { redact } from "../logger.js";
import type { TimelineScrubber } from "./capture-types.js";

const INPUT_LIMIT = 8192;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const PREFIX_TOKEN =
  /(?:paseo_(?:pk|cli)_|gh[pousr]_|github_pat_|xox[abprs]-|xapp-|lin_(?:api|oauth)_|AKIA|ASIA|sk-|AIza|sk_live_|rk_live_|whsec_)[A-Za-z0-9_+/-]*/gu;
const AUTHORIZATION =
  /\bAuthorization[ \t]*:[ \t]*(?:Bearer|Basic|Token)[ \t]+[^\s,;]+|\bBearer[ \t]+[^\s,;]+/giu;
const JWT = /(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2})/gu;
const ASSIGNMENT =
  /(^|[\s,;{])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2[ \t]*[=:][ \t]*(?:"[^"\n]*"?|'[^'\n]*'?|[^\s,;}]+)/gu;
const SENSITIVE_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API[_-]KEY|PRIVATE[_-]KEY|CREDENTIAL/iu;
const FLAG = /--(?:token|password|secret|api-key)(?:=|[ \t]+)(?:"[^"\n]*"?|'[^'\n]*'?|[^\s,;]+)/giu;
const QUERY =
  /([?&](?:token|key|secret|password|sig|signature|code|auth|api_key|access_token)=)[^&#\s]*/giu;
const USERINFO = /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s/:@]*:[^\s/@]*@/gu;
const ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/gu;
const PRIVATE_START = /-----BEGIN[ A-Z0-9-]{0,80}PRIVATE KEY-----/gu;

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
    const privateStart = safe.search(PRIVATE_START);
    if (privateStart !== -1) {
      safe = safe.slice(0, privateStart) + marker;
    }
    safe = safe.replace(PREFIX_TOKEN, marker);
    safe = safe.replace(AUTHORIZATION, marker);
    safe = safe.replace(
      JWT,
      (match: string, token: string) => match.slice(0, -token.length) + marker,
    );
    safe = safe.replace(USERINFO, `$1${marker}@`);
    safe = safe.replace(QUERY, (_match: string, prefix: string) => prefix + marker);
    safe = safe.replace(ASSIGNMENT, (match: string, prefix: string, quote: string, name: string) =>
      SENSITIVE_NAME.test(name) ? `${prefix}${quote}${name}${quote}=${marker}` : match,
    );
    safe = safe.replace(FLAG, marker);
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
      const safe = cut(scrub(cut(scrub(normalized), limit)), limit);
      return containsSensitive(safe) ? "" : safe;
    } catch {
      return fallback(marker, limit);
    }
  };
}
