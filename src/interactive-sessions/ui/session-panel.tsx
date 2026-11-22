import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useRef, useState } from "react";

import { useActiveAccount } from "../../auth/active-account.js";
import type { TeamMember } from "../../auth/organization-contract.js";
import { Card } from "../../components/app/card.js";
import { Composer, type ComposerAgentState } from "../../components/app/composer.js";
import { ConfirmAction } from "../../components/app/confirm-action.js";
import { FailureAlert, NoticeAlert, WarningAlert } from "../../components/app/failure-alert.js";
import { PageHeader, PageHeaderSkeleton } from "../../components/app/page.js";
import { RelativeTime } from "../../components/app/relative-time.js";
import { Section } from "../../components/app/section.js";
import { StatusLine } from "../../components/app/status-line.js";
import { SummaryPanel } from "../../components/app/summary-panel.js";
import { Transcript, TranscriptSkeleton } from "../../components/app/transcript.js";
import { Button } from "../../components/ui/button.js";
import type { Result } from "../../contract/respond.js";
import {
  closeSession,
  readInteractiveSession,
  replaceSessionAgent,
  retrySessionMessage,
  sendSessionMessage,
  setSessionParticipant,
  stopSession,
  type SessionSnapshot,
} from "../functions.js";
import type { Delivery, ParticipantRole } from "../types.js";
import { ParticipantList, ParticipantPicker } from "./session-participants.js";
import {
  MissingSession,
  SessionLoadFailure,
  refusalMessage,
  sessionStatus,
} from "./session-states.js";
import { useSessionStream } from "./use-session-stream.js";

export function SessionDetailLoading() {
  return (
    <div aria-busy="true" aria-label="Loading session">
      <PageHeaderSkeleton />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <Card>
          <TranscriptSkeleton />
        </Card>
      </div>
    </div>
  );
}

export function SessionDetailPanel({
  organizationSlug,
  result,
}: {
  organizationSlug: string;
  result: Awaited<ReturnType<typeof readInteractiveSession>> | null;
}) {
  if (result?.status === "error")
    return <SessionLoadFailure title="Session unavailable" error={result} />;
  if (result === null || "outcome" in result.data)
    return <MissingSession organizationSlug={organizationSlug} />;
  return <LiveSession initial={result.data} organizationSlug={organizationSlug} />;
}

function LiveSession({
  initial,
  organizationSlug,
}: {
  initial: SessionSnapshot;
  organizationSlug: string;
}) {
  const stream = useSessionStream(organizationSlug, initial);
  if (stream.view.snapshot === null) return <MissingSession organizationSlug={organizationSlug} />;
  return (
    <SessionContent
      stream={stream}
      snapshot={stream.view.snapshot}
      organizationSlug={organizationSlug}
    />
  );
}

interface SessionViewProps {
  organizationSlug: string;
  stream: ReturnType<typeof useSessionStream>;
  snapshot: SessionSnapshot;
}

function SessionContent({ stream, snapshot, organizationSlug }: SessionViewProps) {
  const { session } = snapshot;
  const { view, refresh } = stream;
  const daemon = session.daemon.slug;
  const location = daemon === "" ? null : `on ${daemon}`;
  const description = [session.provider, session.model, session.mode, location]
    .filter(Boolean)
    .join(", ");
  const rows = useMemo(
    () => [
      { label: "Started from", value: "Web" },
      { label: "Started", value: <RelativeTime value={session.createdAt} /> },
      { label: "Profile", value: session.profile.name },
    ],
    [session.createdAt, session.profile.name],
  );
  return (
    <>
      <PageHeader title={session.title} description={description} status={sessionStatus(session)}>
        <SessionControls
          organizationSlug={organizationSlug}
          snapshot={snapshot}
          refresh={refresh}
        />
      </PageHeader>
      <SessionNotices
        organizationSlug={organizationSlug}
        session={session}
        reconnecting={view.reconnecting}
        missedUpdates={view.missedUpdates}
        history={view.history}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <SessionConversation
          organizationSlug={organizationSlug}
          stream={stream}
          snapshot={snapshot}
        />
        <div className="min-w-0">
          <SessionPeople
            organizationSlug={organizationSlug}
            snapshot={snapshot}
            refresh={refresh}
          />
          <Section title="Session">
            <SummaryPanel label="Session information" rows={rows} />
          </Section>
        </div>
      </div>
    </>
  );
}

