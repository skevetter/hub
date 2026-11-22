/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- one screen binds one snapshot; a row's action and status are that row's own slots */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useSnapshotQuery, type Snapshot } from "../queries/index.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { MessagesSquare } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useActiveAccount } from "../auth/active-account.js";
import { Card, CardSkeleton } from "../components/app/card.js";
import {
  Checklist,
  ChecklistItem,
  ChecklistProgress,
  type ChecklistItemState,
} from "../components/app/checklist.js";
import { CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert, WarningAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { StatGrid, StatTile, StatTileSkeleton } from "../components/app/stat-tile.js";
import { StatusPill, statusLabel, type StatusTone } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { daemonLoginCommand, GRANT_EXECUTE_COMMAND } from "../daemons/handoff.js";
import { listSessionProfiles } from "../interactive-sessions/functions.js";
import {
  HomeSessionStart,
  sessionProfileQueryOptions,
} from "../interactive-sessions/ui/new-session.js";
import { useRouteTenant } from "../projects/context.js";
import { RECENT_DROP_COUNT_LIMIT } from "../db/dropped-events.js";
import { EDITOR_EVENTS, eventDefinition, isEditorEvent } from "../triggers/configuration/events.js";
import { DROP_REASON_GROUPS, type DropReasonGroup } from "../triggers/drop-reason.js";
import { LIST_PROVIDER_LABELS } from "../triggers/list-providers.js";
import {
  canFinishSetup,
  deriveChecklist,
  SETUP_STEP_TITLES,
  type Checklist as ChecklistState,
  type ChecklistStep,
  type ProfileAvailability,
} from "./checklist.js";
import type { RunTally } from "./dashboard.js";
import { finishHomeSetup, homeSnapshot, type HomeSnapshot } from "./functions.js";
import { HOME_MONTH_DAYS } from "./limits.js";
import { memberFlagKey, useMemberFlag } from "./member-preference.js";
import { thingsToTry, type TrySurfaceKey } from "./things-to-try.js";

const HOME_DESCRIPTION = "What is running, what needs you, and what to try next.";
const HOME_HEADING_ID = "home-heading";
const RECENT_RUNS_SHOWN = 5;

export function HomePanel() {
  const tenant = useRouteTenant();
  const account = useActiveAccount();
  const scope = { organizationSlug: tenant.organization.slug };
  const load = useServerFn(homeSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey: ["home", tenant.organization.id, tenant.account.id],
    queryFn: () => load({ data: scope }),
  });
  const profilesEnabled =
    account.features?.interactiveSessions === true &&
    snapshot.status === "success" &&
    snapshot.data.sessionStarted !== null;
  const list = useServerFn(listSessionProfiles);
  const profiles = useSnapshotQuery({
    ...sessionProfileQueryOptions(tenant.organization.slug, account.account.id, list),
    enabled: profilesEnabled,
  });
  const profileCount = useMemo<ProfileAvailability>(() => {
    if (!profilesEnabled) return null;
    if (profiles.status === "pending") return "checking";
    if (profiles.status === "error") return "unavailable";
    return Array.isArray(profiles.data)
      ? profiles.data.filter(({ status }) => status === "active").length
      : null;
  }, [profiles.data, profiles.status, profilesEnabled]);
  return (
    <HomeView
      key={tenant.organization.id}
      snapshot={snapshot}
      accountId={tenant.account.id}
      operator={account.isInstanceOperator}
      profiles={profileCount}
      canManageProfiles={tenant.capabilities.manageResources}
    />
  );
}

