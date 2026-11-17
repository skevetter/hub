# Public API

Hub exposes organization-scoped operator operations under `/api/v1`:

| Operation                                   | Scope                    | Endpoint                                 |
| ------------------------------------------- | ------------------------ | ---------------------------------------- |
| List active projects                        | `projects:read`          | `GET /api/v1/projects`                   |
| List organization triggers                  | `configuration:validate` | `GET /api/v1/triggers`                   |
| Validate one trigger without writing        | `configuration:validate` | `POST /api/v1/triggers/validate`         |
| Install or replace one trigger              | `configuration:install`  | `POST /api/v1/triggers/install`          |
| Validate configuration without writing      | `configuration:validate` | `POST /api/v1/configurations/validate`   |
| List resolvable configuration resources     | `configuration:validate` | `GET /api/v1/configuration-resources`    |
| Install and activate configuration          | `configuration:install`  | `POST /api/v1/configurations/install`    |
| Dispatch a durable manual run               | `runs:dispatch`          | `POST /api/v1/manual-runs`               |
| Send an authenticated webhook event         | `events:send`            | `POST /api/v1/hooks/{trigger}`           |
| Issue a short-lived daemon enrollment token | `daemons:enroll`         | `POST /api/v1/daemons/enrollment-tokens` |

Create a scoped API key in the Hub dashboard or approve `paseo hub login` in the browser, then send the resulting organization credential as `Authorization: Bearer <credential>`. CLI credentials carry all current operator scopes, are stored server-side only as verifiers, and can be revoked under Settings, API keys, CLI logins. They are not daemon credentials and cannot call the hooks endpoint.

The available API key scopes are `projects:read`, `configuration:validate`, `configuration:install`,
`runs:dispatch`, `runs:read`, `events:send`, and `daemons:enroll`. Grant only the scopes a sender needs.
`events:send` authorizes hooks only, not manual-runs. Hooks require an API key with a bound actor;
optional allowed trigger names further restrict it. See [authenticated webhook triggers](webhooks.md)
for key creation, executable examples, response and error tables, retries, limits and retention.

`runs:read` permits authenticated run timeline reads. It does not grant dispatch access.
Timeline capture and streaming are off by default. Set `PASEO_HUB_RUN_TIMELINE=true` and
`PASEO_HUB_RUN_STREAM=true` to enable streams.
CLI credentials also include this scope. Before rolling back to a build without it, revoke keys
that hold `runs:read`, because older builds reject that scope when authenticating a key.

CLI login starts anonymously at `POST /api/v1/cli-authorizations` and polls at `POST /api/v1/cli-authorizations/poll`. An authenticated owner or admin explicitly approves the active organization at `/cli-login`. The expiring grant is poll-throttled and discloses its durable credential exactly once. Daemons enroll only through the short-lived, single-use token issued by the authenticated enrollment-token operation. A daemon may connect with no permissions and remain available for identity and presence only; only daemons that explicitly grant `hub.execute` are eligible workflow targets.

The canonical, executable operation and schema reference is served by each Hub instance at `/api/reference`; its OpenAPI 3.1 document is `/api/openapi.json`. There are no unversioned operator aliases.

Every canonical `/api/v1` response, including unknown paths and wrong methods, uses RFC 9457 `application/problem+json` on failure and includes `X-Request-ID`; callers may supply that header to correlate a request. Wrong methods return `405` with `Allow`, while unknown paths return `404`. Every `401` response also includes `WWW-Authenticate: Bearer`.