function SessionConversation({ stream, snapshot, organizationSlug }: SessionViewProps) {
  const { session, capabilities } = snapshot;
  const { view, items, refresh, loadOlder } = stream;
  const { id: sessionId, state, generation, daemon } = session;
  const send = useServerFn(sendSessionMessage);
  const retry = useServerFn(retrySessionMessage);
  const { run, busy, error } = useSessionAction(refresh);
  const offline = daemon.connection === "offline";
  const closed = state === "closed";
  const writable = capabilities.send && !closed && state !== "failed";
  const shouldQueue = offline || state === "starting";

  const sendWith = useCallback(
    (message: string, delivery: Delivery) =>
      run([generation, delivery, message], (idempotencyKey) =>
        send({
          data: { organizationSlug, sessionId, generation, message, delivery, idempotencyKey },
        }),
      ),
    [generation, organizationSlug, run, send, sessionId],
  );
  const steer = useCallback(
    (message: string) => sendWith(message, shouldQueue ? "queue" : "steer"),
    [sendWith, shouldQueue],
  );
  const queue = useCallback((message: string) => sendWith(message, "queue"), [sendWith]);
  const sendAgain = useCallback(
    (commandId: string) => {
      void run([generation, "retry", commandId], (idempotencyKey) =>
        retry({ data: { organizationSlug, sessionId, generation, commandId, idempotencyKey } }),
      );
    },
    [generation, organizationSlug, retry, run, sessionId],
  );
  const stopping = state === "stopping";
  const canRetry = writable && !shouldQueue && !stopping && state !== "waiting_permission";
  const mode = composerMode(state, shouldQueue);
  let composer = null;
  if (writable) {
    composer = (
      <Composer
        agentState={mode}
        busy={busy}
        error={error}
        disabledReason={stopping ? "Wait for the agent to stop." : undefined}
        primaryLabel={shouldQueue ? "Queue for next turn" : "Send"}
        placeholder={
          state === "idle" ? "Send a message to continue" : "Steer the agent or queue a note"
        }
        hint={composerHint(mode, shouldQueue)}
        onSteer={steer}
        onQueue={queue}
      />
    );
  } else if (!closed && !capabilities.send) {
    composer = <StatusLine>View only. A controller can send messages.</StatusLine>;
  }
  return (
    <div className="grid min-w-0 content-start gap-4">
      <Card>
        {view.agent.before === null ? null : (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadOlder}
              disabled={view.loadingOlder}
            >
              {view.loadingOlder ? "Loading..." : "Load earlier replies"}
            </Button>
          </div>
        )}
        <Transcript
          items={items}
          version={view.version}
          working={state === "running" && !offline}
          announcement={stopping ? "Stopping..." : view.announcement}
          onRetry={canRetry ? sendAgain : undefined}
          retryBusy={busy}
        />
      </Card>
      {composer === null ? null : (
        // Docked on phones so the box stays reachable under a long transcript.
        <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background px-4 py-3 md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
          {composer}
        </div>
      )}
    </div>
  );
}

function composerMode(
  state: SessionSnapshot["session"]["state"],
  queue: boolean,
): ComposerAgentState {
  if (queue || state === "idle" || state === "stopping") return "idle";
  return state === "waiting_permission" ? "waiting_permission" : "running";
}

function composerHint(mode: ComposerAgentState, queue: boolean) {
  if (queue) return "Ctrl or Cmd+Enter queues the message.";
  if (mode === "waiting_permission") return undefined;
  return mode === "idle" ? "Ctrl or Cmd+Enter sends." : "Ctrl or Cmd+Enter steers.";
}

