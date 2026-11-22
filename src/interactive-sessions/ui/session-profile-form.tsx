import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { formValue } from "../../auth/account-actions.js";
import { useActiveAccount } from "../../auth/active-account.js";
import { CheckboxField } from "../../components/app/checkbox-field.js";
import { Combobox, type ComboboxOption } from "../../components/app/combobox.js";
import { FailureAlert, WarningAlert } from "../../components/app/failure-alert.js";
import { FormDialog } from "../../components/app/form-dialog.js";
import { FormField } from "../../components/app/form-field.js";
import { LoadingLine } from "../../components/app/loading.js";
import { Button } from "../../components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import type { Result } from "../../contract/respond.js";
import { daemonList, daemonProviderSnapshot } from "../../daemons/functions.js";
import type { HubProviderSnapshot, HubProviderSnapshotEntry } from "../../hub/protocol.js";
import { useSnapshotQuery } from "../../queries/index.js";
import type { ProfileView } from "../functions.js";

export interface ProfileFormData extends Omit<ProfileView, "daemonSlug" | "id" | "version"> {
  id: string | null;
  version: number | null;
}

const EMPTY_SETTINGS = { provider: "", model: "", mode: "", thinking: "", acknowledged: false };
const EMPTY_OPTIONS: readonly [] = [];
const PROVIDER_POLL_INTERVAL_MS = 2000;
const PROVIDER_POLL_TIMEOUT_MS = 30_000;

export function SessionProfileForm({
  organizationSlug,
  profile,
  busy,
  close,
  save,
}: {
  organizationSlug: string;
  profile: ProfileView | null;
  busy: boolean;
  close: () => void;
  save: (data: ProfileFormData) => Promise<string | null>;
}) {
  const fieldId = useId();
  const [daemonId, setDaemonId] = useState(profile?.daemonId ?? "");
  const [cwd, setCwd] = useState(profile?.cwd ?? "");
  const [error, setError] = useState<string>();
  const title = profile === null ? "Create a profile" : "Edit profile";
  const directory = cwd.trim();
  const daemon = useProfileDaemon(organizationSlug, daemonId, directory);
  const agent = useProfileAgent(profile, daemon.catalog.data);
  const { changeProvider } = agent;

  const chooseDaemon = useCallback(
    ({ value }: ComboboxOption) => {
      setDaemonId(value);
      changeProvider("");
    },
    [changeProvider],
  );
  const changeOpen = useCallback(
    (open: boolean) => {
      if (!open && !busy) close();
    },
    [busy, close],
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = formValue(form, "name").trim();
      const agentError = agentSettingsError(agent);
      if (name === "" || directory === "") {
        setError("Enter a profile name and working directory.");
      } else if (!daemon.available) {
        setError("Choose a connected daemon with permission to execute.");
      } else if (agentError !== null) {
        setError(agentError);
      } else {
        setError(undefined);
        void submitProfile(
          save,
          profileData(profile, form, name, daemonId, directory, agent.settings),
          close,
          setError,
        );
      }
    },
    [agent, close, daemon.available, daemonId, directory, profile, save],
  );

  return (
    <FormDialog
      open
      onOpenChange={changeOpen}
      title={title}
      description="These settings apply to sessions started from this profile."
      label={title}
      submitLabel={profile === null ? "Create profile" : "Save changes"}
      busy={busy}
      onSubmit={submit}
    >
      <FormField
        id={fieldId + "-name"}
        label="Name"
        description="People pick this when they start a session."
        kind="text"
        name="name"
        required
        maxLength={80}
        defaultValue={profile?.name ?? ""}
      />
      <DaemonField
        id={fieldId + "-daemon"}
        value={daemonId}
        daemon={daemon}
        onChange={chooseDaemon}
        disabled={busy}
      />
      <FormField
        id={fieldId + "-cwd"}
        label="Working directory"
        description="An absolute folder on the daemon. The agent starts here."
        kind="text"
        name="cwd"
        required
        maxLength={1024}
        value={cwd}
        onChange={setCwd}
      />
      <WorktreeFields profile={profile} />
      <AgentFields agent={agent} catalog={daemon.catalog} busy={busy} />
      {error === undefined ? null : (
        <FailureAlert
          title="Could not save profile"
          error={error}
          fallback="Try again."
          focusOnArrival
        />
      )}
    </FormDialog>
  );
}

