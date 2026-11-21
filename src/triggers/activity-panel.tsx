import { getRouteApi, Link } from "@tanstack/react-router";
import { useCallback, useMemo, type ChangeEvent } from "react";
import { useSnapshotQuery } from "../queries/index.js";
import { useServerFn } from "@tanstack/react-start";
import { DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { ListFilters, ListFilterSelect } from "../components/app/list-filters.js";
import { DEFAULT_PAGE_SIZE, type PageSize } from "../components/app/page-size.js";
import { PageHeader } from "../components/app/page.js";
import { statusLabel } from "../components/app/status-pill.js";
import { usePageSizePreference } from "../components/app/use-page-size-preference.js";
import { Button } from "../components/ui/button.js";
import { useRouteTenant } from "../projects/context.js";
import { Pagination, type PaginationTarget } from "../components/app/pagination.js";
import {
  ACTIVITY_RANGES,
  ACTIVITY_RANGE_LABELS,
  ACTIVITY_STATUSES,
  activityPageKey,
  activityPageRequest,
  activitySearchSchema,
  type ActivitySearch,
} from "./activity-query.js";
import { triggerActivityPage } from "./functions.js";
import { ACTIVITY_COLUMNS, TriggerActivityTable } from "./activity-table.js";
import { LIST_PROVIDERS, LIST_PROVIDER_LABELS } from "./list-providers.js";

const route = getRouteApi("/_shell/o/$organizationSlug/activity/");
const HEADING_ID = "activity-title";
const LIVE_REFRESH_MS = 5_000;
const ACTIVITY_DESCRIPTION = "Agent runs launched by organization triggers.";
const STATUS_OPTIONS = ACTIVITY_STATUSES.map((value) => ({ value, label: statusLabel(value) }));
const RANGE_OPTIONS = ACTIVITY_RANGES.map((value) => ({
  value,
  label: ACTIVITY_RANGE_LABELS[value],
}));
const PROVIDER_OPTIONS = LIST_PROVIDERS.map((value) => ({
  value,
  label: LIST_PROVIDER_LABELS[value],
}));

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerActivityPage);
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { cursor, size } = search;
  const organizationSlug = tenant.organization.slug;
  const accountId = tenant.account.id;
  const changeSize = useCallback(
    (next: PageSize, replace = false) => {
      void navigate({
        search: (previous) => ({ ...previous, size: next, cursor: undefined }),
        replace,
      });
    },
    [navigate],
  );
  usePageSizePreference(size, accountId, changeSize);
  const sizeControl = useMemo(
    () => ({ value: size ?? DEFAULT_PAGE_SIZE, accountId, onChange: changeSize }),
    [accountId, changeSize, size],
  );
  const changeFilter = useCallback(
    ({ currentTarget: { name, value } }: ChangeEvent<HTMLSelectElement>) => {
      void navigate({
        search: (previous) =>
          activitySearchSchema.parse({
            ...previous,
            [name]: value || undefined,
            cursor: undefined,
          }),
      });
    },
    [navigate],
  );
  const snapshot = useSnapshotQuery({
    queryKey: activityPageKey(organizationSlug, search),
    queryFn: () => load({ data: activityPageRequest(organizationSlug, search) }),
    // Only the newest page is live. An older page does not move, and a hidden tab is not polled.
    ...(cursor === undefined ? { refetchInterval: LIVE_REFRESH_MS } : {}),
  });
  const triggers = snapshot.data?.triggers;
  const triggerOptions = useMemo(
    () => triggers?.map(({ id, name }) => ({ value: id, label: name })) ?? [],
    [triggers],
  );
  const filtered =
    search.status !== undefined ||
    search.provider !== undefined ||
    search.range !== undefined ||
    search.trigger !== undefined;
  const clear = useMemo(() => {
    const to = pageTarget(organizationSlug, { size }, undefined);
    return (
      <Button variant="outline" size="sm" asChild>
        <Link {...to}>Clear filters</Link>
      </Button>
    );
  }, [organizationSlug, size]);
  const empty = useMemo(
    () => (filtered ? { title: "No runs match these filters", action: clear } : undefined),
    [clear, filtered],
  );
  if (snapshot.status === "pending") {
    return (
      <>
        <PageHeader id={HEADING_ID} title="Activity" description={ACTIVITY_DESCRIPTION} />
        <DataTableSkeleton label="Trigger activity" columns={ACTIVITY_COLUMNS} />
      </>
    );
  }
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Activity unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load trigger activity."
      />
    );
  }
  const { activity, nextCursor, previousCursor, startOffset } = snapshot.data;
  const newer =
    previousCursor === null ? null : pageTarget(organizationSlug, search, previousCursor);
  const older = nextCursor === null ? null : pageTarget(organizationSlug, search, nextCursor);
  const summary =
    activity.length === 0 || startOffset === null
      ? `${activity.length} ${activity.length === 1 ? "run" : "runs"}`
      : `${startOffset + 1} to ${startOffset + activity.length}`;
  return (
    <>
      <PageHeader id={HEADING_ID} title="Activity" description={ACTIVITY_DESCRIPTION} />
      {snapshot.refreshFailure === null ? null : (
        <FailureAlert
          title="Activity may be out of date"
          error={snapshot.refreshFailure.message}
          fallback="Hub couldn't refresh trigger activity."
          onRetry={snapshot.refetch}
          standalone
        />
      )}
      <ListFilters>
        <ListFilterSelect
          name="status"
          label="Status"
          allLabel="All statuses"
          options={STATUS_OPTIONS}
          value={search.status}
          onChange={changeFilter}
        />
        <ListFilterSelect
          name="trigger"
          label="Trigger"
          allLabel="All triggers"
          options={triggerOptions}
          value={search.trigger}
          onChange={changeFilter}
        />
        <ListFilterSelect
          name="provider"
          label="Provider"
          allLabel="All providers"
          options={PROVIDER_OPTIONS}
          value={search.provider}
          onChange={changeFilter}
        />
        <ListFilterSelect
          name="range"
          label="Time range"
          allLabel="All time"
          options={RANGE_OPTIONS}
          value={search.range}
          onChange={changeFilter}
        />
        {filtered && activity.length > 0 ? clear : null}
      </ListFilters>
      <TriggerActivityTable activity={activity} organizationSlug={organizationSlug} empty={empty} />
      <Pagination
        label="Activity pages"
        position={cursor ?? ""}
        fallbackFocusId={HEADING_ID}
        summary={summary}
        newer={newer}
        older={older}
        pageSize={sizeControl}
      />
    </>
  );
}

/** Newer follows the server's reverse cursor, so rows inserted since are not skipped. */
function pageTarget(
  organizationSlug: string,
  search: ActivitySearch,
  cursor: string | undefined,
): PaginationTarget {
  return {
    to: "/o/$organizationSlug/activity",
    params: { organizationSlug },
    search: { ...search, cursor },
  };
}
