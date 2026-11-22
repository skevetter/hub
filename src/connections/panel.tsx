import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useActiveAccount } from "../auth/active-account.js";
import { CONNECTION_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { Card, CardSkeleton } from "../components/app/card.js";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RowActions } from "../components/app/row-actions.js";
import { Section } from "../components/app/section.js";
import { StatusLine } from "../components/app/status-line.js";
import { StatusPill } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import type { Result } from "../contract/respond.js";
import { useRouteTenant } from "../projects/context.js";
import {
  CommandError,
  invalidateOrganization,
  useOrganizationSnapshot,
  type OrganizationSnapshot,
} from "../projects/panel-state.js";
import { useSnapshotQuery } from "../queries/index.js";
import {
  connectionStatus,
  disconnectConnection,
  startConnection,
  type ConnectionDisconnectResult,
} from "./functions.js";
import { ProviderGlyph } from "./provider-glyph.js";
import {
  connectionProviderName,
  connectionReturnCopy,
  type ConnectionProvider,
  type ConnectionReturn,
  type ConnectionReturnCopy,
} from "./result-contract.js";
import { useConnectionReturn } from "./result.js";
import type { ProviderConnectionStatus } from "./status.js";

const GRID_COLUMNS = "sm:grid-cols-2";
const ACCESS_FORMAT = new Intl.ListFormat("en");

function providerCard(provider: ConnectionProvider, description: string) {
  return {
    provider,
    label: connectionProviderName(provider),
    icon: <ProviderGlyph provider={provider} />,
    description,
    droppedSearch: { view: "dropped", range: "7d", provider } as const,
  };
}

const PROVIDER_CARDS = [
  providerCard(
    "linear",
    "Hub can start triggers when Linear issues are assigned, match a rule or get a comment.",
  ),
  providerCard(
    "github",
    "Issues, pull requests and comments can start triggers, and Hub can reply on GitHub.",
  ),
  providerCard("slack", "App mentions can start triggers, and Hub can reply in Slack threads."),
  providerCard("discord", "Bot mentions can start triggers, and Hub can reply in Discord."),
];

type ProviderStatus = ProviderConnectionStatus["status"];

const UPDATING = <StatusPill tone="neutral">Updating</StatusPill>;
const NOT_SET_UP = <StatusPill tone="neutral">Not set up</StatusPill>;
const NEEDS_AUTHORIZATION = <StatusPill tone="warning">Needs authorization</StatusPill>;
const STATE_PILLS: Record<ProviderStatus, ReactNode> = {
  connected: <StatusPill tone="success">Connected</StatusPill>,
  notConfigured: NOT_SET_UP,
  disconnected: NOT_SET_UP,
  requiresReauthorization: NEEDS_AUTHORIZATION,
  suspended: NEEDS_AUTHORIZATION,
};
const ACTION_VERBS = {
  connected: "Connect",
  disconnected: "Connect",
  requiresReauthorization: "Reauthorize",
  suspended: "Reconnect",
};

function ConnectionsLoading() {
  return (
    <Section className={GRID_COLUMNS}>
      {PROVIDER_CARDS.map(({ provider }) => (
        <CardSkeleton key={provider} />
      ))}
    </Section>
  );
}

export function OrganizationConnectionsPanel() {
  const { account, organization } = useRouteTenant();
  return (
    <>
      <PageHeader
        title="Connections"
        description="These services let Hub receive events and post replies for your organization."
      />
      <ConnectionsContent key={JSON.stringify([account.id, organization.id])} />
    </>
  );
}

