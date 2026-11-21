# Linear agents

## Installation and reauthorization

Hub installs its OAuth application with `actor=app`. It requests `read`, `comments:create`, `app:assignable`, `app:mentionable` and `write` on new authorizations and reconnects. The agent scopes allow the installed app user to appear in delegation and mention pickers. Hub uses `write` to update the run progress comment.

Every authorization URL includes `prompt=consent`. Linear documents this parameter as showing the consent screen even when scopes were already granted, so an administrator can choose another workspace. See [OAuth authentication](https://linear.app/developers/oauth-2-0-authentication) and [agent scopes](https://linear.app/developers/agents).

Connections with the four required scopes can keep running workflows. To enable progress comments on an existing connection, reconnect the workspace and grant `write`.

A connection missing any of the other four scopes needs reauthorization, even if its token can still refresh. The Connections page shows "Linear reauthorization required". The Apps inventory shows that action is needed. Until the required scopes are granted, webhook events are acknowledged and durably dropped with `configuration_unavailable`. Reconnecting does not replay those dropped deliveries.

Connecting or reconnecting a workspace adds missing routes for eligible enabled triggers. Linear events dropped because no route matched stay dropped after reconnecting. Hub records those drops as `no_project_route`.

## Delegation and assigned triggers

Linear delegates work to an app by setting the issue's `delegate`, not its human `assignee`. Hub's existing `linear.issue_assigned` trigger accepts an Issue update when `updatedFrom` contains a delegate change and the new delegate is the app user stored on that workspace's Hub connection. Removing the delegate, selecting another app or receiving an unrelated edit does not trigger this path. A stale update that names the same previous and current delegate does not trigger it either.

Ordinary assignee updates keep their existing behavior. Delegation uses the same connection, project, state, label, excluded label and actor filters. `filters.from_users` remains required. `filters.assignees` still filters the human assignee and does not select the delegate. Leave it unset if delegation should work without a human assignee.

Delegation uses the existing issue source, receipt and run identity. A repeated `Linear-Delivery` ID reuses its original receipt, payload and route, even if the retry body differs. Receipt replay can dispatch that saved event again to recover an interrupted handoff. Durable run creation deduplicates it by receipt, project and configured trigger, so the replay does not create another run. The same rules apply to ordinary assignment.

## Agent session limits

Hub records verified `AgentSessionEvent` deliveries from connected Linear workspaces as unsupported in Activity > Dropped and acknowledges them with HTTP 200. This applies to mentions and delegation sessions. These deliveries start no runs and post no activities. Mentions can start runs through a configured Linear comment trigger when the event passes its filters.

Agent sessions and activities are not implemented. If agent session webhooks are enabled, Linear can show the agent as not responding because Hub does not send the initial activity. Do not treat mentionability or delegation support as agent session support. This change adds no calls that post to Linear.

Hub admits at most 600 new unsupported receipts per Hub organization in each UTC clock hour.
Set `PASEO_HUB_LINEAR_UNSUPPORTED_RECEIPTS_PER_HOUR` to a whole number from 1 to 600 to lower
the budget. Retrying an already retained delivery uses no additional budget. Hub acknowledges
excess deliveries with HTTP 200, skips receipt storage, and emits a debug log with no delivery
metadata. The budget is shared across Hub processes and survives restarts.
