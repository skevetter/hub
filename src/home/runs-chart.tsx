import { Figure, Figures } from "../components/app/figure.js";
import { Section } from "../components/app/section.js";
import type { HomeSnapshot } from "./dashboard.js";
import { CHART_DAYS } from "./runs-per-day.js";

type Day = HomeSnapshot["runDays"][number];

export function HomeRuns({ days }: { days: HomeSnapshot["runDays"] }) {
  return (
    <Section title={`Runs, last ${String(CHART_DAYS)} days`}>
      <RunsFigures days={days} />
      <RunsChart days={days} />
    </Section>
  );
}

function RunsFigures({ days }: { days: readonly Day[] }) {
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const failed = days.reduce((sum, day) => sum + day.failed, 0);
  const share =
    total === 0 ? "No runs yet." : `${String(Math.round((failed / total) * 100))}% of runs.`;
  return (
    <Figures label="Runs">
      <Figure value={String(total)} unit={total === 1 ? "run" : "runs"}>
        {`In ${String(CHART_DAYS)} days.`}
      </Figure>
      <Figure
        value={String(failed)}
        unit="did not finish"
        tone={failed > 0 ? "attention" : undefined}
      >
        {share}
      </Figure>
    </Figures>
  );
}

function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function summarize(days: readonly Day[]): string {
  return days
    .map(
      ({ day, total, failed }) =>
        `${dayLabel(day)}: ${String(total)} ${total === 1 ? "run" : "runs"}, ${String(failed)} did not finish`,
    )
    .join("; ");
}

const BAR_SLOT = 10;
const CHART_HEIGHT = 100;

function RunsChart({ days }: { days: readonly Day[] }) {
  const peak = Math.max(1, ...days.map(({ total }) => total));
  return (
    <div className="grid gap-2">
      <svg
        role="img"
        aria-label={`Runs per day. ${summarize(days)}`}
        viewBox={`0 0 ${String(days.length * BAR_SLOT)} ${String(CHART_HEIGHT)}`}
        preserveAspectRatio="none"
        className="h-24 w-full border-b-2 border-foreground"
      >
        {days.map(({ day, total, failed }, index) => (
          <Bar key={day} slot={index} finished={total - failed} failed={failed} peak={peak} />
        ))}
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{dayLabel(days[0]?.day ?? "")}</span>
        <span>Peak {String(peak)} a day</span>
        <span>{dayLabel(days.at(-1)?.day ?? "")}</span>
      </div>
    </div>
  );
}

function Bar(props: { slot: number; finished: number; failed: number; peak: number }) {
  const x = props.slot * BAR_SLOT + 1;
  const finishedHeight = (props.finished / props.peak) * CHART_HEIGHT;
  const failedHeight = (props.failed / props.peak) * CHART_HEIGHT;
  return (
    <>
      <rect
        className="fill-foreground"
        x={x}
        y={CHART_HEIGHT - finishedHeight}
        width={BAR_SLOT - 2}
        height={finishedHeight}
      />
      <rect
        className="fill-attention"
        x={x}
        y={CHART_HEIGHT - finishedHeight - failedHeight}
        width={BAR_SLOT - 2}
        height={failedHeight}
      />
    </>
  );
}
