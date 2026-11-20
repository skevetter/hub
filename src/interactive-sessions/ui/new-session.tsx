import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useId, useMemo, useRef, useState } from "react";

import { useActiveAccount } from "../../auth/active-account.js";
import type { TeamMember } from "../../auth/organization-contract.js";
import { Card, CardSkeleton } from "../../components/app/card.js";
import { Combobox } from "../../components/app/combobox.js";
import { Composer } from "../../components/app/composer.js";
import { WarningAlert } from "../../components/app/failure-alert.js";
import { EmptyState } from "../../components/app/empty-state.js";
import { FormField, type FieldControl } from "../../components/app/form-field.js";
import { PageHeader, PageHeaderSkeleton } from "../../components/app/page.js";
import { Section } from "../../components/app/section.js";
import { SummaryPanel } from "../../components/app/summary-panel.js";
import { Button } from "../../components/ui/button.js";
import { useSnapshotQuery } from "../../queries/index.js";
import { listSessionProfiles, startInteractiveSession, type ProfileView } from "../functions.js";
import { ParticipantList, ParticipantPicker, type Participant } from "./session-participants.js";
import { SessionLoadFailure, SessionsUnavailable, refusalMessage } from "./session-states.js";
import type { ParticipantRole } from "../types.js";

const DESCRIPTION = "Choose where the agent runs, then send the first message.";
const NO_MEMBERS: readonly TeamMember[] = [];

export function NewSessionLoading() {
  return (
    <div aria-busy="true" aria-label="Loading session profiles">
      <PageHeaderSkeleton description={DESCRIPTION} />
      <CardSkeleton />
    </div>
  );
}

export function NewSessionPanel({
  organizationSlug,
  profiles,
}: {
  organizationSlug: string;
  profiles: Awaited<ReturnType<typeof listSessionProfiles>>;
}) {
  const account = useActiveAccount();
  const params = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  const active = useMemo(
    () =>
      profiles.status === "ok" && Array.isArray(profiles.data)
        ? profiles.data.filter(({ status }) => status === "active")
        : undefined,
    [profiles],
  );
  if (
    profiles.status === "ok" &&
    !Array.isArray(profiles.data) &&
    profiles.data.code === "not_found"
  )
    return <SessionsUnavailable />;
  let body = <SessionLoadFailure title="Session profiles unavailable" error={profiles} />;
  if (active?.length === 0) {
    const canManage =
      account.features?.interactiveSessions === true && account.capabilities.manageResources;
    body = (
      <EmptyState
        title="No active session profiles"
        {...(canManage
          ? {}
          : { description: "Ask an organization admin to create a session profile." })}
      >
        {canManage ? (
          <Button asChild>
            <Link to="/o/$organizationSlug/sessions/profiles" params={params}>
              Create a profile
            </Link>
          </Button>
        ) : null}
      </EmptyState>
    );
  } else if (active !== undefined) {
    body = <CreateSessionForm organizationSlug={organizationSlug} profiles={active} />;
  }
  return (
    <>
      <PageHeader title="New session" description={DESCRIPTION} />
      {body}
    </>
  );
}

export function HomeSessionStart({ organizationSlug }: { organizationSlug: string }) {
  const list = useServerFn(listSessionProfiles);
  const accountId = useActiveAccount().account.id;
  const profiles = useSnapshotQuery({
    queryKey: ["session-profiles", organizationSlug, accountId],
    queryFn: () => list({ data: { organizationSlug } }),
  });
  const active = useMemo(
    () =>
      Array.isArray(profiles.data) ? profiles.data.filter(({ status }) => status === "active") : [],
    [profiles.data],
  );
  if (active.length === 0) return null;
  return (
    <Section>
      <Card
        title="Start a session"
        description="Pick where it runs, then say what you want done. The agent works on your daemon."
      >
        <CreateSessionForm
          key={organizationSlug}
          organizationSlug={organizationSlug}
          profiles={active}
          compact
        />
      </Card>
    </Section>
  );
}

