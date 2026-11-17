import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useSnapshotQuery } from "../queries/index.js";
import { runEventsSnapshot } from "./functions.js";
import type { RunEventPage } from "./run-events.js";
import { pollRunDetail, RunEventSubscription } from "./run-event-subscription.js";

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
}: {
  organizationSlug: string;
  runId: string;
  after: number;
  initial: RunEventPage;
}) {
  const queryClient = useQueryClient();
  const load = useServerFn(runEventsSnapshot);
  const refreshDetail = useCallback(() => {
    void queryClient.invalidateQueries(
      { queryKey: runDetailKey(organizationSlug, runId) },
      { cancelRefetch: false },
    );
  }, [queryClient, organizationSlug, runId]);
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
        onSeal: refreshDetail,
      }),
    [organizationSlug, runId, refreshDetail],
  );
  const state = useSyncExternalStore(
    subscription.subscribe,
    subscription.snapshot,
    subscription.snapshot,
  );
  useEffect(() => subscription.start(), [subscription]);
  useEffect(() => {
    subscription.acceptSnapshot(initial);
  }, [subscription, initial]);
  const polling = state.connection === "Polling";
  const page = useSnapshotQuery({
    queryKey: ["run-events", organizationSlug, runId, state.lastSeq],
    queryFn: () => load({ data: { organizationSlug, runId, after: state.lastSeq } }),
    enabled: polling,
    ...(polling ? { refetchInterval: 5000 } : {}),
  });
  useEffect(() => {
    if (page.status === "success" && page.data !== null) subscription.acceptPage(page.data);
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
