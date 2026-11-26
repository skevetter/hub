/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- one screen binds one snapshot; a row's lead and status are that row's own slots */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { Link } from "@tanstack/react-router";

import { EmptyState } from "../components/app/empty-state.js";
import { Figure, Figures } from "../components/app/figure.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StateBlock } from "../components/app/state-block.js";
import {
  connectionState,
  daemonState,
  runListState,
  type StateView,
} from "../components/app/state-label.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { PROVIDER_NAMES } from "../connections/status.js";
import { EDITOR_EVENTS, eventDefinition, isEditorEvent } from "../triggers/configuration/events.js";
import type { HomeSnapshot } from "./dashboard.js";
import {
  HOME_TRIGGER_ROWS,
  triggerHealth,
  type TriggerHealth,
  type TriggerHealthRow,
} from "./trigger-health.js";

const INLINE_LINK =
  "text-link underline underline-offset-4 max-md:inline-flex max-md:min-h-11 max-md:items-center";

/** What the page is for: is each trigger working, and does it have somewhere to run. */
export function HomeOverview({ data, base }: { data: HomeSnapshot; base: string }) {
  const health = triggerHealth(data);
  return (
    <>
      <HomeFigures data={data} health={health} base={base} />
      <HomeTriggers data={data} health={health} base={base} />
      <HomeWhereItRuns data={data} />
    </>
  );
}

function HomeFigures({
  data,
  health,
  base,
}: {
  data: HomeSnapshot;
  health: TriggerHealth;
  base: string;
}) {
  const on = data.triggers.length - health.paused;
  const connected = data.daemons.filter(({ presence }) => presence === "connected").length;
  return (
    <Figures label="Overview">
      <Figure
        value={String(health.failing)}
        unit={health.failing === 1 ? "trigger failing" : "triggers failing"}
        tone={health.failing > 0 ? "attention" : undefined}
        caption={<FailingCaption health={health} base={base} triggers={data.triggers.length} />}
      />
      <Figure
        value={String(on)}
        unit={on === 1 ? "trigger on" : "triggers on"}
        caption={`${String(health.paused)} paused \u00b7 ${String(health.running)} running`}
      />
      <Figure
        value={String(connected)}
        unit={connected === 1 ? "daemon connected" : "daemons connected"}
        caption={daemonDetail(data.daemons)}
      />
    </Figures>
  );
}

function FailingCaption({
  health,
  base,
  triggers,
}: {
  health: TriggerHealth;
  base: string;
  triggers: number;
}) {
  const { latestFailure } = health;
  if (latestFailure === null)
    return triggers === 0 ? "No triggers yet." : "No trigger's last run failed.";
  return (
    <>
      Latest:{" "}
      <Link
        to={`${base}/activity/${latestFailure.runId}` as never}
        className={INLINE_LINK}
        aria-label={`View latest failed run for ${latestFailure.triggerName}`}
      >
        {latestFailure.triggerName}
      </Link>
      {", "}
      {runListState(latestFailure.status).label.toLowerCase()}{" "}
      <RelativeTime value={latestFailure.startedAt} />
    </>
  );
}

function HomeTriggers({
  data,
  health,
  base,
}: {
  data: HomeSnapshot;
  health: TriggerHealth;
  base: string;
}) {
  return (
    <Section
      title="Triggers"
      action={
        <Button variant="link" asChild>
          <Link to={`${base}/triggers` as never}>View all</Link>
        </Button>
      }
    >
      {health.rows.length === 0 ? (
        <EmptyState
          title="No triggers yet"
          description="A trigger turns an event into an agent run."
        >
          <Button asChild variant="outline" size="sm" className="max-md:min-h-11">
            <Link to={`${base}/triggers/new/edit` as never}>Create a trigger</Link>
          </Button>
        </EmptyState>
      ) : (
        <>
          <RecordList label="Trigger health">
            {health.rows.slice(0, HOME_TRIGGER_ROWS).map((row) => (
              <TriggerRow key={row.id} row={row} base={base} windowDays={data.windowDays} />
            ))}
          </RecordList>
          {health.rows.length > HOME_TRIGGER_ROWS ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing the {String(HOME_TRIGGER_ROWS)} worst of {String(health.rows.length)}{" "}
              triggers. View all for the rest.
            </p>
          ) : null}
          <p className="mt-4 text-sm">
            <Link to={`${base}/activity` as never} className={INLINE_LINK}>
              Recent runs
            </Link>
          </p>
        </>
      )}
    </Section>
  );
}

