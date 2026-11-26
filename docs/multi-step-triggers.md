# Multi-step triggers

A trigger can run several steps in order when its event arrives. Each step is an agent prompt or a
shell script. Use `run` for one step and `steps` for two or more. A document has one of them,
never both.

## YAML

Put the target at the top level of the document. Every step runs on that daemon and in that
directory.

```yaml
name: build-check
on:
  manual.run:
    filters:
      from_users: [alice]
target:
  daemon: your-daemon
  cwd: /workspace/app
max_runtime: 3h
steps:
  - id: build
    script: npm ci && npm run build
    max_runtime: 15m
  - id: review
    agent: { provider: codex, mode: full-access }
    prompt: Review the build log in the output tail.
    output:
      schema:
        type: object
        properties:
          verdict: { enum: [ok, fix] }
        required: [verdict]
  - id: fix
    if: "${{ steps.review.outputs.verdict == 'fix' }}"
    agent: { provider: codex, mode: full-access }
    prompt: Fix the problems from the review.
```

A document with `run` is unchanged. It is the same as one step with the id `run`, and its target
stays inside `run`. Existing triggers, their saved text, and their hashes do not change.

## Rules

| Rule             | Detail                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `run` or `steps` | Exactly one. Both, or neither, is refused.                                                           |
| Step count       | 1 to 20. A longer list is refused at `steps`.                                                        |
| `target`         | Top level, with `steps`. A step with its own `target` is refused. With `run`, target stays in `run`. |
| `id`             | Required on every step. Letters, digits, `_` and `-`. Unique within the trigger.                     |
| Step kind        | A step with `script` is a script step. Otherwise it is an agent step with `agent` and `prompt`.      |
| `if`             | Optional. Skips the step when it is false. It may read `steps.<id>.outputs` of earlier steps.        |
| `continuation`   | Per agent step, opt in. A step without one starts a new agent. No document-level `continuation`.     |
| Reply            | `reply_message` adds the reply output to the last agent step only.                                   |

A step accepts the fields `run` accepts for its kind, except `target`. A script step refuses the
same agent options as a script `run`. See [script actions](script-actions.md). A `worktree` under
`target` is refused when any step is a script, because a script runs in the directory as it is.

## When a step fails

A step that fails or times out stops the run. Later steps do not start. There is no
continue-on-failure option. A step skipped by `if` does not stop the run.

`max_runtime` at the top level is the deadline for the whole run. When you leave it out, the run gets the
sum of its steps' deadlines, up to the 24 hour limit every deadline has. Each step keeps its own
`max_runtime`, `idle_timeout` and `startup_timeout`. Any of them ending the run records
`timed_out`.

## Continuation

Follow-up replies continue a step only when that step says so. In a `steps` list, an agent step without
`continuation` starts a new agent every time. Set `continuation: { mode: conversation }` or
`continuation: { mode: key, key: ... }` on a step to continue an earlier conversation.

`run` is different: it keeps `continuation: conversation` as its default. So a one-item `steps` list
without `continuation` behaves like `run` with `continuation: new`.

Steps that continue the same conversation share one agent session, and a session only accepts steps that
match in agent, `env`, `github`, `background`, output schema and allowed outputs. Hub refuses a document
where two such steps differ, at `steps.N.continuation`, and says which fields differ. Give one step
`continuation: new` or a different key. Each event is checked on its own. The reply tool a chat event adds
to the last agent step, and a key written with inputs or event data, are checked when the step dispatches.
A key written as a template is compared by its text when it reads nothing from the event.
A conversation key belongs to the project, not to one trigger: two triggers in the same project that use
the same key and match in the fields above share one session. On Slack, Discord, Linear and GitHub events the reply output is added to the last
agent step, so two steps that both use `continuation: conversation` always differ there.

## Choosing between agents

A step can use `agent.select` with `choices`, as `run` does. Hub keeps one table of named agents for
the trigger, so every step that uses `choices` must list the same ones. A step whose choices differ is
refused at `steps.N.agent.choices`. Steps with an inline `agent` are not affected.

## Step output

A later step reads an earlier step with `${{ steps.<id>.outputs.<field> }}`. The earlier step must
declare `output.schema`, and only earlier steps can be read. The compiler checks both when you save.
If the earlier step was skipped by `if`, a step that reads its output fails instead of running with an empty value.

## Errors

Validation errors name the place in the document: `steps.1.if`, `steps.0.id`, `target.daemon`. With
`run`, they name `run...` as before.