Configuration YAML may include an optional top-level `name` slug as deployment metadata. An explicit request `projectSlug` (including the CLI's `--project`/`-p` option) is authoritative. Otherwise Hub resolves or creates the named project in the authenticated organization; without either field, it resolves or restores that organization's `default` project. Changing `name` targets a different project and leaves the old project's history intact.

Configuration validation and installation accept the same YAML, optional `projectSlug`, and prompt-partial bundle. Both use the same parser, compiler, project selection, daemon/provider resolution, and business validation. Validation returns the resolved `projectSlug` and `wouldCreateProject` without creating a project, recording a revision, or changing active configuration. Installation silently creates a missing bundle-named or default project, then records and activates the revision.

## Run timeline capture

With `PASEO_HUB_RUN_TIMELINE=true`, Hub stores projected run, step and agent lifecycle events, tool names and categories, permission waits, and terminal summaries. Assistant text, reasoning, tool arguments and results, permission details, and script output are never copied into the timeline. Script steps contribute their duration and exit code only.

The timeline queue holds at most 200 ordinary events per run. Refused events are retained for durable accounting and one truncation notice. Ordinary events have a separate count and byte budget, so they cannot displace the first 100 terminal step rows or the final run row and seal. A run with more terminal steps records the omission count and outcome counts for every step. Terminal summaries count pending or running steps left when a run ends as not run without changing workflow rows.

Failed accounting recovers independently of later run activity and timeline sealing. Each capture runtime uses one unref recovery timer with monotonic 30 second deadlines, at most five scheduled attempts per retained batch, and at most 100 entries started per event-loop turn. Durable handoff or an expired reference reclaims the entry. Accounting recovered after sealing updates counters without appending events beyond the seal. Exhausted batches are reclaimed with visible abandonment counters. Bounded shutdown makes a final accounting attempt when time remains and reports known counts it must abandon rather than leaving recovery timers alive.

A recovered accounting acknowledgement wakes subscribers with the persisted truncation notice cursor, even when the acknowledgement deduplicates an earlier commit. A duplicate without a notice does not emit a wake.

Each retained accounting batch keeps one UUID and count across retries. New drops wait in a separate batch until the retained batch is acknowledged or abandoned. The state row remembers the last 16 accepted batch ids in the same transaction as the counter increment. This private ledger does not consume timeline byte budgets and is cleared on expiry. An id replayed after 16 newer distinct batches have evicted it would count again. The per-run capture writer cannot produce that ordering while a retry remains pending; arbitrary out-of-order direct store callers are outside that guarantee. Two queue instances writing the same run do not share that ordering guarantee.

When capture is enabled, runtime resource counts include `timelineQueueDepth` for admitted work, `timelineQueueEntries` for run queue records, `timelineAccountingEntries` for pending or in-flight accounting, `timelineAccountingGiveUps` for abandoned batches, and `timelineAccountingDropsAbandoned` for abandoned refused events. The counters are cumulative within that capture runtime. With capture off, the resource-count shape is unchanged.

| Setting                             | Default | Range          |
| ----------------------------------- | ------- | -------------- |
| `PASEO_HUB_TIMELINE_MAX_EVENTS`     | `500`   | `50` to `5000` |
| `PASEO_HUB_TIMELINE_RETENTION_DAYS` | `30`    | `1` to `365`   |

Projected free-text fields are normalized and checked before logger redaction or partial rewriting. Any sensitive label anywhere in a field replaces the whole field with `[redacted]`, not just the following value. Detection is case-insensitive and ignores separators: password/passwd/pwd/passphrase, secret, token, API key/apikey, auth/authorization, bearer, credential, private key, session, cookie and signature, including compound names and close variants. Benign phrases such as "token count" or "reset your password" intentionally redact the whole field. JSON/JavaScript escapes, percent encoding and inexpensive HTML-style entities are canonicalized for detection in at most three passes; unresolved or ambiguous encodings fail closed. This is bounded text processing, not recursive JSON or arbitrary document parsing. Armored-header searches do not restart inside the same dash run.

Related credential hints such as Basic, pass, key and sig also replace the whole field. Code-bearing query text is treated conservatively as credential text. These checks never retain the remainder of a suspected credential value.

A scheme token followed by a colon and userinfo before a path, query or fragment boundary redacts the whole field. Detection accepts zero or more forward slashes, backslashes or whitespace after the colon, including encoded separators and special-scheme URL forms. It removes ASCII tab, LF and CR in its bounded URL view, as URL parsers do. Protocol-relative authorities remain covered. Spaces do not prove that the authority ended, and ambiguous URL text is redacted conservatively before logger rewriting. PEM and other armored blocks, multiline sensitive labels, escaped spaces and continuation lines also redact the whole field. Authored step ids remain raw (subject to the existing id byte bound); call ids and provider/mode identities retain their existing sensitive-or-invalid identity handling, with stable call-id hashes preserving deduplication.

Conservative token prefixes, entropy checks, exact startup-known secret values and their normalized eight-character fragments remain additional protections before storage and after byte truncation. Markers and their byte cuts cannot introduce startup-known fragments and obey the output byte budget; an unsafe marker is omitted. Benign text sharing a known fragment can also redact, including parts of a database URL. Arbitrary unlabeled base64 or hex encodings of a secret are not parsed and are explicit non-guarantees, as are unknown unlabeled passwords, dictionary secrets and personal data. This scrubber is not a guarantee for every unknown secret format or an outbound-content boundary.

Reconciliation derives missing start, terminal step and run rows from persisted workflow state. It never copies an agent's closing answer or reconstructs missed tool activity. A derived timeline records its origin. Runs sharing one conversation can record each other's tool calls. Events missed during a Hub or daemon disconnect are not replayed.

Finished timelines expire after the configured retention period. Cleanup continues with capture disabled. Existing state rows remain as expiry tombstones and are never reconstructed, even if retention is later extended. A historical run that never had a state row can receive only derived lifecycle rows if an extended window makes it eligible again.

Source progress messages are not provided by this build.

The instance operator console reads organization identity, entitlements, usage and entitlement history. It does not read run or timeline records. Capture does not add operator access.

## Run detail in Activity

Any organization member can open a run from Activity. The page combines the stored run summary, timeline and step results. Tool starts and finishes share a row within each step. Permission waits stay open until resolved. New events follow the bottom only while the reader is there. Jump to latest resumes following.

Live connections use same-origin cookies. After three consecutive connection failures or a disabled stream response, timeline events are polled every five seconds until the stored seal is read or the timeline expires. Separately, persisted run and step details refresh every five seconds while the persisted run is running, even when capture is off. A terminal live status requests the final persisted results. This single detail refresh loop also covers omitted step rows and runs with more than 100 steps without duplicate timers. Reading the seal still refreshes persisted results.

The server marks a timeline unavailable only when capture is off and both the state row and returned event page are absent. Once final persisted results are loaded for such a terminal run, event polling also stops. Retained captured or derived timelines still require their seal or expiry, even if capture has since been turned off.

Stored timeline history is monotonic in the page. Rows, captured or derived provenance and a seal cannot be erased by a later unavailable response. Availability without history is configuration, not stored history. Detail and event reads share a client request sequence assigned before each read starts. Only the most recently issued configuration response can change availability, even when responses arrive out of order. A newer final absence can therefore idle a run that never recorded history. Retained history always keeps the seal or expiry rule. Successful in-flight reads are still accepted after the page becomes idle. Cursors, seals, omission and drop counts never decrease, expiry sticks, and terminal status does not return to running.

Derived timelines show only persisted lifecycle events and say that no tool events were recorded. Expired timelines show no event rows. Pending steps left after a run ends read as Not run. Timeline text is plain text without Markdown or automatic links. The Progress message row describes the disabled Hub setting in this build. It does not imply a provider message was posted.

Running durations use human units and update only while the tab is visible. Updates range from one second for short runs to thirty seconds for runs lasting hours. Terminal durations are static. Long trigger names remain contained in the header. An unavailable run includes a Back to activity link.

## Run event streams

`GET /api/v1/runs/{id}/events` reads only stored timeline rows. Create a separate API key for each consumer and grant only `runs:read`. `runs:dispatch` does not imply read access. CLI credentials also work, while their owner remains an owner or admin. A browser member of any role can use a same-origin session with `?organization=<slug>`.

HEAD and other Fetch-compatible methods return 405 `method_not_allowed` with `Allow: GET`, without authentication, a subscriber or an admission slot. When streaming is disabled, these methods return 404 `not_found`.

The outer HTTP adapter rejects Fetch-forbidden methods such as TRACE with 405 `method_not_allowed` before constructing a Request or reaching authentication and routes. Its generic Allow header lists `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`, regardless of the route or stream switch. Node's parser and unhandled CONNECT behavior are unchanged. An unhandled CONNECT closes the socket without an HTTP response.

```sh
curl -N -H "Authorization: Bearer $HUB_KEY" "$HUB_URL/api/v1/runs/$RUN_ID/events"
```

Save this Node example as an ES module. It reconnects using the last timeline id:

```js
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

let after = "";
let finished = false;
while (!finished) {
  const response = await fetch(`${process.env.HUB_URL}/api/v1/runs/${process.env.RUN_ID}/events`, {
    headers: {
      Authorization: `Bearer ${process.env.HUB_KEY}`,
      ...(after === "" ? {} : { "Last-Event-ID": after }),
    },
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Stream request failed with status ${response.status}`);
  }
  const lines = createInterface({
    input: Readable.fromWeb(response.body),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.startsWith("id: ")) after = line.slice(4);
    if (line === "event: end") finished = true;
    process.stdout.write(`${line}\n`);
  }
  if (!finished) await delay(5000);
}
```

The stream starts with `retry: 5000`, `: stream open` and a `status` event. Status includes `runId`, `status`, `firstSeq`, `lastSeq`, `sealedSeq`, `stepRowsOmitted` and the stored `origin`. Origin is null if capture has not persisted its first row. A timeline row has `id: <seq>`, `event: <kind>` and one JSON `data` line containing `seq`, `kind`, `at`, `stepId` and `data`. No extra free text is added. Heartbeats are `: ping`.

Resume with `Last-Event-ID` or `?after=<seq>`. The query parameter wins. Cursors must be non-negative safe integers. An older cursor replays from the first retained row. A cursor beyond the latest row waits for newer rows. Each subscriber reads pages of at most 100 rows with a 16 KiB high water mark and a 256 KiB safety cap. Shared per-run notifiers hold no event backlog. A bounded 500-row read cache is discarded with the notifier. A 2 second state poll recovers lost bus notifications and writes from another process.

`end` means the run is terminal, reconciled, sealed and all rows through the seal have been read. It carries `status`, `lastSeq`, `sealedSeq` and `stepRowsOmitted`. A terminal status alone does not mean the timeline is complete. `reconnect` and `shutdown` carry `reconnectMs: 5000` and ask the client to reconnect with its last id. Control events have no id. A failed 60 second credential or session check sends `error` with `code: unauthorized` and closes. Reauthorization does not update credential last-use evidence.

| Setting                              | Default | Range           |
| ------------------------------------ | ------- | --------------- |
| `PASEO_HUB_STREAM_MAX_PER_KEY`       | `5`     | `1` to `100`    |
| `PASEO_HUB_STREAM_MAX_PER_ORG`       | `20`    | `1` to `500`    |
| `PASEO_HUB_STREAM_MAX_TOTAL`         | `200`   | `1` to `2000`   |
| `PASEO_HUB_STREAM_HEARTBEAT_SECONDS` | `15`    | `5` to `60`     |
| `PASEO_HUB_STREAM_MAX_SECONDS`       | `3600`  | `60` to `86400` |

Limits are per process, credential kind and id, organization, and user id for sessions. HTTP 429 `too_many_streams` has `Retry-After: 30`. Shutdown returns HTTP 503 `shutting_down` with `Retry-After: 5` before stream admission closes. Missing authentication returns 401 `unauthorized` with a Bearer challenge. Missing scope returns 403 `insufficient_scope`. Unknown, foreign, rejected and invalid run ids share 404 `run_not_found`. An authorized expired timeline returns 410 `timeline_expired` and is never reconstructed. An invalid cursor returns 400 `invalid_request`. Unavailable storage returns 503 `infrastructure_unavailable`. With streaming off the route returns 404 `not_found`.

Headers are `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. No CORS headers are added. Hub does not override Better Auth's cookie defaults: HttpOnly, SameSite=Lax and Secure for an HTTPS base URL. Cross-origin script cannot read the response. The route does not use forwarded client address headers.

