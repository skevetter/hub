import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
  type ConnectionStatus,
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
import {
  cacheAcknowledgedRevocation,
  type ConnectionIdentity,
  type ConnectionQueryKeys,
} from "./revocation-cache.js";
import type { ProviderConnectionStatus } from "./status.js";

const HEADING_ID = "connections-heading";
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

function ConnectionsLoading({ focus = false }: { focus?: boolean }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) region.current?.focus();
  }, [focus]);
  const skeletons = (
    <Section className={GRID_COLUMNS}>
      {PROVIDER_CARDS.map(({ provider }) => (
        <CardSkeleton key={provider} />
      ))}
    </Section>
  );
  return focus ? (
    <div ref={region} role="region" aria-label="Loading connections" tabIndex={-1}>
      {skeletons}
    </div>
  ) : (
    skeletons
  );
}

export function OrganizationConnectionsPanel() {
  const { account, organization } = useRouteTenant();
  return (
    <>
      <PageHeader
        id={HEADING_ID}
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
  const organizationSlug = tenant.organization.slug;
  const scope = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  const loading = <ConnectionsLoading />;
  const snapshot = useOrganizationSnapshot();
  const loadStatus = useServerFn(connectionStatus);
  const keys = useMemo(
    () => ({
      snapshot: snapshot.queryKey,
      status: ["connection-status", tenant.account.id, tenant.organization.id],
      revocation: ["connection-revocation", tenant.account.id, tenant.organization.id],
    }),
    [snapshot.queryKey, tenant.account.id, tenant.organization.id],
  );
  const statusQuery = useSnapshotQuery({
    queryKey: keys.status,
    queryFn: () => loadStatus({ data: scope }),
  });
  const [returned, setReturned] = useConnectionReturn();
  const connect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(startConnection),
  });
  const { revocation, snapshotProgress, statusProgress, paused } = useConnectionReadProgress(keys);
  const disconnect = useConnectionRevocation(scope, keys);
  const mutationPending = useIsMutating({ mutationKey: CONNECTION_MUTATION_KEY }) > 0;
  const readFailure = connectionReadFailure(
    snapshot,
    statusQuery,
    revocation !== undefined && paused,
  );
  const ready = snapshot.status === "success" && statusQuery.status === "success";
  const { retry, retryState, retryPending, focusRetryButton, resetRetry, failure } =
    useConnectionRetry(keys, ready, readFailure, paused);
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
      resetRetry();
      setReturned(undefined);
      revoke({ data: { ...scope, provider, connectionId: row.id }, row });
    },
    [resetRetry, revoke, scope, setReturned],
  );
  const mutations = useMemo(
    () => [
      { data: connect.data, isError: connect.isError },
      { data: disconnect.data, isError: disconnect.isError },
    ],
    [connect.data, connect.isError, disconnect.data, disconnect.isError],
  );
  if (retryPending) {
    return (
      <>
        <StatusLine>{null}</StatusLine>
        <ConnectionsLoading focus />
      </>
    );
  }
  if (failure !== undefined) {
    return (
      <FailureAlert
        title={failure.title}
        error={failure.message}
        fallback={`${failure.title}.`}
        passive={retryState === "idle" && revocation === undefined}
        onRetry={retry}
        retryRef={focusRetryButton}
      />
    );
  }
  if (!ready) return loading;

  const data = snapshotProgress?.data ?? snapshot.data;
  const statuses = statusProgress?.data ?? statusQuery.data;
  const canManage = data.capabilities.manageResources;
  const removing = disconnect.isPending ? disconnect.variables?.data : undefined;
  const busy = mutationPending || revocation !== undefined;
  const connections = connectionRows(data.connections);
  const suspendedGitHub = data.connections.github.some(({ status }) => status === "suspended");
  const result = reconciledRevocation(disconnect, revocation, connections);
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
          const reported = statuses[provider].status;
          const status =
            provider === "github" && reported !== "notConfigured" && suspendedGitHub
              ? "suspended"
              : reported;
          const updating = revocation?.provider === provider;
          const removingId = removing?.provider === provider ? removing.connectionId : undefined;
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

const OFFLINE_FAILURE = {
  title: "Connections unavailable",
  message: "Reconnect to the network and try again.",
};

function connectionReadFailure(snapshot: ConnectionRead, status: ConnectionRead, offline: boolean) {
  if (offline) return OFFLINE_FAILURE;
  const failure = (read: ConnectionRead) =>
    read.status === "error" ? { message: read.error } : read.refreshFailure;
  const snapshotFailure = failure(snapshot);
  if (snapshotFailure != null) return { title: "Organization unavailable", ...snapshotFailure };
  const statusFailure = failure(status);
  if (statusFailure != null) return { title: "Connections unavailable", ...statusFailure };
  return undefined;
}

