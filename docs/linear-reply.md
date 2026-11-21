# Linear run replies

## Opt in

Set `reply_message: true` on a Linear trigger, or enable **Post the agent's reply**
in the trigger editor. Replies are off by default. The trigger needs a named
`from_users` audience. The workflow's existing completion rules and
`progress_message` setting apply independently.

## Answer selection and privacy

Hub waits for the workflow to succeed and uses the final assistant message from
the last agent step it ran. It collects live message deltas for that turn in
memory and redacts credentials before sending. After a successful call to
`finish_execution`, Hub waits up to 10 seconds for that turn to end. An empty
final message or a missing turn end produces a refusal on the run.

The answer leaves Hub for the source issue as a new Paseo app comment. Anyone
who can read the issue can read the answer. Hub retains only delivery
metadata, including the comment ID, length and hash. For an opted-in run,
inferred turn completion records the completion status in execution results
and step outputs. The captured assistant message stays in memory through delivery.

## Delivery and repair

Hub checks the original Linear connection, workspace and issue against the
run's evidence. For comment triggers it also checks that the source comment
is still on that issue with the original text. The app uses the connection's `comments:create`
scope. The answer is capped at 3,500 characters, with a truncation notice.
Hub neutralizes mentions, strips images and raw HTML, and keeps ordinary
links.

Hub reserves one comment UUID per run before calling Linear and adds a short
delivery reference to the comment. After an uncertain create, Hub checks that
specific UUID on the bound issue and verifies the app author and reference.
It adopts a matching comment and records unconfirmed delivery if it cannot
verify the comment. Repair only reads from Linear. A restart that loses the
in-memory answer before any send records a refusal.

## Loop protection and limits

Hub ignores comments from the connected Paseo app when matching triggers.
It drops app replies before recording the webhook body and omits marked replies
when it loads earlier comments for a later run.
`PASEO_HUB_LINEAR_REPLIES_PER_HOUR` defaults to 60 delivery attempts per
Hub organization in a rolling hour. The database enforces the cap across
Hub processes.

## Troubleshooting and turning replies off

The Activity run detail shows **Reply not posted** with the reason when Hub
refuses a reply or cannot confirm delivery. Clear **Post the agent's reply**
in the editor, or remove `reply_message` from YAML, to stop replies for
future runs.
