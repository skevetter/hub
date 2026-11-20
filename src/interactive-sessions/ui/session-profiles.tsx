import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useRef, useState } from "react";
import { useActiveAccount } from "../../auth/active-account.js";
import {
  DataCell,
  DataRow,
  DataTable,
  DataTableSkeleton,
  type DataColumn,
} from "../../components/app/data-table.js";
import { FailureAlert } from "../../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../../components/app/page.js";
import { RowActions } from "../../components/app/row-actions.js";
import { Section } from "../../components/app/section.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { TwoLine } from "../../components/app/two-line.js";
import { Button } from "../../components/ui/button.js";
import { DropdownMenuItem } from "../../components/ui/dropdown-menu.js";
import { saveSessionProfile, type listSessionProfiles, type ProfileView } from "../functions.js";
import { SessionProfileForm, type ProfileFormData } from "./session-profile-form.js";
import { refusalMessage, SessionLoadFailure, SessionsUnavailable } from "./session-states.js";

const DESCRIPTION = "Choose where sessions run and what settings agents use.";
const COLUMNS = [
  { header: "Name", fill: true },
  { header: "Daemon", fill: true, className: "hidden lg:table-cell" },
  { header: "Directory", fill: true, className: "hidden lg:table-cell" },
  { header: "Provider / model", fill: true, className: "hidden lg:table-cell" },
  { header: "State" },
  { header: "", align: "end" },
] satisfies DataColumn[];

export function SessionProfilesLoading() {
  return (
    <div aria-busy="true" aria-label="Loading session profiles">
      <PageHeaderSkeleton description={DESCRIPTION} />
      <DataTableSkeleton label="Session profiles" columns={COLUMNS} />
    </div>
  );
}

export function SessionProfilesPanel({
  organizationSlug,
  result,
}: {
  organizationSlug: string;
  result: Awaited<ReturnType<typeof listSessionProfiles>>;
}) {
  const account = useActiveAccount();
  if (
    account.features?.interactiveSessions !== true ||
    !account.capabilities.manageResources ||
    (result.status === "ok" && !Array.isArray(result.data) && result.data.code === "not_found")
  ) {
    return <SessionsUnavailable />;
  }
  if (result.status === "error" || !Array.isArray(result.data)) {
    return (
      <>
        <PageHeader title="Session profiles" description={DESCRIPTION} />
        <SessionLoadFailure title="Session profiles unavailable" error={result} />
      </>
    );
  }
  return <ProfileTable organizationSlug={organizationSlug} profiles={result.data} />;
}

function ProfileTable({
  organizationSlug,
  profiles,
}: {
  organizationSlug: string;
  profiles: ProfileView[];
}) {
  const router = useRouter();
  const save = useServerFn(saveSessionProfile);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<ProfileView | null>();
  const [error, setError] = useState<string>();

  const submit = useCallback(
    async (data: ProfileFormData) => {
      if (saving.current) return "A profile save is already in progress.";
      saving.current = true;
      setBusy(true);
      try {
        const result = await save({ data: { ...data, organizationSlug } });
        if (result.status === "error") return "The profile could not be saved. Try again.";
        if (result.data.outcome === "refused") return profileSaveMessage(result.data.code);
        await router.invalidate();
        return null;
      } catch {
        return "The profile could not be saved. Try again.";
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [organizationSlug, router, save],
  );

  const close = useCallback(() => setEditor(undefined), []);
  const create = useCallback(() => {
    setError(undefined);
    setEditor(null);
  }, []);
  const edit = useCallback((profile: ProfileView) => {
    setError(undefined);
    setEditor(profile);
  }, []);
  const toggle = useCallback(
    async (profile: ProfileView) => {
      setError(undefined);
      const status = profile.status === "active" ? "disabled" : "active";
      const refusal = await submit({ ...profile, status });
      if (refusal !== null) setError(refusal);
    },
    [submit],
  );

  const createButton = useMemo(
    () => (
      <Button type="button" disabled={busy} onClick={create}>
        Create a profile
      </Button>
    ),
    [busy, create],
  );
  const empty = useMemo(
    () => ({ title: "No session profiles yet", action: createButton }),
    [createButton],
  );

  return (
    <>
      <PageHeader title="Session profiles" description={DESCRIPTION}>
        {profiles.length === 0 ? null : createButton}
      </PageHeader>
      <Section>
        {error === undefined ? null : (
          <FailureAlert title="Could not update profile" error={error} fallback="Try again." />
        )}
        <DataTable
          label="Session profiles"
          columns={COLUMNS}
          isEmpty={profiles.length === 0}
          empty={empty}
        >
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              busy={busy}
              edit={edit}
              toggle={toggle}
            />
          ))}
        </DataTable>
      </Section>
      {editor === undefined ? null : (
        <SessionProfileForm
          organizationSlug={organizationSlug}
          profile={editor}
          busy={busy}
          close={close}
          save={submit}
        />
      )}
    </>
  );
}

function ProfileRow({
  profile,
  busy,
  edit,
  toggle,
}: {
  profile: ProfileView;
  busy: boolean;
  edit: (profile: ProfileView) => void;
  toggle: (profile: ProfileView) => Promise<void>;
}) {
  const enabled = profile.status === "active";
  const daemon = profile.daemonSlug ?? "Unavailable";
  const agent =
    profile.model === null ? profile.provider : `${profile.provider} / ${profile.model}`;
  const openEditor = useCallback(() => edit(profile), [edit, profile]);
  const changeStatus = useCallback(() => void toggle(profile), [profile, toggle]);
  return (
    <DataRow>
      <DataCell>
        <span className="hidden lg:inline" title={profile.name}>
          {profile.name}
        </span>
        <div className="lg:hidden">
          <TwoLine primary={profile.name} secondary={daemon} />
        </div>
      </DataCell>
      <DataCell>{daemon}</DataCell>
      <DataCell>{profile.cwd}</DataCell>
      <DataCell>{agent}</DataCell>
      <DataCell>
        <StatusPill tone={enabled ? "success" : "neutral"}>
          {enabled ? "Enabled" : "Disabled"}
        </StatusPill>
      </DataCell>
      <DataCell>
        <RowActions label={`Actions for ${profile.name}`}>
          <DropdownMenuItem disabled={busy} onSelect={openEditor}>
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={changeStatus}>
            {enabled ? "Disable" : "Enable"}
          </DropdownMenuItem>
        </RowActions>
      </DataCell>
    </DataRow>
  );
}

export function profileSaveMessage(code: string) {
  switch (code) {
    case "profile_changed":
    case "version_conflict":
      return "This profile changed. Reload the page and try again.";
    case "name_taken":
      return "A profile with this name already exists.";
    case "invalid_mode":
      return "The daemon did not accept these provider settings.";
    case "invalid_profile":
      return "Check the profile name and enter an absolute directory on the daemon.";
    default:
      return refusalMessage(code) ?? "The profile could not be saved.";
  }
}