function useConnectionRetry(
  keys: ConnectionQueryKeys,
  ready: boolean,
  readFailure: ReturnType<typeof connectionReadFailure>,
  paused: boolean,
) {
  const queryClient = useQueryClient();
  const [retryState, setRetryState] = useState<"idle" | "pending" | "complete">("idle");
  const resetRetry = useCallback(() => setRetryState("idle"), []);
  const restoreRetryFocus = useRef(false);
  const retry = useCallback(() => {
    restoreRetryFocus.current = true;
    setRetryState("pending");
    void Promise.all([
      queryClient.refetchQueries({ queryKey: keys.snapshot, exact: true }),
      queryClient.refetchQueries({ queryKey: keys.status, exact: true }),
    ]).then(() => setRetryState("complete"));
  }, [queryClient, keys]);
  const focusRetryButton = useCallback((button: HTMLButtonElement | null) => {
    if (button === null || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    button.focus();
  }, []);
  const retryPaused =
    paused &&
    retryState !== "idle" &&
    (retryState === "pending" || !ready || readFailure !== undefined);
  const failure = retryPaused ? OFFLINE_FAILURE : readFailure;
  const retrySucceeded = retryState === "complete" && failure === undefined && ready;
  useEffect(() => {
    if (!retrySucceeded || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    document.getElementById(HEADING_ID)?.focus();
  }, [retrySucceeded]);
  const retryPending =
    !retryPaused &&
    retryState !== "idle" &&
    (retryState === "pending" || (!ready && failure === undefined));
  return { retry, retryState, retryPending, focusRetryButton, resetRetry, failure };
}

interface RevokeInput {
  data: Parameters<typeof disconnectConnection>[0]["data"];
  row: ConnectionRecord;
}

interface RevocationResult {
  provider: ConnectionProvider;
  row: ConnectionRecord;
  result: ConnectionDisconnectResult;
}

function useConnectionRevocation(scope: { organizationSlug: string }, keys: ConnectionQueryKeys) {
  const queryClient = useQueryClient();
  const sendDisconnect = useServerFn(disconnectConnection) as (
    input: Parameters<typeof disconnectConnection>[0],
  ) => Promise<Result<{ result: ConnectionDisconnectResult }>>;
  return useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: ({ data }: RevokeInput) => sendDisconnect({ data }),
    onSuccess: async (response, { data }) => {
      if (response.status !== "ok") return;
      cacheAcknowledgedRevocation(queryClient, keys, {
        provider: data.provider,
        connectionId: data.connectionId,
      });
      await Promise.all([
        invalidateOrganization(queryClient, scope.organizationSlug),
        queryClient.invalidateQueries({ queryKey: keys.status, exact: true }),
      ]);
    },
  });
}

function useConnectionReadProgress(keys: ConnectionQueryKeys) {
  const queryClient = useQueryClient();
  const revocation = useReadProgress<ConnectionIdentity>(queryClient, keys.revocation)?.data;
  const snapshotProgress = useReadProgress<OrganizationSnapshot>(queryClient, keys.snapshot);
  const statusProgress = useReadProgress<ConnectionStatus>(queryClient, keys.status);
  const paused =
    snapshotProgress?.fetchStatus === "paused" || statusProgress?.fetchStatus === "paused";
  return { revocation, snapshotProgress, statusProgress, paused };
}

function useReadProgress<T>(queryClient: QueryClient, queryKey: QueryKey) {
  const read = useCallback(() => queryClient.getQueryState<T>(queryKey), [queryClient, queryKey]);
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, read, read);
}

function reconciledRevocation(
  disconnect: ReturnType<typeof useConnectionRevocation>,
  revocation: ConnectionIdentity | undefined,
  connections: Record<ConnectionProvider, ConnectionRecord[]>,
): RevocationResult | undefined {
  const target = disconnect.variables;
  if (revocation !== undefined || disconnect.data?.status !== "ok" || target === undefined)
    return undefined;
  const { provider, connectionId } = target.data;
  if (connections[provider].some(({ id }) => id === connectionId)) return undefined;
  return { provider, row: target.row, result: disconnect.data.data.result };
}

function revokeBannerCopy(
  result: RevocationResult | undefined,
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
          includeExternalId={connections.some(
            (other) => other.id !== connection.id && other.name === connection.name,
          )}
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
  includeExternalId,
  provider,
  canManage,
  busy,
  removing,
  onRevoke,
}: {
  connection: ConnectionRecord;
  includeExternalId: boolean;
  provider: ConnectionProvider;
  canManage: boolean;
  busy: boolean;
  removing: boolean;
  onRevoke: (provider: ConnectionProvider, row: ConnectionRecord) => void;
}) {
  const { name, externalId, grantedAccess } = connection;
  const actionsLabel = includeExternalId
    ? `Actions for ${name}, ${externalId}`
    : `Actions for ${name}`;
  const revokeTitle = includeExternalId ? `Revoke ${name} (${externalId})?` : `Revoke ${name}?`;
  const detail = removing ? "Being removed" : connection.attention;
  const confirmRevoke = useCallback(
    () => onRevoke(provider, connection),
    [onRevoke, provider, connection],
  );
  const actions = useMemo(
    () =>
      canManage && !removing ? (
        <RowActions label={actionsLabel}>
          <ConfirmMenuItem
            busy={busy}
            destructive
            label="Revoke"
            title={revokeTitle}
            description="Projects using this credential will stop receiving new events."
            confirmLabel="Revoke connection"
            cancelLabel="Cancel"
            onConfirm={confirmRevoke}
          />
        </RowActions>
      ) : undefined,
    [actionsLabel, busy, canManage, confirmRevoke, removing, revokeTitle],
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
): Record<ConnectionProvider, ConnectionRecord[]> {
  return {
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
