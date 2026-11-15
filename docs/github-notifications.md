# GitHub notification triggers

A `github.notification` trigger starts a run when one of your GitHub notifications arrives. Hub polls
the GitHub notifications API with a personal access token that you set in the environment. There is no
GitHub App, no connection, and nothing stored in the database except a cursor.

Use it when you want a run for events that only reach you as a notification, such as a review request
or a mention, in repositories where you cannot install an app.

## Set up

1. Create a classic personal access token with the `notifications` scope. Fine-grained tokens and
   GitHub App tokens cannot read notifications. If your organization enforces SAML single sign-on,
   authorize the token for it.
2. Set these on the Hub process:

   | Variable                                    | Meaning                                                                                      |
   | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
   | `GITHUB_NOTIFICATIONS_TOKEN`                | The token. Polling is off while this is unset.                                               |
   | `GITHUB_NOTIFICATIONS_POLL_SECONDS`         | Optional. Seconds between polls. Default `60`. Values under `30` become `30`.                |
   | `GITHUB_NOTIFICATIONS_MAX_THREADS_PER_POLL` | Optional. Most threads that start runs in one poll. Whole number from 1 to 100. Default `5`. |

3. Restart Hub. The log shows `github notifications polling enabled`.
4. Create a trigger with `on: github.notification`. Choose **GitHub notification** in the form, or
   author it in YAML.

## YAML

Submit this as the `yaml` field to `POST /api/v1/triggers/validate` and `POST /api/v1/triggers/install`:

```yaml
name: review-requests
enabled: true
on:
  github.notification:
    filters:
      repo: acme/webapp
      reason: review_requested
run:
  target:
    daemon: your-daemon
    cwd: /workspace/webapp
  agent:
    provider: codex
    mode: full-access
  prompt: |
    Review the pull request in this notification.
    Notification: ${{ paseo.context }}
  max_runtime: 2h
  idle_timeout: 10m
```

## Filters

All filters are optional. A trigger with none runs for every notification. A trigger runs only when
every filter it sets matches.

| Filter     | Matches                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `repo`     | The repository as `owner/name`. Case does not matter.                                            |
| `reason`   | GitHub's reason for the notification, such as `mention`, `review_requested`, `author`, `assign`. |
| `contains` | Text that appears in the subject title.                                                          |
| `pattern`  | A prefix of the subject title.                                                                   |

Any other filter is a validation error. `from_users` is rejected with a message: a notification has no
commenter, so an allowlist could not be enforced, and Hub does not ignore it silently. A `repo` filter
needs no GitHub connection and is not checked against connected repositories.

Several triggers can match the same notification. Each one starts its own run, on its own daemon.
Triggers that do not match are skipped without a record.

## What the run receives

`${{ paseo.context }}` is this JSON. Hub keeps nothing else from the notification, and it never reads
comment text.

```json
{
  "github_notification": {
    "repo": "acme/webapp",
    "thread_id": "1001",
    "subject_type": "PullRequest",
    "title": "Fix the flaky deploy check",
    "number": 42,
    "html_url": "https://github.com/acme/webapp/pull/42",
    "reason": "review_requested",
    "updated_at": "2026-11-14T10:00:30Z"
  }
}
```

`number` and `html_url` are `null` when the subject is not an issue or pull request.

## Behavior

- **First run.** Hub records the current time as its starting point and delivers nothing. Existing
  notifications are not replayed.
- **Polling.** Each poll asks for `all=true&participating=true` since the starting point. `all=true`
  includes threads you already read, for example on your phone. Hub only reads. It never marks a
  thread as read.
- **304.** Hub sends `If-Modified-Since` with the last `Last-Modified` it saw. A `304 Not Modified`
  response means nothing new, and it does not use rate limit.
- **Poll interval.** Hub never polls faster than the larger of your setting and the `X-Poll-Interval`
  GitHub returns.
- **Overlap.** Each poll looks back two minutes. A thread update is identified by its thread id and
  `updated_at`, and Hub keeps one receipt for each organization and update. A repeated or overlapping
  poll does not start a second run. A later update to the same thread is new work.
