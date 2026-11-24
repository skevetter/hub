import { useServerFn } from "@tanstack/react-start";
import { parseDocument } from "yaml";
import { FailureAlert } from "../components/app/failure-alert.js";
import { LoadingLine } from "../components/app/loading.js";
import { Section } from "../components/app/section.js";
import { useSnapshotQuery } from "../queries/index.js";
import { webhookSettings } from "../webhooks/functions.js";
import { TriggerDocumentSchema } from "./configuration/schema.js";
import { WebhookInvocation } from "./webhook-card.js";

export function canInvokeManually(yaml: string): boolean {
  try {
    const parsed = TriggerDocumentSchema.safeParse(parseDocument(yaml).toJS());
    return parsed.success && parsed.data.on["manual.run"] !== undefined;
  } catch {
    return false;
  }
}

export function TriggerInvocation({
  organizationSlug,
  triggerName,
  manual,
  enabled,
}: {
  organizationSlug: string;
  triggerName: string;
  manual: boolean;
  enabled: boolean;
}) {
  return (
    <Section title="How to invoke">
      {manual ? (
        <ManualInvocation
          organizationSlug={organizationSlug}
          triggerName={triggerName}
          enabled={enabled}
        />
      ) : (
        <p>This trigger runs when its configured event arrives.</p>
      )}
    </Section>
  );
}

function ManualInvocation({
  organizationSlug,
  triggerName,
  enabled,
}: {
  organizationSlug: string;
  triggerName: string;
  enabled: boolean;
}) {
  const load = useServerFn(webhookSettings);
  const settings = useSnapshotQuery({
    queryKey: ["webhooks", "settings", organizationSlug],
    queryFn: () => load(),
  });
  if (settings.status === "pending") return <LoadingLine>Loading webhook address</LoadingLine>;
  if (settings.status === "error") {
    return (
      <FailureAlert
        title="Webhook address unavailable"
        error={settings.error}
        fallback="Hub couldn't load the webhook address."
        onRetry={settings.refetch}
      />
    );
  }
  return (
    <>
      <p>Use Run now or send an authenticated webhook request.</p>
      <WebhookInvocation
        baseUrl={settings.data.baseUrl}
        triggerName={triggerName}
        enabled={enabled}
        saved
      />
    </>
  );
}