function CreateSessionForm({
  organizationSlug,
  profiles,
  compact = false,
}: {
  organizationSlug: string;
  profiles: readonly ProfileView[];
  compact?: boolean;
}) {
  const account = useActiveAccount();
  const navigate = useNavigate();
  const start = useServerFn(startInteractiveSession);
  const [profileId, setProfileId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<{ fingerprint: string; key: string }>(undefined);
  const inFlight = useRef(false);
  const profile =
    profiles.find(({ id }) => id === profileId) ?? (profileId === "" ? profiles[0] : undefined);
  const members = useMemo(
    () =>
      account.organization.slug === organizationSlug
        ? account.team.members.filter(({ userId }) => userId !== account.account.id)
        : NO_MEMBERS,
    [account, organizationSlug],
  );
  const params = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  const secondaryAction = useMemo(
    () => (
      <Button asChild variant="outline">
        {compact ? (
          <Link to="/o/$organizationSlug/sessions/new" params={params}>
            More options
          </Link>
        ) : (
          <Link to="/o/$organizationSlug/sessions" params={params}>
            Cancel
          </Link>
        )}
      </Button>
    ),
    [compact, params],
  );

  const select = useCallback(({ value }: { value: string }) => setProfileId(value), []);
  const change = useCallback(
    (userId: string, role: ParticipantRole | null) => {
      const member = members.find((candidate) => candidate.userId === userId);
      setParticipants((current) => {
        if (role === null) return current.filter((participant) => participant.userId !== userId);
        if (current.some((participant) => participant.userId === userId))
          return current.map((participant) =>
            participant.userId === userId ? { ...participant, role } : participant,
          );
        return member === undefined || current.length >= 20
          ? current
          : [...current, { userId, role, name: member.name }];
      });
    },
    [members],
  );

  const submit = useCallback(
    async (message: string) => {
      if (inFlight.current || profile === undefined) return false;
      const data = {
        organizationSlug,
        profileId: profile.id,
        profileVersion: profile.version,
        message,
        participants: participants.map(({ userId, role }) => ({ userId, role })),
      };
      const fingerprint = JSON.stringify(data);
      const idempotencyKey =
        request.current?.fingerprint === fingerprint ? request.current.key : crypto.randomUUID();
      request.current = { fingerprint, key: idempotencyKey };
      inFlight.current = true;
      setBusy(true);
      setError(undefined);
      try {
        const result = await start({ data: { ...data, idempotencyKey } });
        if (result.status === "error") setError(result.error.message);
        else if (result.data.outcome === "refused") setError(refusalMessage(result.data.code));
        else {
          await navigate({
            to: "/o/$organizationSlug/sessions/$sessionId",
            params: { organizationSlug, sessionId: result.data.sessionId },
          });
          request.current = undefined;
          return true;
        }
      } catch {
        setError("Could not start the session. Try again.");
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
      return false;
    },
    [navigate, organizationSlug, participants, profile, start],
  );

  return (
    <div className={compact ? "grid min-w-0 gap-4" : "grid min-w-0 max-w-2xl gap-6"}>
      <ProfilesPicker
        profiles={profiles}
        value={profileId || profile?.id || ""}
        onChange={select}
        compact={compact}
        disabled={busy}
      />
      {compact || profile === undefined ? null : <ProfileSummary profile={profile} />}
      {profile?.mode === "full" ? (
        <WarningAlert title="Full access">
          This agent runs tools without asking. Controllers can use it to run commands on the
          daemon.
        </WarningAlert>
      ) : null}
      {compact ? null : (
        <Section
          title="Participants"
          description="Controllers can send messages. Viewers can only read. You are a controller."
        >
          {participants.length === 0 ? null : (
            <ParticipantList
              participants={participants}
              accountId={account.account.id}
              onChange={change}
              editing
              disabled={busy}
            />
          )}
          <ParticipantPicker
            members={members}
            participants={participants}
            onChange={change}
            disabled={busy || participants.length >= 20}
          />
        </Section>
      )}
      <Composer
        agentState="idle"
        busy={busy}
        error={error}
        disabledReason={profile === undefined ? "Choose an active profile." : undefined}
        messageLabel="First message"
        primaryLabel="Start session"
        placeholder="What should the agent do?"
        hint="Ctrl or Cmd+Enter starts the session."
        onSteer={submit}
        onQueue={submit}
        secondaryAction={secondaryAction}
      />
    </div>
  );
}

function ProfilesPicker({
  profiles,
  value,
  onChange,
  compact,
  disabled,
}: {
  profiles: readonly ProfileView[];
  value: string;
  onChange: (option: { value: string }) => void;
  compact: boolean;
  disabled: boolean;
}) {
  const id = useId();
  const options = useMemo(
    () =>
      profiles.map(({ id: profileId, name: label, daemonSlug }) => ({
        value: profileId,
        label,
        detail: daemonSlug ?? "",
      })),
    [profiles],
  );
  const picker = useCallback(
    (control: FieldControl) => (
      <Combobox
        {...control}
        value={value}
        options={options}
        onChange={onChange}
        placeholder="Choose a profile"
        empty="No profiles match."
      />
    ),
    [onChange, options, value],
  );
  return (
    <FormField
      id={id}
      label="Profile"
      {...(compact
        ? {}
        : {
            description:
              "A profile fixes the daemon, directory, harness, model and mode. An admin sets these up.",
          })}
      disabled={disabled}
    >
      {picker}
    </FormField>
  );
}

function ProfileSummary({ profile }: { profile: ProfileView }) {
  const rows = useMemo(
    () => [
      { label: "Daemon", value: profile.daemonSlug ?? "Unavailable" },
      { label: "Directory", value: <span className="font-mono">{profile.cwd}</span> },
      { label: "Harness", value: profile.provider },
      { label: "Model", value: profile.model ?? "Provider default" },
      { label: "Mode", value: profile.mode ?? "Provider default" },
    ],
    [profile],
  );
  return (
    <Section title="This session will use">
      <SummaryPanel label="Session configuration" rows={rows} />
    </Section>
  );
}
