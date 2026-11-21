// Assistant prose uses span redaction. Structured timeline fields keep their own policy.
const PREFIX_TOKEN =
  /(?:paseo_(?:pk|cli)_|gh[pousr]_|github_pat_|xox[abprs]-|xapp-|lin_(?:api|oauth)_|AKIA|ASIA|sk-|AIza|sk_live_|rk_live_|whsec_)[A-Za-z0-9_+/-]*/gu;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/gu;
const BEARER = /\bBearer[ \t]+([A-Za-z0-9._~+/-]{4,}={0,2})/giu;
const ASSIGNMENT =
  /\b(?:[a-z0-9]+[-_])*(?:key|token|secret|password)\b["']?[ \t]*[:=][ \t]*["']?([a-z0-9+/_-]{24,}={0,2})/giu;
const ENTROPY = /[A-Za-z0-9+/=_-]{32,}/gu;
const URL_START = /[/\\]{2}|(?:%2f|%5c){2}/giu;
const AUTHORITY_END = /[/?#\s"'<>]/u;
const URL_END = /[\s"'<>]/gu;
const QUERY_VALUE = /[?&#]([a-z0-9_.~-]+)=([^#&\s"'<>]+)/giu;
const SENSITIVE_QUERY =
  /pass|pwd|secret|token|key|auth|basic|bearer|cred|session|cookie|sig|^code$/iu;

const AUTHORITY = /^[^/?#\s"'<>]*/u;
const TOKEN = /^[A-Za-z0-9_+/-]*/u;
const JWT_SUFFIX = /^[A-Za-z0-9_.-]*/u;
const BEARER_SUFFIX = /^[A-Za-z0-9._~+/=-]*/u;
const ENTROPY_SUFFIX = /^[A-Za-z0-9+/=_-]*/u;
const QUERY_SUFFIX = /^[^#&\s"'<>]*/u;
const ARMOR_SUFFIX = /^-*/u;

type Continuation = RegExp | "armor" | { value: string; offset: number; armor?: true };
interface Span {
  start: number;
  end: number;
  open?: Continuation | undefined;
  quiet?: boolean | undefined;
  markOnResume?: boolean | undefined;
}

interface Carry {
  length: number;
  open: Continuation | undefined;
  quiet: boolean;
}

function armorMarker(text: string, offset: number, keyword: "BEGIN" | "END") {
  for (let start = text.indexOf("-", offset); start !== -1; start = text.indexOf("-", offset)) {
    offset = start + 1;
    while (text[offset] === "-") offset += 1;
    if (offset - start < 3) continue;
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
    const end = offset + keyword.length;
    if (text.slice(offset, end).toUpperCase() === keyword && !/[\w]/iu.test(text[end] ?? ""))
      return { start, end };
  }
  return undefined;
}

function finishArmor(text: string, offset: number): number | undefined {
  for (
    let footer = armorMarker(text, offset, "END");
    footer;
    footer = armorMarker(text, offset, "END")
  ) {
    let dashes = 0;
    offset = footer.end;
    while (offset < text.length && text[offset] !== "\r" && text[offset] !== "\n") {
      dashes = text[offset++] === "-" ? dashes + 1 : 0;
      if (dashes === 3) {
        while (text[offset] === "-") offset += 1;
        return offset;
      }
    }
  }
  return undefined;
}

function armorSpans(text: string, offset: number): Span[] {
  const spans: Span[] = [];
  for (
    let begin = armorMarker(text, offset, "BEGIN");
    begin;
    begin = armorMarker(text, offset, "BEGIN")
  ) {
    const close = finishArmor(text, begin.end);
    spans.push({
      start: begin.start,
      end: close ?? text.length,
      open: armorContinuation(close, text.length),
    });
    if (close === undefined) break;
    offset = close;
  }
  return spans;
}

function armorContinuation(close: number | undefined, length: number): Continuation | undefined {
  if (close === undefined) return "armor";
  return close === length ? ARMOR_SUFFIX : undefined;
}

function partialArmor(text: string, release: number, boundary: boolean): Span[] {
  const word = "BEGIN";
  for (let count = word.length - 1; count > 0; count -= 1) {
    let start = text.length - count;
    if (start < 0 || text.slice(start).toUpperCase() !== word.slice(0, count)) continue;
    while (/\s/u.test(text[start - 1] ?? "")) start -= 1;
    const endOfDashes = start;
    while (text[start - 1] === "-") start -= 1;
    if (endOfDashes - start < 3 || start >= release) continue;
    return [
      {
        start,
        end: text.length,
        open: { value: word, offset: count, armor: true },
        quiet: boundary,
        markOnResume: boundary,
      },
    ];
  }
  return [];
}

function encodedSlash(text: string, index: number): boolean {
  return text[index] === "%" && /^(?:2f|5c)$/iu.test(text.slice(index + 1, index + 3));
}

function scanAuthority(
  text: string,
  start: number,
): { start: number; end: number; lastAt: number } {
  while (encodedSlash(text, start)) start += 3;
  while (text[start] === "/" || text[start] === "\\") start += 1;
  let end = start;
  let lastAt = start;
  while (end < text.length && !AUTHORITY_END.test(text[end]!)) {
    if (text[end] === "@") lastAt = end + 1;
    if (text.startsWith("%40", end)) lastAt = end + 3;
    end += 1;
  }
  return { start, end, lastAt };
}

function urlSpans(text: string, release: number, streaming: boolean): Span[] {
  const spans: Span[] = [];
  let skipUntil = 0;
  for (const match of text.matchAll(URL_START)) {
    if (match.index < skipUntil) continue;
    const authority = scanAuthority(text, match.index + match[0].length);
    URL_END.lastIndex = authority.end;
    skipUntil = URL_END.exec(text)?.index ?? text.length;
    if (authority.start < release && authority.end === text.length && streaming) {
      spans.push({ start: authority.start, end: authority.end, open: AUTHORITY });
    } else if (authority.lastAt > authority.start) {
      spans.push({ start: authority.start, end: authority.lastAt });
    }
  }
  return spans;
}

function matchedSpans(
  text: string,
  pattern: RegExp,
  continuation: RegExp,
  capture = false,
): Span[] {
  return [...text.matchAll(pattern)].map((match) => {
    const end = match.index + match[0].length;
    return {
      start: end - match[capture ? 1 : 0]!.length,
      end,
      open: end === text.length ? continuation : undefined,
    };
  });
}

function highEntropy(text: string): boolean {
  if (/^[a-f0-9]{40}$/u.test(text) || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(text))
    return false;
  if (!/[A-Za-z]/u.test(text) || !/[0-9]/u.test(text)) return false;
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4;
}

function entropySpans(text: string, assignments: readonly Span[]): Span[] {
  const spans: Span[] = [];
  let index = 0;
  for (const match of text.matchAll(ENTROPY)) {
    const end = match.index + match[0].length;
    while (assignments[index] && assignments[index]!.start <= match.index) index += 1;
    const assignment = assignments[index];
    const start = assignment && assignment.start < end ? assignment.start : match.index;
    if (highEntropy(text.slice(start, end)))
      spans.push({ start, end, open: end === text.length ? ENTROPY_SUFFIX : undefined });
  }
  return spans;
}

function querySpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(QUERY_VALUE)) {
    if (!SENSITIVE_QUERY.test(match[1]!)) continue;
    const end = match.index + match[0].length;
    spans.push({
      start: end - match[2]!.length,
      end,
      open: end === text.length ? QUERY_SUFFIX : undefined,
    });
  }
  return spans;
}

interface Secret {
  value: string;
  fallback: number[];
}

function prepareSecret(value: string): Secret {
  const fallback = [0];
  let match = 0;
  for (let index = 1; index < value.length; index += 1) {
    while (match && value[index] !== value[match]) match = fallback[match - 1]!;
    if (value[index] === value[match]) match += 1;
    fallback.push(match);
  }
  return { value, fallback };
}

function secretSuffix(text: string, { value, fallback }: Secret): number {
  let match = 0;
  for (let index = Math.max(0, text.length - value.length + 1); index < text.length; index += 1) {
    while (match && text[index] !== value[match]) match = fallback[match - 1]!;
    if (text[index] === value[match]) match += 1;
  }
  return match;
}

function knownSpans(
  text: string,
  secrets: readonly Secret[],
  release: number,
  partial: boolean,
  boundary: boolean,
): Span[] {
  const spans: Span[] = [];
  for (const secret of secrets) {
    const { value } = secret;
    for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1))
      spans.push({ start, end: start + value.length });
    if (!partial) continue;
    const matched = secretSuffix(text, secret);
    const start = text.length - matched;
    if (matched > 0 && start < release)
      spans.push({
        start,
        end: text.length,
        open: { value, offset: matched },
        quiet: boundary,
        markOnResume: boundary,
      });
  }
  return spans;
}

function continueSpan(text: string, carry: Carry): Span {
  const { length, open, quiet } = carry;
  if (open === "armor") {
    const close = finishArmor(text, 0);
    return {
      start: 0,
      end: close ?? text.length,
      open: armorContinuation(close, text.length),
      quiet,
    };
  }
  if (open instanceof RegExp) {
    const end = length + open.exec(text.slice(length))![0].length;
    return { start: 0, end, open: end === text.length ? open : undefined, quiet };
  }
  if (open === undefined) return { start: 0, end: length, quiet };
  return continueLiteral(text, length, open, quiet);
}

function continueLiteral(
  text: string,
  length: number,
  literal: Exclude<Continuation, RegExp | "armor">,
  quiet: boolean,
): Span {
  let matched = 0;
  for (
    ;
    length + matched < text.length && literal.offset + matched < literal.value.length;
    matched += 1
  ) {
    const character = text[length + matched]!;
    if (
      (literal.armor ? character.toUpperCase() : character) !==
      literal.value[literal.offset + matched]
    )
      break;
  }
  const end = length + matched;
  const offset = literal.offset + matched;
  if (literal.armor && offset === literal.value.length && !/[\w]/iu.test(text[end] ?? "")) {
    const close = finishArmor(text, end);
    return {
      start: 0,
      end: close ?? text.length,
      open: armorContinuation(close, text.length),
      quiet,
    };
  }
  return {
    start: 0,
    end,
    open: end === text.length && offset < literal.value.length ? { ...literal, offset } : undefined,
    quiet,
  };
}

function mergedSpans(spans: Span[]): Span[] {
  spans.sort((left, right) => left.start - right.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      if (span.end > last.end || (span.end === last.end && last.open === undefined)) {
        last.end = span.end;
        last.open = span.open;
      }
    } else if (span.start < span.end) merged.push({ ...span });
  }
  return merged;
}

function project(parts: readonly string[], spans: readonly Span[]): string[] {
  let offset = 0;
  let index = 0;
  return parts.map((part) => {
    let from = offset;
    let safe = "";
    const end = offset + part.length;
    for (let span = spans[index]; span && span.start < end; span = spans[++index]) {
      if (span.start >= from)
        safe += part.slice(from - offset, span.start - offset) + (span.quiet ? "" : "[redacted]");
      from = span.end;
      if (from > end) break;
    }
    offset = end;
    return safe + part.slice(from - (end - part.length));
  });
}

export function createAssistantTextRedactor(values: readonly string[]) {
  const known = [...new Set(values.filter(Boolean))].map(prepareSecret);
  function inspect(
    text: string,
    length: number,
    streaming: boolean,
    allowPartial: boolean,
    carry?: Carry,
  ) {
    const prior = carry && continueSpan(text, carry);
    const armor = armorSpans(text, prior?.open === "armor" ? text.length : (prior?.end ?? 0));
    const assigned = matchedSpans(text, ASSIGNMENT, ENTROPY_SUFFIX, true);
    return mergedSpans([
      ...(prior ? [prior] : []),
      ...armor,
      ...matchedSpans(text, PREFIX_TOKEN, TOKEN),
      ...matchedSpans(text, JWT, JWT_SUFFIX),
      ...matchedSpans(text, BEARER, BEARER_SUFFIX, true),
      ...assigned,
      ...entropySpans(text, assigned),
      ...urlSpans(text, length, streaming),
      ...querySpans(text),
      ...knownSpans(text, known, length, allowPartial, !streaming),
      ...(allowPartial ? partialArmor(text, length, !streaming) : []),
    ]);
  }
  return {
    redact(parts: readonly string[], truncated: boolean) {
      const text = parts.join("");
      const spans = inspect(text, text.length, false, truncated);
      // A known value that crosses the input limit is hidden as a span.
      for (const span of spans) span.quiet = false;
      return project(parts, spans);
    },
    open() {
      let carry: Carry | undefined;
      return (
        value: string,
        parts: readonly string[],
        length: number,
        boundary: boolean,
        final: boolean,
      ) => {
        if (length === 0) return parts.map(() => "");
        const spans = inspect(value, length, !boundary, !final, carry);
        const crossed = spans.find(
          (span) =>
            span.start < length &&
            (span.end > length || (span.end === length && span.open !== undefined)),
        );
        carry =
          crossed && !final
            ? {
                length: crossed.end - length,
                open: crossed.open,
                // A partial known value at a tool boundary only earns a marker on continuation.
                quiet: !crossed.markOnResume,
              }
            : undefined;
        return project(parts, spans);
      };
    },
  };
}
