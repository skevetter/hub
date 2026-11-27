import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ScheduleFields } from "./fields.js";
import { DEFAULT_RECURRENCE, type Recurrence } from "./recurrence.js";

function render(value?: Recurrence, error?: string, event = "schedule.tick") {
  return renderToStaticMarkup(
    <ScheduleFields event={event} value={value} error={error} onChange={vi.fn()} />,
  );
}

function fieldOrder(markup: string): string[] {
  return [...markup.matchAll(/ id="(schedule-[^"]+)"/gu)].flatMap(([, id]) =>
    id === undefined || id.endsWith("-description") ? [] : [id],
  );
}

it("only renders recurrence controls for schedule events", () => {
  expect(render(undefined, undefined, "manual.run")).toBe("");
});

it("renders the default preset with one time and no remove control", () => {
  const markup = render();
  expect(fieldOrder(markup)).toEqual([
    "schedule-frequency",
    "schedule-time-0",
    "schedule-timezone",
  ]);
  expect(markup).toContain('value="09:00"');
  expect(markup).toContain("Add time");
  expect(markup).not.toContain("Remove time");
  expect(markup).toContain("Every day at 09:00 (UTC)");
});

it("renders weekly weekday options and multiple time slots in order", () => {
  const markup = render({
    ...DEFAULT_RECURRENCE,
    rule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8,16;BYMINUTE=15,45;BYSECOND=0;BYSETPOS=1,4,5,8",
  });
  expect(fieldOrder(markup)).toEqual([
    "schedule-frequency",
    "schedule-MO",
    "schedule-TU",
    "schedule-WE",
    "schedule-TH",
    "schedule-FR",
    "schedule-SA",
    "schedule-SU",
    "schedule-time-0",
    "schedule-time-1",
    "schedule-timezone",
  ]);
  expect(markup).toContain('aria-label="Remove time 2"');
  expect(markup).toContain("Every Mon, Fri at 08:15 and 16:45 (UTC)");
});

it("hides time slots for an hourly preset", () => {
  const markup = render({ ...DEFAULT_RECURRENCE, rule: "FREQ=HOURLY" });
  expect(fieldOrder(markup)).toEqual(["schedule-frequency", "schedule-timezone"]);
  expect(markup).not.toContain("Add time");
  expect(markup).toContain("Every hour (UTC)");
});

it("renders the custom rule and start without a preset summary", () => {
  const markup = render({ ...DEFAULT_RECURRENCE, rule: "FREQ=MONTHLY;BYDAY=-1FR" }, "Check rule.");
  expect(fieldOrder(markup)).toEqual(["schedule-rule", "schedule-start", "schedule-timezone"]);
  expect(markup).toContain('value="FREQ=MONTHLY;BYDAY=-1FR"');
  expect(markup).toContain('value="1970-01-01T00:00:00"');
  expect(markup).toContain("Check rule.");
  expect(markup).not.toContain('role="status"');
});
