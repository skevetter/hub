# Interactive sessions

Interactive sessions let organization members work with an agent on an enrolled Paseo daemon.
A session profile pins the daemon, working directory, optional worktree, provider, model and
permission mode. The daemon validates provider settings. Hub creates a foreground agent with the
profile's settings and sends the messages participants enter. The daemon needs the
`hub.execute` permission and support for the agent RPCs and request receipts.

Set these variables on the Hub process and restart it.

| Setting                                   | Default | Accepted values                                                         |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `PASEO_HUB_INTERACTIVE_SESSIONS`          | `false` | `true` or `false`.                                                      |
| `PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON` | `4`     | Whole numbers from 1 to 50. Counts sessions that have yet to be closed. |
| `PASEO_HUB_SESSION_MAX_QUEUED`            | `20`    | Whole numbers from 1 to 100. Caps unsettled messages per session.       |

Hub rejects invalid values on startup. With sessions disabled, Hub skips session recovery and
daemon watches, and session requests return `not_found`.

A participant with control can steer the current turn or queue a message for the next idle
turn. A steer can overtake queued messages. Stop interrupts the active turn and discards unsent
messages. When the daemon reconnects after a disconnect or Hub restart, Hub re-watches the
recorded agent and resumes eligible pending work. Close leaves the daemon workspace available.

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