The cookie path relies on SameSite=Lax session cookies, and the route sends no CORS headers. It performs no Origin or Sec-Fetch-Site check, so cross-origin request admission is not independently rejected.

Cloudflare and Caddy buffering behavior is not verified here. Heartbeats are below Cloudflare's 125 second read timeout. The public proxy must flush the initial event and each heartbeat. No proxy configuration is changed. A lifecycle-managed socket with no drain for 30 seconds is destroyed. Client disconnects cancel the reader and release stream and notifier counters. Shutdown closes stream admission and sends `shutdown` before HTTP draining and runtime teardown. The existing HTTP shutdown grace and hard-exit budgets remain backstops.

The runtime exposes `runStreams` and `streamNotifiers` when streaming is enabled. Both return to zero when streams close.

## Workflow MCP tools

Hub sends each daemon the authored rendered prompt unchanged. Execution tools are exposed through the provider-native Hub MCP server and its exact tool policy; Hub does not prepend a tool inventory or otherwise rewrite the prompt. Completion is exposed as `finish_execution`; allowed and materialized output tools use their registered names, such as `reply`. For structured-output steps, `finish_execution` accepts the configured result under `output`. Completing an execution does not necessarily complete the whole workflow.

## Trigger prompt and optional context

`${{ paseo.prompt }}` is exactly the complete text received by any textual trigger, including provider mentions, command markers, typed-input headers, and whitespace. Parsing those elements can select a trigger or populate `${{ paseo.inputs }}`, but never rewrites the prompt. Structured manual input without a textual prompt produces an empty string. `${{ paseo.context }}` is a separate opt-in merge value containing safe ambient provider data. Each workflow step opts in independently: a step that does not author `${{ paseo.context }}` receives no ambient context, no automatic attachment list, and no prompt mutation. Context history and attachment descriptors are fetched and materialized only when an opting step launches; attachment descriptors are Hub URLs scoped to that execution. Provider credentials, raw tokens, private provider download URLs, and unrelated webhook fields are not exposed. There is no alias or fallback for the removed automatic prompt behavior.

