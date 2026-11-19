# Run payload retention

**Rollback after redaction.** Set `PASEO_HUB_RUN_PAYLOAD_EXPIRY=off` first. Once receipt expiry
has run, keep every Hub binary that shares the database at this release or newer. Older binaries
can replay a redacted receipt without honoring its fence. If only launch or session expiry has
run, keep all binaries at the release that added those stages or newer. Build 14 can resume a
previously credentialed agent and restore removed options.

Hub can expire run-owned content after a terminal run has a recorded completion time. The
retention window starts at completion. A run becomes old enough strictly after that window
and stays eligible only while its work is settled.

| Setting                                          | Default | Accepted values                                                                                                                                                                      |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY`                   | `off`   | `off` skips the sweep. `count` reports eligibility and fills missing credential facts. `on` redacts eligible content.                                                                |
| `PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS`           | `30`    | Whole days from 1 to 365.                                                                                                                                                            |
| `PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS` | `50`    | A positive whole number. Shares a cap across filled credential facts, completed run, launch and session redactions, and attempted receipt, installation sync and diagnostic updates. |

Set these environment variables on the Hub process and restart. The run payload and timeline
windows are configured independently. Hub rejects startup in `on` mode when the payload
window is shorter than `PASEO_HUB_TIMELINE_RETENTION_DAYS`. Count mode accepts a shorter
window so operators can evaluate it.

The worker starts in the background after startup and runs hourly. It advances in bounded pages
with a 250 ms pause and uses one UTC cutoff per pass. If a stage reaches the shared work cap,
the next pass starts at the following stage. Failed batches retry after a minute. On restart,
the worker scans from the start and visits staged receipts before fresh ones in their stage. Count mode reports the
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

## Provider receipts and diagnostics

A receipt must be older than the cutoff, have proof of settled admission or a final no-run
disposition, and have no work that can still use its contents. Every referencing run must have
finished its own payload expiry. Hub proves branches against the configuration revisions pinned
at intake. Supported receipt shapes include GitHub App and Linear webhooks, manual and public
webhook requests, schedules, GitHub notifications and proved unrouted drops.

Hub clears the receipt body, pinned route snapshot and routing proof. The tombstone keeps the
receipt ID, tenant, provider and source, connection and resource bindings, repository, delivery
and signature keys, received time, and final disposition. Manual and signed webhook tombstones
keep a validated project, revision and trigger binding for authorized retries. Original run and
filter results remain available on replay.

Slack and Discord receipts remain count-only because their pinned snapshots lack sufficient
matching evidence. Bound GitHub push receipts remain count-only because installation
synchronization settlement cannot be proved for them. Linear delegate changes that need live app
identity and other receipts without conclusive proof remain intact. Attachment capabilities stay
in the database.

Hub clears an old GitHub installation sync body and its exact audited receipt copy together
after successful settlement. A positively settled sync with proof it created no copy can also
expire. Pending syncs and historical syncs without a settlement marker remain intact. Hub
replaces old GitHub notification cursor error text with a fixed message. Poll health, timing
and cursor position stay intact. A successful poll or fresh error clears the diagnostic marker.

Count reports contain counts and oldest ages for fixed dispositions. Apply reports also count
updates and lock or recheck skips. A concurrent change can alter eligibility between the count
and the update. Apart from filling missing credential facts, count leaves the database unchanged.

The [seven-day unhandled-receipt sweep](../src/receipt-retention/README.md) runs independently and
reports its own scanned and deleted counts. It can delete qualifying unmarked receipts along
with their replay keys. A zero-match route can stamp a drop before a sibling route finishes,
so the seven-day sweep can delete the receipt during that gap. Changing that horizon or its
zero-match policy requires a separate decision.

This policy covers logical redaction in the live Hub database. WAL, old tuples, backups, logs,
browser copies, daemon transcripts, and provider comments and files have independent lifetimes.
