# Script actions

A trigger runs one action when its event arrives: an agent prompt, or a shell script on the daemon's
host. Choose **Script** under **Action** in the trigger form. Hub opens a terminal on the daemon,
runs the script there, and records the exit code and the end of the output in the run history.

Hub does not check that the script works on the host. You own that. Hub reports what happened.

## YAML

Put `script` under `run` in place of `agent` and `prompt`. This trigger runs a build whenever
GitHub asks for a review on `acme/webapp`:

```yaml
name: build-on-review
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
  script: |
    set -e
    npm ci
    npm test
    echo "$HUB_EVENT_JSON" | jq -r '.github_notification.html_url'
  max_runtime: 15m
```

A script trigger accepts only these fields under `run`:

| Field         | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `target`      | `daemon` and `cwd`. The directory must be a project open in Paseo on that host.    |
| `script`      | The script text, run by `/bin/sh -c`. Multi-line is fine.                          |
| `max_runtime` | How long the script may run. Defaults to `10m`. Hub stops the script at this time. |

Every other run option is refused when you save, with the reason: `agent`, `prompt`,
`continuation`, `output`, `outputs`, `github`, `env`, `idle_timeout`, `startup_timeout`, `title`,
`background`, `auto_archive`, and `worktree` under `target`. A trigger runs a script or an agent,
not both.

The script text is literal. Hub never renders `${{ }}` into it, and a script that contains one is
refused. Read the event from `HUB_EVENT_JSON` instead.

## A script and an agent on one event

To run a script and also start an agent for the same event, write two triggers. Hub already starts
every trigger an event matches, so both run, each on its own. There is no step chaining and no
`if` between them.

The script trigger:

```yaml
name: build-on-review
on:
  github.notification:
    filters:
      repo: acme/webapp
      reason: review_requested
run:
  target:
    daemon: your-daemon
    cwd: /workspace/webapp
  script: npm ci && npm test
```

The agent trigger on the same event:

```yaml
name: review-on-review
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
```

Save each as its own trigger. The two do not wait for each other and do not share output.

## Event data

The script gets the event as JSON in the `HUB_EVENT_JSON` environment variable. It is the same
JSON an agent prompt receives for `${{ paseo.context }}`: the notification, the GitHub, Slack,
Discord or Linear event, or the schedule tick.

Hub passes the event and the script as separate arguments to the terminal's process, never inside a
shell string, so event text cannot change what the shell runs. Both arguments are visible in the
host's process list while the script runs. Do not put secrets in the script text or expect the
event to stay private from other users on that host.

Treat `HUB_EVENT_JSON` as untrusted text. Read it with a JSON tool such as `jq`. Never pass it to
`eval`, `sh -c`, or an unquoted command substitution, because a title or a comment in the event can
contain shell syntax.

Event data over 100,000 bytes fails the run with a clear message, because the host limits the size
of one argument. Attachment links in the event are scoped to an agent execution. A script has none,
so those links do not resolve.

## Permissions on the daemon

Hub runs a script through the daemon's terminal requests. A daemon must grant Hub these
permissions, besides `hub.execute`, which every Hub target needs:

| Permission        | Needed for                                          |
| ----------------- | --------------------------------------------------- |
| `workspace.write` | Create the terminal and stop it.                    |
| `workspace.read`  | Read its output and check that it is still running. |

Hub does not need `workspace.manage`. Grant the two permissions on the host that runs the daemon:

```sh
paseo hub permissions grant workspace.write
paseo hub permissions grant workspace.read
```

The terminal opens in a project that Paseo already has open. If `cwd` is not one, the run fails
until you open the directory as a project on that host.

## How a run works

Hub starts `/bin/sh` in a terminal 240 columns wide and 50 rows tall. The shell runs your script as
`/bin/sh -c`, prints a marker line with the exit code, then waits 30 seconds so the output can still
be read. Hub polls the terminal about every 250 ms, and about every second after the first 10
seconds. When it sees the marker it takes the exit code, keeps the output before it, and asks the
daemon to stop the terminal. Hub asks the same when the script times out, the terminal vanishes, or
the run fails.

What Hub guarantees about that stop, and what is best effort:

