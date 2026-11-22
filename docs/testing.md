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