Daemon environments may author `worktree.newBranch: "trigger-${{ paseo.execution.id }}"` for a stable branch name unique to each agent execution. Hub materializes the execution UUID before persisting or dispatching the launch intent; recovery reuses that fully rendered intent. This is independent of whether a manual, Slack, Discord, GitHub, or Linear trigger selected the reusable environment. No prompt, context, input, value, step output, or provider event namespace is available in environment configuration, and unsupported expressions fail bundle activation at the authored `newBranch` field.

`deliveryKey` is caller-supplied request identity for the existing durable manual-event path. Hub namespaces it by the authenticated organization and resolved project before persistence, so the same caller key can be used independently in different tenants or projects. Existing receipt/run de-duplication applies, but this API does not promise exactly-once execution or guaranteed response replay; retries can still fail or conflict during restart and timing races. A successful representation contains `deliveryKey`, `providerEventReceiptId`, `triggerRunId`, `configuredTriggerName`, and the durable `workflowStatus`.

For manual-runs, `deliveryKey` remains required. A bound API key supplies the actor; omit `actor`
or send the same value. A different actor returns `403 actor_forbidden`. A legacy key without a
bound actor must supply `actor` and cannot start script actions (`403 key_actor_required`).
An object `input` maps its fields to declared typed inputs, and manual context is available through
`${{ paseo.context }}`. Unknown triggers and projects without an active configuration return `404`.
Input errors remain `400 invalid_input`, unlike hooks' `422 invalid_input`. Manual filter mismatches
retain `409 dispatch_conflict`; hooks instead accept them as filtered deliveries.

