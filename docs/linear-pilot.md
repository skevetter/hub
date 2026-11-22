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

The daemon accepts an agent ID for an interrupt. A person driving the same agent
directly through Paseo on the daemon can start a turn between Hub's check and
the interrupt. Use Linear as the command source for the pilot agent. A future
daemon-side turn ID check would close this race.