function ConnectionsContent() {
  const tenant = useRouteTenant();
  const { isInstanceOperator } = useActiveAccount();
  const queryClient = useQueryClient();
  const organizationSlug = tenant.organization.slug;
  const scope = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  const loading = <ConnectionsLoading />;
  const snapshot = useOrganizationSnapshot();
  const loadStatus = useServerFn(connectionStatus);
  const statusKey = useMemo(
    () => ["connection-status", tenant.account.id, tenant.organization.id],
    [tenant.account.id, tenant.organization.id],
  );
  const statusQuery = useSnapshotQuery({
    queryKey: statusKey,
    queryFn: () => loadStatus({ data: scope }),
  });
  const [returned, setReturned] = useConnectionReturn();
  const [retryState, setRetryState] = useState<"idle" | "pending" | "complete">("idle");
  const connect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(startConnection),
  });
  const { disconnect, revocation, snapshotProgress, statusProgress, resetRevocation } =
    useConnectionRevocation(scope, snapshot.queryKey, statusKey);
  const refresh = refreshProgress(revocation, snapshotProgress, statusProgress, [
    snapshot.data,
    statusQuery.data,
  ]);
  const start = connect.mutate;
  const revoke = disconnect.mutate;
  const connectProvider = useCallback(
    (provider: ConnectionProvider) => {
      start(
        { data: { ...scope, provider } },
        {
          onSuccess: (response) => {
            if (response.status === "ok") window.location.assign(response.data.url);
          },
        },
      );
    },
    [scope, start],
  );
  const revokeConnection = useCallback(
    (provider: ConnectionProvider, row: ConnectionRecord) => {
      setRetryState("idle");
      setReturned(undefined);
      resetRevocation();
      revoke({ data: { ...scope, provider, connectionId: row.id }, row });
    },
    [resetRevocation, revoke, scope, setReturned],
  );
  const mutations = useMemo(
    () => [
      { data: connect.data, isError: connect.isError },
      { data: disconnect.data, isError: disconnect.isError },
    ],
    [connect.data, connect.isError, disconnect.data, disconnect.isError],
  );
  const retry = useCallback(() => {
    setRetryState("pending");
    void Promise.all([
      queryClient.refetchQueries({ queryKey: snapshot.queryKey, exact: true }),
      queryClient.refetchQueries({ queryKey: statusKey, exact: true }),
    ]).then(() => setRetryState("complete"));
  }, [queryClient, snapshot.queryKey, statusKey]);
  if (retryState === "pending") {
    return (
      <>
        <StatusLine>{null}</StatusLine>
        {loading}
      </>
    );
  }

  const failure = connectionReadFailure(snapshot, statusQuery, refresh);
  if (failure !== undefined) {
    return (
      <FailureAlert
        title={failure.title}
        error={failure.message}
        fallback={`${failure.title}.`}
        passive={retryState === "idle" && revocation === undefined}
        onRetry={retry}
      />
    );
  }
  if (snapshot.status !== "success" || statusQuery.status !== "success") return loading;

  const data = snapshot.data;
  const canManage = data.capabilities.manageResources;
  const pending = pendingRemoval(disconnect, refresh);
  const busy = connect.isPending || disconnect.isPending || pending !== undefined;
  const connections = connectionRows(data.connections, pending?.data, pending?.row);
  const suspendedGitHub = data.connections.github.some(({ status }) => status === "suspended");
  const result = reconciledRevocation(connections, revocation, refresh);
  const banner = revokeBannerCopy(result, returned, connections);
  return (
    <>
      {retryState === "complete" && result === undefined ? (
        <StatusLine>Connections loaded.</StatusLine>
      ) : null}
      {banner === undefined ? null : <ConnectionReturnBanner copy={banner} />}
      <CommandError mutations={mutations} />
      <Section className={GRID_COLUMNS}>
        {PROVIDER_CARDS.map(({ provider, label, icon, description, droppedSearch }) => {
          const reported = statusQuery.data[provider].status;
          const status =
            provider === "github" && reported !== "notConfigured" && suspendedGitHub
              ? "suspended"
              : reported;
          const updating = refresh === "pending" && revocation?.provider === provider;
          const removingId =
            pending?.data.provider === provider ? pending.data.connectionId : undefined;
          const dropped = data.droppedConnectionEvents[provider];
          return (
            <Card
              key={provider}
              label={label}
              icon={icon}
              title={label}
              description={description}
              status={updating ? UPDATING : STATE_PILLS[status]}
            >
              {connections[provider].length > 0 ? (
                <ProviderConnections
                  label={label}
                  provider={provider}
                  connections={connections[provider]}
                  removingId={removingId}
                  canManage={canManage}
                  busy={busy}
                  onRevoke={revokeConnection}
                />
              ) : null}
              {provider === "linear" &&
              dropped === "some" &&
              canManage &&
              connections.linear.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Linear events dropped because no route matched stay dropped after reconnecting.
                </p>
              ) : null}
              {dropped !== "none" ? (
                <div>
                  <Link
                    className="text-link underline underline-offset-2"
                    to="/o/$organizationSlug/activity"
                    params={scope}
                    search={droppedSearch}
                  >
                    {dropped === "some"
                      ? "Dropped events in the last 7 days"
                      : "Check dropped events in Activity"}
                  </Link>
                </div>
              ) : null}
              {updating ? null : (
                <ConnectionHint
                  label={label}
                  status={status}
                  canManage={canManage}
                  isInstanceOperator={isInstanceOperator}
                />
              )}
              {canManage ? (
                <ConnectionAction
                  label={label}
                  provider={provider}
                  status={updating ? "disconnected" : status}
                  isInstanceOperator={isInstanceOperator}
                  busy={busy}
                  onConnect={connectProvider}
                />
              ) : null}
            </Card>
          );
        })}
      </Section>
    </>
  );
}

