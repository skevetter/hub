import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { FailureAlert } from "../components/app/failure-alert.js";
import { LoadingLine, Spinner } from "../components/app/loading.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StickyActions } from "../components/app/sticky-actions.js";
import { StatusLine } from "../components/app/status-line.js";
import { SummaryPanel } from "../components/app/summary-panel.js";
import { Button } from "../components/ui/button.js";
import { useSnapshotQuery } from "../queries/index.js";
import { describeTriggerYaml, triggerEventClause } from "./configuration/describe.js";
import { runManualTrigger, triggerEditorSnapshot, type TriggerSnapshot } from "./functions.js";
import { LIST_PROVIDER_LABELS } from "./list-providers.js";
import {
  RunLink,
  TriggerReadRuns,
  triggerReadRunsKey,
  type TriggerReadScope,
} from "./read-runs.js";
import { TriggerInvocation, canInvokeManually } from "./read-invocation.js";

type Trigger = TriggerSnapshot["triggers"][number];
type TriggerState = NonNullable<Parameters<typeof PageHeader>[0]["status"]>;
const NO_EDITOR_SEARCH = {};

export function TriggerReadPanel(scope: TriggerReadScope) {
  const { organizationSlug, triggerId } = scope;
  const load = useServerFn(triggerEditorSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey: ["triggers", organizationSlug, "editor", triggerId],
    queryFn: () => load({ data: scope }),
  });
  if (snapshot.status === "pending") {
    return (
      <>
        <PageHeaderSkeleton />
        <LoadingLine>Loading trigger</LoadingLine>
      </>
    );
  }
  const trigger = snapshot.data?.triggers.find(({ id }) => id === triggerId);
  if (trigger === undefined) {
    return (
      <FailureAlert
        title="Trigger unavailable"
        error={snapshot.error}
        fallback="This trigger no longer exists or is unavailable."
        onRetry={snapshot.refetch}
      />
    );
  }
  return (
    <TriggerReadView
      scope={scope}
      trigger={trigger}
      canManage={snapshot.data?.canManage === true}
    />
  );
}

function TriggerReadView({
  scope,
  trigger,
  canManage,
}: {
  scope: TriggerReadScope;
  trigger: Trigger;
  canManage: boolean;
}) {
  const manual = canInvokeManually(trigger.yaml);
  const state = triggerState(trigger);
  const runner = useManualRun(scope);
  const canRun = manual && state.label === "On";
  const description =
    describeTriggerYaml(trigger.yaml) ??
    `When ${triggerEventClause(trigger.event)}, run the configured action on the configured host.`;
  return (
    <>
      <TriggerReadHeader
        scope={scope}
        title={trigger.name}
        description={description}
        state={state}
        canRun={canRun}
        runner={runner}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <TriggerReadRuns {...scope} />
          <TriggerInvocation
            organizationSlug={scope.organizationSlug}
            triggerName={trigger.name}
            manual={manual}
            enabled={trigger.enabled}
            canManage={canManage}
          />
        </div>
        <TriggerFacts trigger={trigger} />
      </div>
      <StickyActions>
        <RunStatus scope={scope} run={runner.run} />
        <RunNowButton canRun={canRun} runner={runner} className="max-md:h-11" />
      </StickyActions>
    </>
  );
}

type ManualRun = ReturnType<typeof useManualRun>;

function TriggerReadHeader({
  scope,
  title,
  description,
  state,
  canRun,
  runner,
}: {
  scope: TriggerReadScope;
  title: string;
  description: string;
  state: TriggerState;
  canRun: boolean;
  runner: ManualRun;
}) {
  const search =
    useLocation({ select: ({ state: history }) => history.triggerListSearch }) ?? NO_EDITOR_SEARCH;
  return (
    <div>
      <PageHeader title={title} description={description} status={state}>
        <RunNowButton canRun={canRun} runner={runner} className="max-md:hidden" />
        <Button variant="outline" asChild>
          <Link to="/o/$organizationSlug/triggers/$triggerId/edit" params={scope} search={search}>
            Edit
          </Link>
        </Button>
      </PageHeader>
      <div className="max-md:hidden">
        <RunStatus scope={scope} run={runner.run} />
      </div>
    </div>
  );
}

function RunNowButton({
  canRun,
  runner: { run, startRun },
  className,
}: {
  canRun: boolean;
  runner: ManualRun;
  className: string;
}) {
  return (
    <Button
      className={className}
      onClick={startRun}
      disabled={!canRun || run.isPending}
      aria-busy={run.isPending}
    >
      {run.isPending ? <Spinner /> : null}
      Run now
    </Button>
  );
}

function RunStatus({ scope, run }: { scope: TriggerReadScope; run: ManualRun["run"] }) {
  const result = run.data;
  return (
    <StatusLine>
      {result?.status === "ok" ? (
        <>
          Run started.{" "}
          <RunLink organizationSlug={scope.organizationSlug} runId={result.data.runId}>
            View run
          </RunLink>
        </>
      ) : (
        (result?.error.message ?? (run.isError ? "Hub couldn't start this run." : null))
      )}
    </StatusLine>
  );
}

function useManualRun(scope: TriggerReadScope) {
  const start = useServerFn(runManualTrigger);
  const queryClient = useQueryClient();
  // A retry after a failed or uncertain dispatch reuses the key so it cannot start a second run.
  const deliveryKey = useRef<string>(undefined);
  const run = useMutation({
    mutationFn: (key: string) => start({ data: { ...scope, deliveryKey: key } }),
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      deliveryKey.current = undefined;
      await queryClient.invalidateQueries({ queryKey: triggerReadRunsKey(scope) });
    },
  });
  const { mutate } = run;
  const startRun = useCallback(() => {
    deliveryKey.current ??= crypto.randomUUID();
    mutate(deliveryKey.current);
  }, [mutate]);
  return { run, startRun };
}

function triggerState(trigger: Trigger): TriggerState {
  if (!trigger.enabled) return { label: "Off", tone: "neutral" };
  if (trigger.blockers.length > 0 || trigger.draft?.manualNoCallers === true) {
    return { label: "Blocked", tone: "warning" };
  }
  return { label: "On", tone: "success" };
}

function TriggerFacts({ trigger }: { trigger: Trigger }) {
  const rows = triggerFactsRows(trigger);
  return (
    <Section title="Facts">
      <SummaryPanel label="Trigger facts" rows={rows} inline />
    </Section>
  );
}

function triggerFactsRows(trigger: Trigger) {
  const rows = [
    { label: "Trigger ID", value: <span className="font-mono">{trigger.id}</span> },
    { label: "Provider", value: LIST_PROVIDER_LABELS[trigger.provider] },
    { label: "Updated", value: <RelativeTime value={trigger.updatedAt} /> },
  ];
  if (trigger.draft !== null) {
    rows.push(
      { label: "Daemon", value: <span className="font-mono">{trigger.draft.daemon}</span> },
      { label: "Working directory", value: <span className="font-mono">{trigger.draft.cwd}</span> },
    );
  }
  return rows;
}
