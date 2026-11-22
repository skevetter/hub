# Native Linear session pilot

Use the pilot for one Linear workspace, one human, and one private Hub
[interactive session profile](interactive-sessions.md). The profile author must
be a current owner of the Hub organization.

## Enable and disable

1. Enable interactive sessions with `PASEO_HUB_INTERACTIVE_SESSIONS=true`.
2. Set `PASEO_HUB_LINEAR_PILOT` to one JSON record with `hubOrganizationId`,
   `linearOrganizationId`, `allowedHumanId`, and `profileId`. Use the Linear
   workspace ID from the signed event and the owner's Linear user ID. Use the
   exact ID of the private Hub profile.
3. Disable the overlapping legacy mention trigger before turning on **Agent
   session events** for the shared Linear app. Test a human mention from the
   configured owner. Check that the native session receives the acknowledgement
   and final response and that the legacy trigger creates no run.
4. To roll back, turn off **Agent session events**, remove the pilot setting and
   restart Hub. Restore the legacy trigger after the pilot's pending work settles.

Without the pilot setting, Hub acknowledges native session events using the
existing drop path. The pilot accepts only the configured workspace and human.
The signed event must prove who initiated the session. Hub uses the existing
[Linear reply sanitizer](linear-reply.md) for the final answer from the proven
turn.

Admitted pilot messages appear under **Other** in Dropped events with the
reason `linear_pilot_admitted`. Deploy outside active turns. Hub drops an
owner message delivered during shutdown with HTTP 200, so Linear does not retry.

## Isolation assumption

The pilot assumes Read Committed, the PostgreSQL default and the production
setting. The refresh lease sets it explicitly.

If the isolation setting changes, harden these three sites.

