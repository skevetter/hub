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
import { FigureSkeleton, Figures } from "../components/app/figure.js";
import {
  Checklist,
  ChecklistItem,
  ChecklistProgress,
  type ChecklistItemState,
} from "../components/app/checklist.js";
import { CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { StatusPill, type StatusTone } from "../components/app/status-pill.js";
import { Button } from "../components/ui/button.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { daemonLoginCommand, GRANT_EXECUTE_COMMAND } from "../daemons/handoff.js";
import { listSessionProfiles } from "../interactive-sessions/functions.js";
import { sessionProfileQueryOptions } from "../interactive-sessions/ui/new-session.js";
import { useRouteTenant } from "../projects/context.js";
import {
  canFinishSetup,
  deriveChecklist,
  SETUP_STEP_TITLES,
  type Checklist as ChecklistState,
  type ChecklistStep,
  type ProfileAvailability,
} from "./checklist.js";
import { finishHomeSetup, homeSnapshot, type HomeSnapshot } from "./functions.js";
import { memberFlagKey, useMemberFlag } from "./member-preference.js";
import { HomeOverview } from "./overview.js";
import { thingsToTry, type TrySurface, type TrySurfaceKey } from "./things-to-try.js";

const HOME_HEADING_ID = "home-heading";

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

interface HomeViewProps {
  snapshot: Snapshot<HomeSnapshot> & { refetch: () => void; isFetching: boolean };
  accountId: string;
  operator: boolean;
  profiles: ProfileAvailability;
  canManageProfiles: boolean;
}

function HomeView({ snapshot, ...props }: HomeViewProps) {
  const [focusOnCompletion, setFocusOnCompletion] = useState(false);
  const retryRequested = useRef(false);
  const { isFetching, status } = snapshot;
  useEffect(() => {
    if (!retryRequested.current || isFetching) return;
    retryRequested.current = false;
    if (status === "success") document.getElementById(HOME_HEADING_ID)?.focus();
  }, [isFetching, status]);
  const header = <PageHeader id={HOME_HEADING_ID} title="Home" focusOnMount={focusOnCompletion} />;
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
  return (
    <>
      {header}
      <HomeContent {...props} data={snapshot.data} onFinished={() => setFocusOnCompletion(true)} />
    </>
  );
}

function HomeContent({
  data,
  accountId,
  operator,
  profiles,
  canManageProfiles,
  onFinished,
}: Omit<HomeViewProps, "snapshot"> & {
  data: HomeSnapshot;
  onFinished: () => void;
}) {
  const base = `/o/${data.organization.slug}`;
  return (
    <>
      {data.checklistCompletedAt === null ? (
        <HomeChecklist
          snapshot={data}
          base={base}
          accountId={accountId}
          operator={operator}
          profiles={profiles}
          canManageProfiles={canManageProfiles}
          onFinished={onFinished}
        />
      ) : null}
      <HomeOverview data={data} base={base} />
      <ThingsToTry
        snapshot={data}
        base={base}
        profiles={profiles}
        canManageProfiles={canManageProfiles}
      />
    </>
  );
}

function HomeLoading() {
  return (
    <div role="group" aria-busy="true" aria-label="Loading Home">
      <div className="grid gap-8">
        <Figures label="Loading overview" columns={4}>
          {Array.from({ length: 4 }, (_, position) => (
            <FigureSkeleton key={position} />
          ))}
        </Figures>
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
      </div>
    </div>
  );
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
      <Card title="Things to try">
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
        <TryExamples surface={surface} />
      </Card>
    </Section>
  );
}

function TryExamples({ surface }: { surface: TrySurface }) {
  return surface.examples.length === 0 ? null : (
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
  const completion = useFinishHomeSetup(organization, onFinished);
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
        <FinishSetupCard
          complete={checklist.complete}
          operator={operator}
          completion={completion}
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

function FinishSetupCard({
  complete,
  operator,
  completion,
}: {
  complete: boolean;
  operator: boolean;
  completion: ReturnType<typeof useFinishHomeSetup>;
}) {
  return (
    <Card
      title={complete ? "You are all set" : "Organization setup"}
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
  );
}

function useFinishHomeSetup(organization: HomeSnapshot["organization"], onFinished: () => void) {
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
  return completion;
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
  status: { label: string; tone: StepTone };
  /** The one next action, when there is one the reader can press. */
  action?: ReactNode;
  /** A command to run somewhere else, when that is the next action. */
  command?: { label: string; value: string };
}

type StepTone = Exclude<StatusTone, "live">;

const STEP_STATES: Record<StepTone, ChecklistItemState> = {
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
        <Link to={`${base}/triggers/new/edit` as never}>New trigger</Link>
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
