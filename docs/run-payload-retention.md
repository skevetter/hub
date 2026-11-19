# Run payload retention

Hub can expire run-owned content after a terminal run has a recorded completion time. The
retention window starts at completion. A run becomes old enough strictly after that window
and stays eligible only while its work is settled.

| Setting                                          | Default | Accepted values                                                                        |
| ------------------------------------------------ | ------- | -------------------------------------------------------------------------------------- |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY`                   | `off`   | `off` skips the sweep, `count` reports eligibility, and `on` redacts eligible content. |
| `PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS`           | `30`    | Whole days from 1 to 365.                                                              |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS` | `50`    | A positive whole number. Caps completed run, launch and session redactions per sweep.  |

Set these environment variables on the Hub process and restart. The run payload and timeline
windows are configured independently. Hub rejects startup in `on` mode when the payload
window is shorter than `PASEO_HUB_TIMELINE_RETENTION_DAYS`. Count mode accepts a shorter
window so operators can evaluate it.

The worker starts in the background after startup and runs hourly. Count mode reports the
number and oldest age of eligible and blocked runs without changing rows or logging content.
Pending workflow work, execution or script cleanup, unresolved receipt fan-out, terminal
notifications and reporter work can keep old runs ineligible. Ordinary provider receipts
need a persisted branch for each workflow that admission matches against the stored receipt
and the configuration revision pinned to each route. Slack and Discord receipts and Linear
delegate changes that depend on the installed app user count as unresolved fan-out because
matching requires provider state outside the receipt. Missing evidence also counts as unresolved
fan-out. Hub counts terminal runs that lack a completion time. Apply mode records expiry
before clearing child rows in batches and resumes interrupted redactions after a restart in
`on` mode.

The same window covers launch intents of settled standalone executions and executions
whose runs have already expired. Hub keeps the run association, provider and model
labels, and the recorded credential fact used to rotate sessions. Unknown credential
history blocks expiry. Hub also reduces creation options for old, bound sessions with
completed bootstrap and settled owners. The session keeps its continuation key,
identity, compatibility, tool contract and capability verifier. This includes custom
continuation keys built from event input. Unused, unbound, and incomplete sessions
remain available for recovery. Count mode also inventories legacy payloads on old,
terminated, unreferenced machines. Age is unavailable for historical sessions without
any recorded activity.

An open timeline stream checks the run's expiry marker before each buffered event and ends
with `timeline_expired` when it sees the marker. An event already read when the marker
commits may still be delivered on that open connection.

The run page marks expired content and keeps status, dates, step summaries, and available
counts and links. Deduplication still recognizes the original delivery and run identity.
Deploy expiry-aware Hub code on all writers before enabling `on`. Back up the database and
review a count run before enabling redaction. Stopping the sweep or increasing its window
cannot restore redacted content.

This policy covers logical redaction in the live Hub database. Backups, WAL, old tuples, logs,
daemon transcripts, and provider comments and files are outside this policy. Receipts still
hold the raw event body and are scheduled for expiry in a later build.

Set the mode to `off` before a rollback. Keep every binary at this build or newer while
`on` is enabled or after it has redacted any content. Build 14 can miss credentialed-session
history after a launch intent expires and can overwrite reduced options. Build 13 and
earlier can also expose a retained receipt body or restore redacted step output.