- **Catch-up.** One poll starts runs for at most `GITHUB_NOTIFICATIONS_MAX_THREADS_PER_POLL` threads,
  so a backlog does not start every run at once. Hub sorts the returned threads by `updated_at`,
  oldest first, and delivers the first ones. A thread counts toward the limit only when it starts a
  run. A thread that no trigger matches, or that Hub already delivered, does not count. Receipts and
  runs for the batch are saved in one transaction.
  When threads are left over, Hub sets its starting point to one second before the last delivered
  thread and forgets the `Last-Modified` value, so the next poll cannot answer `304` and skip them.
  The next poll runs after the usual interval and delivers the next batch. It repeats until
  everything fits under the limit. Then Hub goes back to a starting point two minutes behind the
  newest thread. Every thread is delivered once. When all threads fit under the limit, a poll behaves
  as described above and sets no limit state.
- **Outage.** If GitHub or the network fails, Hub keeps its starting point and reports the failure.
  The next poll after the interval picks up everything since then, at most
  `GITHUB_NOTIFICATIONS_MAX_THREADS_PER_POLL` threads at a time. The failure message never includes
  the token.
- **One poller.** A database lock lets one Hub process poll at a time. A second process waits, finds
  the interval has not passed, and skips.
- **Reason can change.** GitHub can change a thread's `reason`. A thread that did not match earlier
  can match on a later update.

## Status in the UI

The Triggers page shows a **GitHub notifications** card when your organization has a
`github.notification` trigger, enabled or not. The card has six rows in a three column grid. After a
failure, the last error appears in its own block below the grid.

| Row                            | Meaning                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| Status                         | One of the states below.                                                                 |
| Last poll                      | When the last poll finished without an error. A `304` counts.                            |
| Next poll                      | When the next poll may run.                                                              |
| Poll interval                  | The configured seconds between polls, for example `60 seconds`. `Not polling` while off. |
| Delivered in the last 24 hours | Notifications that started runs for your organization, counted by receipt.               |
| Token                          | `Configured` or `Not set`. The card never shows the token.                               |
| Last error (below the grid)    | The latest failure, up to 200 characters, without the token. Only shown after a failure. |

The poll interval is your setting. GitHub can ask for a longer wait with `X-Poll-Interval`, and Hub
then waits that long.

States:

- **Polling.** A token is set and the last poll succeeded.
- **Starting.** A token is set and no poll has finished yet.
- **Error.** The last poll failed. The next success clears the message and returns the status to
  Polling.
- **Stalled.** A token is set, but the next poll is more than five minutes overdue. Check the Hub
  logs.
- **Off.** `GITHUB_NOTIFICATIONS_TOKEN` is not set on the Hub. The card says so and links to
  [Set up](#set-up).

The status is stored with the cursor, so every Hub process shows the same card. The card never
shows the token.

## Trigger list

The **Last triggered** column shows when the trigger last ran. The line under it summarizes the runs
from the last 24 hours, so one failed run among many does not look like a failing trigger:

- All runs succeeded: `Succeeded`.
- All runs failed or timed out: `Failed`.
- A mix: the count, for example `2 of 12 failed`.
- No runs in the last 24 hours: only the time.

The summary covers the trigger's 100 newest runs. Runs that are still running are not counted as
failures.

## Limits

- No commenter or author filter. That needs the `repo` scope, which is write access to every private
  repository, so Hub does not ask for it.
- No replies. `github.reply` is not available for this event, because a notification has no
  installation to reply through. The run can comment with `gh` on its own host.
- Classic personal access tokens only.
- The token sees only your notifications. Other people's notifications are not visible to it.
- Threads you do not take part in are not included, because Hub sets `participating=true`.
- The token belongs to the Hub, not to an organization. On an instance with several organizations,
  every organization's matching triggers run for each notification.
- After a long outage, every thread that changed meanwhile starts one run, delivered in batches of
  `GITHUB_NOTIFICATIONS_MAX_THREADS_PER_POLL` threads. With the defaults, 100 threads take 20 polls,
  about 20 minutes. Set `repo` or `reason` filters so a backlog does not start unrelated runs.
- The limit counts threads, not runs. A thread that matches several triggers starts one run per
  trigger.
- A startup value outside 1 to 100, or one that is not a whole number, stops Hub with a message that
  names the variable.

## Security

The token reads your notification titles, repository names and URLs, and Hub stores those fields in
receipts. Hub does not log the token, send it to any host except `api.github.com`, or put it in a
receipt, run context or error message. The `notifications` scope does not grant access to code.
Treat the environment variable like any other secret, and revoke the token in GitHub to turn the
source off immediately.
