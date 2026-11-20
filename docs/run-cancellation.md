# Stop a run

Open a running run in Activity and select **Stop run**. The account that started
the run and organization admins and owners can stop it. Hub records the starter
for manual runs started through an authenticated CLI login. Runs without a
recorded Hub account, such as schedules, provider events, and runs started with
an API key, can be stopped by an admin or owner. Plain members cannot currently
start a run as a recorded starter because starting through the CLI requires
an admin or owner.

Hub marks the run canceled immediately and skips steps that have not started.
It requests an interrupt for active agent work and uses the script cleanup path
for active script work. The run's stopped notification is sent once.

An interrupt addresses the agent and can stop its current work. When the daemon
acknowledges the interrupt, other runs with work still attached to that agent
follow the normal agent-interrupted failure path. Runs between steps can use
the same session for their next step. The confirmation shows how many other
runs have attached work. If that number changes before submission, Hub asks
you to confirm the updated impact.

Overlapping Stops on the same agent can share one interrupt. Hub compares when
it accepted each Stop with the recorded send marker for the frame. An observed
frame whose marker is at or after another Stop was accepted covers that Stop.
Hub records the covered action as coalesced and shows confirmed cleanup with a note.
A Stop accepted after the send marker can request a new interrupt. If Hub only
has an uncertain send marker for a covering attempt, it reports unconfirmed
delivery without sending another interrupt.

Hub records the start of an interrupt attempt before sending it. If the daemon
is offline or Hub knows the frame never went out, the attempt remains pending
and can send on reconnect. A temporarily unavailable agent lookup also leaves
it pending. Each attempt can send one cancel frame. If Hub cannot confirm
delivery after the send began, it records that outcome and does not resend.
A delayed first send also settles as unconfirmed if a new execution attached
outside the confirmed scope.

Activity shows the cleanup state. For an unconfirmed interrupt or a missing
target, an authorized person can select **Stop again** to confirm a new
interrupt. The new attempt addresses the original agent's current work. The
run stays canceled and Hub keeps the original stopped notification. The
button is available until payload retention starts or another attempt is in
progress.

- `confirmed` means Hub has a daemon acknowledgement for the cleanup.
- `waiting_for_daemon` means cleanup is pending. The daemon may be offline, its
  response may be unavailable, or cleanup may still be in progress.
- `delivery_unconfirmed` means Hub could not confirm the interrupt. The
  original work may still be running. Pending agent interrupts with unresolved
  delivery settle in this state when recovery finds them at least 24 hours old.
  A recorded acknowledgement resumes peer settlement at any age. Revocation
  after the send marker also leaves unacknowledged delivery unconfirmed.
- `target_gone` means Hub lost the agent or its daemon before recording a send
  marker.
- `not_needed` means there was no daemon cleanup for this Stop.

Settled agent interrupts no longer block payload expiry. Other retention
requirements, including reporting and any pending script cleanup, still apply.
Stop can win after the last step succeeds if the workflow itself is still running.

The public endpoint is `POST /api/v1/runs/{id}/stop`. It requires a bearer
credential from an organization CLI login and has no request body. An
authorized call returns HTTP 200 with the run ID, current status and
`cleanupState`, even for a finished run. A pending or coalesced response also
includes a note. Repeating the HTTP request returns current state. Use Activity to
confirm a new interrupt for a canceled run. A caller without stop permission
receives HTTP 403. An out-of-organization run returns HTTP 404.

## Roll back to build 17

Rolling back below the first Stop build preserves existing data. On build 17,
pending terminal notifications and progress messages report canceled runs as
failed. The timeline reconciler logs an error every 60 seconds for each
unsealed canceled timeline. Build 17 leaves canceled script steps out of its
cleanup sweep, so any terminal still awaiting cleanup can keep running and that
run's payload cannot expire until Hub rolls forward and completes cleanup.
