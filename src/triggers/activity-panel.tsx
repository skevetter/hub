import { getRouteApi } from "@tanstack/react-router";
import { useSnapshotQuery } from "../queries/index.js";
import { useServerFn } from "@tanstack/react-start";
import { DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { useRouteTenant } from "../projects/context.js";
import { Pagination, type PaginationTarget } from "../components/app/pagination.js";
import { activityPageKey, activityPageRequest } from "./activity-query.js";
import { triggerActivityPage } from "./functions.js";
import { ACTIVITY_COLUMNS, TriggerActivityTable } from "./activity-table.js";

const route = getRouteApi("/_shell/o/$organizationSlug/activity/");
const HEADING_ID = "activity-title";
const LIVE_REFRESH_MS = 5_000;
const ACTIVITY_DESCRIPTION = "Agent runs launched by organization triggers.";

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerActivityPage);
  const { cursor } = route.useSearch();
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: activityPageKey(organizationSlug, cursor),
    queryFn: () => load({ data: activityPageRequest(organizationSlug, cursor) }),
    // Only the newest page is live. An older page does not move, and a hidden tab is not polled.
    ...(cursor === undefined ? { refetchInterval: LIVE_REFRESH_MS } : {}),
  });
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
  const { activity, nextCursor, previousCursor } = snapshot.data;
  // The route drops a cursor the server could not use, so a cursor here always has a page behind it.
  const newer = previousCursor === null ? null : pageTarget(organizationSlug, previousCursor);
  const older = nextCursor === null ? null : pageTarget(organizationSlug, nextCursor);
  const count = `${activity.length} ${activity.length === 1 ? "run" : "runs"}`;
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
      <TriggerActivityTable activity={activity} organizationSlug={organizationSlug} />
      {activity.length === 0 ? null : (
        <Pagination
          label="Activity pages"
          position={cursor ?? ""}
          fallbackFocusId={HEADING_ID}
          summary={previousCursor === null ? `Showing the newest ${count}` : `Showing ${count}`}
          newer={newer}
          older={older}
        />
      )}
    </>
  );
}

/** Newer follows the server's reverse cursor, so rows inserted since are not skipped. */
function pageTarget(organizationSlug: string, cursor: string): PaginationTarget {
  return {
    to: "/o/$organizationSlug/activity",
    params: { organizationSlug },
    search: { cursor },
  };
}
