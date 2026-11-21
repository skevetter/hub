import { getRouteApi, Link, linkOptions } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useId, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormField } from "../components/app/form-field.js";
import { ClearListFilters, ListFilters, ListFilterSelect } from "../components/app/list-filters.js";
import { LIST_RESULT_ACTION } from "../components/app/list-result-announcement.js";
import { DEFAULT_PAGE_SIZE, type PageSize } from "../components/app/page-size.js";
import { Pagination, type PaginationTarget } from "../components/app/pagination.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { usePageSizePreference } from "../components/app/use-page-size-preference.js";
import { Button } from "../components/ui/button.js";
import type { DroppedEventRow } from "../db/types.js";
import { useRouteTenant } from "../projects/context.js";
import { useSnapshotQuery } from "../queries/index.js";
import {
  ACTIVITY_RANGES,
  ACTIVITY_RANGE_LABELS,
  DROPPED_SOURCE_MAX,
  activitySearchSchema,
  droppedActivityPageKey,
  droppedActivityPageRequest,
  type ActivitySearch,
} from "./activity-query.js";
import {
  DROP_REASON_FILTERS,
  DROP_REASON_LABELS,
  providerEventDropReasonHint,
  providerEventDropReasonSummary,
} from "./drop-reason.js";
import { droppedActivityPage } from "./functions.js";
import { LIST_PROVIDERS, LIST_PROVIDER_LABELS } from "./list-providers.js";

const route = getRouteApi("/_shell/o/$organizationSlug/activity/");
const FILTERS_ID = "dropped-activity-filters";
const LABEL = "Dropped events";
const NO_FILTERED_EVENTS = "No dropped events match these filters";
const PROVIDERS = LIST_PROVIDERS.map((value) => ({ value, label: LIST_PROVIDER_LABELS[value] }));
const RANGES = ACTIVITY_RANGES.map((value) => ({ value, label: ACTIVITY_RANGE_LABELS[value] }));
const REASONS = DROP_REASON_FILTERS.map((value) => ({ value, label: DROP_REASON_LABELS[value] }));
const COLUMNS = [
  { header: "Received", className: "hidden xl:table-cell" },
  { header: "Provider", className: "hidden xl:table-cell" },
  { header: "Source", fill: true, className: "xl:min-w-44" },
  { header: "Workspace or repository", fill: true, className: "hidden xl:table-cell" },
  { header: "Reason", fill: true, className: "hidden xl:table-cell" },
  { header: "What to do", fill: true, className: "hidden xl:table-cell" },
];