function HomeView({
  snapshot,
  accountId,
  operator,
  profiles,
  canManageProfiles,
}: {
  snapshot: Snapshot<HomeSnapshot> & { refetch: () => void; isFetching: boolean };
  accountId: string;
  operator: boolean;
  profiles: ProfileAvailability;
  canManageProfiles: boolean;
}) {
  const [focusOnCompletion, setFocusOnCompletion] = useState(false);
  const retryRequested = useRef(false);
  const { isFetching, status } = snapshot;
  useEffect(() => {
    if (!retryRequested.current || isFetching) return;
    retryRequested.current = false;
    if (status === "success") document.getElementById(HOME_HEADING_ID)?.focus();
  }, [isFetching, status]);
  const header = (
    <PageHeader
      id={HOME_HEADING_ID}
      title="Home"
      description={HOME_DESCRIPTION}
      focusOnMount={focusOnCompletion}
    />
  );
  if (snapshot.status === "pending") {
    return (
      <>
        {header}
        <HomeLoading />
      </>
    );
  }
  if (snapshot.status === "error") {
    return (
      <>
        {header}
        <FailureAlert
          title="Home unavailable"
          error={snapshot.error}
          fallback="Hub could not load this organization's activity and setup."
          onRetry={() => {
            retryRequested.current = true;
            snapshot.refetch();
          }}
        />
      </>
    );
  }
  const { data } = snapshot;
  const base = `/o/${data.organization.slug}`;
  return (
    <>
      {header}
      <NeedsAttention data={data} base={base} profiles={profiles} />
      <Section>
        <HomeTiles data={data} />
      </Section>
      {data.checklistCompletedAt === null ? (
        <HomeChecklist
          snapshot={data}
          base={base}
          accountId={accountId}
          operator={operator}
          profiles={profiles}
          canManageProfiles={canManageProfiles}
          onFinished={() => setFocusOnCompletion(true)}
        />
      ) : null}
      {profiles === null ? null : <HomeSessionStart organizationSlug={data.organization.slug} />}
      <ThingsToTry
        snapshot={data}
        base={base}
        profiles={profiles}
        canManageProfiles={canManageProfiles}
      />
      <Section
        title="Recent runs"
        description={`The last ${String(data.windowDays)} days.`}
        action={
          <Button variant="link" asChild>
            <Link to={`${base}/activity` as never}>View all</Link>
          </Button>
        }
      >
        {data.runs.length === 0 ? (
          <EmptyState title="No recent runs" />
        ) : (
          <RecordList label="Recent runs">
            {data.runs.slice(0, RECENT_RUNS_SHOWN).map((run) => (
              <RecordRow
                key={run.id}
                status={
                  <StatusPill tone={runTone(run.status)}>{statusLabel(run.status)}</StatusPill>
                }
              >
                <TwoLine
                  primary={run.triggerName}
                  secondary={
                    <>
                      {run.payloadExpiredAt == null
                        ? runSourceLabel(run.source)
                        : "Run payload expired"}
                      {" \u00b7 "}
                      <RelativeTime value={run.receivedAt} />
                    </>
                  }
                />
              </RecordRow>
            ))}
          </RecordList>
        )}
      </Section>
    </>
  );
}

/**
 * The figures a reader checks first. Runs are counted over rolling windows because the server
 * does not know the reader's midnight.
 */
function HomeTiles({ data }: { data: HomeSnapshot }) {
  const enabled = data.triggers.filter((trigger) => trigger.enabled).length;
  return (
    <StatGrid columns={4}>
      <StatTile
        label="Runs, 24 hours"
        value={String(data.runCounts.day.total)}
        detail={runOutcomes(data.runCounts.day)}
      />
      <StatTile
        label={`Runs, ${String(HOME_MONTH_DAYS)} days`}
        value={String(data.runCounts.month.total)}
        detail={runOutcomes(data.runCounts.month)}
      />
      <StatTile
        label="Active triggers"
        value={String(enabled)}
        detail={triggerDetail(data.triggers.length, enabled)}
      />
      <StatTile
        label="Daemons connected"
        value={String(data.daemons.filter(({ presence }) => presence === "connected").length)}
        detail={daemonDetail(data.daemons)}
      />
    </StatGrid>
  );
}

function HomeLoading() {
  return (
    <div role="group" aria-busy="true" aria-label="Loading Home">
      <div className="grid gap-8">
        <StatGrid columns={4}>
          {Array.from({ length: 4 }, (_, position) => (
            <StatTileSkeleton key={position} />
          ))}
        </StatGrid>
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
      </div>
    </div>
  );
}

