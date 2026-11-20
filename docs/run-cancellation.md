# Stop a run

Open a running run in Activity and select **Stop run**. The account that started
the run and organization admins and owners can stop it. Hub records the starter
for manual runs started through an authenticated CLI login. Runs without a
recorded Hub account, such as schedules, provider events, and runs started with
an API key, can be stopped by an admin or owner. Plain members cannot currently
start a run as a recorded starter because starting through the CLI requires
an admin or owner.

Hub marks the run canceled immediately, skips steps that have not started, and
interrupts any active agent or script. If the daemon is offline, Hub records the
stop immediately and retries pending cleanup on reconnect. A canceled run
remains subject to the run payload retention policy once cleanup and reporting
settle.

Stop interrupts the agent's current work. Every other run that still has active
work attached to that agent follows the normal agent-interrupted failure path.
Runs between steps continue through normal scheduling and can use the same
session for their next step.
The confirmation shows how many other runs have attached work and asks you
to review the impact again if that count changes.

Hub records which executions were attached at the first interrupt attempt. If
the acknowledgement is lost, Hub checks the daemon's state before retrying.
It leaves the action pending when the daemon state is unavailable. If the agent
has stopped or another execution has joined, Hub settles the pending action
without sending another interrupt. A delayed first attempt also skips the
interrupt if it would affect executions that attached after Stop was accepted.

Stop can win after the last step succeeds if the workflow itself is still running.

The public endpoint is `POST /api/v1/runs/{id}/stop`. It requires a bearer
credential from an organization CLI login and has no request body. An authorized
call returns HTTP 200 with the run ID and current status, including when the run
already finished. A canceled response includes a note only while cleanup is
pending.
A caller without stop permission receives HTTP 403. A run
outside the credential's organization returns HTTP 404.

## Roll back to build 17

Rolling back below the first Stop build preserves existing data. On build 17,
pending terminal notifications and progress messages report canceled runs as
failed. The timeline reconciler logs an error every 60 seconds for each
unsealed canceled timeline. Build 17 leaves canceled script steps out of its
cleanup sweep, so any terminal still awaiting cleanup can keep running and that
run's payload cannot expire until Hub rolls forward and completes cleanup.
