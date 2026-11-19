# Run payload retention

**Rollback after redaction.** Set the mode to `off` first and keep every Hub binary at the
build that added launch and session expiry or newer. Once `on` has removed a launch intent
or reduced session options, never run build 14 or older against that database. Build 14
can resume a previously credentialed agent and write removed session options back.

Hub can expire run-owned content after a terminal run has a recorded completion time. The
retention window starts at completion. A run becomes old enough strictly after that window
and stays eligible only while its work is settled.

| Setting                                          | Default | Accepted values                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY`                   | `off`   | `off` skips the sweep. `count` reports eligibility and fills missing credential facts. `on` redacts eligible content. After `on` removes a launch intent or reduces session options, set the mode to `off` first for rollback and keep every binary at this build or newer. Never run build 14 or older. It can reuse credentialed agents and restore removed options. |
| `PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS`           | `30`    | Whole days from 1 to 365.                                                                                                                                                                                                                                                                                                                                              |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS` | `50`    | A positive whole number. Caps credential facts filled and run, launch and session redactions per sweep.                                                                                                                                                                                                                                                                |

Set these environment variables on the Hub process and restart. The run payload and timeline
windows are configured independently. Hub rejects startup in `on` mode when the payload
window is shorter than `PASEO_HUB_TIMELINE_RETENTION_DAYS`. Count mode accepts a shorter
window so operators can evaluate it.

The worker starts in the background after startup and runs hourly. Count mode reports the
number and oldest age of eligible and blocked rows without logging content. Both `count`
and `on` can write missing credential facts when the stored launch intent proves them.
Only `on` can redact payloads.
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
labels, and the recorded credential fact used to rotate sessions. Hub starts a fresh agent
for an idle session if any execution used temporary credentials or its credential history
cannot be determined. Unknown credential history blocks expiry. A running finish-tool
acknowledgement keeps the launch intent
and its session options until the acknowledgement settles. Hub reduces creation options for
old, bound sessions with completed bootstrap and settled owners. The session keeps its continuation key,
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

Build 13 and earlier can also expose a retained receipt body or restore redacted step output.
