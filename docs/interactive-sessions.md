# Interactive sessions

Interactive sessions let organization members work with an agent on an enrolled Paseo daemon.
A session profile pins the daemon, working directory, optional worktree, provider, model and
permission mode. The daemon validates provider settings. Hub creates a foreground agent with the
profile's settings and sends the messages participants enter. The daemon needs the
`hub.execute` permission and support for the agent RPCs and request receipts.

Set these variables on the Hub process and restart it.

| Setting                                     | Default | Accepted values                                                                                             |
| ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `PASEO_HUB_INTERACTIVE_SESSIONS`            | `false` | `true` or `false`.                                                                                          |
| `PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON`   | `4`     | Whole numbers from 1 to 50. Counts sessions that have yet to be closed.                                     |
| `PASEO_HUB_SESSION_MAX_QUEUED`              | `20`    | Whole numbers from 1 to 100. Caps unsettled messages per session.                                           |
| `PASEO_HUB_SESSION_MAX_MESSAGES_PER_MINUTE` | `10`    | Whole numbers from 1 to 600. Counts new messages from each person in each session over the previous minute. |

Hub rejects invalid values on startup. With sessions disabled, Hub skips session recovery and
daemon watches, and session requests return `not_found`.

## Create a session profile

As an organization owner or admin, open **Sessions**, select **Profiles**, then choose
**Create a profile**. Name the profile, select a connected daemon with `hub.execute`, and enter
an absolute working directory on that daemon. Admins use daemons enrolled with their own Paseo
CLI credentials.

Choose a provider and its settings from the daemon's catalog. For OMP, choose the mode
explicitly. If you choose full access, check **Run every tool without asking** to confirm.
If each session needs its own branch, select **Use a new branch per session** and optionally
enter a base branch. Select **Create profile** to make it available in **New session**.

Use the profile's row menu to edit, disable, or re-enable it. Disabling a profile prevents new
sessions from using it. Admins can change profiles they created. Owners can change any profile.
The daemon must be connected when you save a change.

## Work in a session

A participant with control can steer the current turn or queue a message for the next idle
turn. A steer can overtake queued messages. Stop interrupts the active turn and discards unsent
messages. When the daemon reconnects after a disconnect or Hub restart, Hub re-watches the
recorded agent and resumes eligible pending work. Close leaves the daemon workspace available.

Run interactive sessions on a single Hub process. Database claims and daemon request receipts
protect command delivery across processes, but each daemon socket and live transcript watch has
one local owner. With two Hubs, the owner may miss a wakeup or relay text briefly after the other
process accepts a close.

Changing session participants triggers an immediate stream access check. When someone loses
organization membership outside the session, an open stream can take up to 60 seconds to recheck
that membership. New requests check current membership.

PostgreSQL times command leases using its own clock. Retry backoff uses elapsed time on Hub.
The Hub clock supplies message timestamps, rate windows and retention cutoffs. A clock jump
forward can expire and permanently remove bodies early when expiry is on. Message order follows
the stored ordinal.

## Message retention

Session message bodies use `PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS` from
[run payload retention](run-payload-retention.md), which defaults to 30 days. Age is measured
from the message's creation time. A message exactly at the cutoff is retained.
`PASEO_HUB_RUN_PAYLOAD_EXPIRY` controls the sweep.

- `off` keeps stored human message bodies.
- `count` logs only the number of eligible session message bodies and keeps them.
- `on` hides older bodies from Hub reads and clears them from the live database in batches of
  up to 200. The transcript marks the entries as **Message expired**. Hub keeps message and
  delivery metadata.

Hub relays assistant text and reads its history from the daemon. The session sweep covers the
Hub database. Daemon transcripts, database backups and browser copies have their own lifetimes.
