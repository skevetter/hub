# Authenticated webhook triggers

Send a message and data from a service you control to a named Hub trigger. Each request starts
only that trigger. To start several triggers, call each URL. This is a server to server API;
there is no CORS or browser preflight support.

## Create a Bearer sender key

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

## GitHub SHA-256 signing keys

When your operator enables GitHub SHA-256 for the organization, choose **GitHub SHA-256**
under **Settings > API keys > Create API key**. Choose one existing enabled manual trigger
and an actor allowed by its `from_users` filter. The key keeps that trigger's identity and
name for its lifetime. To use a different trigger or replace a deleted trigger, create a new key.

In GitHub's webhook settings, paste the **GitHub webhook URL** into **Payload URL**,
choose `application/json` as the content type, and paste the **Signing secret** into **Secret**.
Hub shows the secret once. The URL contains the public key UUID and can be copied separately.
The trigger receives GitHub JSON as context. A native event without a `message` field
has an empty prompt, so include `${{ paseo.context }}` where the workflow needs the data.

| Route                                          | Authentication                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /api/v1/hooks/{trigger}`                 | Organization Bearer API key with `events:send` and a bound actor                       |
| `POST /api/v1/hooks/{trigger}/signers/{keyId}` | GitHub SHA-256 signing key with `events:send`, a bound actor and one immutable trigger |

The signer route requires one `X-Hub-Signature-256: sha256=<64 lowercase hex digits>` header.
Compute HMAC-SHA256 over the exact request bytes, using the full `paseo_whsec_...` string as
the UTF-8 key. Sign the BOM, whitespace and final newline if present. Send identity-encoded
UTF-8 JSON. The `Authorization` and `X-Paseo-Signature` headers are rejected on the signer
route. Hub v1, SHA-1-only signing, dual authentication and other signed sender formats are unsupported.

Hub uses the SHA-256 digest of the raw body to record a delivery permanently for the signing
key. Reuse the exact bytes to retry. A duplicate returns the original run identity or filtered
result, even after secret rotation. If supplied, `Idempotency-Key` must equal `github-sha256:`
followed by the lowercase raw-body SHA-256 hex digest. `X-GitHub-Delivery` and `X-GitHub-Event`
are unsigned and have no effect on routing, authorization or deduplication.

GitHub signs the body without a timestamp. An unseen captured request can be accepted later
while its secret remains eligible. Identical legitimate payloads collapse. Different bytes
signed by an authorized sender count as a separate delivery. Replacing the entire key
starts a new delivery history and generates a new secret.

Invalid signatures, revoked keys and disabled signing return `401 unauthorized` without a
Bearer challenge. Unavailable signing authentication returns `503 authentication_unavailable`.
After valid authentication, a missing, disabled, changed or forbidden target returns
`404 trigger_not_found`. The payload, size, rate and active-run limits below also apply.

### Send a GitHub-compatible request

Set `HUB_SIGNER_URL` to the URL shown at creation, `HUB_SIGNING_SECRET` to the one-time
secret and `HUB_BODY_FILE` to a JSON file containing the request bytes. This Node.js example
sends the file unchanged. Set a different `GITHUB_DELIVERY_ID` to retry with a different
unsigned delivery header.

```javascript
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const body = await readFile(process.env.HUB_BODY_FILE);
const signature = createHmac("sha256", process.env.HUB_SIGNING_SECRET).update(body).digest("hex");
const response = await fetch(process.env.HUB_SIGNER_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": "sha256=" + signature,
    "X-GitHub-Delivery": process.env.GITHUB_DELIVERY_ID ?? "example-delivery",
  },
  body,
});
if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
console.log(await response.text());
```

### Rotate a signing secret

Use the key's **Rotate signing secret** action and update GitHub. During the overlap, both
versions can authenticate. The default is one hour and the supported range is zero to 72 hours.
Choose zero for immediate cutover after a compromise when no overlap is appropriate. Revoke the
key if you need to invalidate both versions. In-flight requests that already passed
authentication may complete. Retire the previous version explicitly or wait until it expires
before rotating again. If you lose a reveal response, reload the list to check its version, then
rotate explicitly or revoke the key. The list and API never recover an issued secret.

Session-authenticated managers can create a signing key with
`POST /api/auth/paseo/api-keys` using `scopes: ["events:send"]`, a bound `actor`, and
`authentication: { mode: "hmac", profile: "github_sha256", targetTriggerId }`.
The response includes `signingSecret` once and uses `Cache-Control: no-store`.
`POST /api/auth/paseo/rotate-api-key-signing-secret` takes `id`, `expectedCurrentVersionId`
and optional `overlapSeconds`. `POST /api/auth/paseo/retire-api-key-signing-secret`
takes `id` and `expectedPreviousVersionId`. Stale versions and an unexpired previous
version during rotation return `409`. Listing returns version metadata only. Revocation
continues to work when signing is disabled.

### Enable signing on a self-hosted Hub

| Setting                                       | Value                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PASEO_HUB_WEBHOOK_HMAC_ENABLED`              | `true` to enable webhook signatures. Defaults to `false`.                                           |
| `PASEO_HUB_WEBHOOK_GITHUB_SIGNATURES_ENABLED` | `true` to enable GitHub SHA-256. Defaults to `false`.                                               |
| `PASEO_HUB_WEBHOOK_HMAC_ORGANIZATION_IDS`     | JSON array of eligible organization IDs. Defaults to an empty array.                                |
| `PASEO_HUB_WEBHOOK_HMAC_KEYRING`              | Secret JSON object mapping up to two versioned key IDs to canonical base64 of 32 random bytes each. |
| `PASEO_HUB_WEBHOOK_HMAC_ACTIVE_KEY_ID`        | Key ID used for new signing secret versions. Required when HMAC is enabled.                         |