const PROVIDER_NAMES = { github: "GitHub", slack: "Slack", discord: "Discord", linear: "Linear" };

/**
 * Only what the reader has to act on, each with the one place to act. Nothing here is a state
 * report: a daemon that is offline while nothing depends on it is not a problem.
 */
function NeedsAttention({
  data,
  base,
  profiles,
}: {
  data: HomeSnapshot;
  base: string;
  profiles: ProfileAvailability;
}) {
  const providers = [
    ...new Set(
      data.connections
        .filter(({ needsAuthorization }) => needsAuthorization)
        .map(({ provider }) => provider),
    ),
  ];
  const daemons = daemonAttention(data, profiles);
  return (
    <>
      {providers.map((provider) => {
        const names = data.connections
          .filter((connection) => connection.provider === provider && connection.needsAuthorization)
          .map(({ label }) => label)
          .join(", ");
        return (
          <WarningAlert
            key={provider}
            passive
            standalone
            title={`${PROVIDER_NAMES[provider]} needs authorization`}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={`${base}/connections` as never}>Open connections</Link>
              </Button>
            }
          >
            <p>Review authorization for {names} in Connections.</p>
          </WarningAlert>
        );
      })}
      {daemons === undefined ? null : (
        <WarningAlert
          passive
          standalone
          title={daemons.title}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to={`${base}/daemons` as never}>View daemons</Link>
            </Button>
          }
        >
          <p>{daemons.message}</p>
        </WarningAlert>
      )}
      <DroppedEventNotices data={data} />
    </>
  );
}

/** Work is waiting on a daemon only when something would use one: a trigger or a profile. */
function daemonAttention(
  data: HomeSnapshot,
  profiles: ProfileAvailability,
): { title: string; message: string } | undefined {
  const waiting =
    data.triggers.some(({ enabled }) => enabled) || (typeof profiles === "number" && profiles > 0);
  if (!waiting || data.daemons.length === 0) return undefined;
  const able = data.daemons.filter(({ canExecute }) => canExecute);
  if (able.some(({ presence }) => presence === "connected")) return undefined;
  if (able.length === 0) {
    return {
      title: "No daemon may run agents",
      message:
        "No enrolled daemon may run agents yet. Triggers and sessions cannot start an agent until one is allowed to run Hub automations.",
    };
  }
  const names = able.map(({ slug }) => slug).join(", ");
  return {
    title: "No daemon that may run agents is connected.",
    message: `${names} ${able.length === 1 ? "is" : "are"} not connected. Reconnect a daemon to run work configured for it.`,
  };
}