export function DroppedActivityPanel({ headingId }: { headingId: string }) {
  const tenant = useRouteTenant();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { cursor, provider, range, reason, size, source } = search;
  const organizationSlug = tenant.organization.slug;
  const accountId = tenant.account.id;
  const load = useServerFn(droppedActivityPage);
  const filtered =
    provider !== undefined || range !== undefined || reason !== undefined || source !== undefined;

  const changeSize = useCallback(
    (next: PageSize, replace = false) => {
      void navigate({
        search: (previous) => ({ ...previous, size: next, cursor: undefined }),
        state: replace ? {} : LIST_RESULT_ACTION,
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
  const setFilter = useCallback(
    (name: string, value: string) => {
      void navigate({
        state: LIST_RESULT_ACTION,
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
  const changeFilter = useCallback(
    ({ currentTarget: { name, value } }: ChangeEvent<HTMLSelectElement>) => setFilter(name, value),
    [setFilter],
  );
  const changeSource = useCallback((value: string) => setFilter("source", value), [setFilter]);
  const snapshot = useSnapshotQuery({
    queryKey: droppedActivityPageKey(organizationSlug, search),
    queryFn: () => load({ data: droppedActivityPageRequest(organizationSlug, search) }),
    ...(cursor === undefined ? { refetchInterval: 5_000 } : {}),
  });
  const clear = useMemo(
    () => (
      <ClearListFilters
        target={pageTarget(organizationSlug, { size }, undefined)}
        focusId={FILTERS_ID}
      />
    ),
    [organizationSlug, size],
  );
  const empty = useMemo(
    () =>
      filtered ? { title: NO_FILTERED_EVENTS, action: clear } : { title: "No dropped events" },
    [clear, filtered],
  );

  if (snapshot.status === "pending") return <DataTableSkeleton label={LABEL} columns={COLUMNS} />;
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Dropped events unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load dropped events."
      />
    );
  }
  const { events, nextCursor, previousCursor, startOffset } = snapshot.data;
  const older = nextCursor === null ? null : pageTarget(organizationSlug, search, nextCursor);
  const newer =
    previousCursor === null ? null : pageTarget(organizationSlug, search, previousCursor);
  const { summary, announcement } = droppedPageFeedback(
    search,
    events.length,
    startOffset,
    filtered,
  );

  return (
    <>
      {snapshot.refreshFailure === null ? null : (
        <FailureAlert
          title="Dropped events may be out of date"
          error={snapshot.refreshFailure.message}
          fallback="Hub couldn't refresh dropped events."
          onRetry={snapshot.refetch}
          standalone
        />
      )}
      <ListFilters id={FILTERS_ID}>
        <ListFilterSelect
          name="provider"
          label="Provider"
          allLabel="All providers"
          options={PROVIDERS}
          value={provider}
          onChange={changeFilter}
        />
        <DroppedSourceFilter key={source ?? ""} source={source} onApply={changeSource} />
        <ListFilterSelect
          name="reason"
          label="Drop reason"
          allLabel="All reasons"
          options={REASONS}
          value={reason}
          onChange={changeFilter}
        />
        <ListFilterSelect
          name="range"
          label="Time range"
          allLabel="All time"
          options={RANGES}
          value={range}
          onChange={changeFilter}
        />
        {filtered && events.length > 0 ? clear : null}
      </ListFilters>
      <DataTable label={LABEL} columns={COLUMNS} empty={empty} isEmpty={events.length === 0}>
        {events.map((event) => (
          <DroppedEvent key={event.id} event={event} organizationSlug={organizationSlug} />
        ))}
      </DataTable>
      <Pagination
        label="Dropped event pages"
        position={cursor ?? ""}
        fallbackFocusId={headingId}
        summary={summary}
        announcement={announcement}
        newer={newer}
        older={older}
        pageSize={sizeControl}
      />
    </>
  );
}

function droppedPageFeedback(
  search: ActivitySearch,
  countOfEvents: number,
  startOffset: number | null,
  filtered: boolean,
) {
  const { size, provider, source, reason, range } = search;
  const count = `${countOfEvents} ${countOfEvents === 1 ? "event" : "events"}`;
  const rows =
    countOfEvents === 0 || startOffset === null
      ? undefined
      : `${startOffset + 1} to ${startOffset + countOfEvents}`;
  const announcement = [
    filtered && countOfEvents === 0 ? NO_FILTERED_EVENTS : count,
    rows === undefined ? undefined : `Rows ${rows}`,
    `Rows per page ${size ?? DEFAULT_PAGE_SIZE}`,
    provider === undefined ? undefined : `Provider ${LIST_PROVIDER_LABELS[provider]}`,
    source === undefined ? undefined : `Source ${source}`,
    reason === undefined ? undefined : `Drop reason ${DROP_REASON_LABELS[reason]}`,
    range === undefined ? undefined : ACTIVITY_RANGE_LABELS[range],
  ]
    .filter((detail) => detail !== undefined)
    .join(". ");

  return { summary: rows ?? count, announcement };
}

function DroppedSourceFilter({
  source,
  onApply,
}: {
  source: string | undefined;
  onApply: (source: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(source ?? "");
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onApply(draft);
    },
    [draft, onApply],
  );
  return (
    <form className="flex min-w-0 items-end gap-2" onSubmit={submit}>
      <FormField
        id={id}
        name="source"
        kind="text"
        label="Source"
        value={draft}
        placeholder="e.g. linear.comment"
        maxLength={DROPPED_SOURCE_MAX}
        onChange={setDraft}
      />
      <Button type="submit" variant="outline">
        Apply
      </Button>
    </form>
  );
}

function DroppedEvent({
  event,
  organizationSlug,
}: {
  event: DroppedEventRow;
  organizationSlug: string;
}) {
  const { source, workspaceOrRepo, reason, provider, receivedAt } = event;
  const summary =
    providerEventDropReasonSummary(reason) ?? "Hub dropped this event for an unrecognized reason.";
  const guidance = <DropGuidance event={event} organizationSlug={organizationSlug} />;
  return (
    <DataRow>
      <DataCell muted>
        <RelativeTime value={receivedAt} />
      </DataCell>
      <DataCell>{LIST_PROVIDER_LABELS[provider]}</DataCell>
      <DataCell>
        <div className="py-1.5 whitespace-normal wrap-anywhere">
          <div className="font-mono text-xs">{source}</div>
          <div className="mt-1 grid gap-1 xl:hidden">
            <p className="text-xs text-muted-foreground">
              {LIST_PROVIDER_LABELS[provider]}
              {workspaceOrRepo === null ? "" : ` \u00b7 ${workspaceOrRepo}`}
              {" \u00b7 "}
              <RelativeTime value={receivedAt} />
            </p>
            <p>{summary}</p>
            {guidance}
          </div>
        </div>
      </DataCell>
      <DataCell muted>
        <p className="whitespace-normal wrap-anywhere">{workspaceOrRepo ?? "Unavailable"}</p>
      </DataCell>
      <DataCell>
        <p className="whitespace-normal wrap-anywhere">{summary}</p>
      </DataCell>
      <DataCell>{guidance}</DataCell>
    </DataRow>
  );
}

function DropGuidance({
  event,
  organizationSlug,
}: {
  event: DroppedEventRow;
  organizationSlug: string;
}) {
  const { text, action } = providerEventDropReasonHint(
    event.reason,
    event.source,
    event.workspaceOrRepo,
  );
  const create = linkOptions({
    to: "/o/$organizationSlug/triggers/$triggerId",
    params: { organizationSlug, triggerId: "new" },
  });
  const connections = linkOptions({
    to: "/o/$organizationSlug/connections",
    params: { organizationSlug },
  });
  return (
    <p className="whitespace-normal wrap-anywhere">
      {text}{" "}
      {action === "create" ? (
        <Link className="text-link hover:underline" {...create}>
          Create one
        </Link>
      ) : null}
      {action === "review" ? (
        <ReviewTriggerLink organizationSlug={organizationSlug} event={event} />
      ) : null}
      {action === "connections" ? (
        <Link className="text-link hover:underline" {...connections}>
          Open connections
        </Link>
      ) : null}
    </p>
  );
}

function ReviewTriggerLink({
  organizationSlug,
  event,
}: {
  organizationSlug: string;
  event: DroppedEventRow;
}) {
  const target =
    event.triggerId === null
      ? linkOptions({
          to: "/o/$organizationSlug/triggers",
          params: { organizationSlug },
          search: { provider: event.provider },
        })
      : linkOptions({
          to: "/o/$organizationSlug/triggers/$triggerId",
          params: { organizationSlug, triggerId: event.triggerId },
        });
  return (
    <Link className="text-link hover:underline" {...target}>
      Review trigger filters
    </Link>
  );
}

function pageTarget(
  organizationSlug: string,
  search: ActivitySearch,
  cursor: string | undefined,
): PaginationTarget {
  return {
    to: "/o/$organizationSlug/activity",
    params: { organizationSlug },
    search: { ...search, view: "dropped", cursor },
  };
}
