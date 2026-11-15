# Running omp from triggers

An organization trigger can run the `omp` (oh-my-pi) agent provider unattended. Choose an omp model
under **Agent**, then choose mode **full**. The form offers no other mode for omp.

## Requirement: mode full

omp is accepted only in mode `full`. Hub refuses `write`, `ask`, and an omitted mode when you
validate or save the trigger. Nobody answers prompts during a Hub run, and omp prompts for approval in
every other mode, so such a run would stall until `idle_timeout`.

Mode `full` runs omp in its yolo approval mode: every tool call runs without approval. That includes
every MCP server configured in omp on the daemon's host, not only the Hub tools. Hub cannot restrict
it. Whoever writes the trigger accepts that, and should give the run only a working directory and
credentials it may use freely.

## How it differs from other providers

For Claude, Codex, and OpenCode, Hub sends a tool policy that preapproves exactly the Hub MCP tools
(`finish_execution`, `reply`). The daemon accepts that policy only for those providers. For omp, Hub
omits the policy and still injects the `hub` MCP server. The daemon bridges that server into omp as
tools, so `finish_execution` and `reply` work as they do for other providers. Everything else about
the launch is unchanged.

## Example

```yaml
name: webapp-review
enabled: true
on:
  manual.run: {}
run:
  target:
    daemon: your-daemon
    cwd: /workspace/acme/webapp
  agent:
    provider: omp
    mode: full
  prompt: Review the open changes in acme/webapp, then call finish_execution with a summary.
  max_runtime: 1h
  idle_timeout: 10m
```

## When a run ends without finish_execution

Tell the agent in the prompt to call `finish_execution`. If the run ends without it, Hub waits until
`idle_timeout` passes with no agent activity, then marks the execution failed. A run that exceeds
`max_runtime` is marked failed the same way.