function TriggerRow({
  row,
  base,
  windowDays,
}: {
  row: TriggerHealthRow;
  base: string;
  windowDays: number;
}) {
  const eventLabel = runSourceLabel(row.event);
  return (
    <RecordRow
      lead={<StateBlock state={row.state} />}
      status={
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {windowTally(row, windowDays)}
        </span>
      }
    >
      <TwoLine
        primary={
          <Link to={`${base}/triggers/${row.id}` as never} className={INLINE_LINK}>
            {row.name}
          </Link>
        }
        secondary={
          <>
            {eventLabel}
            {eventLabel !== "" && row.latest !== null ? " \u00b7 " : null}
            {row.latest === null ? null : (
              <>
                last run <RelativeTime value={row.latest.startedAt} />
              </>
            )}
          </>
        }
      />
    </RecordRow>
  );
}

function windowTally({ total, failed }: TriggerHealthRow, days: number): string {
  if (total === 0) return `No runs in ${String(days)} days`;
  const runs = `${String(total)} ${total === 1 ? "run" : "runs"} in ${String(days)} days`;
  return failed === 0 ? runs : `${runs} \u00b7 ${String(failed)} failed`;
}

function HomeWhereItRuns({ data }: { data: HomeSnapshot }) {
  const empty = data.daemons.length === 0 && data.connections.length === 0;
  return (
    <Section title="Where it runs">
      {empty ? (
        <EmptyState
          title="Nothing connected yet"
          description="Connect an app for events and a daemon to run them on."
        />
      ) : (
        <RecordList label="Daemons and apps">
          {data.daemons.map((daemon) => (
            <PlaceRow
              key={daemon.id}
              state={daemonView(daemon)}
              name={daemon.slug}
              kind="Daemon"
              mono
            />
          ))}
          {data.connections.map((connection) => (
            <PlaceRow
              key={`${connection.provider}:${connection.slug}`}
              state={connectionView(connection)}
              name={connection.label}
              kind={PROVIDER_NAMES[connection.provider]}
            />
          ))}
        </RecordList>
      )}
    </Section>
  );
}

function PlaceRow({
  state,
  name,
  kind,
  mono = false,
}: {
  state: StateView;
  name: string;
  kind: string;
  mono?: boolean;
}) {
  return (
    <RecordRow lead={<StateBlock state={state} />}>
      <TwoLine primary={name} secondary={kind} mono={mono} />
    </RecordRow>
  );
}

function daemonView(daemon: HomeSnapshot["daemons"][number]): StateView {
  if (!daemon.canExecute) return { label: "Cannot run agents", tone: "attention" };
  return daemonState(daemon.presence === "connected" ? "connected" : "offline");
}

function connectionView(connection: HomeSnapshot["connections"][number]): StateView {
  return connectionState(connection.needsAuthorization ? "requiresReauthorization" : "connected");
}

function daemonDetail(daemons: HomeSnapshot["daemons"]): string {
  const cannot = daemons.filter(({ canExecute }) => !canExecute).length;
  return `${String(daemons.length)} enrolled${cannot === 0 ? "" : ` \u00b7 ${String(cannot)} cannot run agents`}`;
}

function runSourceLabel(source: string): string {
  if (isEditorEvent(source)) return eventDefinition(source).label;
  // An issue receipt can match either of the Linear issue events.
  if (source === "linear.issue") return "Linear issue event";
  const event = EDITOR_EVENTS.find((id) => eventDefinition(id).receiptSource === source);
  return event === undefined ? source : eventDefinition(event).label;
}