async function submitProfile(
  save: (data: ProfileFormData) => Promise<string | null>,
  data: ProfileFormData,
  close: () => void,
  setError: (message: string) => void,
) {
  const refusal = await save(data);
  if (refusal === null) close();
  else setError(refusal);
}

function profileData(
  profile: ProfileView | null,
  form: FormData,
  name: string,
  daemonId: string,
  cwd: string,
  settings: typeof EMPTY_SETTINGS,
): ProfileFormData {
  const base = form.has("base") ? formValue(form, "base").trim() : "";
  const worktree = form.has("branch") ? { mode: "branch-off" as const } : null;
  return {
    id: profile?.id ?? null,
    version: profile?.version ?? null,
    name,
    daemonId,
    cwd,
    worktree: worktree !== null && base !== "" ? { ...worktree, base } : worktree,
    provider: settings.provider,
    model: settings.model || null,
    mode: settings.mode || null,
    thinkingOptionId: settings.thinking || null,
    fullAccessAcknowledged: settings.acknowledged,
    status: profile?.status ?? "active",
  };
}

function useProfileDaemon(organizationSlug: string, daemonId: string, directory: string) {
  const accountId = useActiveAccount().account.id;
  const loadDaemons = useServerFn(daemonList);
  const loadProviders = useServerFn(daemonProviderSnapshot);
  const [catalogCwd, setCatalogCwd] = useState(directory);
  useEffect(() => {
    const timer = setTimeout(() => setCatalogCwd(directory), 350);
    return () => clearTimeout(timer);
  }, [directory]);

  const daemons = useSnapshotQuery({
    queryKey: ["session-profile-daemons", organizationSlug, accountId],
    queryFn: () => loadDaemons({ data: { organizationSlug } }),
  });
  const options = useMemo(
    () =>
      (daemons.data?.daemons ?? [])
        .filter(
          ({ status, presence, permissions }) =>
            status === "active" && presence === "connected" && permissions.includes("hub.execute"),
        )
        .map(({ id, slug }) => ({ value: id, label: slug })),
    [daemons.data],
  );
  const available = options.some(({ value }) => value === daemonId);
  const enabled = available && catalogCwd !== "" && catalogCwd === directory;
  const query = useSnapshotQuery({
    queryKey: [
      "session-profile-catalog",
      organizationSlug,
      accountId,
      daemonId,
      enabled ? catalogCwd : "",
    ],
    enabled,
    queryFn: ({ signal }) =>
      loadProfileCatalog(
        (readSignal) =>
          loadProviders({
            data: { organizationSlug, daemonId, cwd: catalogCwd },
            signal: readSignal,
          }),
        signal,
      ),
  });
  return {
    options,
    available,
    daemons,
    catalog: { ...query, enabled, data: enabled ? query.data : undefined },
  };
}

function isReadyProvider({ status, enabled }: HubProviderSnapshotEntry): boolean {
  return status === "ready" && enabled;
}

function isLoadingCatalog({ entries }: HubProviderSnapshot): boolean {
  return entries.some(({ status }) => status === "loading") && !entries.some(isReadyProvider);
}