type ConnectionRead = Pick<
  ReturnType<typeof useOrganizationSnapshot>,
  "status" | "error" | "refreshFailure"
>;

function connectionReadFailure(
  snapshot: ConnectionRead,
  status: ConnectionRead,
  refresh: RevocationRefresh,
) {
  if (refresh === "paused") {
    return {
      title: "Connections unavailable",
      message: "Reconnect to the network and try again.",
    };
  }
  const failure = (read: ConnectionRead) =>
    read.status === "error" ? { message: read.error } : read.refreshFailure;
  const snapshotFailure = failure(snapshot);
  if (snapshotFailure != null) return { title: "Organization unavailable", ...snapshotFailure };
  const statusFailure = failure(status);
  if (statusFailure != null) return { title: "Connections unavailable", ...statusFailure };
  return undefined;
}

interface ConnectionIdentity {
  provider: ConnectionProvider;
  connectionId: string;
}

interface RevokeInput {
  data: Parameters<typeof disconnectConnection>[0]["data"];
  row: ConnectionRecord;
}

interface Revocation extends ConnectionIdentity {
  row: ConnectionRecord;
  result: ConnectionDisconnectResult;
  snapshotVersion: number;
  statusVersion: number;
}

type RevocationRefresh = "idle" | "pending" | "paused" | "fresh";

function useConnectionRevocation(
  scope: { organizationSlug: string },
  snapshotKey: QueryKey,
  statusKey: QueryKey,
) {
  const queryClient = useQueryClient();
  const snapshot = useReadProgress(queryClient, snapshotKey);
  const status = useReadProgress(queryClient, statusKey);
  const [revocation, setRevocation] = useState<Revocation>();
  const resetRevocation = useCallback(() => setRevocation(undefined), []);
  const sendDisconnect = useServerFn(disconnectConnection) as (
    input: Parameters<typeof disconnectConnection>[0],
  ) => Promise<Result<{ result: ConnectionDisconnectResult }>>;
  const disconnect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: ({ data }: RevokeInput) => sendDisconnect({ data }),
    onSuccess: async (response, { data, row }) => {
      if (response.status !== "ok") return;
      setRevocation({
        provider: data.provider,
        connectionId: data.connectionId,
        row,
        result: response.data.result,
        snapshotVersion: queryClient.getQueryState(snapshotKey)?.dataUpdateCount ?? 0,
        statusVersion: queryClient.getQueryState(statusKey)?.dataUpdateCount ?? 0,
      });
      await Promise.all([
        invalidateOrganization(queryClient, scope.organizationSlug),
        queryClient.invalidateQueries({ queryKey: statusKey, exact: true }),
      ]);
    },
  });
  return {
    disconnect,
    revocation,
    snapshotProgress: snapshot,
    statusProgress: status,
    resetRevocation,
  };
}

