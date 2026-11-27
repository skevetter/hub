# Local tests

## Run the suite

Install dependencies and build the server with Node 24.22.0. The stream integration tests use the
compiled server in `.output`. PostgreSQL integration tests start containers in local Docker.

```sh
mise exec node@24.22.0 -- npm ci
mise exec node@24.22.0 -- npm run build
mise exec node@24.22.0 -- npm test
```

`npm test` runs the Node script tests and then the serial Vitest suite without taking the lock.
If you need exclusive access for `npm test`, hold the lock by hand as described below.

`npm run test:parallel` (including `--rerun-failed`) and `npm run test:changed` runs that cover the
whole suite take the full-suite lock and refuse to run when it is held. The lock is the directory
`/tmp/hub-fullsuite.lock`, with the owner recorded in its `pid` file.

A file gets its own shard when its cached duration exceeds the ideal time per shard. The runner
assigns the remaining files longest first to the lightest shard and prints each estimated total.
The runner uses timings from the last complete parallel run, or `scripts/test-timings.json` when
that cache is missing. It estimates unknown files by size and ignores filtered caches. A full
run saves timings when every shard reports a result for every selected file, even if tests fail.
Interruptions, crashes, and reports with missing, pending, or empty results leave the cache alone.

To refresh the baseline from complete shard JSON reports, run
`mise exec node@24.22.0 -- node scripts/generate-test-timings.mjs <run-directory>`.
The generator accepts live `shard-N/results.json` files or archived `shard-N.json` files.

The parallel runner divides available cores by three, rounds to the nearest integer, and clamps
the default shard count to 1 through 6. Set `TEST_SHARDS` to override it. Load does not reduce the
shard count. Full sharded runs print the load and core count at the start and end, and warn when
the starting one-minute load exceeds the core count. The higher of the starting one-minute and
five-minute loads, divided by the core count and clamped to 1x through 4x, scales the Vitest test,
hook, and teardown timeouts. The timeout banner shows which load was used. Serial reruns keep the
usual timeouts.

```sh
mise exec node@24.22.0 -- npm run test:scripts
mise exec node@24.22.0 -- npm run test:parallel
```

Each shard gets its own temporary directory, application data and Vite cache. Mise shims keep
using the caller's installed tools so child commands such as `python3` can start with the same
toolchain.

After a sharded failure or interruption, `npm run test:parallel -- --rerun-failed` runs every
file from the affected shards in one process. A passing rerun requires a zero exit and a complete
passing report for those files. Run the parallel suite again if the retry list came from an older
runner. The summary counts files without results separately from failed tests. On failure, the
shard's `vitest.log` includes Vitest's own diagnostics and `results.json` contains the test report
if Vitest could write it. A failure that passes on rerun can be sensitive to machine load.

## Run one shard on its own machine

CI splits the suite across machines. Each machine runs one shard:

```sh
npm run test:parallel -- --shard 3/6
TEST_SHARD_INDEX=3 TEST_SHARD_TOTAL=6 npm run test:parallel
```

`--shard` wins over the environment pair. A bad value exits 2. The split uses only
`scripts/test-timings.json` and file sizes, so every machine computes the same shards. It ignores
the local timing cache and the machine load.

The three built-server suites listed under `.output/server/` in `scripts/test-runtime-files.json`
are not in any shard. Run them after `npm run build` with `npm run test:parallel -- --built-only`.
`npm run test:parallel -- --check-coverage` runs no tests. It exits 0 when the shards plus the
built-only suites cover every discovered file exactly once, 1 when they do not, and 2 on bad
arguments. `TEST_SHARD_TOTAL` sets the shard count for the check, 6 by default.

A file is retried once when every failure in it starts with `Port <n>/tcp not bound after <n>ms` or
`Hook timed out in <n>ms`. Vitest's JSON report leaves out hook failures, so the runner also reads
the first error line of each failure block in `vitest.log`. Each such file runs alone in its own
Vitest process. Each retry prints a `::warning::` line (or `::error::` if it fails again) and shows
in the step summary. Nothing is retried when the shard has any other failure, a process error, an
incomplete report or an unhandled error. More than 5 candidate files in one shard fails the shard
without a retry.

With `TEST_SHARD_REPORT_DIR` set, the run writes `shard-<i>.json` (or `built-only.json`), a
`.summary.json` next to it, `vitest.log` and, after retries, `vitest.retry-<n>.log`. Values of
environment variables whose names suggest secrets (token, key, password, URL, DSN and similar) of
3 or more characters, plus the host name, are replaced with `[redacted]` in those files and in the
step summary. The repository path becomes `.`. To refresh `scripts/test-timings.json`, run
`node scripts/generate-test-timings.mjs <dir>`, where `<dir>` holds the downloaded
`shard-<i>.json` files of one complete run and a copy of `built-only.json` named
`shard-<n>.json`.

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

The runners record their PID, start time and worker groups in `/tmp/hub-fullsuite.lock/pid` on
macOS and Linux. On interrupt the parallel runner gives each group five seconds to stop, sends
SIGKILL if needed, and keeps the lock while any workers remain. The runners check the recorded
workers before reclaiming a stale lock.

To hold the lock for another command, run `mkdir /tmp/hub-fullsuite.lock` and proceed only if it
succeeds. In the shell that will hold the lock, run `printf '%s\n' "$$" > /tmp/hub-fullsuite.lock/pid`
before starting the command. Write the pid of a process that stays alive until the command and its
workers exit. If that process exits first, the runners treat the lock as stale and reclaim it.
After the command and its workers exit, run
`rm /tmp/hub-fullsuite.lock/pid` and then `rmdir /tmp/hub-fullsuite.lock`.

For manual recovery, run `cat /tmp/hub-fullsuite.lock/pid` and check the owner and any listed
worker groups with `ps -axo pid,pgid,lstart,stat,command`. Remove the `pid` file and then the directory
only after confirming that the owner and workers have exited. An empty or unreadable `pid` file
does not make the lock safe to remove.

Package, Vitest config and setup changes select the full Vitest suite. When a selection covers
every Vitest file, the command prints a full-suite banner and hands off to the parallel runner,
which takes the full-suite lock. `test:changed` starts each child command in its own process
group. It forwards SIGINT, SIGTERM and SIGHUP to the group. Selected-test groups get three seconds
to stop before it sends SIGKILL. The parallel runner gets time to stop its own shards. The
receipt wrapper also forwards these signals and waits for its command to stop. Both commands
remove their temporary files and exit 1 with an `INTERRUPTED` line. After a successful command
exits, all three runners give background children up to two seconds to finish on their own.
The run fails if the runner still has to stop them.

Use `HUB_TEST_FULLSUITE_LOCK` only for tests and scratch checkouts.