async function loadProfileCatalog(
  read: (signal: AbortSignal) => Promise<Result<HubProviderSnapshot>>,
  signal: AbortSignal,
): Promise<Result<HubProviderSnapshot>> {
  const initial = await read(signal);
  if (initial.status !== "ok" || !isLoadingCatalog(initial.data)) return initial;

  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), PROVIDER_POLL_TIMEOUT_MS);
  const pollSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    let snapshot = initial;
    while (isLoadingCatalog(snapshot.data)) {
      await waitForProviderPoll(pollSignal);
      pollSignal.throwIfAborted();
      const result = await read(pollSignal);
      if (result.status === "error") return result;
      snapshot = result;
    }
    return snapshot;
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted) return initial;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function waitForProviderPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, PROVIDER_POLL_INTERVAL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function DaemonField({
  id,
  value,
  daemon,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  daemon: ReturnType<typeof useProfileDaemon>;
  onChange: (option: ComboboxOption) => void;
  disabled: boolean;
}) {
  const { daemons, options } = daemon;
  return (
    <>
      <FormField id={id} label="Daemon" required disabled={disabled}>
        {(control) => (
          <Combobox
            {...control}
            value={value}
            options={options}
            loading={daemons.status === "pending"}
            placeholder="Select a daemon"
            empty="No connected daemons can execute."
            onChange={onChange}
          />
        )}
      </FormField>
      {daemons.status === "error" ? (
        <FailureAlert
          title="Could not load daemons"
          error={daemons.error}
          fallback="Try again."
          onRetry={daemons.refetch}
        />
      ) : null}
    </>
  );
}

function WorktreeFields({ profile }: { profile: ProfileView | null }) {
  const fieldId = useId();
  const [enabled, setEnabled] = useState(profile?.worktree != null);
  const [base, setBase] = useState(profile?.worktree?.base ?? "");
  return (
    <>
      <CheckboxField
        id={fieldId + "-branch"}
        name="branch"
        label="Use a new branch per session"
        checked={enabled}
        onChange={setEnabled}
      />
      {enabled ? (
        <FormField
          id={fieldId + "-base"}
          label="Base branch"
          description="Leave blank to use the daemon's default."
          kind="text"
          name="base"
          maxLength={200}
          value={base}
          onChange={setBase}
        />
      ) : null}
    </>
  );
}

function useProfileAgent(profile: ProfileView | null, catalog: HubProviderSnapshot | undefined) {
  const [settings, setSettings] = useState({
    provider: profile?.provider ?? "",
    model: profile?.model ?? "",
    mode: profile?.mode ?? "",
    thinking: profile?.thinkingOptionId ?? "",
    acknowledged: profile?.fullAccessAcknowledged ?? false,
  });
  const available = useMemo(
    () => (catalog?.entries ?? EMPTY_OPTIONS).filter(isReadyProvider),
    [catalog],
  );
  const providers = useMemo(
    () =>
      available.map(({ provider, label }) => ({
        id: provider,
        label: label ?? provider,
      })),
    [available],
  );
  const provider = available.find((entry) => entry.provider === settings.provider);
  const models = useMemo(
    () => (provider?.models ?? EMPTY_OPTIONS).filter(({ isSelectable }) => isSelectable !== false),
    [provider],
  );
  const model = models.find(({ id }) => id === settings.model);
  const modes = provider?.modes ?? EMPTY_OPTIONS;
  const thinking = model?.thinkingOptions ?? EMPTY_OPTIONS;
  const explicitMode = settings.provider === "omp" || provider?.defaultModeId === "full";

  const changeProvider = useCallback((choice: string) => {
    setSettings({ ...EMPTY_SETTINGS, provider: choice });
  }, []);
  const changeModel = useCallback((choice: string) => {
    setSettings((previous) => ({ ...previous, model: choice, thinking: "" }));
  }, []);
  const changeMode = useCallback((choice: string) => {
    setSettings((previous) => ({ ...previous, mode: choice, acknowledged: false }));
  }, []);
  const changeThinking = useCallback((choice: string) => {
    setSettings((previous) => ({ ...previous, thinking: choice }));
  }, []);
  const acknowledge = useCallback((acknowledged: boolean) => {
    setSettings((previous) => ({ ...previous, acknowledged }));
  }, []);
  return {
    settings,
    providers,
    provider,
    models,
    model,
    modes,
    thinking,
    explicitMode,
    changeProvider,
    changeModel,
    changeMode,
    changeThinking,
    acknowledge,
  };
}