function useReadProgress(queryClient: QueryClient, queryKey: QueryKey) {
  const read = useCallback(() => queryClient.getQueryState(queryKey), [queryClient, queryKey]);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, read, read);
}

type ReadProgress = ReturnType<typeof useReadProgress>;

function refreshProgress(
  revocation: Revocation | undefined,
  snapshot: ReadProgress,
  status: ReadProgress,
  [snapshotData, statusData]: [unknown, unknown],
): RevocationRefresh {
  if (revocation === undefined) return "idle";
  if (
    readIsFresh(snapshot, revocation.snapshotVersion, snapshotData) &&
    readIsFresh(status, revocation.statusVersion, statusData)
  ) {
    return "fresh";
  }
  if (snapshot?.fetchStatus === "paused" || status?.fetchStatus === "paused") return "paused";
  return "pending";
}

function readIsFresh(read: ReadProgress, version: number, displayed: unknown) {
  // The cache can update before the snapshot observer passes the new data to the panel.
  return read !== undefined && read.dataUpdateCount > version && read.data === displayed;
}

function pendingRemoval(
  disconnect: ReturnType<typeof useConnectionRevocation>["disconnect"],
  refresh: RevocationRefresh,
) {
  if (refresh === "pending" || (refresh === "idle" && disconnect.isPending)) {
    return disconnect.variables;
  }
  return undefined;
}

function reconciledRevocation(
  connections: Record<ConnectionProvider, ConnectionRecord[]>,
  revocation: Revocation | undefined,
  refresh: RevocationRefresh,
) {
  if (revocation === undefined || refresh !== "fresh") return undefined;
  if (connections[revocation.provider].some(({ id }) => id === revocation.connectionId))
    return undefined;
  return revocation;
}

function revokeBannerCopy(
  result: Revocation | undefined,
  returned: ConnectionReturn | undefined,
  connections: Record<ConnectionProvider, ConnectionRecord[]>,
): ConnectionReturnCopy | undefined {
  if (result !== undefined && connections[result.provider].length > 0) {
    return { tone: "success", message: `${result.row.name} disconnected.` };
  }
  const outcome = result ?? returned;
  return outcome === undefined ? undefined : connectionReturnCopy(outcome);
}

/** A card with no action still says what has to happen before there is one. */
function ConnectionHint({
  label,
  status,
  canManage,
  isInstanceOperator,
}: {
  label: string;
  status: ProviderStatus;
  canManage: boolean;
  isInstanceOperator: boolean;
}) {
  if (status === "notConfigured") {
    return (
      <p className="text-sm text-muted-foreground">
        This Hub has no {label} app yet.
        {isInstanceOperator ? null : " An instance operator sets one up before anyone can connect."}
      </p>
    );
  }
  if (canManage || status === "connected") return null;
  return (
    <p className="text-sm text-muted-foreground">
      {status === "disconnected"
        ? `Someone who manages this organization can connect ${label}.`
        : `Someone who manages this organization must ${ACTION_VERBS[status].toLowerCase()} ${label}.`}
    </p>
  );
}

function ConnectionAction({
  label,
  provider,
  status,
  isInstanceOperator,
  busy,
  onConnect,
}: {
  label: string;
  provider: ConnectionProvider;
  status: ProviderStatus;
  isInstanceOperator: boolean;
  busy: boolean;
  onConnect: (provider: ConnectionProvider) => void;
}) {
  const handleConnect = useCallback(() => onConnect(provider), [onConnect, provider]);
  if (status === "notConfigured") {
    if (!isInstanceOperator) return null;
    return (
      <div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/apps">Set up the {label} app</Link>
        </Button>
      </div>
    );
  }
  return (
    <div>
      <Button disabled={busy} variant="outline" size="sm" onClick={handleConnect}>
        {ACTION_VERBS[status]} {label}
      </Button>
    </div>
  );
}

interface ConnectionRecord {
  id: string;
  name: string;
  externalId: string;
  grantedAccess?: readonly string[];
  attention?: string | undefined;
}

