import { useSnapshotQuery } from "../queries/index.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useId, useMemo, useState, type FormEvent } from "react";
import { useActiveAccount } from "../auth/active-account.js";
import { ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DeviceCardSkeleton } from "../components/app/device-card.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { FormField } from "../components/app/form-field.js";
import { ListFilters } from "../components/app/list-filters.js";
import { PageHeader } from "../components/app/page.js";
import { RowActions } from "../components/app/row-actions.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { DropdownMenuItem } from "../components/ui/dropdown-menu.js";
import {
  daemonList,
  renameDaemon,
  revokeDaemon,
  type BrowserDaemon,
  type BrowserDaemonList,
  type DaemonCommand,
} from "./functions.js";
import type { Result } from "../contract/respond.js";
import { DAEMON_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { ConnectAnotherDaemon, DaemonDevice, DaemonResults } from "./daemon-list.js";
import {
  filterDaemons,
  type DaemonFilterStatus,
  type DeviceProfileName,
} from "./device-details.js";
import { useDeviceProfiles, useDeviceProviders } from "./device-queries.js";
import { daemonsQueryKey, refreshDaemons } from "./status.js";

const DAEMONS_DESCRIPTION = "See the machines that run your agents and what Hub can do on them.";
const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "connected", label: "Connected" },
  { value: "offline", label: "Offline" },
];
const DISABLED_FILTER_OPTIONS = FILTER_OPTIONS.map((option) => ({ ...option, disabled: true }));
const INITIAL_FILTERS = { search: "", status: "all" } as const;
const EMPTY_PROFILE_NAMES: readonly DeviceProfileName[] = [];

export function DaemonsPanel({
  accountId,
  organizationId,
  organizationSlug,
}: {
  accountId: string;
  organizationId: string;
  organizationSlug: string;
}) {
  const account = useActiveAccount();
  const showProfiles =
    account.features?.interactiveSessions === true && account.capabilities.manageResources;
  const queryClient = useQueryClient();
  const queryKey = daemonsQueryKey(accountId, organizationId);
  const loadDaemons = useServerFn(daemonList);
  const snapshot = useSnapshotQuery({
    queryKey,
    queryFn: () => loadDaemons({ data: { organizationSlug } }),
  });
  const rename = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(renameDaemon) as (
      input: Parameters<typeof renameDaemon>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      if (result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
        return;
      }
      queryClient.removeQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const revoke = useMutation({
    mutationKey: DAEMON_MUTATION_KEY,
    mutationFn: useServerFn(revokeDaemon) as (
      input: Parameters<typeof revokeDaemon>[0],
    ) => Promise<Result<DaemonCommand>>,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      if (result.data.state === "complete") {
        await refreshDaemons(queryClient, accountId, organizationId);
        return;
      }
      queryClient.removeQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["account"] });
    },
  });
  const renameSelected = useCallback(
    async (daemonId: string, slug: string) => {
      try {
        const result = await rename.mutateAsync({
          data: { organizationSlug, daemonId, slug },
        });
        if (result.status === "error") return result.error.message;
        return result.data.state === "complete"
          ? undefined
          : "The daemon is no longer available in the current organization. Reload the daemon list.";
      } catch {
        return "Hub did not receive the daemon rename result. Check your connection and reload its current name.";
      }
    },
    [organizationSlug, rename],
  );
  const revokeSelected = useCallback(
    (daemonId: string) => revoke.mutate({ data: { organizationSlug, daemonId } }),
    [organizationSlug, revoke],
  );
  const revokeFailed = revoke.isError || revoke.data?.status === "error";
  const busy = rename.isPending || revoke.isPending;
  return (
    <>
      <PageHeader id="daemons-heading" title="Daemons" description={DAEMONS_DESCRIPTION} />
      {revokeFailed ? (
        <FailureAlert
          standalone
          title="The daemon wasn't revoked"
          error={revoke.data}
          fallback="Hub did not receive the daemon revocation result. Check your connection and reload its current status."
        />
      ) : null}
      {snapshot.status === "pending" ? <DaemonsLoading showProfiles={showProfiles} /> : null}
      {snapshot.status === "error" ? (
        <FailureAlert
          title="Daemons unavailable"
          error={snapshot.error}
          fallback="Hub did not receive the daemon list. Check your connection and try again."
          onRetry={snapshot.refetch}
        />
      ) : null}
      {snapshot.status === "success" ? (
        <DaemonsContent
          key={`${accountId}:${organizationId}`}
          snapshot={snapshot.data}
          accountId={accountId}
          organizationSlug={organizationSlug}
          showProfiles={showProfiles}
          busy={busy}
          onRename={renameSelected}
          onRevoke={revokeSelected}
        />
      ) : null}
    </>
  );
}