function agentSettingsError(agent: ReturnType<typeof useProfileAgent>) {
  const { provider, model, modes, thinking, settings, explicitMode } = agent;
  if (
    provider === undefined ||
    (settings.model !== "" && model === undefined) ||
    ((explicitMode || settings.mode !== "") && !modes.some(({ id }) => id === settings.mode)) ||
    (settings.thinking !== "" && !thinking.some(({ id }) => id === settings.thinking))
  )
    return "Choose provider settings available for this directory.";
  if (settings.mode === "full" && !settings.acknowledged)
    return "Confirm full access before saving.";
  return null;
}

function AgentFields({
  agent,
  catalog,
  busy,
}: {
  agent: ReturnType<typeof useProfileAgent>;
  catalog: ReturnType<typeof useProfileDaemon>["catalog"];
  busy: boolean;
}) {
  const fieldId = useId();
  const { settings, providers, provider, models, modes, thinking } = agent;
  const disabled = busy || provider === undefined;
  return (
    <>
      <CatalogStatus catalog={catalog} hasProviders={providers.length > 0} />
      <ProfileSelect
        id={fieldId + "-provider"}
        label="Provider"
        options={providers}
        value={settings.provider}
        onChange={agent.changeProvider}
        disabled={busy || providers.length === 0}
        required
      />
      <ProfileSelect
        id={fieldId + "-model"}
        label="Model"
        options={models}
        value={settings.model}
        onChange={agent.changeModel}
        disabled={disabled}
      />
      <ProfileSelect
        id={fieldId + "-mode"}
        label="Mode"
        options={modes}
        value={settings.mode}
        onChange={agent.changeMode}
        disabled={disabled}
        required={agent.explicitMode}
      />
      <ProfileSelect
        id={fieldId + "-thinking"}
        label="Thinking"
        options={thinking}
        value={settings.thinking}
        onChange={agent.changeThinking}
        disabled={disabled}
      />
      {settings.mode === "full" ? (
        <>
          <WarningAlert title="Full access">
            The agent can run tools without asking for permission.
          </WarningAlert>
          <CheckboxField
            id={fieldId + "-acknowledge"}
            label="Run every tool without asking"
            required
            checked={settings.acknowledged}
            onChange={agent.acknowledge}
          />
        </>
      ) : null}
    </>
  );
}

function CatalogStatus({
  catalog,
  hasProviders,
}: {
  catalog: ReturnType<typeof useProfileDaemon>["catalog"];
  hasProviders: boolean;
}) {
  const { refetch } = catalog;
  const retry = useCallback(() => refetch(), [refetch]);
  const retryAction = useMemo(
    () => (
      <Button type="button" size="sm" variant="outline" onClick={retry}>
        Retry
      </Button>
    ),
    [retry],
  );
  if (!catalog.enabled) return null;
  if (catalog.isFetching) return <LoadingLine>Loading provider settings...</LoadingLine>;
  if (catalog.status === "error") {
    return (
      <FailureAlert
        title="Could not load provider settings"
        error={catalog.error}
        fallback="Check the daemon connection."
        onRetry={catalog.refetch}
      />
    );
  }
  if (!hasProviders) {
    const timedOut = catalog.data !== undefined && isLoadingCatalog(catalog.data);
    return (
      <WarningAlert title="No providers available" action={timedOut ? retryAction : undefined}>
        Check the providers configured on the daemon.
      </WarningAlert>
    );
  }
  return null;
}

function ProfileSelect({
  id,
  label,
  options,
  value,
  onChange,
  disabled,
  required = false,
}: {
  id: string;
  label: string;
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  required?: boolean;
}) {
  const empty = required ? "" : "default";
  const selection = value === "" ? empty : "option:" + value;
  const select = useCallback(
    (choice: string) => onChange(choice === "default" ? "" : choice.slice("option:".length)),
    [onChange],
  );
  return (
    <FormField id={id} label={label} required={required} disabled={disabled}>
      {(control) => (
        <Select value={selection} onValueChange={select} disabled={disabled} required={required}>
          <SelectTrigger {...control}>
            <SelectValue placeholder={`Select a ${label.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent position="popper">
            {required ? null : <SelectItem value="default">Provider default</SelectItem>}
            {options.map((option) => (
              <SelectItem key={option.id} value={`option:${option.id}`}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}
