import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { FailureAlert, type Failure } from "../../components/app/failure-alert.js";
import { PageHeader } from "../../components/app/page.js";
import { Section } from "../../components/app/section.js";
import { Button } from "../../components/ui/button.js";
import type { SessionSnapshot } from "../functions.js";
import { pillTone, sessionState } from "../../components/app/state-label.js";

export function SessionsUnavailable() {
  return (
    <>
      <PageHeader title="Sessions unavailable" />
      <FailureAlert
        title="Sessions unavailable"
        error={null}
        fallback="Sessions are unavailable."
      />
    </>
  );
}

export function MissingSession({ organizationSlug }: { organizationSlug: string }) {
  const params = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  return (
    <Section>
      <FailureAlert
        title="Session unavailable"
        error={null}
        fallback="This session is unavailable."
      />
      <Link
        to="/o/$organizationSlug/sessions"
        params={params}
        className="text-link hover:underline"
      >
        Back to sessions
      </Link>
    </Section>
  );
}

export function SessionLoadFailure({ title, error }: { title: string; error?: Failure }) {
  const router = useRouter();
  const retry = useCallback(() => void router.invalidate(), [router]);
  return (
    <FailureAlert
      title={title}
      error={error}
      fallback="The session request could not be completed."
      onRetry={retry}
    />
  );
}

export function SessionRouteError() {
  return <SessionLoadFailure title="Sessions unavailable" />;
}

export function NewSessionLink({ organizationSlug }: { organizationSlug: string }) {
  const params = useMemo(() => ({ organizationSlug }), [organizationSlug]);
  return (
    <Button asChild>
      <Link to="/o/$organizationSlug/sessions/new" params={params}>
        New session
      </Link>
    </Button>
  );
}

export function sessionStatus(session: SessionSnapshot["session"]) {
  return sessionState(session.state, session.stateReason);
}

export function sessionPill(session: SessionSnapshot["session"]) {
  const { label, tone } = sessionStatus(session);
  return { label, tone: pillTone(tone) };
}

const refusalMessages: Readonly<Record<string, string>> = {
  not_found: "This session is unavailable.",
  forbidden: "You no longer have permission to do that.",
  profile_changed: "This profile changed. Reload the page and review it before starting.",
  profile_unavailable: "This profile is no longer available.",
  daemon_unavailable: "The daemon is unavailable. Try again when it reconnects.",
  active_limit: "This daemon has reached its active session limit.",
  usage_limit: "The organization has reached its execution limit.",
  queue_full: "The message queue is full. Try again after a message is delivered.",
  rate_limited: "Too many messages were sent recently. Try again shortly.",
  stale_generation: "The session agent changed. Review the session and try again.",
  session_closed: "This session is closed.",
  session_failed: "The session agent failed.",
  session_stopping: "Wait for the agent to stop, then try again.",
  waiting_permission: "The agent is waiting for permission. Queue the message instead.",
  not_stoppable: "The agent has no running turn to stop.",
  last_controller: "Keep at least one controller in the session.",
  invalid_participant: "Choose a current member of this organization.",
  not_retryable: "This message can no longer be sent again.",
  message_too_long: "Message is over 16 KiB.",
};

export function refusalMessage(code: string) {
  return Object.hasOwn(refusalMessages, code)
    ? refusalMessages[code]
    : "The session request could not be completed.";
}
