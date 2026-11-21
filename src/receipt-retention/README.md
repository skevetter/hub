# Receipt retention

Every production Hub runtime starts `ReceiptRetention` after application startup and stops it
before closing the database. PostgreSQL and embedded instances use the same policy; there are no
settings to enable or tune it.

This sweep deletes a receipt when its `received_at` is strictly older than seven days, its committed drop
reason is one of the public unhandled-event reasons (`no_project_route`,
`no_trigger_for_source`, `trigger_filters_rejected`, `configuration_unavailable`, `unsupported_event`), and neither a
trigger run nor an attachment capability references it. Marked receipts and `webhook.received`
receipts are excluded. Admission snapshots in `accepted_routes` precede trigger matching. A
zero-match route can stamp a drop even when another route has yet to admit work, so this sweep
can delete the receipt before that route finishes. Any change to this zero-match gap or the
seven-day horizon is a separate policy decision. Receipts without a drop decision
and internal markers for handled events such as `github_lifecycle` stay too. Deleted receipts lose
their payload, history, and delivery/signature deduplication; a subsequent delivery is evaluated
against the current configuration.

Hub also keeps at most 5,000 unsupported Linear receipts per organization, evicting the oldest receipt when a new delivery exceeds that cap.

The first sweep starts asynchronously at startup. Each query examines at most 500 receipt IDs,
using the existing primary key to advance even through pages containing only retained receipts.
A sweep uses one fixed cutoff. Batches run sequentially with a 250 ms pause; completed sweeps
repeat after an hour. Failures keep the cursor in place and retry after a minute. Restarts safely
begin another sweep. There is no large transaction, full-table delete, or startup-blocking cleanup.

Cleanup logs report scanned and deleted counts and sweep completion without event contents.
Deleting rows frees space for PostgreSQL to reuse after vacuum; it does not immediately reduce
allocated table bytes.

The optional [run payload retention sweep](../../docs/run-payload-retention.md) applies its own
cutoff and requires proof that every branch has settled before clearing a receipt body. It keeps
delivery and signature keys in a tombstone. The seven-day sweep skips tombstones in both
`expiring` and `expired` states. Its deletion counts and replay horizon are independent of the
optional sweep and its `off`, `count` and `on` settings.

Build 16 (`0.11.0-notifications.16`) is the first build that protects marked receipts. In builds
14 and 15 and older, the seven-day sweep can delete a marked receipt and its duplicate-delivery
keys even with payload expiry set to `off`. A duplicate can then create a new receipt and a new
run. Once any receipt has expired, set payload expiry to `off` before rollback and keep every
binary at build 16 or newer.
