import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, type ReactNode } from "react";
import { useActiveAccount } from "../auth/active-account.js";
import { CONNECTION_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { Card, CardSkeleton } from "../components/app/card.js";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RowActions } from "../components/app/row-actions.js";
import { Section } from "../components/app/section.js";
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
  return (
    <>
      <PageHeader
        title="Connections"
        description="These services let Hub receive events and post replies for your organization."
      />
      <ConnectionsContent />
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
  const snapshot = useOrganizationSnapshot(loading);
  const loadStatus = useServerFn(connectionStatus);
  const statusKey = ["connection-status", tenant.account.id, tenant.organization.id];
  const statusQuery = useSnapshotQuery({
    queryKey: statusKey,
    queryFn: () => loadStatus({ data: scope }),
  });
  const [returned, setReturned] = useConnectionReturn();
  const connect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(startConnection),
  });
  const disconnect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(disconnectConnection) as (
      input: Parameters<typeof disconnectConnection>[0],
    ) => Promise<Result<{ result: ConnectionDisconnectResult }>>,
    onSuccess: async (response, variables) => {
      if (response.status !== "ok") return;
      setReturned({ provider: variables.data.provider, result: response.data.result });
      await Promise.all([
        invalidateOrganization(queryClient, scope.organizationSlug),
        queryClient.invalidateQueries({ queryKey: statusKey }),
      ]);
    },
  });
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
    (provider: ConnectionProvider, connectionId: string) => {
      revoke({ data: { ...scope, provider, connectionId } });
    },
    [revoke, scope],
  );
  const mutations = useMemo(
    () => [
      { data: connect.data, isError: connect.isError },
      { data: disconnect.data, isError: disconnect.isError },
    ],
    [connect.data, connect.isError, disconnect.data, disconnect.isError],
  );
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Organization unavailable"
        error={snapshot.error}
        fallback="Organization unavailable."
        onRetry={snapshot.refetch}
      />
    );
  }
  if (!snapshot.ok) return snapshot.element;
  if (statusQuery.status === "pending") return loading;
  if (statusQuery.status === "error") {
    return (
      <FailureAlert
        title="Connections unavailable"
        error={statusQuery.error}
        fallback="Connections unavailable."
        onRetry={statusQuery.refetch}
      />
    );
  }

  const data = snapshot.data;
  const canManage = data.capabilities.manageResources;
  const busy = connect.isPending || disconnect.isPending;
  const connections = connectionRows(data.connections);
  const suspendedGitHub = data.connections.github.some(({ status }) => status === "suspended");
  return (
    <>
      {returned === undefined ? null : (
        <ConnectionReturnBanner copy={connectionReturnCopy(returned)} />
      )}
      <CommandError mutations={mutations} />
      <Section className={GRID_COLUMNS}>
        {PROVIDER_CARDS.map(({ provider, label, icon, description, droppedSearch }) => {
          const reported = statusQuery.data[provider].status;
          const status =
            provider === "github" && reported !== "notConfigured" && suspendedGitHub
              ? "suspended"
              : reported;
          const dropped = data.droppedConnectionEvents[provider];
          return (
            <Card
              key={provider}
              label={label}
              icon={icon}
              title={label}
              description={description}
              status={STATE_PILLS[status]}
            >
              {connections[provider].length > 0 ? (
                <ProviderConnections
                  label={label}
                  provider={provider}
                  connections={connections[provider]}
                  canManage={canManage}
                  busy={busy}
                  onRevoke={revokeConnection}
                />
              ) : null}
              {provider === "linear" && canManage && connections.linear.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Linear events dropped because no route matched stay dropped after reconnecting.
                </p>
              ) : null}
              {dropped > 0 ? (
                <div>
                  <Link
                    className="text-link underline underline-offset-2"
                    to="/o/$organizationSlug/activity"
                    params={scope}
                    search={droppedSearch}
                  >
                    {data.droppedConnectionEventsCapped ? "At least " : ""}
                    {dropped} dropped {dropped === 1 ? "event" : "events"} in the last 7 days
                  </Link>
                </div>
              ) : null}
              <ConnectionHint
                label={label}
                status={status}
                canManage={canManage}
                isInstanceOperator={isInstanceOperator}
              />
              {canManage ? (
                <ConnectionAction
                  label={label}
                  provider={provider}
                  status={status}
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
  if (status === "disconnected" && !canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Someone who manages this organization can connect {label}.
      </p>
    );
  }
  return null;
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
}

function ProviderConnections({
  label,
  provider,
  connections,
  canManage,
  busy,
  onRevoke,
}: {
  label: string;
  provider: ConnectionProvider;
  connections: readonly ConnectionRecord[];
  canManage: boolean;
  busy: boolean;
  onRevoke: (provider: ConnectionProvider, connectionId: string) => void;
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
  onRevoke,
}: {
  connection: ConnectionRecord;
  provider: ConnectionProvider;
  canManage: boolean;
  busy: boolean;
  onRevoke: (provider: ConnectionProvider, connectionId: string) => void;
}) {
  const { id, name, externalId, grantedAccess } = connection;
  const confirmRevoke = useCallback(() => onRevoke(provider, id), [onRevoke, provider, id]);
  const actions = useMemo(
    () =>
      canManage ? (
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
    [busy, canManage, confirmRevoke, name],
  );
  return (
    <RecordRow actions={actions}>
      <TwoLine primary={name} secondary={externalId} mono />
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
    })),
    github: connections.github.map((connection) => ({
      id: connection.id,
      name: connection.accountLogin,
      externalId: `installation ${connection.installationId}`,
    })),
    slack: connections.slack.map((connection) => ({
      id: connection.id,
      name: connection.teamName,
      externalId: `workspace ${connection.teamId}`,
      grantedAccess: connection.grantedAccess,
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
