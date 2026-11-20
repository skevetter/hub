import { getRouteApi } from "@tanstack/react-router";
import { useSnapshotQuery } from "../queries/index.js";
import { useServerFn } from "@tanstack/react-start";
import { DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { useRouteTenant } from "../projects/context.js";
import { Pagination, type PaginationTarget } from "../components/app/pagination.js";
import { ACTIVITY_PAGE_SIZE } from "./activity-cursor.js";
import { triggerActivityPage } from "./functions.js";
import { ACTIVITY_COLUMNS, TriggerActivityTable } from "./activity-table.js";

const route = getRouteApi("/_shell/o/$organizationSlug/activity/");
const ACTIVITY_DESCRIPTION = "Agent runs launched by organization triggers.";

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerActivityPage);
  const { cursor, page } = route.useSearch();
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: ["activity", organizationSlug, cursor ?? null],
    queryFn: () =>
      load({
        data: {
          organizationSlug,
          limit: ACTIVITY_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
      }),
    refetchInterval: 5_000,
  });
  if (snapshot.status === "pending") {
    return (
      <>
        <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
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
  // The server falls back to the newest page when a cursor is stale, so the label follows it.
  const current = previousCursor === null ? 1 : (page ?? 2);
  const first = (current - 1) * ACTIVITY_PAGE_SIZE + 1;
  const newer =
    previousCursor === null ? null : pageTarget(organizationSlug, current - 1, previousCursor);
  const older = nextCursor === null ? null : pageTarget(organizationSlug, current + 1, nextCursor);
  return (
    <>
      <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
      <TriggerActivityTable activity={activity} organizationSlug={organizationSlug} />
      {activity.length === 0 ? null : (
        <Pagination
          label="Activity pages"
          range={`${first} to ${first + activity.length - 1}`}
          newer={newer}
          older={older}
        />
      )}
    </>
  );
}

/** The first page is the bare address, so Newer back to it leaves no cursor behind. */
function pageTarget(organizationSlug: string, page: number, cursor: string): PaginationTarget {
  return {
    to: "/o/$organizationSlug/activity",
    params: { organizationSlug },
    search: page > 1 ? { cursor, page } : {},
  };
}
