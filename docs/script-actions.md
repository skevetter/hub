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
Discord or Linear event, the schedule tick, or the manual run input.

Hub passes the event and the script as separate arguments to the terminal's process, never inside a
shell string, so event text cannot change what the shell runs. Both arguments are visible in the
host's process list while the script runs. Do not put secrets in the script text or expect the
event to stay private from other users on that host.

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
seconds. When it sees the marker it takes the exit code, keeps the output before it, and kills the
terminal. It kills the terminal in every other case too.

- **Output.** A terminal merges stdout and stderr into one stream. Hub keeps at most the last 64 KB
  of it, with terminal escape codes removed, and marks the output truncated when it cut anything.
  Hub reads the last 400 terminal rows, and rows wrap at 240 columns.
- **Environment.** The script inherits the daemon's environment. Hub cannot change it. Start the
  script with `env -i` or unset what you must hide.
- **Input.** The terminal has no input. A script that reads from stdin waits until it times out.
- **Shell.** The script runs under `/bin/sh`, not your login shell. Write POSIX shell, or start the
  script with a different interpreter.
- **Time limit.** The daemon has no timeout. Hub stops the terminal at `max_runtime`, or earlier if
  the whole trigger deadline comes first, and marks the run timed out.
- **Visibility.** While it runs, the terminal is named `hub-script-` followed by the step id. Anyone
  who can see the project in Paseo on that host can read it.
- **Exit code.** Exit code 0 succeeds. Any other code fails the run with `script exited <code>`.

The run detail shows the step's exit code and a collapsible **Output**. The step output is
`{ exit_code, output_tail, truncated }`. `exit_code` is `null` when the script never reported one.

## Restart and recovery

Hub records the terminal as soon as it exists. If Hub restarts while a script runs, the new process
stops the recorded terminal and fails the run with `script interrupted: Hub restarted while it was
running`. It does not run the script again, because the script may not be safe to repeat. If the
daemon is offline at that moment, Hub waits for it to reconnect, and the step deadline still ends
the run if it does not.

If Hub never learned the terminal's id because it stopped in that short window, it finds the
terminal by its name and stops it.

## Security

A script is arbitrary code that runs as the daemon's user on the host. Treat who can start it as a
permission to run code there. Hub refuses to save a script trigger that is open to anyone:

- **People and bots.** For Slack, Discord, GitHub and Linear events, and for manual runs,
  `filters.from_users` must name the people allowed to start it. A `*` or an empty list is
  refused. The form hides the Everyone choice for a script.
- **Notifications.** A GitHub notification has no author to allowlist, so a script on it needs
  `filters.repo`, `filters.reason`, or both.
- **Schedules.** A `schedule.tick` script needs no audience. Only Hub starts it.

The same event can still start an agent trigger for everyone. The check applies to the script
trigger alone.

A script gets no GitHub token and no Hub connection secrets. It sees the daemon's environment and
the event, nothing else from Hub.

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
| trigger `<name>` runs a script on github.notification...                                                                                                       | Add `filters.repo` or `filters.reason`.                                                     |
| script text is not templated...                                                                                                                                | Remove the `${{ }}` and read `HUB_EVENT_JSON` in the script.                                |

## Ownership

`src/config/compiler.ts` owns the script step and its launch checks. `src/triggers/configuration/`
owns the `run.script` document shape and the form. `src/daemons/terminals/` owns the terminal
requests and the wrapper. `src/workflows/script-step.ts` runs a step for the durable engine. The
step's terminal and result live in the existing step output, so there is no extra table.
