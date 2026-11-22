# Local tests

## Run the suite

Install dependencies and build the server with Node 24.22.0. The stream integration tests use the
compiled server in `.output`. PostgreSQL integration tests start containers in local Docker.

```sh
mise exec node@24.22.0 -- npm ci
mise exec node@24.22.0 -- npm run build
mise exec node@24.22.0 -- npm test
```

`npm test` runs the Node script tests and then the serial Vitest suite. To run the Vitest suite in
four processes, wait for other test runs to finish and run the parallel command. It holds
`/tmp/hub-fullsuite.lock` for the run. Set `TEST_SHARDS` to choose the number of processes.
The daemon suite takes the first shard when at least two are available.

```sh
mise exec node@24.22.0 -- npm run test:scripts
mise exec node@24.22.0 -- npm run test:parallel
```

After a sharded failure, `npm run test:parallel -- --rerun-failed` runs the recorded failed files in
one process. A failure that passes on rerun can be sensitive to machine load.

## Run tests affected by a change

```sh
mise exec node@24.22.0 -- npm run test:changed
mise exec node@24.22.0 -- npm run test:changed -- --base origin/main --safe
```

The default base is the merge base with the local release branch or its existing remote-tracking ref,
then the origin default branch. `--base` selects a different local Git ref. Staged, unstaged, and
untracked changes are included.

The command runs changed test files and uses Vitest's static import graph to find related tests. It
also checks the generated route tree and runs the typography policy. Changes under `drizzle/` run
the migration tests and `npm run db:check`.

Dynamic imports and files read at runtime, including SQL and documentation, can be absent from the
module graph. `--safe` adds tests from touched source folders. Root configuration changes and edits
with no relevant tests may need a targeted test or a full run. Check the printed selection.

## Record test evidence

Run receipt commands from a clean commit. The default command is `npm run test:changed`. Pass a
command explicitly to record a different test or check.

```sh
mise exec node@24.22.0 -- npm run test:receipt
mise exec node@24.22.0 -- npm run test:receipt -- -- npm run typecheck
mise exec node@24.22.0 -- npm run test:receipt -- --verify "$(git rev-parse HEAD)"
```

The ignored `.test-receipts/<sha>.json` file records green commands, their elapsed times, and any
file selections and counts reported by the test runner. A failed command or a dirty checkout cannot
add evidence. Reviewers can use the receipt for that exact SHA and run checks missing from it.

Receipts bind each command to the commit and tree and hash the canonical JSON and command logs with
SHA-256. Verification needs both the JSON and its files under `.test-receipts/logs/`. This detects
accidental edits, sloppy tampering, and copies between commits. A determined forger can rewrite the
evidence and recompute the hashes. Record fresh evidence for receipts from older versions.

The generated runtime-file map also selects tests that read checked-in fixtures, SQL, and docs.
When tests add a file read, regenerate the map with
`node scripts/generate-test-runtime-files.mjs` and commit the JSON. The script tests check that the
map matches the current reads. Resolve new dynamic paths in the generator when static analysis
cannot determine their directory.

The parallel runner records its PID, start time and worker groups in the full-suite lock on macOS
and Linux. On interrupt it gives each group five seconds to stop, sends SIGKILL if needed, and
keeps the lock while any workers remain. A new full run reports and reclaims a stale lock after
checking its workers. For manual recovery, inspect the lock with `cat /tmp/hub-fullsuite.lock` and
check its PID and process groups with `ps -axo pid,pgid,lstart,stat,command`. Run
`unlink /tmp/hub-fullsuite.lock` only after confirming that its owner and worker groups have exited.

Package, Vitest config and setup changes select the full Vitest suite. When a selection covers
every Vitest file, the command prints a full-suite banner and hands off to the parallel runner,
which takes the full-suite lock.
