# Run payload retention

Hub can expire run-owned content after a terminal run has a recorded completion time. The
retention window starts at completion. A run becomes old enough strictly after that window
and stays eligible only while its work is settled.

| Setting                                          | Default | Accepted values                                                                            |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY`                   | `off`   | `off` skips the sweep, `count` reports eligibility, and `on` redacts eligible run content. |
| `PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS`           | `30`    | Whole days from 1 to 365.                                                                  |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS` | `50`    | A positive whole number. Caps completed redactions per sweep in `on` mode.                 |

Set these environment variables on the Hub process and restart. The run payload and timeline
windows are configured independently. Hub rejects startup in `on` mode when the payload
window is shorter than `PASEO_HUB_TIMELINE_RETENTION_DAYS`. Count mode accepts a shorter
window so operators can evaluate it.

The worker starts in the background after startup and runs hourly. Count mode reports the
number and oldest age of eligible and blocked runs without changing rows or logging content.
Pending workflow work, execution or script cleanup, unresolved receipt fan-out, terminal
notifications and reporter work can keep old runs ineligible. Ordinary provider receipts
need a pinned route snapshot with an admitted branch for every workflow for that provider.
If Hub cannot prove that from stored rows, the receipt counts as unresolved fan-out. Hub also counts terminal runs
that lack a completion time. Apply mode records expiry before clearing child rows in batches,
and resumes interrupted redactions after a restart in `on` mode.

The run page marks expired content and keeps status, dates, step summaries, and available
counts and links. Deduplication still recognizes the original delivery and run identity.
Deploy expiry-aware Hub code on all writers before enabling `on`. Back up the database and
review a count run before enabling redaction. Stopping the sweep or increasing its window
cannot restore redacted content.

This policy covers logical redaction in the live Hub database. Backups, WAL, old tuples, logs,
daemon transcripts, and provider comments and files are outside this policy. Receipts still
hold the raw event body and are scheduled for expiry in a later build. This build also keeps
launch intents and sessions.

Set the mode to `off` before a rollback. Keep every binary at this build or newer while
`on` is enabled or after it has redacted any content. Build 12 and earlier bypass both
expiry fences. Their activity reads can return the retained receipt body, and their script
output writers can restore content to a redacted step.
