# Authenticated webhook triggers

Send a message and data from a service you control to a named Hub trigger. Each request starts
only that trigger. To start several triggers, call each URL. This is a server to server API;
there is no CORS or browser preflight support.

## Create a sender key

1. Open **Settings**, then **API keys** in the organization that owns the trigger. Create a key
   named `CI partner`.
2. Select **Send events** (`events:send`) only. This scope cannot read runs, change triggers, or
   call `/api/v1/manual-runs`. That endpoint requires `runs:dispatch` instead.
3. Set **Actor** to `ci-partner`. The default is a slug of the key name. Actors contain 1 to 63
   lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.
   The actor is required for Send events. Existing keys without an actor cannot send webhooks.
4. Optionally restrict **Allowed triggers** to `build-finished`. An empty selection means any
   trigger that allows this actor, not every trigger unconditionally. A key can have up to 50
   unique allowed names; the names need not exist yet.
5. Create the key and save its secret from the one time reveal in the sender's secret store.
   Supply it to the examples as `HUB_KEY`. Never paste it into a trigger, event, URL, or log.

The key belongs to one organization. Hub uses its bound actor, ignoring any actor in the request
body or other headers. `from_users` must allow that actor. Trigger names do not cross organization
boundaries, even if another organization uses the same name. Unknown, disabled, wrong event kind,
and disallowed triggers all return the same `404 trigger_not_found`.

Keys have no expiry. To rotate, create another key, switch the sender, then revoke the old key on
the API keys page. Revoked keys return `401`. Last used is updated at most once per minute, not
on every delivery; use it as a coarse signal of unexpected use, not an exact request timestamp.

## Write a trigger

Choose **Manual run** in the trigger editor, narrow its audience to `ci-partner`, and use its
**Webhook** URL. A disabled trigger still shows the URL but returns `404` until enabled.
Alternatively, submit this document as `yaml` to the trigger validation and installation APIs.
Replace `daemon-10000000` and `/workspace/webapp` with your enrolled daemon and working directory.
Choose a low authority agent mode supported by that daemon.

```yaml
name: build-finished
enabled: true
on:
  manual.run:
    filters:
      from_users: [ci-partner]
      inputs: { status: failed }
inputs:
  status: { type: string, required: true, choices: [passed, failed] }
  failures: { type: number }
run:
  target: { daemon: daemon-10000000, cwd: /workspace/webapp }
  agent: { provider: codex, mode: read-only }
  prompt: |
    Summarize this build report without running commands.
    Summary: ${{ paseo.prompt }}
    Status: ${{ paseo.inputs.status }}
    Event: ${{ paseo.context }}
  max_runtime: 30m
```

The YAML event remains `manual.run`. Accepted webhook receipts and activity use source
`webhook.received`; this is not another YAML event name. A filter mismatch accepts the delivery
without starting a run. Trigger names are case sensitive and match `^[a-z][a-z0-9_-]*$`.

## Send an event

Set `HUB_URL` in the sender's environment to your Hub origin, with no trailing slash, and `HUB_KEY`
to the key from your secret store. Use HTTPS outside a local test. All three examples send the
same report with different delivery identities. Repeating one example returns its original result.
Each prints the JSON response and treats an HTTP error as a failure. They make one attempt;
apply the retry policy below in a production sender.

### curl

```sh
curl --fail-with-body --silent --show-error \
  -X POST "$HUB_URL/api/v1/hooks/build-finished" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: build-43-curl' \
  --data '{"message":"build 43 finished: 2 tests failed","status":"failed","failures":2}'
```

### Node.js

Run with a current Node.js release that includes `fetch`:

```javascript
const response = await fetch(`${process.env.HUB_URL}/api/v1/hooks/build-finished`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.HUB_KEY}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "build-43-node",
  },
  body: JSON.stringify({
    message: "build 43 finished: 2 tests failed",
    status: "failed",
    failures: 2,
  }),
});
if (!response.ok) throw new Error(`Webhook returned ${response.status}: ${await response.text()}`);
console.log(await response.text());
```

### Python

This uses only the Python 3 standard library:

```python
import json
import os
import urllib.request

request = urllib.request.Request(
    os.environ["HUB_URL"] + "/api/v1/hooks/build-finished",
    data=json.dumps({"message": "build 43 finished: 2 tests failed", "status": "failed", "failures": 2}).encode("utf-8"),
    headers={
        "Authorization": "Bearer " + os.environ["HUB_KEY"],
        "Content-Type": "application/json",
        "Idempotency-Key": "build-43-python",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode("utf-8"))
```

## Request contract

Use `POST /api/v1/hooks/{trigger}`, without a trailing slash. The name is URL decoded once.
No project slug fallback exists. Other methods return `405` and `Allow: POST`.

