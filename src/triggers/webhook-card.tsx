import { WebhookIcon } from "lucide-react";
import { Card } from "../components/app/card.js";
import { CopyBlock, CopyField } from "../components/app/copy-field.js";
import { WarningAlert } from "../components/app/failure-alert.js";
import { webhookCurl, webhookUrl } from "../webhooks/contract.js";

const WEBHOOK_ICON = <WebhookIcon aria-hidden="true" />;

interface WebhookInvocationProps {
  baseUrl: string;
  triggerName: string;
  enabled: boolean;
  saved?: boolean;
}

export function WebhookCard(props: WebhookInvocationProps) {
  return (
    <Card
      icon={WEBHOOK_ICON}
      title="Webhook"
      description="Send an authenticated event to this manual trigger."
    >
      <WebhookInvocation {...props} />
    </Card>
  );
}

export function WebhookInvocation({
  baseUrl,
  triggerName,
  enabled,
  saved = false,
}: WebhookInvocationProps) {
  return (
    <>
      {enabled ? null : (
        <WarningAlert title="Trigger is disabled">
          Calls return 404 until this trigger is enabled and saved.
        </WarningAlert>
      )}
      <CopyField label="Webhook URL" value={webhookUrl(baseUrl, triggerName)} />
      <CopyBlock
        label="Webhook request"
        value={webhookCurl(baseUrl, triggerName)}
        action="Copy request"
      />
      <p className="text-sm text-muted-foreground">
        {saved ? null : "Save changes before sending. "}Set HUB_KEY to an API key with the
        events:send scope and a bound actor allowed by this trigger. Add any required declared
        inputs as top-level JSON fields before sending, using their declared types and choices. Do
        not include secrets in event data.
      </p>
    </>
  );
}