interface DaemonActions {
  busy: boolean;
  onRename: (daemonId: string, slug: string) => Promise<string | undefined>;
  onRevoke: (daemonId: string) => void;
}

interface DaemonsFilters {
  search: string;
  status: DaemonFilterStatus;
}

function DaemonsContent({
  snapshot,
  accountId,
  organizationSlug,
  showProfiles,
  busy,
  onRename,
  onRevoke,
}: DaemonActions & {
  snapshot: BrowserDaemonList;
  accountId: string;
  organizationSlug: string;
  showProfiles: boolean;
}) {
  const searchId = useId();
  const [filters, setFilters] = useState<DaemonsFilters>(INITIAL_FILTERS);
  const [announcement, setAnnouncement] = useState<{ count: number; revision: number }>();
  const { daemons, canManage } = snapshot;
  const matches = filterDaemons(daemons, filters.search, filters.status);
  const profiles = useDeviceProfiles(
    showProfiles && daemons.length > 0,
    accountId,
    organizationSlug,
  );
  const apply = useCallback(
    (next: DaemonsFilters) => {
      const count = filterDaemons(daemons, next.search, next.status).length;
      setFilters(next);
      setAnnouncement((previous) => ({ count, revision: (previous?.revision ?? 0) + 1 }));
    },
    [daemons],
  );
  const search = useCallback(
    (value: string) => apply({ ...filters, search: value }),
    [apply, filters],
  );
  const changeStatus = useCallback(
    (value: string) => {
      if (value === "all" || value === "connected" || value === "offline") {
        apply({ ...filters, status: value });
      }
    },
    [apply, filters],
  );
  const clear = useCallback(() => {
    document.getElementById(searchId)?.focus();
    apply(INITIAL_FILTERS);
  }, [apply, searchId]);

  return (
    <>
      {daemons.length === 0 ? null : (
        <DaemonFilters
          searchId={searchId}
          filters={filters}
          onSearch={search}
          onStatusChange={changeStatus}
        />
      )}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement === undefined ? null : (
          <span key={announcement.revision}>
            {announcement.count} {announcement.count === 1 ? "daemon" : "daemons"} shown
          </span>
        )}
      </span>
      <div className="grid min-w-0 gap-6">
        <DaemonResults hasDaemons={daemons.length > 0} onClear={clear}>
          {matches.map((daemon) => (
            <ConnectedDaemonDevice
              key={daemon.id}
              daemon={daemon}
              accountId={accountId}
              organizationSlug={organizationSlug}
              profiles={profiles}
              canManage={canManage}
              busy={busy}
              onRename={onRename}
              onRevoke={onRevoke}
            />
          ))}
        </DaemonResults>
        {daemons.length > 0 && canManage ? <ConnectAnotherDaemon /> : null}
      </div>
    </>
  );
}

function DaemonFilters({
  filters,
  searchId,
  onSearch,
  onStatusChange = ignoreFilter,
}: {
  filters: DaemonsFilters;
  searchId: string;
  onSearch?: (value: string) => void;
  onStatusChange?: (value: string) => void;
}) {
  const disabled = onSearch === undefined;
  return (
    <ListFilters id={`${searchId}-filters`}>
      <div className="min-w-0 flex-1 basis-48 sm:max-w-xs">
        <FormField
          id={searchId}
          label="Search daemons"
          name="daemon-search"
          kind="text"
          value={filters.search}
          disabled={disabled}
          {...(onSearch === undefined ? {} : { onChange: onSearch })}
        />
      </div>
      <SegmentedControl
        label="Daemon status"
        description="Daemon status"
        value={filters.status}
        options={disabled ? DISABLED_FILTER_OPTIONS : FILTER_OPTIONS}
        onChange={onStatusChange}
      />
    </ListFilters>
  );
}