Inject the master keyring from a secret manager or encrypted vault through the service
environment. Keep the master keys and their recovery copy separate from database dumps.
The database holds random salts and key IDs. A signing secret requires both its database
record and the corresponding master key. Verify both sources in an isolated restore before
enabling signing. Invalid enabled key configuration or missing master keys for eligible
stored versions refuse startup.

Keep the master bytes for each existing key ID identical. To rotate the master, add a new
key ID to the keyring and make it active. Rotate each sender to a new signing secret, update
GitHub, and wait for or retire the old overlap. Remove the old online key only after no
eligible versions reference it. Keep offline copies for retained backups.

Restore with signing disabled. Reconcile revocations and retire or rotate restored signing
versions before exposure. Restoring an older dump can restore old keys and lose delivery
history. Before rolling back to a binary without signature enforcement, revoke signed keys
with the current binary and preserve the additive schema. A predecessor that also predates
`runs:read` or `events:send` needs that feature's scope cleanup before the switch.
The existing no-expiry receipt and run payload policy also applies to signed deliveries.

## Request contract

Use `POST /api/v1/hooks/{trigger}`, without a trailing slash. The name is URL decoded once.
No project slug fallback exists. Other methods return `405` and `Allow: POST`.

| Header                        | Required | Meaning                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `Authorization: Bearer <key>` | Yes      | Organization API key with `events:send` and a bound actor.                                                   |
| `Content-Type`                | Yes      | `application/json` or `text/plain`, case insensitive. Only UTF-8 is supported. Other parameters are ignored. |
| `Idempotency-Key`             | No       | 1 to 200 printable ASCII characters. Supply it whenever retrying.                                            |
| `X-Request-ID`                | No       | Echoed if it matches `^[A-Za-z0-9._-]{1,128}$`; otherwise Hub generates an id.                               |

The original hooks route accepts organization API keys in the Authorization header.
Query parameters carry no credentials. CLI logins cannot call either hooks route.

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

JSON string values and object keys must contain Unicode scalar values without U+0000. Escaped
NUL or an unpaired UTF-16 surrogate anywhere in JSON, including `message`, returns `422 invalid_body`.
A text body containing U+0000, or any body containing invalid UTF-8, including UTF-8 encodings of
surrogate code points, returns `400 invalid_request`. Valid surrogate pairs representing astral
characters are accepted. These rejections store no receipt and do not reserve the `Idempotency-Key`.

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

Bearer delivery idempotency is scoped by organization, project and trigger name, with no expiry.
Reuse an Idempotency-Key for the same event. Omitting that header on the Bearer route generates
a random delivery identity. GitHub SHA-256 always deduplicates by signed body, even when the
header is omitted.

A duplicate still passes authentication, permissions, media type, UTF-8, envelope size, message,
depth and object key limits, and rate limiting. Once a valid duplicate envelope is recognized,
its new typed input values are ignored and the active run cap is bypassed. It returns the original
result, even if the new body would fail typed input validation. Rejected requests before storage
do not reserve a key. Races can return `409 dispatch_conflict`; retry with the same key. This is
not an exactly once execution guarantee, including across restarts.

[Run payload retention](run-payload-retention.md) preserves public webhook deduplication after
the receipt body expires. An authorized Bearer retry with the same key returns the original run
or filtered result even if the valid envelope carries a different body. Signed retries still
require the exact original bytes and a currently valid signer for the original trigger. During
key rotation, a valid overlapping or current key for that signer can authenticate the same
retry. Expiry leaves the recorded result available and prevents new work for that delivery.

Retry only `409`, `429`, `503`, or a network failure. Keep the same body and any Idempotency-Key.
Use exponential backoff with full jitter: before retry number n, choose a random delay from zero
to `min(60, 2^(n-1))` seconds. The first retry window is 1 second, and the cap is 60 seconds.
Make at most 8 total attempts, including the initial request. If `Retry-After` is present, wait
at least that long; accept either whole seconds or an HTTP date. Do not retry other HTTP errors,
including other 4xx responses or `500`. After an ambiguous network failure, a retry with the same
key is how to discover whether the original event was accepted.

## Errors and troubleshooting