- **Retries.** Hub repeats a failed stop request with backoff, five attempts, and treats an answer
  of "nothing stopped" as done only when the daemon also no longer lists the terminal.
- **Unconfirmed stops are recorded.** If the daemon never confirms, the step output carries a
  `cleanup` record with the daemon, directory, terminal name and id. The run still ends normally.
- **A sweep finishes the job.** Hub retries every `cleanup` record when the daemon connects, when
  Hub starts, and about once a minute while the daemon is connected. It also stops any terminal
  named `hub-script-` in the workspaces or directories those records name, unless a running step owns it. When the
  daemon confirms, the record is removed.
- **Best effort.** The sweep looks only where a record points: the workspace the daemon chose for the terminal when Hub saw it, else the directory. A terminal Hub never
  heard of, in another directory, is not found. A daemon that stays offline keeps its terminals
  until it reconnects. The script itself ends on its own when the shell does, within 30 seconds of
  finishing.
- **Capture.** A failed or lost capture is asked again until the deadline. It does not fail the run.

- **Output.** A terminal merges stdout and stderr into one stream. Hub keeps at most the last 64 KB
  of it, with terminal escape codes removed, and marks the output truncated when it cut anything.
  Hub reads the last 400 terminal rows, and rows wrap at 240 columns.
- **Environment.** The script inherits the daemon's environment. Hub cannot change it. Start the
  script with `env -i` or unset what you must hide.
- **Input.** The terminal has no input. A script that reads from stdin waits until it times out.
- **Shell.** The script runs under `/bin/sh`, not your login shell. Write POSIX shell, or start the
  script with a different interpreter.
- **Time limit.** The daemon has no timeout. Hub stops the terminal at `max_runtime`, or earlier if
  the whole trigger deadline comes first, and marks the run timed out. The message says which
  deadline ended it, for example `script timed out after 1m, when the trigger's deadline came
first (the step allows 10m)`.
- **Script size.** The script text is at most 64 KiB and has no NUL bytes. Hub refuses to save
  anything else.
- **Visibility.** While it runs, the terminal is named `hub-script-` followed by the id of the step
  run, a UUID Hub assigns, not the step's name. Anyone who can see the project in Paseo on that
  host can read it.
- **Exit code.** Exit code 0 succeeds. Any other code fails the run with `script exited <code>`.

The run detail shows the step's exit code and a collapsible **Output**. The step output is
`{ exit_code, output_tail, truncated }`. `exit_code` is `null` when the script never reported one.
Hub removes terminal escape codes and every control character except tab and newline from the
output before storing it, so a script that prints NUL bytes is still recorded with its exit code.

**The output is stored and shown.** Hub keeps the output tail in its database and shows it in the
run history to everyone who can read the project's runs. That includes anything the script prints:
secrets from the daemon's environment, `set -x` traces, tokens in error messages. Do not print
what you would not put in a run log.

## Limits

Hub runs only so many scripts at once. A script over a limit waits and starts when a slot frees. It
does not fail.

| Setting                            | Default | Meaning                                               |
| ---------------------------------- | ------- | ----------------------------------------------------- |
| `PASEO_HUB_SCRIPT_MAX_PER_DAEMON`  | `5`     | Scripts running at once on one daemon.                |
| `PASEO_HUB_SCRIPT_MAX_PER_TRIGGER` | `3`     | Scripts running at once for one trigger in a project. |

Each is a whole number from 1 to 50. Hub refuses to start with anything else. A script waiting for
a slot is checked again every couple of seconds, and its run deadline keeps counting.

Scripts run only on a Hub process that holds the daemon's connection, and a running script is
watched by that process alone. Running two Hub processes on one database is not supported for
scripts.

Pending cleanup records for a daemon that never returns stay in the step output until it reconnects.

## Restart and recovery

Hub records the terminal as soon as it exists. If Hub restarts while a script runs, the new process
stops the recorded terminal and fails the run with `script interrupted: Hub restarted while it was
running`. It does not run the script again, because the script may not be safe to repeat. If the
daemon is offline at that moment, Hub waits for it to reconnect, and the step deadline still ends
the run if it does not.

If Hub never learned the terminal's id because it stopped in that short window, it finds the
terminal by its name and stops it.