function ThingsToTry({
  snapshot,
  base,
  profiles,
  canManageProfiles,
}: {
  snapshot: HomeSnapshot;
  base: string;
  profiles: ProfileAvailability;
  canManageProfiles: boolean;
}) {
  const surfaces = useMemo(
    () => thingsToTry(snapshot, profiles, canManageProfiles),
    [snapshot, profiles, canManageProfiles],
  );
  const [selected, setSelected] = useState<TrySurfaceKey>("linear");
  const surface = surfaces.find(({ key }) => key === selected) ?? surfaces[0];
  const options = useMemo(
    () =>
      surfaces.map(({ key, label }) => ({
        value: key,
        label,
        icon: key === "sessions" ? MessagesSquare : <ProviderGlyph provider={key} />,
      })),
    [surfaces],
  );
  if (surface === undefined) return null;
  return (
    <Section>
      <Card
        title="Things to try"
        description="Explore example prompts and see what each surface needs."
      >
        <SegmentedControl
          label="Where to try it"
          value={surface.key}
          options={options}
          onChange={(value) => setSelected(value as TrySurfaceKey)}
        />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 basis-64 wrap-anywhere text-sm text-muted-foreground">
            {surface.where}
          </p>
          {surface.next === undefined ? null : (
            <Button asChild variant="outline" size="sm">
              <Link to={`${base}/${surface.next.path}` as never}>{surface.next.label}</Link>
            </Button>
          )}
        </div>
        {surface.examples.length === 0 ? null : (
          <ul aria-label={`${surface.label} examples`} className="grid gap-4">
            {surface.examples.map((example) => (
              <li key={example.title} className="grid min-w-0 gap-1.5">
                <CopyField
                  prose
                  label={example.title}
                  value={example.prompt}
                  copyLabel={`Copy the prompt: ${example.title}`}
                />
                <p className="text-xs text-muted-foreground">{example.description}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}

function HomeChecklist({
  snapshot,
  base,
  accountId,
  operator,
  profiles,
  canManageProfiles,
  onFinished,
}: {
  snapshot: HomeSnapshot;
  base: string;
  accountId: string;
  operator: boolean;
  profiles: ProfileAvailability;
  canManageProfiles: boolean;
  onFinished: () => void;
}) {
  const { organization } = snapshot;
  const checklist = deriveChecklist(snapshot, profiles);
  const setupReady = canFinishSetup(snapshot);
  const queryClient = useQueryClient();
  const finish = useServerFn(finishHomeSetup);
  const completion = useMutation({
    mutationFn: () => finish({ data: { organizationSlug: organization.slug } }),
    onSettled: async (result) => {
      const queryKey = ["home", organization.id];
      if (result?.status !== "ok") {
        await queryClient.invalidateQueries({ queryKey });
        return;
      }
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueriesData<HomeSnapshot>({ queryKey }, (cached) =>
        cached === undefined
          ? undefined
          : { ...cached, checklistCompletedAt: result.data.completedAt },
      );
      onFinished();
    },
  });
  return (
    <Section>
      {completion.isError || completion.data?.status === "error" ? (
        <FailureAlert
          title="Setup could not be finished"
          error={completion.error ?? completion.data}
          fallback="Try finishing setup again."
          focusOnArrival
        />
      ) : null}
      {setupReady ? (
        <Card
          title={checklist.complete ? "You are all set" : "Organization setup"}
          description={
            operator
              ? "Finishing setup hides Getting started for the whole organization."
              : "An instance operator can finish setup."
          }
          action={
            operator ? (
              <Button
                disabled={completion.isPending}
                aria-busy={completion.isPending}
                onClick={() => completion.mutate()}
              >
                Finish setup
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {!checklist.complete ? (
        <GetStarted
          checklist={checklist}
          snapshot={snapshot}
          base={base}
          accountId={accountId}
          operator={operator}
          profiles={profiles}
          canManageProfiles={canManageProfiles}
        />
      ) : null}
    </Section>
  );
}

function GetStarted({
  checklist,
  snapshot,
  base,
  accountId,
  operator,
  profiles,
  canManageProfiles,
}: {
  checklist: ChecklistState;
  snapshot: HomeSnapshot;
  base: string;
  accountId: string;
  operator: boolean;
  profiles: ProfileAvailability;
  canManageProfiles: boolean;
}) {
  // Minimizing is the member's own choice, so it is remembered for them and nobody else.
  const [open, setOpen] = useMemberFlag(
    memberFlagKey("getting-started-open", snapshot.organization.id, accountId),
    true,
  );
  const progress = `${String(checklist.completed)} of ${String(checklist.steps.length)} done`;
  // The address the reader reached this Hub at is the address their daemon has to be told. Home
  // is a route, so it can be rendered on the server, where there is no window: the command is
  // simply absent from that render and arrives with the client.
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  return (
    <Disclosure
      id="get-started"
      open={open}
      onOpenChange={setOpen}
      title="Getting started"
      description={
        snapshot.sessionStarted === null
          ? "Connect an app and a daemon, create a trigger, and run it."
          : "Connect a daemon, talk to an agent on it, then let events start one."
      }
      status={<StatusPill tone="neutral">{progress}</StatusPill>}
    >
      <div className="grid gap-4">
        <ChecklistProgress
          label="Getting started progress"
          done={checklist.completed}
          total={checklist.steps.length}
        />
        <Checklist label="Getting started">
          {checklist.steps.map((step) => (
            <StepRow
              key={step.key}
              {...stepPresentation(step, snapshot, {
                base,
                operator,
                origin,
                profiles,
                canManageProfiles,
              })}
            />
          ))}
        </Checklist>
      </div>
    </Disclosure>
  );
}

interface StepPresentation {
  title: string;
  hint: ReactNode;
  status: { label: string; tone: StatusTone };
  /** The one next action, when there is one the reader can press. */
  action?: ReactNode;
  /** A command to run somewhere else, when that is the next action. */
  command?: { label: string; value: string };
}

const STEP_STATES: Record<StatusTone, ChecklistItemState> = {
  success: "done",
  neutral: "todo",
  warning: "attention",
  danger: "attention",
};

function StepRow({ title, hint, status, action, command }: StepPresentation) {
  return (
    <ChecklistItem
      state={STEP_STATES[status.tone]}
      stateLabel={status.label}
      title={title}
      hint={hint}
      {...(action === undefined ? {} : { action })}
    >
      {command === undefined ? undefined : (
        <CopyField label={command.label} value={command.value} />
      )}
    </ChecklistItem>
  );
}

const DONE = { label: "Done", tone: "success" } as const;
const TO_DO = { label: "To do", tone: "neutral" } as const;

/** What the page knows that the snapshot does not: where it is, who is reading, and from where. */
interface StepContext {
  base: string;
  operator: boolean;
  profiles: ProfileAvailability;
  canManageProfiles: boolean;
  /** This Hub's address as the browser sees it; absent in a server render. */
  origin: string | undefined;
}

function stepPresentation(
  step: ChecklistStep,
  snapshot: HomeSnapshot,
  context: StepContext,
): StepPresentation {
  if (step.key === "app") return appStep(step.state, snapshot, context.base, context.operator);
  if (step.key === "daemon") return daemonStep(step.state, snapshot, context.origin);
  if (step.key === "trigger") return triggerStep(step.state, snapshot, context.base);
  if (step.key === "profile") return profileStep(step.state, context);
  if (step.key === "session") return sessionStep(step.state, context);
  return runStep(step.state, snapshot, context.base);
}

function profileStep(
  state: Extract<ChecklistStep, { key: "profile" }>["state"],
  { base, profiles, canManageProfiles }: StepContext,
): StepPresentation {
  const title = "Create a session profile";
  if (state === "done" && typeof profiles === "number") {
    return {
      title,
      hint: profileLabel(profiles),
      status: DONE,
    };
  }
  if (state === "checking" || state === "unavailable") {
    const label = state === "checking" ? "Checking profiles" : "Profile availability unknown";
    return { title, hint: label, status: { label, tone: "neutral" } };
  }
  return {
    title,
    hint: canManageProfiles
      ? "A profile is the daemon, folder and agent a session starts from."
      : "Ask an organization admin to create a session profile.",
    status: TO_DO,
    ...(canManageProfiles
      ? {
          action: (
            <Button asChild variant="outline" size="sm">
              <Link to={`${base}/sessions/profiles` as never}>Create a profile</Link>
            </Button>
          ),
        }
      : {}),
  };
}

function profileLabel(count: number): string {
  return count === 1 ? "1 active profile" : `${String(count)} active profiles`;
}

function sessionStep(state: "done" | "pending", { base, profiles }: StepContext): StepPresentation {
  const title = "Start a session";
  if (state === "done") return { title, hint: "You started or joined a session.", status: DONE };
  return {
    title,
    hint: "Choose an active profile and send a first message.",
    status: TO_DO,
    ...(typeof profiles === "number" && profiles > 0
      ? {
          action: (
            <Button asChild variant="outline" size="sm">
              <Link to={`${base}/sessions/new` as never}>New session</Link>
            </Button>
          ),
        }
      : {}),
  };
}

function appStep(
  state: Extract<ChecklistStep, { key: "app" }>["state"],
  snapshot: HomeSnapshot,
  base: string,
  operator: boolean,
): StepPresentation {
  const title = SETUP_STEP_TITLES.app;
  const unauthorized = snapshot.connections.filter(({ needsAuthorization }) => needsAuthorization);
  const names = unauthorized.map(({ label }) => label).join(", ");
  const authorizationHint =
    names === "" ? "" : `${names} ${unauthorized.length === 1 ? "needs" : "need"} authorization.`;
  if (state === "done") {
    const connected = snapshot.connections
      .filter(({ needsAuthorization }) => !needsAuthorization)
      .map(({ label }) => label)
      .join(", ");
    return {
      title,
      hint: authorizationHint === "" ? connected : `${connected} connected. ${authorizationHint}`,
      status: DONE,
    };
  }
  if (state === "setup") {
    return {
      title,
      hint: operator
        ? "This Hub has no Linear, GitHub, Slack, or Discord app yet. Set one up first."
        : "This Hub has no Linear, GitHub, Slack, or Discord app yet. Ask whoever runs it to set one up.",
      status: { label: "Needs setup", tone: "warning" },
      ...(operator
        ? {
            action: (
              <Button asChild variant="outline" size="sm">
                <Link to={"/apps" as never}>Set up apps</Link>
              </Button>
            ),
          }
        : {}),
    };
  }
  return {
    title,
    hint: authorizationHint || "Linear, GitHub, Slack, or Discord: the place events come from.",
    status: TO_DO,
    action: (
      <Button asChild variant="outline" size="sm">
        <Link to={`${base}/connections` as never}>Connect an app</Link>
      </Button>
    ),
  };
}

function daemonStep(
  state: Extract<ChecklistStep, { key: "daemon" }>["state"],
  snapshot: HomeSnapshot,
  origin: string | undefined,
): StepPresentation {
  const title = SETUP_STEP_TITLES.daemon;
  if (state === "done") {
    const able = snapshot.daemons.filter(({ canExecute }) => canExecute);
    const connected = able.filter(({ presence }) => presence === "connected").length;
    return {
      title,
      hint: `${able.map(({ slug }) => slug).join(", ")} \u00b7 ${String(connected)} of ${String(able.length)} connected`,
      status: DONE,
    };
  }
  if (state === "cannotRun") {
    return {
      title,
      hint: "Allow Hub automations on an enrolled daemon by running this command there:",
      status: { label: "Cannot run agents", tone: "warning" },
      command: { label: "Grant command", value: GRANT_EXECUTE_COMMAND },
    };
  }
  return {
    title,
    hint: "Hub runs your triggers on a machine you own. Run this where your code lives, and answer yes to running Hub automations:",
    status: TO_DO,
    ...(origin === undefined
      ? {}
      : { command: { label: "Login command", value: daemonLoginCommand(origin) } }),
  };
}

function triggerStep(
  state: Extract<ChecklistStep, { key: "trigger" }>["state"],
  snapshot: HomeSnapshot,
  base: string,
): StepPresentation {
  const title = SETUP_STEP_TITLES.trigger;
  if (state === "done") {
    return {
      title,
      hint: snapshot.triggers.map(({ name }) => name).join(", "),
      status: DONE,
    };
  }
  return {
    title,
    hint: "Choose an event and configure the work Hub runs when it matches.",
    status: TO_DO,
    action: (
      <Button asChild variant="outline" size="sm">
        <Link to={`${base}/triggers/new` as never}>New trigger</Link>
      </Button>
    ),
  };
}

function runStep(
  state: Extract<ChecklistStep, { key: "run" }>["state"],
  snapshot: HomeSnapshot,
  base: string,
): StepPresentation {
  const title = SETUP_STEP_TITLES.run;
  const latest = snapshot.runs[0];
  if (state === "done" && latest !== undefined) {
    return {
      title,
      hint: (
        <>
          {latest.triggerName} received an event <RelativeTime value={latest.receivedAt} />
        </>
      ),
      status: DONE,
      action: (
        <Button asChild variant="outline" size="sm">
          <Link to={`${base}/activity` as never}>View activity</Link>
        </Button>
      ),
    };
  }
  return { title, hint: runHint(snapshot.triggers), status: TO_DO };
}

/** Suggest an action supported by the enabled events without assuming their filters. */
export function runHint(triggers: HomeSnapshot["triggers"]): string {
  const activeTriggers = triggers.filter(({ enabled }) => enabled);
  if (activeTriggers.length === 0) {
    return triggers.length === 0 ? "Create and enable a trigger first." : "Enable a trigger first.";
  }

  const hints = new Set<string>();
  for (const { event } of activeTriggers) {
    if (event === "manual.run") {
      hints.add(
        "Check the trigger's allowed callers and inputs. Send an event with an API key to POST /api/v1/hooks/{trigger} or POST /api/v1/manual-runs.",
      );
    } else if (event === "schedule.tick") {
      hints.add("Check the trigger's schedule for when it can run.");
    } else {
      hints.add("Send an event that matches an enabled trigger's settings.");
    }
  }
  return [...hints].join(" ");
}

const DROP_NOTICE_TITLES: Record<DropReasonGroup, string> = {
  routing: "Events arrived without a route or matching trigger",
  trigger_filters_rejected: "Trigger filters rejected events",
  configuration_unavailable: "Events arrived while configuration was unavailable",
  unsupported_event: "Linear sent unsupported events",
  other: "Hub dropped events for other reasons",
};

function DroppedEventNotices({ data }: { data: HomeSnapshot }) {
  const capped =
    data.dropped.reduce((total, { count }) => total + count, 0) >= RECENT_DROP_COUNT_LIMIT;
  return DROP_REASON_GROUPS.map((reason) => {
    const group = data.dropped.filter((count) => count.reason === reason);
    if (group.length === 0) return null;
    const total = group.reduce((sum, { count }) => sum + count, 0);
    const sources = group
      .map(({ provider, count }) => `${String(count)} from ${LIST_PROVIDER_LABELS[provider]}`)
      .join(", ");
    return (
      <WarningAlert
        key={reason}
        passive
        standalone
        title={DROP_NOTICE_TITLES[reason]}
        action={
          <Button asChild variant="outline" size="sm">
            <Link
              to="/o/$organizationSlug/activity"
              params={{ organizationSlug: data.organization.slug }}
              search={{ view: "dropped", reason, range: "7d" }}
            >
              View dropped events
            </Link>
          </Button>
        }
      >
        <p>
          {capped ? "At least " : ""}
          {total} {total === 1 ? "event" : "events"} in the last {data.windowDays} days ({sources}).
        </p>
      </WarningAlert>
    );
  });
}

function runSourceLabel(source: string): string {
  if (isEditorEvent(source)) return eventDefinition(source).label;
  // An issue receipt can match either of the Linear issue events.
  if (source === "linear.issue") return "Linear issue event";
  const event = EDITOR_EVENTS.find((id) => eventDefinition(id).receiptSource === source);
  return event === undefined ? source : eventDefinition(event).label;
}

function runOutcomes({ succeeded, failed }: RunTally): string {
  return `${String(succeeded)} succeeded \u00b7 ${String(failed)} failed`;
}

function runTone(status: HomeSnapshot["runs"][number]["status"]): StatusTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}

function triggerDetail(total: number, enabled: number): string {
  if (total === 0) return "None yet";
  const paused = total - enabled;
  return paused === 0 ? "None paused" : `${String(paused)} paused`;
}

function daemonDetail(daemons: HomeSnapshot["daemons"]): string {
  const cannot = daemons.filter(({ canExecute }) => !canExecute).length;
  return `${String(daemons.length)} enrolled${cannot === 0 ? "" : ` \u00b7 ${String(cannot)} cannot run agents`}`;
}