| HTTP status | Code                         | What to check                                                                                                     |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `400`       | `invalid_json`               | Send valid, nonempty JSON when using application/json.                                                            |
| `400`       | `invalid_request`            | Check Idempotency-Key characters and length, UTF-8 encoding, and nonempty text.                                   |
| `401`       | `unauthorized`               | Check the API key or the GitHub signature and signing key. Invalid Bearer credentials receive a Bearer challenge. |
| `403`       | `insufficient_scope`         | Create a key with events:send.                                                                                    |
| `403`       | `key_actor_required`         | Use an API key with a bound actor, not a CLI credential or a legacy unbound key.                                  |
| `403`       | `actor_forbidden`            | Add the key's actor to the trigger's from_users audience.                                                         |
| `404`       | `trigger_not_found`          | Check the organization, exact name, enabled state, manual.run event and allowed trigger names.                    |
| `405`       | `method_not_allowed`         | Use POST. The response includes Allow: POST.                                                                      |
| `409`       | `dispatch_conflict`          | Retry the same Bearer delivery key or the same signed body after a concurrent dispatch race.                      |
| `413`       | `payload_too_large`          | Reduce the raw body or message to the limits below.                                                               |
| `415`       | `unsupported_media_type`     | Use UTF-8 JSON or plain text for Bearer. Use identity-encoded UTF-8 JSON for GitHub SHA-256.                      |
| `422`       | `invalid_input`              | Fix message type, declared input types, required fields or choices. The issues identify fields.                   |
| `422`       | `invalid_body`               | Send a JSON object with finite numbers and stay within depth and object key limits.                               |
| `429`       | `rate_limited`               | The sender's per-key bucket is empty. Honor Retry-After, rounded up to whole seconds.                             |
| `429`       | `trigger_busy`               | Too many running runs for this trigger. Retry-After is 30 seconds.                                                |
| `503`       | `infrastructure_unavailable` | Storage is unavailable. Retry with backoff.                                                                       |
| `503`       | `authentication_unavailable` | The credential store is unavailable. Retry with backoff.                                                          |
| `500`       | `internal_error`             | Use requestId to investigate the unexpected server failure; do not automatically retry.                           |

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
bodies do not consume rate tokens. Bearer authentication runs before body intake. On the signer
route Hub checks key eligibility before intake and verifies the signature over the bounded bytes.
The per-key limiter applies after authentication. Use a separately approved edge rate limit if needed.

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

Never send secrets in events. Hub stores the full receipt payload and the run's prompt and typed
inputs. Anyone able to read those runs can see their retained content. The optional
[run payload retention](run-payload-retention.md) sweep can clear eligible payloads. It defaults
to `off`. Keep API keys out of request bodies, query strings and
application logs. Keep Authorization and signature headers out of logs as well. A captured
Bearer request without an idempotency key can be replayed. A captured GitHub request can be
accepted while its signing secret is valid if Hub has never accepted that exact body.

If receipt expiry has run, set its mode to `off` first and keep every Hub binary at this release
or newer. The pre-webhook rollback below applies only to a database without expired receipts.

Before rolling back to the pre-webhook Hub binary, take a restorable database backup. Revocation
alone is insufficient: the old API key list parses scopes on revoked rows too, and cannot parse
events:send. Perform this procedure before switching binaries:

1. While the current binary is still running, explicitly revoke every key containing events:send
   in every organization, including keys with a mixture of old and new scopes. Stop senders.
2. Stop all Hub processes and other database writers. Keep them stopped through cleanup and the
   binary switch. Keep the additive schema and migration history; do not drop columns or undo
   migrations.
3. Run the complete [rollback cleanup SQL](webhook-rollback.sql) against the backed-up database,
   using a SQL client that stops on errors. It uses one transaction and locks both key and token
   tables. If any events:send key is still active, it refuses the entire cleanup without changing
   any rows. Roll back a failed transaction, revoke the remaining keys with the current binary,
   stop it again, then retry.
4. Only after the transaction commits successfully, switch to the old binary and restart Hub.

The SQL strips events:send from revoked mixed-scope keys, preserving their remaining scopes and
revocation. It deletes revoked events:send-only key rows because neither an empty scope list nor
invented replacement permissions are valid. These deleted key records are recoverable only from
the backup. Old-scope-only keys, active or revoked, remain unchanged.

Before stripping scopes or deleting keys, the SQL expires every unconsumed enrollment token issued
by the affected keys. It then unlinks unconsumed tokens only for keys being deleted, retaining
the expired token rows. Consumed tokens are unchanged. The current schema has no foreign key on
token issued_by_api_key_id or daemon registered_by_api_key_id: consumed tokens and daemon history
keep their original issuer UUID even when that key row is deleted. Existing daemons are not revoked
or deleted. Retain the backup to resolve those historical issuer IDs. After upgrading again, create
new appropriate keys and reconfigure senders; this cleanup does not restore revoked credentials.

See the [public API](public-api.md) for the API reference, and
[GitHub notification triggers](github-notifications.md) for polling notifications instead of
receiving events from your own sender.