const NO_MEMBERS: readonly TeamMember[] = [];

function SessionPeople({
  organizationSlug,
  snapshot,
  refresh,
}: {
  organizationSlug: string;
  snapshot: SessionSnapshot;
  refresh: () => Promise<boolean>;
}) {
  const { session, participants, capabilities } = snapshot;
  const { id: sessionId, startedBy, state } = session;
  const account = useActiveAccount();
  const setParticipant = useServerFn(setSessionParticipant);
  const { run, busy, error } = useSessionAction(refresh);
  const changeParticipant = useCallback(
    (userId: string, role: ParticipantRole | null) => {
      void run([userId, role], () =>
        setParticipant({ data: { organizationSlug, sessionId, userId, role } }),
      );
    },
    [setParticipant, organizationSlug, run, sessionId],
  );
  const members =
    account.organization.slug === organizationSlug ? account.team.members : NO_MEMBERS;
  const manage = capabilities.manageParticipants && state !== "closed";
  return (
    <Section title="Participants">
      <ParticipantList
        participants={participants}
        startedBy={startedBy?.userId}
        accountId={account.account.id}
        onChange={manage ? changeParticipant : undefined}
        disabled={busy}
      />
      {manage ? (
        <ParticipantPicker
          members={members}
          participants={participants}
          onChange={changeParticipant}
          disabled={busy}
        />
      ) : null}
      {error === undefined ? null : (
        <FailureAlert title="Could not change participants" error={error} fallback="Try again." />
      )}
    </Section>
  );
}

function SessionNotices({
  organizationSlug,
  session,
  reconnecting,
  missedUpdates,
  history,
}: {
  organizationSlug: string;
  session: SessionSnapshot["session"];
  reconnecting: boolean;
  missedUpdates: boolean;
  history: ReturnType<typeof useSessionStream>["view"]["history"];
}) {
  const { daemon, state, stateReason } = session;
  const offline = daemon.connection === "offline";
  const waiting = state === "waiting_permission";
  const historyMissing = history === "history_unavailable" || history === "agent_missing";
  const failed = state === "failed" || (state === "closed" && stateReason === "launch_failed");
  const stopped = state === "idle" && stateReason === "stopped_by_person";
  const closed = state === "closed";
  const params = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  const daemonLink = useMemo(
    () => (
      <Button asChild variant="outline" size="sm">
        <Link to="/o/$organizationSlug/daemons" params={params}>
          Open Daemons
        </Link>
      </Button>
    ),
    [params],
  );
  return (
    <>
      {reconnecting ? <StatusLine>Live updates paused, reconnecting.</StatusLine> : null}
      {missedUpdates && !offline ? <StatusLine>Some live updates were missed.</StatusLine> : null}
      {offline ? (
        <WarningAlert
          standalone
          title={daemon.slug ? `Daemon ${daemon.slug} is offline` : "The daemon is offline"}
          action={daemonLink}
        >
          Your messages are kept and wait for it to reconnect. Agent replies load when the daemon
          reconnects.
        </WarningAlert>
      ) : null}
      {!offline && historyMissing ? (
        <WarningAlert standalone title="Agent history unavailable">
          The transcript still shows messages already loaded.
        </WarningAlert>
      ) : null}
      {waiting ? (
        <WarningAlert standalone title="The agent is waiting for permission">
          Answer the prompt in the Paseo app on {daemon.slug || "the daemon"}. You can queue a
          message while you wait.
        </WarningAlert>
      ) : null}
      {failed ? (
        <FailureAlert
          standalone
          title="Session agent failed"
          error={null}
          fallback={sessionFailure(stateReason)}
        />
      ) : null}
      {stateReason === "stop_unconfirmed" ? (
        <WarningAlert standalone title="Stop could not be confirmed">
          Check the agent on the daemon before stopping it again.
        </WarningAlert>
      ) : null}
      {stopped ? (
        <NoticeAlert standalone tone="neutral" title="Stopped">
          The agent stopped mid-step. Send a message to continue from here.
        </NoticeAlert>
      ) : null}
      {closed ? (
        <NoticeAlert standalone tone="neutral" title="Session closed">
          The transcript remains readable.
        </NoticeAlert>
      ) : null}
    </>
  );
}

