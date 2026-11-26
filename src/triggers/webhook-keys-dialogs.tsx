import { useCallback, useState, type SyntheticEvent } from "react";
import { apiKeyActorSchema } from "../auth/api-key-contract.js";
import { CopyBlock, CopyField } from "../components/app/copy-field.js";
import { FailureAlert, WarningAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { FormField } from "../components/app/form-field.js";
import { LoadingLine } from "../components/app/loading.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import type { Snapshot } from "../queries/index.js";
import { webhookCurl, webhookUrl } from "../webhooks/contract.js";
import {
  DEFAULT_OVERLAP_MINUTES,
  MAX_OVERLAP_MINUTES,
  actorFixMessage,
  overlapError,
  overlapSecondsFromMinutes,
} from "./webhook-keys-model.js";

const ACTOR_PATTERN = "[a-z0-9][a-z0-9_.\\-]{0,62}";

export interface WebhookKeyReveal {
  secret: string;
  actor: string | null;
  actorAllowedByTrigger: boolean;
  rotated: boolean;
}

export type WebhookAddress = Snapshot<{ baseUrl: string }>;

export function CreateWebhookKeyDialog({
  busy,
  error,
  onOpenChange,
  onCreate,
}: {
  busy: boolean;
  error: string | undefined;
  onOpenChange: (open: boolean) => void;
  onCreate: (actor: string | undefined) => void;
}) {
  const [actor, setActor] = useState("");
  const trimmed = actor.trim();
  const invalid = trimmed !== "" && !apiKeyActorSchema.safeParse(trimmed).success;
  const submit = useCallback(
    (event: SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!invalid) onCreate(trimmed === "" ? undefined : trimmed);
    },
    [invalid, onCreate, trimmed],
  );
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="Create webhook key"
      description="This key can send events to this trigger only."
      label="Create webhook key"
      submitLabel="Create webhook key"
      busy={busy}
      onSubmit={submit}
    >
      <FormField
        kind="text"
        id="webhook-key-actor"
        name="actor"
        label="Actor"
        description="Optional. Defaults to your account name. Use up to 63 lowercase letters, numbers, dots, underscores or hyphens, starting with a letter or number. The trigger's from_users must allow it."
        value={actor}
        onChange={setActor}
        pattern={ACTOR_PATTERN}
        maxLength={63}
        {...(invalid
          ? { error: "Use lowercase letters, numbers, dots, underscores or hyphens." }
          : {})}
      />
      {error === undefined ? null : (
        <FailureAlert title="Webhook key not created" error={error} fallback={error} />
      )}
    </FormDialog>
  );
}

export function RotateWebhookKeyDialog({
  name,
  busy,
  error,
  onOpenChange,
  onRotate,
}: {
  name: string;
  busy: boolean;
  error: string | undefined;
  onOpenChange: (open: boolean) => void;
  onRotate: (overlapSeconds: number) => void;
}) {
  const [minutes, setMinutes] = useState(String(DEFAULT_OVERLAP_MINUTES));
  const problem = overlapError(minutes);
  const submit = useCallback(
    (event: SyntheticEvent<HTMLFormElement>) => {
      event.preventDefault();
      const seconds = overlapSecondsFromMinutes(minutes);
      if (seconds !== null) onRotate(seconds);
    },
    [minutes, onRotate],
  );
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="Rotate webhook key"
      description={`Issue a replacement for ${name}. The new key keeps the same name.`}
      label="Rotate webhook key"
      submitLabel="Rotate key"
      busy={busy}
      onSubmit={submit}
    >
      <FormField
        kind="number"
        id="webhook-key-overlap"
        name="overlapMinutes"
        label="Overlap in minutes"
        description={`Both keys work during the overlap. Choose 0 to ${String(MAX_OVERLAP_MINUTES)}. Switch the sender to the new key before it ends.`}
        min={0}
        step={1}
        required
        value={minutes}
        onChange={setMinutes}
        {...(problem === undefined ? {} : { error: problem })}
      />
      {minutes.trim() === "0" ? (
        <WarningAlert title="Immediate cutover">
          The current key stops working as soon as you rotate.
        </WarningAlert>
      ) : null}
      {error === undefined ? null : (
        <FailureAlert title="Webhook key not rotated" error={error} fallback={error} />
      )}
    </FormDialog>
  );
}

const keepOpen = (event: { preventDefault: () => void }) => event.preventDefault();

export function WebhookKeySecretDialog({
  reveal,
  triggerName,
  address,
  onClose,
}: {
  reveal: WebhookKeyReveal;
  triggerName: string;
  address: WebhookAddress;
  onClose: () => void;
}) {
  const change = useCallback((open: boolean) => (open ? undefined : onClose()), [onClose]);
  return (
    <Dialog open onOpenChange={change}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={keepOpen}
        onPointerDownOutside={keepOpen}
      >
        <DialogHeader>
          <DialogTitle>
            {reveal.rotated ? "Copy your new webhook key" : "Copy your webhook key"}
          </DialogTitle>
          <DialogDescription>
            This key is shown once. You will not see it again. Store it in the sender's secret store
            now.
          </DialogDescription>
        </DialogHeader>
        <WebhookKeySecretContent reveal={reveal} triggerName={triggerName} address={address} />
        <FormActions>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </FormActions>
      </DialogContent>
    </Dialog>
  );
}

export function WebhookKeySecretContent({
  reveal,
  triggerName,
  address,
}: {
  reveal: WebhookKeyReveal;
  triggerName: string;
  address: WebhookAddress;
}) {
  return (
    <>
      <WarningAlert title="Save this key now">
        This secret cannot be recovered after you close this dialog.
      </WarningAlert>
      <CopyField
        label="Webhook key"
        value={reveal.secret}
        copyLabel="Copy webhook key"
        focusOnMount
      />
      {reveal.actorAllowedByTrigger ? null : (
        <WarningAlert title="This key's actor is not allowed">
          {actorFixMessage(reveal.actor)}
        </WarningAlert>
      )}
      <WebhookKeyRequest address={address} triggerName={triggerName} />
    </>
  );
}

function WebhookKeyRequest({
  address,
  triggerName,
}: {
  address: WebhookAddress;
  triggerName: string;
}) {
  if (address.status === "pending") return <LoadingLine>Loading webhook address</LoadingLine>;
  if (address.status === "error") {
    return (
      <FailureAlert
        title="Webhook address unavailable"
        error={address.error}
        fallback="Hub couldn't load the webhook address. Find it on the trigger page after you close this dialog."
      />
    );
  }
  return (
    <>
      <CopyField
        label="Webhook URL"
        value={webhookUrl(address.data.baseUrl, triggerName)}
        copyLabel="Copy webhook URL"
      />
      <CopyBlock
        label="Webhook request"
        value={webhookCurl(address.data.baseUrl, triggerName)}
        action="Copy request"
      />
      <p className="text-sm text-muted-foreground">
        Set HUB_KEY to the key above. The key goes in the Authorization header, never in the URL.
      </p>
    </>
  );
}