If Hub was down past the step's deadline, the database marks the step and the run timed out when Hub
returns. Hub then stops the terminal as well. If the daemon is not connected yet, the step keeps a
`cleanup` record and the sweep stops the terminal when the daemon connects.

## Security

A script is arbitrary code that runs as the daemon's user on the host. Treat who can start it as a
permission to run code there. Hub refuses to save a script trigger that is not safe by these rules:

- **Slack, Discord, GitHub and Linear events.** `filters.from_users` must name the people allowed
  to start it. A `*` or an empty list is refused. The form hides the Everyone choice for a script.
  These names come from the provider's own event, which the provider signs.
- **GitHub notifications.** A notification has no author to allowlist, so a script on it must set
  both `filters.repo` and `filters.reason`. `reason` must be one of `author`, `assign`,
  `review_requested`, `state_change` or `ci_activity`. Hub refuses `mention`, `team_mention`,
  `comment`, `subscribed`, `manual` and any other reason, because anyone can mention a user.
  The allowed reasons are not outsider-proof. On a public repository an outsider can cause
  `author` (any comment on a thread you created), `state_change`, and possibly `ci_activity`.
  The script text stays fixed, so an outsider controls only when the script runs and what is in
  `HUB_EVENT_JSON`. Treat the event data as untrusted, and use script triggers on private
  repositories.
- **Schedules.** A `schedule.tick` script needs no audience. Only Hub starts it.
- **Manual runs.** Script actions on `manual.run` are not available yet. The actor on a manual run,
  like every API call, is a string the caller chooses, so `from_users` cannot keep anyone out of
  the script: whoever can call the API can name an allowed user. `from_users` is a filter on events
  that arrive signed from a provider. It is not an authorization boundary for API callers. Hub
  refuses the trigger with `Script actions on manual.run are not available yet`, until a manual
  run's actor comes from something the caller cannot pick, such as an API key bound to one actor.

The same event can still start an agent trigger for everyone. The checks apply to the script
trigger alone.

A script gets no GitHub token and no Hub connection secrets. It sees the daemon's environment and
the event, nothing else from Hub. Anyone who can save triggers in an organization can run code on
every daemon that grants Hub the permissions above, so give that role carefully.

## Troubleshooting

| Message                                                                                                                                                        | What to do                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| The daemon does not allow Hub to run scripts: run `paseo hub permissions grant workspace.write` and `paseo hub permissions grant workspace.read` on that host. | Run both commands on the host, then retry.                                                  |
| Open `<cwd>` as a project in Paseo on that host, then retry.                                                                                                   | Open the working directory as a project in Paseo, or point `cwd` at a project that is open. |
| terminal ended before reporting an exit code                                                                                                                   | Something closed the terminal, or the host restarted. The output shows what it printed.     |
| script exited `<code>`                                                                                                                                         | The script failed. Read the output.                                                         |
| script timed out after `<time>`                                                                                                                                | Raise `max_runtime`, or make the script faster. Hub stopped the terminal.                   |
| script interrupted: Hub restarted while it was running                                                                                                         | Hub restarted during the run. Start it again if it is safe to repeat.                       |
| The daemon is not connected to this Hub, so it cannot run the script.                                                                                          | Connect the daemon. A script runs only on a daemon connected to this Hub process.           |
| trigger `<name>` runs a script, so `<event>` needs filters.from_users...                                                                                       | Name the people allowed to start it.                                                        |
| trigger `<name>` runs a script on github.notification...                                                                                                       | Set both `filters.repo` and `filters.reason`, and use a reason that is not a mention.       |
| Script actions on manual.run are not available yet...                                                                                                          | Use a schedule, a GitHub notification, or another external event.                           |
| script text is not templated...                                                                                                                                | Remove the `${{ }}` and read `HUB_EVENT_JSON` in the script.                                |

## Ownership

`src/config/compiler.ts` owns the script step and its launch checks. `src/triggers/configuration/`
owns the `run.script` document shape and the form. `src/daemons/terminals/` owns the terminal
requests and the wrapper. `src/workflows/script-step.ts` runs a step for the durable engine. The
step's terminal and result live in the existing step output, so there is no extra table.
