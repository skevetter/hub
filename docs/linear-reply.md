# Linear run replies

## Opt in

Set `reply_message: true` on a Linear trigger, or enable **Post the agent's reply**
in the trigger editor. Replies are off by default. The trigger needs a named
`from_users` audience. The workflow's existing completion rules and
`progress_message` setting apply independently.

## Answer selection and privacy

Hub waits for the workflow to succeed and uses the final assistant message from
the last agent step that ran. A step skipped by its `if` does not count, so an
earlier step's final message is posted when every later agent step was skipped.
If no agent step ran, the run records `No agent step ran, so there was no reply.`
Hub collects live message deltas for every agent step that could be last, in
memory, and redacts credentials before sending. Only the message of the step that
ran last leaves Hub. If that step sends an empty final message, Hub refuses the
reply and does not fall back to an earlier step.

Answer capture adds no tool. The automatic `<provider>.reply` output is granted
to the last agent step by position, and to any step you grant it to explicitly.
A step without that grant can have its final message posted by Hub, but it cannot
post through the tool. To let an earlier step reply with the tool, grant it that
output yourself.

Because an earlier step's final message can now be posted, give each step that
could be last only context you are willing to show the issue's readers.

After a successful call to `finish_execution`, Hub waits up to 10 seconds for
that turn to end. A missing turn end produces a refusal on the run.

The answer leaves Hub for the source issue as a new Paseo app comment. Anyone
who can read the issue can read the answer. Hub retains only delivery
metadata, including the comment ID, length and hash. For an opted-in run,
inferred turn completion on the last agent step by position records the
completion status in its execution result and step output, without the message.
Earlier steps keep recording their message as before. Captured messages stay
in memory until the run settles, and Hub reads only the one from the last step that ran.

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

When Linear confirms a rate limit before the create ran, Hub can retry once
with the same UUID within the delivery deadline. It waits for Linear's retry
delay and checks the target again first. A confirmed rejection appears on the
run with Linear's refusal reason.

## Loop protection and limits

Hub ignores comments from the connected Paseo app when matching triggers.
It drops app replies before recording the webhook body and omits marked replies
when it loads earlier comments for a later run.

This applies to every Linear comment webhook, with or without `reply_message`.
Hub looks up the connection's app user for each comment event. A comment written by
that user, or any comment that carries a `Paseo reply <id>` line, returns 200
and stores no receipt. Build 21 stored a receipt for these comments and could
match them to a trigger. The change is intentional loop protection. Tests in
`src/triggers/linear/webhook.test.ts` cover both cases.
`PASEO_HUB_LINEAR_REPLIES_PER_HOUR` defaults to 60 delivery attempts per
Hub organization in a rolling hour. The database enforces the cap across
Hub processes.

Hub delivers replies and repairs uncertain ones from one background cycle. The cycle
runs every 2 seconds while a captured answer waits, and a new answer never delays a
cycle that is already scheduled. With nothing waiting it runs every 30 seconds, so an
idle Hub makes at most 2 database queries per minute for replies.

## Acceptance limits

For any answer, including adversarial input:

- The reply always posts, as Markdown or as plain text. It is never lost because the
  Markdown step fails.
- No resolvable mention or profile link survives, and no known secret appears verbatim.
- The final body is at most 3,500 characters.
- Rendering takes under 300 ms in the worst case and under 30 ms for typical answers.

Which path an answer takes depends on its text alone. Deeply nested or marker-heavy
text goes to plain text before any parsing. The 150 ms render budget is only a last
safety net, and Hub logs a debug line when it fires. The cap of 60 replies per hour per
organization bounds the total CPU an adversary can spend.

## Troubleshooting and turning replies off

The Activity run detail shows **Reply not posted** with the reason when Hub
refuses a reply or cannot confirm delivery. Clear **Post the agent's reply**
in the editor, or remove `reply_message` from YAML, to stop replies for
future runs.