function ignoreFilter() {}

function DaemonsLoading({ showProfiles }: { showProfiles: boolean }) {
  const searchId = useId();
  return (
    <div aria-busy="true" aria-label="Loading daemons">
      <DaemonFilters filters={INITIAL_FILTERS} searchId={searchId} />
      <div className="grid gap-3">
        <DeviceCardSkeleton detailCount={showProfiles ? 3 : 2} />
        <DeviceCardSkeleton detailCount={showProfiles ? 3 : 2} />
      </div>
    </div>
  );
}

function ConnectedDaemonDevice({
  daemon,
  accountId,
  organizationSlug,
  profiles,
  canManage,
  busy,
  onRename,
  onRevoke,
}: DaemonActions & {
  daemon: BrowserDaemon;
  accountId: string;
  organizationSlug: string;
  profiles: ReturnType<typeof useDeviceProfiles>;
  canManage: boolean;
}) {
  const providers = useDeviceProviders(daemon, accountId, organizationSlug);
  const deviceProfiles = useMemo(
    () =>
      profiles === undefined
        ? undefined
        : {
            names: profiles.byDaemon?.get(daemon.id) ?? EMPTY_PROFILE_NAMES,
            message: profiles.message,
          },
    [daemon.id, profiles],
  );
  const actions = useMemo(
    () =>
      canManage ? (
        <DaemonRowActions daemon={daemon} busy={busy} onRename={onRename} onRevoke={onRevoke} />
      ) : null,
    [busy, canManage, daemon, onRename, onRevoke],
  );
  return (
    <DaemonDevice
      daemon={daemon}
      organizationSlug={organizationSlug}
      providers={providers}
      profiles={deviceProfiles}
      actions={actions}
    />
  );
}

function DaemonRowActions({
  daemon,
  busy,
  onRename,
  onRevoke,
}: DaemonActions & { daemon: BrowserDaemon }) {
  const [renaming, setRenaming] = useState(false);
  const requestRename = useCallback((event: Event) => {
    event.preventDefault();
    setRenaming(true);
  }, []);
  const revoke = useCallback(() => onRevoke(daemon.id), [daemon.id, onRevoke]);

  return (
    <>
      <RowActions label={`Actions for ${daemon.slug}`}>
        <DropdownMenuItem disabled={busy} onSelect={requestRename}>
          Rename
        </DropdownMenuItem>
        {daemon.status === "revoked" ? null : (
          <ConfirmMenuItem
            busy={busy}
            destructive
            label="Revoke"
            title={`Revoke ${daemon.slug}?`}
            description="The daemon will disconnect and its credential cannot reconnect."
            cancelLabel="Cancel"
            confirmLabel="Revoke daemon"
            onConfirm={revoke}
          />
        )}
      </RowActions>
      <RenameDaemonDialog
        daemon={daemon}
        busy={busy}
        onRename={onRename}
        open={renaming}
        onOpenChange={setRenaming}
      />
    </>
  );
}

function RenameDaemonDialog({
  daemon,
  busy,
  onRename,
  open,
  onOpenChange,
}: {
  daemon: BrowserDaemon;
  busy: boolean;
  onRename: (daemonId: string, slug: string) => Promise<string | undefined>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState<string>();
  const changeOpen = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setError(undefined);
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );
  const completeRename = useCallback(
    async (slug: string) => {
      const failure = await onRename(daemon.id, slug);
      setError(failure);
      if (failure === undefined) changeOpen(false);
    },
    [changeOpen, daemon.id, onRename],
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const slug = new FormData(event.currentTarget).get("slug");
      if (typeof slug !== "string") return;
      void completeRename(slug);
    },
    [completeRename],
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={changeOpen}
      title="Rename daemon"
      label={`Rename ${daemon.slug}`}
      submitLabel="Rename"
      busy={busy}
      onSubmit={submit}
    >
      <FormField
        id={`daemon-slug-${daemon.id}`}
        label="Daemon slug"
        kind="text"
        name="slug"
        defaultValue={daemon.slug}
        maxLength={100}
        required
        {...(error === undefined ? {} : { error })}
      />
    </FormDialog>
  );
}
