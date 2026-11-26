/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { Link } from "@tanstack/react-router";

import { Figure, Figures } from "../components/app/figure.js";
import type { HomeSnapshot } from "./dashboard.js";
import { needsYou, type NeedsYou } from "./needs-you.js";

const LINK =
  "text-link underline underline-offset-4 max-md:inline-flex max-md:min-h-11 max-md:items-center";

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function HomeNeedsYou({ data, base }: { data: HomeSnapshot; base: string }) {
  const found = needsYou(data);
  return (
    <Figures label="Needs you" columns={4}>
      <FailingFigure found={found} base={base} />
      <AppsFigure found={found} base={base} />
      <DaemonsFigure found={found} base={base} />
      <StoppedFigure found={found} base={base} />
    </Figures>
  );
}

interface FigureProps {
  found: NeedsYou;
  base: string;
}

function FailingFigure({ found: { failing }, base }: FigureProps) {
  return (
    <Figure
      value={String(failing)}
      unit={plural(failing, "trigger failing", "triggers failing")}
      tone={failing > 0 ? "attention" : undefined}
    >
      {failing === 0 ? (
        "Last runs all finished."
      ) : (
        <Link to={`${base}/activity?status=did_not_finish` as never} className={LINK}>
          Review runs
        </Link>
      )}
    </Figure>
  );
}

function AppsFigure({ found: { unauthorizedApps }, base }: FigureProps) {
  const count = unauthorizedApps.length;
  return (
    <Figure
      value={String(count)}
      unit={plural(count, "app to authorize", "apps to authorize")}
      tone={count > 0 ? "attention" : undefined}
    >
      {count === 0 ? (
        "All apps authorized."
      ) : (
        <>
          {unauthorizedApps.join(", ")}.{" "}
          <Link to={`${base}/connections` as never} className={LINK}>
            Open connections
          </Link>
        </>
      )}
    </Figure>
  );
}

function DaemonsFigure({ found: { daemons }, base }: FigureProps) {
  return (
    <Figure
      value={String(daemons.total)}
      unit={plural(daemons.total, "daemon to check", "daemons to check")}
      tone={daemons.total > 0 ? "attention" : undefined}
    >
      {daemons.total === 0 ? (
        "All daemons ready."
      ) : (
        <>
          {String(daemons.offline)} offline, {String(daemons.cannotExecute)} cannot run agents.{" "}
          <Link to={`${base}/daemons` as never} className={LINK}>
            View daemons
          </Link>
        </>
      )}
    </Figure>
  );
}

function StoppedFigure({ found: { stopped }, base }: FigureProps) {
  const [first] = stopped;
  return (
    <Figure
      value={String(stopped.length)}
      unit="stopped matching"
      tone={first === undefined ? undefined : "attention"}
    >
      {first === undefined ? (
        "All triggers matching."
      ) : (
        <>
          {first.name} matched {String(first.previousMatches)} the week before and none since
          {stopped.length > 1 ? `, and ${String(stopped.length - 1)} more` : ""}.{" "}
          <Link
            to={`${base}/triggers${stopped.length === 1 ? `/${first.id}` : ""}` as never}
            className={LINK}
          >
            {stopped.length === 1 ? "Open trigger" : "View triggers"}
          </Link>
        </>
      )}
    </Figure>
  );
}
