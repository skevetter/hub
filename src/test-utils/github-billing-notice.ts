import { encodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import type { GitHubTriggerContext } from "../triggers/github/provider.js";

export const GITHUB_BILLING_DENIAL = encodeEntitlementDenialFailureReason({
  error: "entitlement_denied",
  entitlement: "executions.monthly",
  kind: "meter",
  limit: 50,
  current: 50,
});

export function githubBillingTriggerContext(deliveryId = "test-delivery"): GitHubTriggerContext {
  return {
    provider: "github",
    organizationId: "org-1",
    target: { installationId: 42, repository: "example/project" },
    reactionSubject: null,
    event: {
      github: {
        delivery_id: deliveryId,
        received_at: "2026-08-06T11:00:00.000Z",
        event_name: "issue_comment",
        repository: { full_name: "example/project" },
        pull_request: null,
        item: { type: "issue", number: 92, title: null, body: null, url: null, author: null },
      },
    },
  };
}
