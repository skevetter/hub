import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useSnapshotQuery } from "../queries/index.js";
import { runEventsSnapshot } from "./functions.js";
import type { RunEventPage } from "./run-events.js";
import { pollOmittedSteps, RunEventSubscription } from "./run-event-subscription.js";

export function runDetailKey(organizationSlug: string, runId: string) {
  return ["run-detail", organizationSlug, runId] as const;
}

async function probeStream(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: "text/event-stream" } });
  await response.body?.cancel();
  return response.status;
}

export function useRunEvents({
  organizationSlug,
  runId,
  after,
  initial,
  stepCount,
}: {
  organizationSlug: string;
  runId: string;
  after: number;
  initial: RunEventPage;
  stepCount: number;
}) {
  const queryClient = useQueryClient();
  const load = useServerFn(runEventsSnapshot);
  const seed = useRef({ initial, after });
  seed.current = { initial, after };
  const subscription = useMemo(
    () =>
      new RunEventSubscription({
        url: `/api/v1/runs/${encodeURIComponent(runId)}/events?organization=${encodeURIComponent(organizationSlug)}`,
        initial: seed.current.initial,
        after: seed.current.after,
        source: (url) => new EventSource(url),
        probe: probeStream,
        onSeal: () => {
          void queryClient.invalidateQueries({ queryKey: runDetailKey(organizationSlug, runId) });
        },
      }),
    [organizationSlug, runId, queryClient],
  );
  const state = useSyncExternalStore(
    subscription.subscribe,
    subscription.snapshot,
    subscription.snapshot,
  );
  useEffect(() => subscription.start(), [subscription]);
  useEffect(() => {
    subscription.acceptPage(initial);
  }, [subscription, initial]);
  const polling = state.connection === "Polling";
  const page = useSnapshotQuery({
    queryKey: ["run-events", organizationSlug, runId, state.lastSeq],
    queryFn: () => load({ data: { organizationSlug, runId, after: state.lastSeq } }),
    enabled: polling,
    ...(polling ? { refetchInterval: 5000 } : {}),
  });
  useEffect(() => {
    if (polling && page.status === "success" && page.data !== null)
      subscription.acceptPage(page.data);
  }, [subscription, polling, page.status, page.data]);
  useEffect(() => {
    if (state.status !== "running" || (state.stepRowsOmitted === 0 && stepCount <= 100))
      return undefined;
    return pollOmittedSteps(() => {
      void queryClient.invalidateQueries({ queryKey: runDetailKey(organizationSlug, runId) });
    });
  }, [queryClient, organizationSlug, runId, state.status, state.stepRowsOmitted, stepCount]);
  return state;
}