| Header                        | Required | Meaning                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `Authorization: Bearer <key>` | Yes      | Organization API key with `events:send` and a bound actor.                                                   |
| `Content-Type`                | Yes      | `application/json` or `text/plain`, case insensitive. Only UTF-8 is supported. Other parameters are ignored. |
| `Idempotency-Key`             | No       | 1 to 200 printable ASCII characters. Supply it whenever retrying.                                            |
| `X-Request-ID`                | No       | Echoed if it matches `^[A-Za-z0-9._-]{1,128}$`; otherwise Hub generates an id.                               |

Credentials are accepted only in the Authorization header, never query parameters. CLI login
credentials cannot call this endpoint, even though they have operator scopes. HMAC signatures
are not supported in v1. Services that cannot set an Authorization header cannot use this API.

A JSON body must be an object. Optional `message` must be a string and becomes the complete
`${{ paseo.prompt }}`. Without it the prompt is empty. Top level fields fill only declared inputs:
strings need JSON strings, numbers need finite JSON numbers without string coercion, and booleans
need JSON booleans. Missing values use declared defaults. Missing required values, nulls, wrong
types and values outside `choices` return `422 invalid_input` with field issues before storage.
Undeclared fields, including objects and arrays, stay in context but gain no input authority.
A JSON message does not parse `key=value` input headers.

A `text/plain` body becomes the complete prompt, including whitespace and any `key=value` header
tokens. Only this text path parses those tokens for declared inputs. It has no JSON data object.
Empty text is invalid. JSON arrays and scalar values are invalid bodies. Empty or malformed JSON
is invalid JSON. A UTF-8 byte order mark is stripped; invalid UTF-8 is refused. Duplicate JSON
object keys use the last value.

`${{ paseo.context }}` contains a `manual` object with `actor`, `input`, optional `data`, `trigger`,
`delivery_id` and `source`. JSON `data` is the entire parsed object, including `message`. Context
is opt in: include the expression only where the agent needs it.

The stored and rendered context copy has a 64 KiB serialized JSON budget. If oversized, Hub first
replaces `manual.data`, then `manual.input` if needed, with `{ "truncated": true, "bytes": n }`.
Each byte count is the UTF-8 size of that field's original JSON serialization, not its character
count or the size of the whole context. This can truncate context input as well as data. The full
run prompt, typed inputs and original receipt payload remain intact. This context bound is not a
payload retention limit.

## Responses and retries

| HTTP status | Body and meaning                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `202`       | New run: `deliveryKey`, `providerEventReceiptId`, `triggerRunId`, `configuredTriggerName`, `workflowStatus`, `duplicate: false`. Acceptance does not mean the run has finished. |
| `200`       | Existing delivery: the original run identity fields and `duplicate: true`. No new run.                                                                                          |
| `202`       | Filtered delivery: `{ "status": "filtered", "duplicate": false }`, without run ids.                                                                                             |
| `200`       | Duplicate filtered delivery: `{ "status": "filtered", "duplicate": true }`.                                                                                                     |

Success uses `application/json`. Failures use RFC 9457 `application/problem+json` with `code`,
`detail` and `requestId`. Responses also include `X-Request-ID`. Check run progress in Hub.

Idempotency is scoped by organization, project and trigger name, with no expiry. Reuse a key only
for the same event. Omitting the header generates a random delivery identity and does not dedupe.
A duplicate still passes authentication, permissions, media type, UTF-8, envelope size, message,
depth and object key limits, and rate limiting. Once a valid duplicate envelope is recognized,
its new typed input values are ignored and the active run cap is bypassed. It returns the original
result, even if the new body would fail typed input validation. Rejected requests before storage
do not reserve a key. Races can return `409 dispatch_conflict`; retry with the same key. This is
not an exactly once execution guarantee, including across restarts.

Retry only `409`, `429`, `503`, or a network failure. Keep the same body and Idempotency-Key.
Use exponential backoff with full jitter: before retry number n, choose a random delay from zero
to `min(60, 2^(n-1))` seconds. The first retry window is 1 second, and the cap is 60 seconds.
Make at most 8 total attempts, including the initial request. If `Retry-After` is present, wait
at least that long; accept either whole seconds or an HTTP date. Do not retry other HTTP errors,
including other 4xx responses or `500`. After an ambiguous network failure, a retry with the same
key is how to discover whether the original event was accepted.

## Errors and troubleshooting

