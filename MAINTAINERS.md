# Maintaining Paseo Hub

This guide covers repository operations for maintainers. Product usage belongs in the
[public Hub documentation](https://paseo.sh/docs/hub); architecture decisions live under
[`docs/`](docs/).

## Verify a change

1. Pull requests run [CI](.github/workflows/ci.yml): static checks, Docker smoke, and six
   unit shards. Static builds Hub, checks migrations and packaging, runs script tests and
   the built-only tests, and confirms the six shards and built-only tests cover every test
   file exactly once. Static runs both regular lint and strict lint. Strict lint checks
   applicable changed files against the comparison base.
2. On pull requests, UI paths also trigger three browser shards, Hub integration paths
   trigger Hub E2E, and workflow paths trigger workflow and shell lint. The required check
   checks the results for the jobs that apply.
3. [Nightly](.github/workflows/nightly.yml) runs all three browser shards and Hub E2E
   regardless of changed paths. It skips static checks, Docker smoke, unit shards, and
   workflow lint.

```sh
npm run typecheck
npm run lint
npm run lint:strict
npm run format:check
npm run test:parallel
npm run db:check
npm run build
npm run docker:smoke
npm run test:e2e:browser
npm run test:e2e:hub:source
```

The source-built browser and Hub suites use the exact Paseo commit in `PASEO_E2E_COMMIT`.
When a Hub change depends on a Paseo protocol or CLI change, update that immutable SHA and
prove the combined contract before merging. Do not replace it with a branch or another mutable
reference.

Use the repository formatter through `npm run format` or `npm run format:files`. This repository
uses Oxfmt, not Prettier.

## Publish a release

[Main](.github/workflows/main.yml) checks the pushed commit and packs that exact commit in a
scratch checkout. The version comes from Conventional Commits. The checkout's version stays
unchanged. The package job extracts the tarball, runs `npm ci --omit=dev --legacy-peer-deps`,
and checks the production tree against the bundled shrinkwrap before
it can be published. The build branch produces a workflow artifact. Only `main` creates a tag and
GitHub Release with the tarball and its checksum. Main release runs serialize planning,
packing, and publishing. Publish attests the verified tarball. Manual deployment checks
the downloaded checksum and attestation for the requested main commit.

Push path classification compares against the latest reachable stable-form `v*` tag, or the
previous push SHA if none exists. Changes limited
to the [no-ship paths](scripts/cd/ship-paths.mjs) skip the tag and deploy. If the last release was
paused or failed after tagging, a no-ship push does not retry it. Start the published release
manually from `main` with its exact SHA.

Automatic deploys take a backup, install, and check the service. A failed smoke check rolls back
and pauses deployment. Mark incompatible migrations and persisted data changes `rollback-unsafe`
on the PR. The pipeline publishes held releases as prereleases. It keeps the hold on subsequent
releases until a successful manual deploy promotes a prerelease. A held prerelease never rolls
back automatically. A manual dispatch of a stable release can roll back. Only the repository owner
can unpause. See the `cd-alert` issues for failed or held
releases.

### Deployment runbook

1. The first release after the legacy baseline is held without scanning historical migrations or
   PR labels. Run `cd-control status` and `selftest`, then `unpause`. Dispatch
   [Main](.github/workflows/main.yml) from `main` with the held release's exact SHA.
2. After an automatic rollback and pause, run `cd-control unpause`, then use **Re-run failed jobs**
   on the run that holds the fix. Dispatching the SHA already recorded as running only runs smoke.
3. The workflow refuses older releases. Roll forward with a revert, or have an administrator
   run `rollback` through `sudo` on the host. A main push waits for the running main deploy,
   whose job can take up to 55 minutes.
4. With squash merges, put `!` in the Conventional Commit title for a major bump. The squash
   commit has no breaking-change footer.

### Accepted limits

- Holds are stored in the GitHub Release prerelease flag. Anyone with repository write access
  can change that flag.
- Store deploy secrets only in the `production` environment, never at repository level.
- The `production` environment limits deployment to `main`.
- A runner killed without running its signal traps can leave an accepted install unrecorded.
  Use `cd-control status` to see the running version and reconcile it.

## Update public documentation

Public Hub documentation lives in `getpaseo/paseo` under `public-docs/`. Open a companion PR
when an API, interface, or user-facing workflow change affects what users need to know or do.
Internal changes and fixes that restore expected behavior do not require new public docs.
If existing documentation becomes inaccurate, correct it with the smallest necessary edit.

Document the intended public experience, not internal architecture or maintainer process.
Keep each addition tied to a reader’s task; omit details that do not help them complete it.
