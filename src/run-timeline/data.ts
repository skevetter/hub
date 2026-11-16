import { createHash } from "node:crypto";
import type { JsonValue } from "../config/compiler.js";
import type { RunTimelineState, TimelineData, TimelineKind } from "./store.js";

function decimalText(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Timeline numbers must be finite");
  const text = String(value);
  if (!/[eE]/u.test(text)) return text;
  const [mantissa, exponentText] = text.split(/[eE]/u);
  const negative = mantissa!.startsWith("-");
  const unsigned = negative ? mantissa!.slice(1) : mantissa!;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = whole! + fraction;
  const point = whole!.length + Number(exponentText);
  let expanded: string;
  if (point <= 0) expanded = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) expanded = digits + "0".repeat(point - digits.length);
  else expanded = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + expanded;
}

function quoted(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next >= 0xdc00 && next <= 0xdfff) continue;
    } else if (code !== 0 && (code < 0xdc00 || code > 0xdfff)) continue;
    throw new TypeError("Timeline text must be valid PostgreSQL Unicode text");
  }
  return JSON.stringify(value);
}

export function jsonbText(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return quoted(value);
  if (typeof value === "number") return decimalText(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  return `{${Object.keys(value)
    .sort(
      (a, b) =>
        Buffer.byteLength(a) - Buffer.byteLength(b) ||
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
    )
    .map((key) => `${quoted(key)}: ${jsonbText(value[key]!)}`)
    .join(", ")}}`;
}

export function jsonbBytes(value: JsonValue): number {
  return Buffer.byteLength(jsonbText(value));
}

export function isOrdinary(kind: TimelineKind): boolean {
  return kind !== "step_finished" && kind !== "run_finished" && kind !== "truncated";
}

export function timelineRowLimit(kind: TimelineKind): number {
  if (kind === "truncated") return 128;
  return isOrdinary(kind) ? 1024 : 512;
}

export function prepareTimelineData(kind: TimelineKind, data: TimelineData): TimelineData {
  const prepared = structuredClone(data);
  while (jsonbBytes(prepared) > timelineRowLimit(kind)) {
    let longest: { parent: TimelineData | JsonValue[]; key: string; size: number } | undefined;
    const visit = (value: TimelineData | JsonValue[]) => {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string" && key !== "callId" && child !== "truncated") {
          const size = Buffer.byteLength(JSON.stringify(child));
          if (size > 11 && (longest === undefined || size > longest.size))
            longest = { parent: value, key, size };
        } else if (child !== null && typeof child === "object") visit(child);
      }
    };
    visit(prepared);
    if (longest === undefined) throw new RangeError("Timeline data exceeds its row byte limit");
    const target: { parent: TimelineData | JsonValue[]; key: string; size: number } = longest;
    if (Array.isArray(target.parent)) target.parent[Number(target.key)] = "truncated";
    else target.parent[target.key] = "truncated";
  }
  return prepared;
}

export function timelineStepId(value: string): string {
  if (Buffer.byteLength(value) <= 64) return value;
  let prefix = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 48) break;
    prefix += character;
    bytes += size;
  }
  return `${prefix}.${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

export function timelineDedupeKey(
  kind: TimelineKind,
  stepId: string,
  data: TimelineData,
): string | undefined {
  if (
    ["run_started", "step_started", "step_finished", "run_finished", "agent_started"].includes(kind)
  )
    return JSON.stringify([kind, stepId]);
  if (
    (kind === "tool_started" || kind === "tool_finished") &&
    data["callId"] !== undefined &&
    data["callId"] !== null
  )
    return JSON.stringify([
      kind,
      stepId,
      typeof data["callId"] === "string" ? data["callId"] : jsonbText(data["callId"]),
    ]);
  if (kind === "truncated") return JSON.stringify([kind]);
  return undefined;
}

export function timelineCallIdText(data: TimelineData): string | null {
  const callId = data["callId"];
  if (callId === undefined || callId === null) return null;
  return typeof callId === "string" ? callId : jsonbText(callId);
}

export function timelineBudgetExceeded(
  state: RunTimelineState,
  kind: TimelineKind,
  bytes: number,
  maxEvents: number,
  notice: boolean,
): boolean {
  if (isOrdinary(kind)) {
    const count = state.eventCount - state.stepEndCount - Number(notice);
    return count >= maxEvents || state.byteCount + bytes > 196608;
  }
  return (
    kind === "step_finished" && (state.stepEndCount >= 100 || state.stepEndBytes + bytes > 51200)
  );
}