| HTTP status | Code                         | What to check                                                                                   |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `400`       | `invalid_json`               | Send valid, nonempty JSON when using application/json.                                          |
| `400`       | `invalid_request`            | Check Idempotency-Key characters and length, UTF-8 encoding, and nonempty text.                 |
| `401`       | `unauthorized`               | Supply a valid, unrevoked key in the header. Includes `WWW-Authenticate: Bearer`.               |
| `403`       | `insufficient_scope`         | Create a key with events:send.                                                                  |
| `403`       | `key_actor_required`         | Use an API key with a bound actor, not a CLI credential or a legacy unbound key.                |
| `403`       | `actor_forbidden`            | Add the key's actor to the trigger's from_users audience.                                       |
| `404`       | `trigger_not_found`          | Check the organization, exact name, enabled state, manual.run event and allowed trigger names.  |
| `405`       | `method_not_allowed`         | Use POST. The response includes Allow: POST.                                                    |
| `409`       | `dispatch_conflict`          | Retry the same delivery key after a concurrent dispatch race.                                   |
| `413`       | `payload_too_large`          | Reduce the raw body or message to the limits below.                                             |
| `415`       | `unsupported_media_type`     | Use application/json or text/plain with UTF-8 charset.                                          |
| `422`       | `invalid_input`              | Fix message type, declared input types, required fields or choices. The issues identify fields. |
| `422`       | `invalid_body`               | Send a JSON object with finite numbers and stay within depth and object key limits.             |
| `429`       | `rate_limited`               | The sender's per-key bucket is empty. Honor Retry-After, rounded up to whole seconds.           |
| `429`       | `trigger_busy`               | Too many running runs for this trigger. Retry-After is 30 seconds.                              |
| `503`       | `infrastructure_unavailable` | Storage is unavailable. Retry with backoff.                                                     |
| `503`       | `authentication_unavailable` | The credential store is unavailable. Retry with backoff.                                        |
| `500`       | `internal_error`             | Use requestId to investigate the unexpected server failure; do not automatically retry.         |

## Limits and operation

| Limit                                     | Default                | Configuration and allowed range                                            |
| ----------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| Raw request body                          | 262144 bytes (256 KiB) | PASEO_HUB_WEBHOOK_MAX_BYTES, 1024 to 1048576. Also applies to manual-runs. |
| Message, including the complete text body | 65536 bytes (64 KiB)   | Fixed UTF-8 limit.                                                         |
| JSON nesting depth                        | 20                     | Fixed.                                                                     |
| Keys per JSON object                      | 1000                   | Fixed; not a total across all objects.                                     |
| Stored and rendered context copy          | 65536 bytes (64 KiB)   | Fixed serialized JSON budget.                                              |
| Per-key token refill                      | 120 per minute         | PASEO_HUB_WEBHOOK_RATE_PER_MINUTE, 1 to 6000.                              |
| Per-key burst                             | 30                     | PASEO_HUB_WEBHOOK_BURST, 1 to 1000.                                        |
| Running runs per trigger                  | 25                     | PASEO_HUB_WEBHOOK_MAX_ACTIVE_RUNS, 1 to 1000.                              |

Set environment settings on the Hub process and restart it. Values must be whole numbers within
the stated ranges. Invalid values fail startup rather than falling back to a default. Raw body
limits apply while streaming too, including chunked requests. Oversized bodies and messages return
`413`; depth and key violations return `422 invalid_body`. Invalid media types and oversized
bodies do not consume rate tokens. Authentication runs before the body checks; unauthenticated
floods are not covered by this per-key limiter. Use a separately approved edge rate limit if needed.

Buckets live in each Hub process. With several processes sharing PostgreSQL, the effective rate
and burst can reach the configured amounts times the process count. Restarting loses bucket state.
The active run check reads the shared database but is best effort, not atomic: concurrent requests
can exceed the cap. It counts running runs, including those waiting for a daemon, not completed
runs. A duplicate does not need another active slot.

## Security, retention and rollback

Treat every message, data field and typed input as untrusted. Prompt injection can arrive in any
of them. Keep agent authority low, and restrict any declared input that selects an environment,
agent or permission with narrow choices. Declaring an input does not make its value trusted.
Use a dedicated least privilege key per sender and narrow both allowed triggers and from_users.

Script actions on manual.run are supported only with a bound API key actor and an explicitly
named from_users audience, never a wildcard or empty list. On manual-runs an unbound key is also
refused for a script trigger; a bound key cannot override its actor. Webhook data reaches a script
only through HUB_EVENT_JSON, never by interpolation into command text. Parse it as data, never as
shell code. See [script actions](script-actions.md) for host permissions and inherited environment.

Never send secrets in events. Hub retains the full receipt payload and the run's prompt and typed
inputs with no expiry. The bounded context copy does not delete the full payload. Anyone able to
read those runs can see their content. Keep API keys out of request bodies, query strings and
application logs; do not print Authorization headers. A captured request without an idempotency
key can be replayed, since v1 has no signature or timestamp protection.

Before rolling back to an older Hub binary, revoke every key that includes events:send, including
keys that also have older scopes. Older binaries cannot parse that scope and may fail credential
authentication. The schema additions are additive; revocation must happen before the binary
switch, not after an error. Restore service with newly created appropriate keys after upgrading.

See the [public API](public-api.md) for the API reference, and
[GitHub notification triggers](github-notifications.md) for polling notifications instead of
receiving events from your own sender.