The self-hosted Scalar reference is served with a restrictive Content Security Policy and does not require external fonts, scripts, telemetry, registries, or proxies.

## Plan catalog

`GET /api/billing/plans` is unauthenticated and read-only. It returns the plan catalog mirrored
from Stripe (see docs/billing.md) as marketing copy, pricing, and the figures each plan includes.
It never includes the entitlement document itself (`granted` caps/flags/meters); that stays
internal to `src/billing/` and `src/entitlements/`. This is the shape the marketing site
(paseo.sh) fetches to render pricing; Hub itself has no pricing page.

It returns every plan the instance offers, the free one included, in catalog order. Today that is
two:

```json
{
  "plans": [
    {
      "slug": "free",
      "name": "Free",
      "billing": {
        "model": "per_unit",
        "unit": {
          "key": "seat",
          "label": "seat"
        }
      },
      "included": {
        "seats": 1,
        "executionsPerMonth": 50
      },
      "features": [
        {
          "key": "daemon-location",
          "label": "Daemons run on your machines",
          "tooltip": null
        }
      ],
      "prices": [
        {
          "interval": "monthly",
          "intervalCount": 1,
          "unitAmount": 0,
          "currency": "usd",
          "tooltip": null
        }
      ]
    },
    {
      "slug": "hosted",
      "name": "Pro",
      "billing": {
        "model": "per_unit",
        "unit": {
          "key": "seat",
          "label": "seat"
        }
      },
      "included": {
        "seats": null,
        "executionsPerMonth": null
      },
      "features": [
        {
          "key": "hub-operation",
          "label": "Paseo operates Hub",
          "tooltip": null
        }
      ],
      "prices": [
        {
          "interval": "monthly",
          "intervalCount": 1,
          "unitAmount": 1500,
          "currency": "usd",
          "tooltip": "Seats are Hub members and pending invitations. People who only trigger agents through GitHub, Slack, or Discord do not count as seats."
        }
      ]
    }
  ]
}
```

`included` is what the plan gives, as figures: `seats` is the seat cap and `executionsPerMonth`
the monthly agent-run allowance, each `null` for unlimited. They are derived from the same
validated template the instance enforces, so a plan's advertised numbers and its stamped limits
cannot disagree. Render these rather than writing the numbers into your own copy; `features` is
prose that no template can contradict.

`unitAmount` is the amount per billing unit in the smallest currency unit (cents for `usd`),
matching Stripe's own `Price` convention; a free plan prices at `0`. An interval is absent when the
plan has no active price at that interval. `slug` is catalog identity and does not change with the
displayed `name`. A self-hosted instance without `STRIPE_SECRET_KEY` 404s this route rather than
serving an empty catalog. The billing boundary means the route is never registered on an
unconfigured instance. See docs/billing.md.
