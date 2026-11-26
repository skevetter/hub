import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState } from "react";
import { useActiveAccount } from "../../auth/active-account.js";
import {
  DataCell,
  DataRow,
  DataTable,
  DataTableSkeleton,
} from "../../components/app/data-table.js";
import { FailureAlert } from "../../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../../components/app/page.js";
import { RelativeTime } from "../../components/app/relative-time.js";
import { Section } from "../../components/app/section.js";
import { SegmentedControl } from "../../components/app/segmented-control.js";
import { StateBlock } from "../../components/app/state-block.js";
import { TwoLine } from "../../components/app/two-line.js";
import { Button } from "../../components/ui/button.js";
import { useRouteTenant } from "../../projects/context.js";
import { listInteractiveSessions, type SessionListPage } from "../functions.js";
import {
  NewSessionLink,
  SessionLoadFailure,
  SessionsUnavailable,
  refusalMessage,
  sessionStatus,
} from "./session-states.js";

const COLUMNS = [
  { header: "State", lead: true },
  { header: "Session", fill: true },
  { header: "Last activity", className: "hidden md:table-cell" },
];
const FILTERS = [
  { value: "active", label: "Active" },
  { value: "all", label: "All" },
];

type SessionListResult = Awaited<ReturnType<typeof listInteractiveSessions>>;

export function SessionListLoading() {
  return (
    <div aria-busy="true" aria-label="Loading sessions">
      <PageHeaderSkeleton />
      <DataTableSkeleton label="Sessions" columns={COLUMNS} />
    </div>
  );
}

export function SessionListPanel({
  organizationSlug,
  filter,
  result,
}: {
  organizationSlug: string;
  filter: "active" | "all";
  result: SessionListResult;
}) {
  const navigate = useNavigate();
  const account = useActiveAccount();
  const tenant = useRouteTenant();
  const params = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  const changeFilter = useCallback(
    (value: string) => {
      void navigate({
        to: "/o/$organizationSlug/sessions",
        params: { organizationSlug },
        search: value === "all" ? { filter: "all" } : {},
      });
    },
    [navigate, organizationSlug],
  );

  if (result.status === "ok" && "outcome" in result.data && result.data.code === "not_found")
    return <SessionsUnavailable />;
  // The empty state carries the one New session action; a second filled button would compete.
  const hasRows = hasSessionRows(result);
  return (
    <>
      <PageHeader title="Sessions">
        {account.features?.interactiveSessions === true && tenant.capabilities.manageResources ? (
          <Button asChild variant="outline">
            <Link to="/o/$organizationSlug/sessions/profiles" params={params}>
              Profiles
            </Link>
          </Button>
        ) : null}
        {hasRows ? <NewSessionLink organizationSlug={organizationSlug} /> : null}
      </PageHeader>
      <Section>
        <SegmentedControl
          label="Session state"
          value={filter}
          options={FILTERS}
          onChange={changeFilter}
        />
        {result.status === "error" || "outcome" in result.data ? (
          <SessionLoadFailure title="Sessions unavailable" error={result} />
        ) : (
          <SessionTable organizationSlug={organizationSlug} filter={filter} first={result.data} />
        )}
      </Section>
    </>
  );
}

function hasSessionRows(result: SessionListResult) {
  return result.status === "ok" && !("outcome" in result.data) && result.data.sessions.length > 0;
}

function SessionTable({
  organizationSlug,
  filter,
  first,
}: {
  organizationSlug: string;
  filter: "active" | "all";
  first: SessionListPage;
}) {
  const load = useServerFn(listInteractiveSessions);
  const [pages, setPages] = useState<SessionListPage[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const next = (pages.at(-1) ?? first).nextCursor;
  const rows = [
    ...new Map(
      [first, ...pages].flatMap((page) => page.sessions).map((session) => [session.id, session]),
    ).values(),
  ];

  const more = useCallback(async () => {
    if (next === null || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await load({ data: { organizationSlug, filter, cursor: next } });
      if (result.status === "error") setError(result.error.message);
      else if ("outcome" in result.data) setError(refusalMessage(result.data.code));
      else {
        const page = result.data;
        setPages((previous) => [...previous, page]);
      }
    } catch {
      setError("Could not load more sessions.");
    } finally {
      setBusy(false);
    }
  }, [busy, filter, load, next, organizationSlug]);

  const loadMore = useCallback(() => void more(), [more]);
  const empty = useMemo(
    () => ({
      title: "No sessions yet",
      description:
        "A session is a live conversation with an agent on one of your daemons, started from a session profile.",
      action: <NewSessionLink organizationSlug={organizationSlug} />,
    }),
    [organizationSlug],
  );

  return (
    <>
      <DataTable label="Sessions" columns={COLUMNS} isEmpty={rows.length === 0} empty={empty}>
        {rows.map((session) => (
          <SessionRow key={session.id} organizationSlug={organizationSlug} session={session} />
        ))}
      </DataTable>
      <SessionPagination error={error} next={next} busy={busy} loadMore={loadMore} />
    </>
  );
}

function SessionPagination({
  error,
  next,
  busy,
  loadMore,
}: {
  error: string | undefined;
  next: SessionListPage["nextCursor"];
  busy: boolean;
  loadMore: () => void;
}) {
  return (
    <>
      {error === undefined ? null : (
        <FailureAlert title="Could not load more sessions" error={error} fallback="Try again." />
      )}
      {next === null ? null : (
        <div>
          <Button type="button" variant="outline" onClick={loadMore} disabled={busy}>
            {busy ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}

function SessionRow({
  organizationSlug,
  session,
}: {
  organizationSlug: string;
  session: SessionListPage["sessions"][number];
}) {
  const navigate = useNavigate();
  const sessionId = session.id;
  const open = useCallback(() => {
    void navigate({
      to: "/o/$organizationSlug/sessions/$sessionId",
      params: { organizationSlug, sessionId },
    });
  }, [navigate, organizationSlug, sessionId]);
  const params = useMemo(() => ({ organizationSlug, sessionId }), [organizationSlug, sessionId]);
  const title = useMemo(
    () => (
      <Link to="/o/$organizationSlug/sessions/$sessionId" params={params} title={session.title}>
        {session.title}
      </Link>
    ),
    [params, session.title],
  );
  const status = sessionStatus(session);
  const byline =
    session.startedBy === null || session.startedBy === undefined
      ? `On ${session.daemon.slug}`
      : `${session.startedBy.name} on ${session.daemon.slug}`;
  return (
    <DataRow onSelect={open}>
      <DataCell>
        <StateBlock state={status} />
      </DataCell>
      <DataCell>
        <TwoLine primary={title} secondary={byline} />
      </DataCell>
      <DataCell muted>
        <RelativeTime value={session.lastActivityAt} />
      </DataCell>
    </DataRow>
  );
}
