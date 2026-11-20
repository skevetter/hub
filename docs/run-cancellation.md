# Stop a run

Open a running run in Activity and select **Stop run**. The account that started
the run and organization admins and owners can stop it. Hub records the starter
for manual runs started through an authenticated CLI login. Runs without a
recorded Hub account, such as schedules, provider events, and runs started with
an API key, can be stopped by an admin or owner.

Hub marks the run canceled immediately, skips steps that have not started, and
interrupts any active agent or script. If the daemon is offline, Hub records the
stop immediately and retries pending cleanup on reconnect. A canceled run
remains subject to the run payload retention policy once cleanup and reporting
settle. If another active run shares the same daemon agent, Hub preserves that
run's work and cancels only the selected workflow.

The public endpoint is `POST /api/v1/runs/{id}/stop`. It requires a bearer
credential from an organization CLI login and has no request body. An authorized
call returns HTTP 200 with the run ID and current status, including when the run
already finished. A canceled response includes a note about offline cleanup.
A caller without stop permission receives HTTP 403. A run
outside the credential's organization returns HTTP 404.
