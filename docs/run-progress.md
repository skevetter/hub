# Run progress message settings

The reporter core is off by default. A Hub with a registered progress provider can enable it
with `PASEO_HUB_RUN_TIMELINE=true` and `PASEO_HUB_PROGRESS_MESSAGES=true`. A trigger also needs
`progress_message: true`. The reporter sends status, counts, timings and a link to the Hub run
when `PASEO_HUB_APP_URL` is configured. Anyone who can read the source conversation can see
the message. Access to the linked run requires a Hub login.

| Setting                               | Default | Accepted values                                                                       |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `PASEO_HUB_PROGRESS_MESSAGES`         | `false` | `true` or `false`                                                                     |
| `PASEO_HUB_PROGRESS_MIN_EDIT_SECONDS` | `20`    | Whole seconds from 5 to 600. After 15 minutes, regular edits are paced at 60 seconds. |
| `PASEO_HUB_PROGRESS_MAX_EDITS`        | `120`   | Whole regular edit attempts from 10 to 1,000 per run.                                 |
| `PASEO_HUB_TIMELINE_RETENTION_DAYS`   | `30`    | Whole days from 1 to 365 after run completion.                                        |

Failed and uncertain regular writes count toward pacing and the edit cap. A crash between the
durable reservation and the provider call consumes one of the default 120 regular edit slots.
Keeping the slot charged ensures the cap cannot permit an extra provider call. Final, repair,
and settle edits remain outside the regular edit cap.

Hub rejects invalid settings at startup. Timeline retention removes settled local progress
rows even when the reporter is off. Final edits, repairs, and credential cooldowns can keep
a progress row beyond the timeline window. Messages already posted remain at the source.
See [run payload retention](run-payload-retention.md) for the separate settings for run-owned content.

Hub shares credential cooldowns across processes through the database. Admission checks
the latest cooldown before reserving an attempt. Each process limits its own provider calls
to four in flight and paces its regular edits from the actual send start. Other processes
use the durable reservation as their pacing lower bound.

A write that times out or has an uncertain outcome schedules a repair. Hub watches for a late
success for up to 10 minutes from the start of the write and keeps at most 256 observations
per process, evicting the oldest first. A late success detected in that window requests
another repair. If the provider commits without reporting success within that window, only a
scheduled repair can overwrite it. A write that lands after the last scheduled repair can
remain visible.

Hub schedules the settle edit 120 seconds after the final edit. When the settle is the only
repair, allow up to 145 seconds from a stale write to visible repair, including the repair's
operation budget. With one rate limit at the 900-second cap, allow up to 1,070 seconds.
That includes the 120-second settle delay and two 25-second operation budgets.

## Linear

With the reporter enabled and the Linear integration configured, an opted-in Linear run
creates a Paseo app comment on the source issue and edits it as the run advances.
The Linear reporter requires a connection with the `write` scope before it can post or edit
comments. Current connections lack that scope, so the reporter skips Linear runs until the
owner reauthorizes the connection with `write`.

Hub refuses an edit with `target_mismatch` when the stored issue or workspace differs from
the run's Linear destination, or when the stored reference lacks the bound issue or workspace.

A connection rebind can commit after the final database lookup takes its snapshot and before
the HTTP request is sent. In that window, a comment mutation can use the previous binding's
token. The Linear organization ID still identifies the same workspace.

Set `reply_message: true` on a Linear trigger with a named audience to have the Paseo app post
the agent's final answer after a successful run. Hub retains only delivery metadata. Replies
use `comments:create`, are limited to one per run and default to 60 attempts per organization per
hour. Paseo app comments cannot start comment triggers. Clear the editor checkbox or remove
`reply_message` to turn replies off. See [Linear run replies](linear-reply.md).

## GitHub

GitHub progress uses one conversation comment on the source issue or pull request. For GitHub
App events, enable progress messages and configure the existing GitHub App. The App needs
Issues or Pull requests write access on the repository. Hub checks that the active installation
belongs to the run's organization and that the installation synced the repository before each
write. Start live verification with the App on a repository you own.

Notification runs can use a separate write credential. Configure both
`PASEO_HUB_PROGRESS_GITHUB_TOKEN` and `PASEO_HUB_PROGRESS_GITHUB_ORGS` to enable this path.
Hub reads the variables at startup. Restart Hub to rotate the token or change the mapping.
A token without a mapping stops startup. The token should have write access only to the
intended repositories. Hub warns if GitHub reports a broad classic token scope. The
`GITHUB_NOTIFICATIONS_TOKEN` setting is used by the notification poller.

| Setting                           | Default  | Accepted values                                                                                                                                          |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_HUB_PROGRESS_GITHUB_TOKEN` | Unset    | A separate GitHub comment-write token for notification runs.                                                                                             |
| `PASEO_HUB_PROGRESS_GITHUB_ORGS`  | Unset    | `slug:owner/repo,owner/repo;other-slug:owner/*`. Maximum 20 Hub organization slugs and 100 repository patterns. Repository matching is case-insensitive. |
| `PASEO_HUB_PROGRESS_PUBLIC_REPOS` | `refuse` | `refuse` or `allow`.                                                                                                                                     |

The public repository setting applies to both credentials. Hub rechecks repository visibility
when the previous check is ten minutes old and before the final edit. If a private repository
becomes public under the `refuse` policy, Hub stops updating the comment. The existing comment
remains visible. If GitHub cannot confirm visibility, Hub stops after three failed checks.

Hub never retries an uncertain create. If the process restarts after posting and before saving
the comment ID, Hub looks for the run's hidden marker on one page of recent comments. Hub adopts
a unique match from the authenticated GitHub actor. Credential rotation can prevent adoption.
A recovery miss ends the message without creating a replacement.

Automated tests use fake GitHub responses to verify both credential paths, organization and
repository checks, visibility changes, rate limits, and crash recovery. Verify the live App's
installation permissions separately before enabling the reporter on an opted-in trigger.
