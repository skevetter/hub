# Run progress message settings

The reporter core is off by default. A Hub with a registered progress provider can enable it
with `PASEO_HUB_RUN_TIMELINE=true` and `PASEO_HUB_PROGRESS_MESSAGES=true`. A trigger also needs
`progress_message: true`. The reporter sends status, counts, timings and a link to the Hub run
when `PASEO_HUB_APP_URL` is configured. Anyone who can read the source conversation can see
the message. Access to the linked run requires a Hub login.

| Setting                               | Default | Accepted values                                                                       |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `PASEO_HUB_PROGRESS_MESSAGES`         | `false` | `true` or `false`                                                                     |
| `PASEO_HUB_PROGRESS_MIN_EDIT_SECONDS` | `20`    | Whole seconds from 5 to 600. After 15 minutes, regular edits are paced at 60 seconds. |
| `PASEO_HUB_PROGRESS_MAX_EDITS`        | `120`   | Whole regular edit attempts from 10 to 1,000 per run.                                 |
| `PASEO_HUB_TIMELINE_RETENTION_DAYS`   | `30`    | Whole days from 1 to 365 after run completion.                                        |

Failed and uncertain regular writes count toward pacing and the edit cap. Final and repair
edits are outside the cap. Hub rejects invalid settings at startup. Retention removes local progress rows even when the
reporter is off. Messages already posted remain at the source.

Hub shares credential cooldowns across processes through the database. Each process still
limits its own provider calls to four in flight.

A write that times out or has an uncertain outcome schedules a repair. Hub also watches for a
late success after an abort and requests another repair when one arrives. If the provider
commits after the abort and never reports success, only a scheduled repair can overwrite it.
A write that lands after the last scheduled repair can remain visible.

Hub schedules the settle edit 120 seconds after the final edit. When the settle is the only
repair, allow up to 145 seconds from a stale write to visible repair, including the repair's
operation budget. Rate limiting can add up to 900 seconds (1,045 seconds in total).
