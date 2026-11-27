import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useSnapshotQuery } from "../queries/index.js";
import { runEventsSnapshot } from "./functions.js";
import type { RunEventPage } from "./run-events.js";
import { pollRunDetail, RunEventSubscription } from "./run-event-subscription.js";
import { runReadClock, runReadResult } from "./run-read.js";

export function runDetailKey(organizationSlug: string, runId: string) {
  return ["run-detail", organizationSlug, runId] as const;
}

async function probeStream(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: "text/event-stream" } });
  await response.body?.cancel();
  return response.status;
}

interface UseRunEventsOptions {
  organizationSlug: string;
  runId: string;
  after: number;
  initial: RunEventPage;
  initialSequence: number;
}

export function useRunEvents({
  organizationSlug,
  runId,
  after,
  initial,
  initialSequence,
}: UseRunEventsOptions) {
  const queryClient = useQueryClient();
  const load = useServerFn(runEventsSnapshot);
  const requests = runReadClock(queryClient);
  const refreshDetail = useCallback(() => {
    void queryClient.invalidateQueries(
      { queryKey: runDetailKey(organizationSlug, runId) },
      { cancelRefetch: false },
    );
  }, [queryClient, organizationSlug, runId]);
  const subscription = useRunEventSubscription(
    { organizationSlug, runId, after, initial, initialSequence },
    refreshDetail,
  );
  const state = useSyncExternalStore(
    subscription.subscribe,
    subscription.snapshot,
    subscription.snapshot,
  );
  useEffect(() => subscription.start(), [subscription]);
  useEffect(() => {
    subscription.acceptSnapshot(initial, initialSequence);
  }, [subscription, initial, initialSequence]);
  const polling = state.connection === "Polling";
  const page = useSnapshotQuery({
    queryKey: ["run-events", organizationSlug, runId, state.lastSeq],
    queryFn: async () => {
      const sequence = requests.issue();
      return runReadResult(
        sequence,
        await load({ data: { organizationSlug, runId, after: state.lastSeq } }),
      );
    },
    enabled: polling,
    ...(polling ? { refetchInterval: 5000 } : {}),
  });
  useEffect(() => {
    if (page.status === "success" && page.data.value !== null)
      subscription.acceptPage(page.data.value, page.data.sequence);
  }, [subscription, page.status, page.data]);
  useEffect(() => {
    if (initial.status !== "running") return undefined;
    return pollRunDetail(refreshDetail);
  }, [initial.status, refreshDetail]);
  useEffect(() => {
    if (initial.status === "running" && state.status !== "running") refreshDetail();
  }, [initial.status, state.status, refreshDetail]);
  return state;
}

function useRunEventSubscription(
  { organizationSlug, runId, initial, after, initialSequence }: UseRunEventsOptions,
  refreshDetail: () => void,
) {
  const seed = useRef({ initial, after, initialSequence });
  seed.current = { initial, after, initialSequence };
  return useMemo(
    () =>
      new RunEventSubscription({
        url: `/api/v1/runs/${encodeURIComponent(runId)}/events?organization=${encodeURIComponent(organizationSlug)}`,
        initial: seed.current.initial,
        initialSequence: seed.current.initialSequence,
        after: seed.current.after,
        source: (url) => new EventSource(url),
        probe: probeStream,
        onSeal: refreshDetail,
      }),
    [organizationSlug, runId, refreshDetail],
  );
}
