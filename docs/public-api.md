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

`runs:read` is reserved for authenticated run timeline reads. It does not grant dispatch access.
Timeline capture is off by default and can be enabled with `PASEO_HUB_RUN_TIMELINE=true`.
Streaming is not provided by this build.
CLI credentials also include this scope. Before rolling back to a build without it, revoke keys
that hold `runs:read`, because older builds reject that scope when authenticating a key.

CLI login starts anonymously at `POST /api/v1/cli-authorizations` and polls at `POST /api/v1/cli-authorizations/poll`. An authenticated owner or admin explicitly approves the active organization at `/cli-login`. The expiring grant is poll-throttled and discloses its durable credential exactly once. Daemons enroll only through the short-lived, single-use token issued by the authenticated enrollment-token operation. A daemon may connect with no permissions and remain available for identity and presence only; only daemons that explicitly grant `hub.execute` are eligible workflow targets.

The canonical, executable operation and schema reference is served by each Hub instance at `/api/reference`; its OpenAPI 3.1 document is `/api/openapi.json`. There are no unversioned operator aliases.

Every canonical `/api/v1` response, including unknown paths and wrong methods, uses RFC 9457 `application/problem+json` on failure and includes `X-Request-ID`; callers may supply that header to correlate a request. Wrong methods return `405` with `Allow`, while unknown paths return `404`. Every `401` response also includes `WWW-Authenticate: Bearer`.

Configuration YAML may include an optional top-level `name` slug as deployment metadata. An explicit request `projectSlug` (including the CLI's `--project`/`-p` option) is authoritative. Otherwise Hub resolves or creates the named project in the authenticated organization; without either field, it resolves or restores that organization's `default` project. Changing `name` targets a different project and leaves the old project's history intact.

Configuration validation and installation accept the same YAML, optional `projectSlug`, and prompt-partial bundle. Both use the same parser, compiler, project selection, daemon/provider resolution, and business validation. Validation returns the resolved `projectSlug` and `wouldCreateProject` without creating a project, recording a revision, or changing active configuration. Installation silently creates a missing bundle-named or default project, then records and activates the revision.

## Run timeline capture

With `PASEO_HUB_RUN_TIMELINE=true`, Hub stores projected run, step and agent lifecycle events, tool names and categories, permission waits, and terminal summaries. Assistant text, reasoning, tool arguments and results, permission details, and script output are never copied into the timeline. Script steps contribute their duration and exit code only.

The timeline queue holds at most 200 ordinary events per run. Overflow is counted durably and produces one truncation notice. Ordinary events have a separate count and byte budget, so they cannot displace the first 100 terminal step rows or the final run row and seal. A run with more terminal steps records the omission count and outcome counts for every step. Terminal summaries count pending or running steps left when a run ends as not run without changing workflow rows.

Runtime resource counts include timeline queue depth only when capture is enabled. With capture off, the resource-count shape is unchanged.

| Setting                             | Default | Range          |
| ----------------------------------- | ------- | -------------- |
| `PASEO_HUB_TIMELINE_MAX_EVENTS`     | `500`   | `50` to `5000` |
| `PASEO_HUB_TIMELINE_RETENTION_DAYS` | `30`    | `1` to `365`   |

Projected free-text fields are normalized and checked before logger redaction or partial rewriting. Any sensitive label anywhere in a field replaces the whole field with `[redacted]`, not just the following value. Detection is case-insensitive and ignores separators: password/passwd/pwd/passphrase, secret, token, API key/apikey, auth/authorization, bearer, credential, private key, session, cookie and signature, including compound names and close variants. Benign phrases such as "token count" or "reset your password" intentionally redact the whole field. JSON/JavaScript escapes, percent encoding and inexpensive HTML-style entities are canonicalized for detection in at most three passes; unresolved or ambiguous encodings fail closed. This is bounded text processing, not recursive JSON or arbitrary document parsing.

Related credential hints such as Basic, pass, key and sig also replace the whole field. Code-bearing query text is treated conservatively as credential text. These checks never retain the remainder of a suspected credential value.

Any `scheme://` authority with an at sign before its path, query or fragment boundary is treated as userinfo and redacts the whole field, including custom schemes, encoded authorities and passwords containing additional at signs. PEM and other armored blocks, multiline sensitive labels, escaped spaces and continuation lines also redact the whole field. Authored step ids remain raw (subject to the existing id byte bound); call ids and provider/mode identities retain their existing sensitive-or-invalid identity handling, with stable call-id hashes preserving deduplication.

Conservative token prefixes, entropy checks, exact startup-known secret values and their normalized eight-character fragments remain additional protections before storage and after byte truncation. Markers and their byte cuts cannot introduce startup-known fragments and obey the output byte budget; an unsafe marker is omitted. Benign text sharing a known fragment can also redact, including parts of a database URL. Arbitrary unlabeled base64 or hex encodings of a secret are not parsed and are explicit non-guarantees, as are unknown unlabeled passwords, dictionary secrets and personal data. This scrubber is not a guarantee for every unknown secret format or an outbound-content boundary.

Reconciliation derives missing start, terminal step and run rows from persisted workflow state. It never copies an agent's closing answer or reconstructs missed tool activity. A derived timeline records its origin. Runs sharing one conversation can record each other's tool calls. Events missed during a Hub or daemon disconnect are not replayed.

Finished timelines expire after the configured retention period. Cleanup continues with capture disabled. Existing state rows remain as expiry tombstones and are never reconstructed, even if retention is later extended. A historical run that never had a state row can receive only derived lifecycle rows if an extended window makes it eligible again.

Capture remains an internal storage feature in this build. There is no timeline stream or source progress message yet.

The instance operator console reads organization identity, entitlements, usage and entitlement history. It does not read run or timeline records. Capture does not add operator access.

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
