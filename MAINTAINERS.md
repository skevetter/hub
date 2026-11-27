# Maintaining Paseo Hub

This guide covers repository operations for maintainers. Product usage belongs in the
[public Hub documentation](https://paseo.sh/docs/hub); architecture decisions live under
[`docs/`](docs/).

## Verify a change

The required checks match the jobs in [CI](.github/workflows/ci.yml):

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
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
unchanged. The tarball includes a shrinkwrap and the package job checks the installed tree before
it can be published. The build branch produces a workflow artifact. Only `main` creates a tag and
GitHub Release with the tarball and its checksum.

The release check compares the tested commit to the latest reachable `v*` tag. Changes limited
to the [no-ship paths](scripts/cd/ship-paths.mjs) skip the tag and deploy. If the last release was
paused or failed after tagging, a no-ship push does not retry it. Start the published release
manually from `main` with its exact SHA.

Automatic deploys take a backup, install, and check the service. A failed smoke check rolls back
and pauses deployment. Mark incompatible migrations and persisted data changes `rollback-unsafe`
on the PR. The pipeline publishes those releases and waits for a manual start. Manual deployments
do not roll back automatically. See the `cd-alert` issues for failed or held releases.

## Update public documentation

Public Hub documentation lives in `getpaseo/paseo` under `public-docs/`. Open a companion PR
when an API, interface, or user-facing workflow change affects what users need to know or do.
Internal changes and fixes that restore expected behavior do not require new public docs.
If existing documentation becomes inaccurate, correct it with the smallest necessary edit.

Document the intended public experience, not internal architecture or maintainer process.
Keep each addition tied to a reader’s task; omit details that do not help them complete it.
