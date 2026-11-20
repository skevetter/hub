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
settle. If another active run shares the agent, Stop interrupts both turns. The
selected run ends canceled. Other runs that are still active when Hub handles
the interrupt follow the normal agent-interrupted failure path, and any run
that has already reached a terminal state keeps it. Stop can win after the last
step succeeds if the workflow itself is still running.

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
