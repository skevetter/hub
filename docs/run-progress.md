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
| `PASEO_HUB_PROGRESS_MAX_EDITS`        | `120`   | Whole edits from 10 to 1,000 per run. Final and repair edits are outside this cap.    |
| `PASEO_HUB_TIMELINE_RETENTION_DAYS`   | `30`    | Whole days from 1 to 365 after run completion.                                        |

Hub rejects invalid settings at startup. Retention removes local progress rows even when the
reporter is off. Messages already posted remain at the source.

Hub shares credential cooldowns across processes through the database. Each process still
limits its own provider calls to four in flight.