function ProviderConnections({
  label,
  provider,
  connections,
  removingId,
  canManage,
  busy,
  onRevoke,
}: {
  label: string;
  provider: ConnectionProvider;
  connections: readonly ConnectionRecord[];
  removingId: string | undefined;
  canManage: boolean;
  busy: boolean;
  onRevoke: (provider: ConnectionProvider, row: ConnectionRecord) => void;
}) {
  return (
    <RecordList label={`${label} connections`}>
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          connection={connection}
          provider={provider}
          canManage={canManage}
          busy={busy}
          removing={connection.id === removingId}
          onRevoke={onRevoke}
        />
      ))}
    </RecordList>
  );
}

function ConnectionRow({
  connection,
  provider,
  canManage,
  busy,
  removing,
  onRevoke,
}: {
  connection: ConnectionRecord;
  provider: ConnectionProvider;
  canManage: boolean;
  busy: boolean;
  removing: boolean;
  onRevoke: (provider: ConnectionProvider, row: ConnectionRecord) => void;
}) {
  const { name, externalId, grantedAccess } = connection;
  const detail = removing ? "Being removed" : connection.attention;
  const confirmRevoke = useCallback(
    () => onRevoke(provider, connection),
    [onRevoke, provider, connection],
  );
  const actions = useMemo(
    () =>
      canManage && !removing ? (
        <RowActions label={`Actions for ${name}`}>
          <ConfirmMenuItem
            busy={busy}
            destructive
            label="Revoke"
            title={`Revoke ${name}?`}
            description="Projects using this credential will stop receiving new events."
            confirmLabel="Revoke connection"
            cancelLabel="Cancel"
            onConfirm={confirmRevoke}
          />
        </RowActions>
      ) : undefined,
    [busy, canManage, confirmRevoke, name, removing],
  );
  return (
    <RecordRow actions={actions} busy={removing}>
      <TwoLine primary={name} secondary={externalId} mono />
      {detail === undefined ? null : <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
      {grantedAccess !== undefined && grantedAccess.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Granted permission to {ACCESS_FORMAT.format(grantedAccess)}.
        </p>
      ) : null}
    </RecordRow>
  );
}

function connectionRows(
  connections: OrganizationSnapshot["connections"],
  pending?: ConnectionIdentity,
  removing?: ConnectionRecord,
): Record<ConnectionProvider, ConnectionRecord[]> {
  const rows: Record<ConnectionProvider, ConnectionRecord[]> = {
    linear: connections.linear.map((connection) => ({
      id: connection.id,
      name: connection.linearOrganizationName,
      externalId: `workspace ${connection.linearOrganizationId}`,
      grantedAccess: connection.grantedAccess,
      attention: connection.requiresReauthorization ? "Workspace needs authorization" : undefined,
    })),
    github: connections.github.map((connection) => ({
      id: connection.id,
      name: connection.accountLogin,
      externalId: `installation ${connection.installationId}`,
      attention: connection.status === "suspended" ? "Suspended on GitHub" : undefined,
    })),
    slack: connections.slack.map((connection) => ({
      id: connection.id,
      name: connection.teamName,
      externalId: `workspace ${connection.teamId}`,
      grantedAccess: connection.grantedAccess,
      attention: connection.requiresReauthorization ? "Workspace needs authorization" : undefined,
    })),
    discord: connections.discord.map((connection) => ({
      id: connection.id,
      name: connection.guildName,
      externalId: `guild ${connection.guildId}`,
    })),
  };
  if (
    pending !== undefined &&
    removing !== undefined &&
    !rows[pending.provider].some(({ id }) => id === removing.id)
  ) {
    rows[pending.provider].push(removing);
  }
  return rows;
}

function ConnectionReturnBanner({ copy }: { copy: ConnectionReturnCopy }): ReactNode {
  if (copy.tone === "error") {
    return (
      <FailureAlert
        standalone
        title={copy.title}
        error={copy.message}
        fallback="Hub couldn't finish the connection. Start it again from this page."
      />
    );
  }
  return (
    <NoticeAlert standalone tone="success">
      {copy.message}
    </NoticeAlert>
  );
}