1. Retirement owner read after the session row lock.
   [postgres-store.ts:651](../src/interactive-sessions/postgres-store.ts#L651)
2. Reservation owner and capacity reads after the advisory locks.
   [postgres-store.ts:215](../src/interactive-sessions/postgres-store.ts#L215),
   [postgres-store.ts:805](../src/interactive-sessions/postgres-store.ts#L805)
3. Binding admission and advance run `sessionHasBinding` after `lockMutation`.
   A Repeatable Read snapshot taken before the lock wait could miss a binding
   the lock holder just wrote.
   [binding.ts:348](../src/linear-pilot/binding.ts#L348),
   [binding.ts:401](../src/linear-pilot/binding.ts#L401),
   [binding.ts:424](../src/linear-pilot/binding.ts#L424)

## Rollout conditions

Use the owner's Mac daemon for the pilot profile and dedicate it to the pilot.
Set `PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON` and the profile's `maxActive` to
the planned thread count before the first thread. For acceptance, use 12 for
both and start at most 12 Linear threads. Saving the profile later can strand
existing threads with `profile_changed`.

A native session uses capacity until a follow-up in the same thread retires
it. A failed or canceled turn, a sealed turn that lost proof, a pilot profile
edit, or a Hub restart during a turn can leave the session open without an
automatic retirement path. Hub offers no Close or Stop control for native
sessions in the pilot.

## Manual close procedure

The list query takes the pilot profile UUID as `$1` and shows open native
sessions and their current pilot binding.

```sql
SELECT s.id, s.state, s.generation, s.created_at AS started_at, b.native_session_id,
       s.daemon_id, s.daemon_agent_id
FROM interactive_sessions AS s
LEFT JOIN surface_bindings AS b
  ON b.session_id = s.id AND b.organization_id = s.organization_id
  AND b.policy_revision = 2147483647 AND b.superseded_at IS NULL
WHERE s.profile_id = $1::uuid AND s.origin = 'linear' AND s.state <> 'closed'
ORDER BY s.created_at, s.id;
```

A session in `starting` can still launch an agent until Hub is stopped. Take a
backup first, stop Hub, and wait for in-flight dispatch to settle. Re-run the
list query. Use the listed daemon and agent IDs to confirm in Paseo that the
agent has no running turn. If it does, stop it directly in Paseo and confirm
the turn has ended before closing the session.

Run the following statement as a single transaction. Bind the listed session
UUID as `$1` and the pilot profile UUID as `$2`. It locks the exact open Linear
session and records the closed state using the same fields and event as
automatic retirement. Counts of zero mean the guards found nothing to close.

```sql
WITH target AS (
  SELECT s.id, s.organization_id, statement_timestamp() AS closed_at
  FROM interactive_sessions AS s
  WHERE s.id = $1::uuid AND s.profile_id = $2::uuid
    AND s.origin = 'linear' AND s.state <> 'closed' AND s.closed_at IS NULL
    AND s.requester_identity_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM surface_bindings AS b
      WHERE b.session_id = s.id AND b.organization_id = s.organization_id
        AND b.superseded_at IS NULL AND b.policy_revision <> 2147483647
    )
  FOR UPDATE OF s
), closed AS (
  UPDATE interactive_sessions AS s
  SET state = 'closed',
      state_reason = NULL,
      closed_at = target.closed_at,
      closed_by_user_id = NULL,
      hub_seq = s.hub_seq + 1,
      last_activity_at = greatest(s.last_activity_at, target.closed_at),
      updated_at = greatest(s.updated_at, target.closed_at)
  FROM target
  WHERE s.id = target.id AND s.organization_id = target.organization_id
  RETURNING s.id, s.organization_id, s.hub_seq, s.closed_at, s.generation, s.turn
), retired AS (
  UPDATE surface_bindings AS b
  SET superseded_at = closed.closed_at
  FROM closed
  WHERE b.session_id = closed.id AND b.organization_id = closed.organization_id
    AND b.policy_revision = 2147483647 AND b.superseded_at IS NULL
  RETURNING b.id
), state_event AS (
  INSERT INTO interactive_session_events (session_id, organization_id, seq, kind, data, at)
  SELECT id, organization_id, hub_seq, 'state',
         jsonb_build_object('state', 'closed', 'stateReason', NULL,
                            'generation', generation, 'turn', turn),
         closed_at
  FROM closed
  RETURNING session_id
)
SELECT (SELECT count(*)::int FROM closed) AS sessions_closed,
       (SELECT count(*)::int FROM retired) AS bindings_retired,
       (SELECT count(*)::int FROM state_event) AS events_written;
```

In `psql`, prepend `PREPARE pilot_list(uuid) AS` or
`PREPARE pilot_close(uuid, uuid) AS` to the corresponding statement. Use
`EXECUTE pilot_list('profile UUID')` or
`EXECUTE pilot_close('session UUID', 'profile UUID')` with the actual UUIDs.

Start Hub after the close transaction commits. Closing the row releases
capacity and retires its binding. Later prompts in that thread are fenced. A
pending first command stays unsettled under the closed row, and dispatch
skips it.

## Follow-up messages

Reply in the same Linear panel after the prior answer. Hub starts a fresh
agent and supplies bounded, sanitized history from the conversation. Linear
is the source for rebuilding the conversation. Hub keeps reconstructed history
in memory for dispatch. The daemon records the submitted prompt in its own
timeline and can include it in trace logs.

While a turn is running, Hub replies `Still working on the previous message;
reply when I have answered.` The reply starts no new agent. A pending permission
stays pending until a person resolves it.

Run one Hub process for the pilot. It serializes work for each native session
locally. A second process can receive signed deliveries and read current session
state. PostgreSQL receipts deduplicate the same interaction, and the retirement
and binding comparisons allow only one advance of the prior turn. A Stop sent
to another process can remain unapplied. The interrupt requires the process
holding the live coordinator watch.

## Stop an active turn

Hub checks the active turn and sends one interrupt while it holds the pilot
session's command lock. Hub holds new turn starts until the interrupt result
is known. It posts `Stopped.` only after observing that the targeted turn
ended or was canceled. If it cannot confirm the outcome, it posts
`Stop requested; I could not confirm it stopped` and leaves further sends
blocked. Hub does not retry the interrupt automatically.

A sealed turn has lost proof of the active turn and leaves the daemon agent
running. Stop that agent directly through Paseo.
Duplicate detection checks the most recent 1024 distinct assistant block IDs per turn.

The daemon accepts an agent ID for an interrupt. A person driving the same agent
directly through Paseo on the daemon can start a turn between Hub's check and
the interrupt. Use Linear as the command source for the pilot agent. A future
daemon-side turn ID check would close this race.
