import type { Recurrence } from "./recurrence.js";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export const FREQUENCIES = [
  { value: "MINUTELY", label: "Every minute" },
  { value: "HOURLY", label: "Every hour" },
  { value: "DAILY", label: "Every day" },
  { value: "WEEKLY", label: "Every week" },
];
export interface RecurrenceDraft {
  frequency: string;
  days: string[];
  times: string[];
}
export function defaultDraft(start: string): RecurrenceDraft {
  return {
    frequency: "DAILY",
    days: ["MO"],
    times: [start.slice(11, 16)],
  };
}

/** Compile approachable controls into a single standard rule, including exact time pairs. */
export function ruleFromDraft(draft: RecurrenceDraft): string {
  const parts = [`FREQ=${draft.frequency}`];
  if (draft.frequency === "WEEKLY") {
    if (draft.days.length === 0) throw new Error("Choose at least one day.");
    parts.push(`BYDAY=${DAY_CODES.filter((day) => draft.days.includes(day)).join(",")}`);
  }
  if (!["MINUTELY", "HOURLY"].includes(draft.frequency)) {
    if (
      draft.times.length === 0 ||
      draft.times.some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))
    )
      throw new Error("Choose at least one valid time.");
    if (new Set(draft.times).size !== draft.times.length) throw new Error("Choose distinct times.");
    const hours = [...new Set(draft.times.map((time) => Number(time.slice(0, 2))))].sort(
      (a, b) => a - b,
    );
    const minutes = [...new Set(draft.times.map((time) => Number(time.slice(3))))].sort(
      (a, b) => a - b,
    );
    parts.push(`BYHOUR=${hours.join(",")}`, `BYMINUTE=${minutes.join(",")}`, "BYSECOND=0");
    const combinations = hours.flatMap((hour) =>
      minutes.map(
        (minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ),
    );
    if (combinations.length !== draft.times.length) {
      const positions = combinations.flatMap((time, index) =>
        draft.times.includes(time) ? [index + 1] : [],
      );
      const days = draft.frequency === "WEEKLY" ? draft.days.length : 1;
      parts.push(
        `BYSETPOS=${Array.from({ length: days }, (_, day) =>
          positions.map((position) => day * combinations.length + position),
        )
          .flat()
          .join(",")}`,
      );
    }
  }
  return parts.join(";");
}

/** Rules the controls cannot faithfully express remain editable as RRULE without conversion. */
export function projectRecurrence(value: Recurrence): RecurrenceDraft | null {
  const parts = ruleParts(value.rule);
  const frequency = parts.get("FREQ");
  if (frequency === undefined || !FREQUENCIES.some((item) => item.value === frequency)) return null;
  if (!hasPresetFields(parts)) return null;
  const draft = { ...defaultDraft(value.start), frequency };
  const byDay = parts.get("BYDAY");
  if (frequency === "WEEKLY") {
    const days = projectWeeklyDays(value, byDay);
    if (days === null) return null;
    draft.days = days;
  } else if (byDay !== undefined) return null;
  if (["MINUTELY", "HOURLY"].includes(frequency))
    return parts.size <= (parts.has("INTERVAL") ? 2 : 1) ? draft : null;
  return projectTimes(value, parts, draft);
}

function ruleParts(rule: string): Map<string, string> {
  return new Map(
    rule.split(";").map((part) => {
      const equals = part.indexOf("=");
      return [part.slice(0, equals), part.slice(equals + 1)];
    }),
  );
}

const PRESET_FIELDS = new Set([
  "FREQ",
  "INTERVAL",
  "BYDAY",
  "BYHOUR",
  "BYMINUTE",
  "BYSECOND",
  "BYSETPOS",
]);

function hasPresetFields(parts: Map<string, string>): boolean {
  return (
    [...parts.keys()].every((key) => PRESET_FIELDS.has(key)) &&
    (!parts.has("INTERVAL") || parts.get("INTERVAL") === "1")
  );
}

function projectWeeklyDays(value: Recurrence, byDay: string | undefined): string[] | null {
  if (byDay === undefined) {
    const day = DAY_CODES[(new Date(`${value.start}Z`).getUTCDay() + 6) % 7];
    return day === undefined ? null : [day];
  }
  const days = byDay.split(",");
  return days.every((day) => DAY_CODES.some((code) => code === day)) ? days : null;
}

function projectTimes(
  value: Recurrence,
  parts: Map<string, string>,
  draft: RecurrenceDraft,
): RecurrenceDraft | null {
  const seconds = parts.get("BYSECOND");
  if (seconds === undefined ? value.start.slice(17) !== "00" : seconds !== "0") return null;
  const combinations = timeCombinations(value, parts);
  const positions = parts.get("BYSETPOS")?.split(",").map(Number);
  draft.times =
    positions === undefined
      ? combinations
      : combinations.filter((_, index) => positions.includes(index + 1));
  if (draft.times.length === 0 || draft.times.length > 24) return null;
  if (
    positions !== undefined &&
    ruleParts(ruleFromDraft(draft)).get("BYSETPOS") !== parts.get("BYSETPOS")
  )
    return null;
  return draft;
}

function timeCombinations(value: Recurrence, parts: Map<string, string>): string[] {
  const hours = (parts.get("BYHOUR") ?? value.start.slice(11, 13))
    .split(",")
    .map(Number)
    .sort((a, b) => a - b);
  const minutes = (parts.get("BYMINUTE") ?? value.start.slice(14, 16))
    .split(",")
    .map(Number)
    .sort((a, b) => a - b);
  return hours.flatMap((hour) =>
    minutes.map((minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`),
  );
}

export function describeRecurrence(value: Recurrence): string {
  const draft = projectRecurrence(value);
  if (draft === null) return `${value.rule} (${value.timezone})`;
  const frequency = FREQUENCIES.find((item) => item.value === draft.frequency);
  if (frequency === undefined)
    throw new TypeError("Cannot read properties of undefined (reading 'label')");
  let summary = frequency.label;
  if (draft.frequency === "WEEKLY")
    summary = `Every ${DAY_CODES.filter((day) => draft.days.includes(day))
      .map(weekdayAbbreviation)
      .map((day) => day.charAt(0).toUpperCase() + day.slice(1))
      .join(", ")}`;
  if (!["MINUTELY", "HOURLY"].includes(draft.frequency))
    summary += ` at ${draft.times.join(" and ")}`;
  return `${summary} (${value.timezone})`;
}

function weekdayAbbreviation(day: (typeof DAY_CODES)[number]): string {
  const weekday = WEEKDAYS[DAY_CODES.indexOf(day)];
  if (weekday === undefined)
    throw new TypeError("Cannot read properties of undefined (reading 'slice')");
  return weekday.slice(0, 3);
}
