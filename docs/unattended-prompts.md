# Writing unattended prompts

A trigger starts an agent with no one watching. Hub expects the agent to say it is done by calling
the Hub MCP tool `finish_execution`. Claude shows it as `mcp__hub__finish_execution`. Until the
agent calls it, Hub treats the run as unfinished.

## What goes wrong

Claude sometimes answers with a short "ok" and ends its turn without calling `finish_execution`.
In one measurement about 30 percent of Claude runs did this. The work was done, but the run sat
idle until `idle_timeout` passed and Hub marked the run timed out with `step_idle_timeout`. Permission mode
and load did not change the rate. Naming the tool in the prompt made 15 of 15 runs finish.

Hub never rewrites a prompt, so it cannot add that line for you. You add it, or you turn on
`complete_on_turn_end`, or both.

## Prompt line

Put this at the end of the prompt. It is safe to copy as is:

```text
When the work is done, call the Hub finish tool (finish_execution, shown as
mcp__hub__finish_execution in Claude) with the executionId you were given, then stop. Do not end
your turn without calling it.
```

A run that continues a conversation gets a `Hub execution:` line in front of the prompt that holds
the executionId, and the tool asks for it as `executionId`. A run with continuation `new` is bound
to its execution already, so the tool needs no executionId. The same line works for both.

## Setting: complete_on_turn_end

`complete_on_turn_end` is an option on the agent action. It is off by default. When it is off,
nothing changes: an agent that stops without calling `finish_execution` times out with
`step_idle_timeout` once `idle_timeout` passes.

```yaml
run:
  target:
    daemon: your-daemon
    cwd: /workspace/project
  agent:
    provider: claude
    mode: default
  prompt: |
    Triage the new issue.

    When the work is done, call the Hub finish tool (finish_execution, shown as
    mcp__hub__finish_execution in Claude) with the executionId you were given, then stop.
  idle_timeout: 10m
  complete_on_turn_end: true
```

In the trigger form it is the checkbox **Complete when the agent ends its turn**. Exported
trigger YAML keeps the key as authored: `true` and `false` stay, and an unset key stays unset.

### What it does

When the setting is on and the agent ends a turn without calling `finish_execution`, Hub completes
the step as succeeded. The step output and the execution result say it was inferred:

```json
{
  "status": "succeeded",
  "completion": "inferred_from_turn_end",
  "output": "The agent's closing message."
}
```

An explicit finish has no `completion` field, so you can tell the two apart. `output` is the
agent's closing message: the assistant text after its last tool call, cut to 16,000 characters
with `outputTruncated: true` when longer. If the agent said nothing, there is no `output`. Hub
does not make one up. Hub drops NUL characters and replaces unpaired surrogates with U+FFFD before it stores the text.

### When Hub counts a turn as finished

Hub waits for the daemon's `turn_completed` event, which is the daemon's own report that a turn
ended normally. Then it waits 2 seconds. Any new activity in that time cancels the completion: a
new turn, a tool call, a message, a permission request. After the wait Hub checks the execution
again, asks the daemon for the agent's status, and completes the step only if the agent is idle.

These cases do not complete, and fail or time out as before:

- A turn that is still running, including a tool call in flight.
- A turn waiting for a provider permission or question request. It has not ended.
- A turn that errored or was canceled.
- A turn with a `finish_execution` call that is still running or has completed. The explicit
  finish owns the outcome. A call that failed or was canceled does not block the completion.
- A daemon that cannot be reached when Hub checks.
- A turn shared by several queued prompts of one continuation. One turn cannot be matched to one
  execution, so those runs use the idle timeout.

A turn that ended while Hub was down is not seen, so that run uses the idle timeout.
Keep `idle_timeout` above 2 seconds.

### Explicit finish wins

The first writer wins. If the agent calls `finish_execution` before Hub completes the step, the
explicit finish is the result. If the agent calls it after Hub completed the step, Hub keeps the
inferred result and completes nothing twice. The tool call may report that the execution is no
longer live. That is expected, and the run stays succeeded.

### Limits

The setting is refused when the step declares `output.schema` or a `required` output. A finished
turn carries free text, so it cannot satisfy either contract. Use the prompt line for those steps.

If an agent ends a turn expecting to continue later, for example after starting background work,
the run completes at that turn end. Leave the setting off for such prompts.

A turn that ends by asking a question in plain text has ended normally. The run completes as
succeeded, with the question as `output`. Only a provider permission or question request keeps a
turn open.

Hub checks the agent's status once, when the settle wait ends. If that lookup fails for a transient
reason, Hub does not retry it, and the run uses the idle timeout. A new turn that starts within a
few milliseconds of Hub writing the completion can still lose the race: the run is already
succeeded.

## Recommendation

For the most reliable runs, use both: the prompt line and `complete_on_turn_end: true`. The prompt
line makes the agent finish on its own and gives you an explicit finish. The setting catches the
rest.
