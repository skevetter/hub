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
A file gets its own shard when its cached duration exceeds the ideal time per shard. The runner
assigns the remaining files longest first to the lightest shard. It prefers timings from the last
completed parallel run over timings that may come from a filtered run.

```sh
mise exec node@24.22.0 -- npm run test:scripts
mise exec node@24.22.0 -- npm run test:parallel
```

Each shard gets its own temporary directory, application data and Vite cache. Mise shims keep
using the caller's installed tools so child commands such as `python3` can start with the same
toolchain.

After a sharded failure or interruption, `npm run test:parallel -- --rerun-failed` runs the
recorded failed and unfinished files in one process. Interrupted runs show how many files did not
report in a separate line. A failure that passes on rerun can be sensitive to machine load.

The test commands and runtime-file map generator print the target root, branch, HEAD, worktree
status, current directory and planned action. Calling a script by path from a different Git
worktree requires `--root <path>` to identify the worktree to test. The runners use that
worktree's dependencies and Vitest configuration.

## Run tests affected by a change

```sh
mise exec node@24.22.0 -- npm run test:changed
mise exec node@24.22.0 -- npm run test:changed -- --base origin/main --safe
```

The command compares the merge bases of HEAD with each local or remote release branch, the
configured upstream and `origin/main`, and picks the one with the fewest commits to HEAD. Ties go
to the highest release version, then the upstream, then `origin/main`. A checkout on a release
branch considers earlier versions in its release series. It prints the selected base and reason.
`--base` accepts an explicit local Git ref. Staged, unstaged, and untracked changes are included.

The command runs changed test files and uses Vitest's static import graph to find related tests. It
also checks the generated route tree and runs the typography policy. Changes under `drizzle/` run
the migration tests and `npm run db:check`.

Dynamic imports and files read at runtime, including SQL and documentation, can be absent from the
module graph. `--safe` adds tests from touched source folders. Root configuration changes and edits
with no relevant tests may need a targeted test or a full run. Check the printed selection.

## Record test evidence

Run receipt commands from a clean commit. The default runs the changed-test runner in the
selected worktree with the same base-selection rules. Pass a command explicitly to record a
different test or check.

```sh
mise exec node@24.22.0 -- npm run test:receipt
mise exec node@24.22.0 -- npm run test:receipt -- -- npm run typecheck
mise exec node@24.22.0 -- npm run test:receipt -- --verify "$(git rev-parse HEAD)"
```

The ignored `.test-receipts/<sha>.json` file records commands, their outcomes, worktree roots,
branches and commits, elapsed times, and any test selections and counts. A repeat replaces the
earlier result for the same command and commit with an in-progress entry before starting the
command. A completed failure replaces that entry with the failure. An interruption or crash
leaves the command unverified. `--verify` requires completed passing results and checks that
no receipt writer holds the lock.

The test runners report their starting worktree and commit and check HEAD again before publishing
metrics. The changed runner also checks the worktree and commit reported by the parallel runner.
Recording requires a clean checkout and matching metrics when a command emits them. For explicit
commands without metrics, the receipt uses the recording worktree as the tested root. `--verify`
reports that metrics did not confirm that root. Verification requires the worktree where the
receipt was recorded.

Receipts bind each command to the commit and tree and hash the canonical JSON and command logs with
SHA-256. Verification needs both the JSON and its files under `.test-receipts/logs/`. This detects
accidental edits, sloppy tampering, and copies between commits. A determined forger can rewrite the
evidence and recompute the hashes. Record fresh evidence for receipts from older versions.

The generated runtime-file map also selects tests that read checked-in fixtures, SQL, and docs.
When tests add a file read, regenerate the map with
`node scripts/generate-test-runtime-files.mjs` and commit the JSON. The generator formats it
with the repository's oxfmt. The script tests check that the
map matches the current reads. Resolve new dynamic paths in the generator when static analysis
cannot determine their directory.

The parallel runner records its PID, start time and worker groups in the full-suite lock on macOS
and Linux. On interrupt it gives each group five seconds to stop, sends SIGKILL if needed, and
keeps the lock while any workers remain. Full runs and serial runs from `--rerun-failed` or
`test:changed` hold the same lock. Each checks the recorded workers before reclaiming a stale lock.
For manual recovery, inspect the lock with `cat /tmp/hub-fullsuite.lock` and
check its PID and process groups with `ps -axo pid,pgid,lstart,stat,command`. Run
`unlink /tmp/hub-fullsuite.lock` only after confirming that its owner and worker groups have exited.

Package, Vitest config and setup changes select the full Vitest suite. When a selection covers
every Vitest file, the command prints a full-suite banner and hands off to the parallel runner,
which takes the full-suite lock. `test:changed` starts each child command in its own process
group. It forwards SIGINT, SIGTERM and SIGHUP to the group. Selected-test groups get three seconds
to stop before it sends SIGKILL. The parallel runner gets time to stop its own shards. The
receipt wrapper also forwards these signals and waits for its command to stop. Both commands
remove their temporary files and exit 1 with an `INTERRUPTED` line. All three runners fail if
they have to stop background children after a command exits successfully.

Set `HUB_TEST_FULLSUITE_LOCK` to use a different lock path, for example in a scratch checkout.