function sessionFailure(reason: SessionSnapshot["session"]["stateReason"]) {
  if (reason === "agent_missing") return "The agent is no longer available on the daemon.";
  if (reason === "daemon_revoked") return "The daemon's access was revoked.";
  return "The agent could not be started.";
}

function SessionControls({
  organizationSlug,
  snapshot,
  refresh,
}: {
  organizationSlug: string;
  snapshot: SessionSnapshot;
  refresh: () => Promise<boolean>;
}) {
  const { session, capabilities, participants } = snapshot;
  const { id: sessionId, state, generation } = session;
  const stop = useServerFn(stopSession);
  const close = useServerFn(closeSession);
  const replace = useServerFn(replaceSessionAgent);
  const { busy, error, run } = useSessionAction(refresh);
  const command = useCallback(
    (kind: "stop" | "close" | "replace") => {
      const operation = { stop, close, replace }[kind];
      void run([kind, generation], (idempotencyKey) =>
        operation({ data: { organizationSlug, sessionId, generation, idempotencyKey } }),
      );
    },
    [close, generation, organizationSlug, replace, run, sessionId, stop],
  );
  const stopAgent = useCallback(() => command("stop"), [command]);
  const closeAgent = useCallback(() => command("close"), [command]);
  const replaceAgent = useCallback(() => command("replace"), [command]);
  if (state === "closed" && error === undefined) return null;
  return (
    <div className="grid min-w-0 max-w-64 justify-items-start gap-2 sm:justify-items-end">
      <div className="flex flex-wrap items-center gap-2">
        {capabilities.stop && (state === "running" || state === "waiting_permission") ? (
          <ConfirmAction
            label="Stop"
            title="Stop this agent?"
            busy={busy}
            destructive
            confirmLabel="Stop agent"
            cancelLabel="Cancel"
            onConfirm={stopAgent}
            description={
              participants.length > 1
                ? "Everyone on this shared session will see the agent stop. Its current step will be interrupted. Saved work stays."
                : "The agent's current step will be interrupted. Saved work stays."
            }
          />
        ) : null}
        {capabilities.close && state !== "closed" ? (
          <ConfirmAction
            label="Close"
            title="Close this session?"
            busy={busy}
            confirmLabel="Close session"
            cancelLabel="Cancel"
            onConfirm={closeAgent}
            description="Nobody can send messages after it closes. The transcript stays readable."
          />
        ) : null}
        {capabilities.replaceAgent && state === "failed" ? (
          <Button type="button" size="sm" disabled={busy} onClick={replaceAgent}>
            Start new agent
          </Button>
        ) : null}
      </div>
      {error === undefined ? null : (
        <FailureAlert title="Session action failed" error={error} fallback="Try again." />
      )}
    </div>
  );
}

type ActionResult = Result<{ outcome: "accepted" } | { outcome: "refused"; code: string }>;

function useSessionAction(refresh: () => Promise<boolean>) {
  const request = useRef<{ fingerprint: string; key: string }>(undefined);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(
    async (input: readonly unknown[], action: (key: string) => Promise<ActionResult>) => {
      if (inFlight.current) return false;
      const fingerprint = JSON.stringify(input);
      const key =
        request.current?.fingerprint === fingerprint ? request.current.key : crypto.randomUUID();
      request.current = { fingerprint, key };
      inFlight.current = true;
      setError(undefined);
      setBusy(true);
      try {
        const result = await action(key);
        if (result.status === "error") setError(result.error.message);
        else if (result.data.outcome === "refused") {
          setError(refusalMessage(result.data.code));
          void refresh();
        } else {
          request.current = undefined;
          void refresh();
          return true;
        }
      } catch {
        setError("The session request could not be completed. Try again.");
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
      return false;
    },
    [refresh],
  );
  return { busy, error, run };
}
