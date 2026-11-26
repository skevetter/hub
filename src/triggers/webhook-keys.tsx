import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  createTriggerWebhookKey,
  listTriggerWebhookKeys,
  revokeTriggerWebhookKey,
  rotateTriggerWebhookKey,
} from "../auth/functions.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { LoadingLine } from "../components/app/loading.js";
import { Section } from "../components/app/section.js";
import { Button } from "../components/ui/button.js";
import { useSnapshotQuery } from "../queries/index.js";
import { webhookSettings } from "../webhooks/functions.js";
import {
  CreateWebhookKeyDialog,
  RotateWebhookKeyDialog,
  WebhookKeySecretDialog,
  type WebhookKeyReveal,
} from "./webhook-keys-dialogs.js";
import { WebhookKeyTable } from "./webhook-keys-table.js";
import type { WebhookKeyRecord } from "./webhook-keys-model.js";

const KEY_FAILURE = "Hub couldn't complete the request. Reload the key list to check its status.";
const LIST_FAILURE = "Hub couldn't load the webhook keys. Check your connection and reload.";

type Dialog = { kind: "create" } | { kind: "rotate"; record: WebhookKeyRecord } | undefined;

interface Scope {
  organizationSlug: string;
  triggerName: string;
}

/** Only owners and admins reach this: the server refuses everyone else the list and every change. */
export function WebhookKeys({ enabled, ...scope }: Scope & { enabled: boolean }) {
  const state = useWebhookKeyState(scope);
  const { keys, dialog, reveal, openCreate } = state;
  const action = useMemo(
    () => (
      <Button type="button" variant="outline" size="sm" disabled={!enabled} onClick={openCreate}>
        <KeyRound aria-hidden="true" />
        Create webhook key
      </Button>
    ),
    [enabled, openCreate],
  );
  return (
    <Section
      title="Webhook keys"
      description="Keys that let a sender call this trigger's webhook. Each works for this trigger only."
      action={action}
    >
      {enabled ? null : (
        <p className="text-sm text-muted-foreground">Enable this trigger to create a key.</p>
      )}
      {state.actionError === undefined ? null : (
        <FailureAlert
          title="Webhook key not changed"
          error={state.actionError}
          fallback={KEY_FAILURE}
        />
      )}
      <WebhookKeyList
        keys={keys}
        busy={state.busy}
        onRotate={state.openRotate}
        onRevoke={state.revoke}
      />
      <WebhookKeyDialogs
        state={state}
        dialog={dialog}
        reveal={reveal}
        triggerName={scope.triggerName}
      />
    </Section>
  );
}

function WebhookKeyList({
  keys,
  busy,
  onRotate,
  onRevoke,
}: {
  keys: WebhookKeyState["keys"];
  busy: boolean;
  onRotate: (record: WebhookKeyRecord) => void;
  onRevoke: (id: string) => void;
}) {
  if (keys.status === "pending") return <LoadingLine>Loading webhook keys</LoadingLine>;
  if (keys.status === "error") {
    return (
      <FailureAlert
        title="Webhook keys unavailable"
        error={keys.error}
        fallback={LIST_FAILURE}
        onRetry={keys.refetch}
      />
    );
  }
  return (
    <WebhookKeyTable
      records={keys.data.keys}
      now={Date.now()}
      busy={busy}
      onRotate={onRotate}
      onRevoke={onRevoke}
    />
  );
}

function WebhookKeyDialogs({
  state,
  dialog,
  reveal,
  triggerName,
}: {
  state: WebhookKeyState;
  dialog: Dialog;
  reveal: WebhookKeyReveal | undefined;
  triggerName: string;
}) {
  if (reveal !== undefined) {
    return (
      <WebhookKeySecretDialog
        reveal={reveal}
        triggerName={triggerName}
        address={state.address}
        onClose={state.closeReveal}
      />
    );
  }
  if (dialog?.kind === "create") {
    return (
      <CreateWebhookKeyDialog
        busy={state.create.isPending}
        error={state.createError}
        onOpenChange={state.closeDialog}
        onCreate={state.submitCreate}
      />
    );
  }
  if (dialog?.kind === "rotate") {
    return (
      <RotateWebhookKeyDialog
        name={dialog.record.name}
        busy={state.rotate.isPending}
        error={state.rotateError}
        onOpenChange={state.closeDialog}
        onRotate={state.submitRotate}
      />
    );
  }
  return null;
}

type WebhookKeyState = ReturnType<typeof useWebhookKeyState>;

function useWebhookKeyState(scope: Scope) {
  const [dialog, setDialog] = useState<Dialog>();
  const [reveal, setReveal] = useState<WebhookKeyReveal>();
  const { keys, address, operations } = useWebhookKeyQueries(scope);
  const { create, rotate, revoke } = useWebhookKeyMutations(scope, setReveal);
  const openCreate = useCallback(() => setDialog({ kind: "create" }), []);
  const openRotate = useCallback(
    (record: WebhookKeyRecord) => setDialog({ kind: "rotate", record }),
    [],
  );
  const closeDialog = useCallback(
    (open: boolean) => {
      if (open || create.isPending || rotate.isPending) return;
      setDialog(undefined);
      create.reset();
      rotate.reset();
    },
    [create, rotate],
  );
  const closeReveal = useCallback(() => {
    setReveal(undefined);
    setDialog(undefined);
    create.reset();
    rotate.reset();
    void operations.invalidate();
  }, [create, rotate, operations]);
  const submitRevoke = useCallback(
    (id: string) => {
      if (!revoke.isPending) revoke.mutate(id);
    },
    [revoke],
  );
  const submitCreate = useCallback((actor: string | undefined) => create.mutate(actor), [create]);
  const submitRotate = useCallback(
    (overlapSeconds: number) => {
      if (dialog?.kind === "rotate") rotate.mutate({ id: dialog.record.id, overlapSeconds });
    },
    [dialog, rotate],
  );
  return {
    keys,
    address,
    dialog,
    reveal,
    create,
    rotate,
    busy: revoke.isPending || create.isPending || rotate.isPending,
    createError: create.isError ? KEY_FAILURE : create.data,
    rotateError: rotate.isError ? KEY_FAILURE : rotate.data,
    actionError: revoke.isError ? KEY_FAILURE : revoke.data,
    revoke: submitRevoke,
    openCreate,
    openRotate,
    closeDialog,
    closeReveal,
    submitCreate,
    submitRotate,
  };
}

function useWebhookKeyQueries({ organizationSlug, triggerName }: Scope) {
  const queryClient = useQueryClient();
  const loadKeys = useServerFn(listTriggerWebhookKeys);
  const loadAddress = useServerFn(webhookSettings);
  const queryKey = ["trigger-webhook-keys", organizationSlug, triggerName];
  const keys = useSnapshotQuery({
    queryKey,
    queryFn: () => loadKeys({ data: { organizationSlug, triggerName } }),
  });
  const address = useSnapshotQuery({
    queryKey: ["webhooks", "settings", organizationSlug],
    queryFn: () => loadAddress(),
  });
  const invalidate = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ["trigger-webhook-keys", organizationSlug, triggerName],
      }),
    [queryClient, organizationSlug, triggerName],
  );
  return { keys, address, operations: { invalidate } };
}

/**
 * The secret leaves the mutation through `setReveal` and nowhere else, so it is never in the
 * query cache and goes away with the dialog. A failed call returns the server's message instead.
 */
function useWebhookKeyMutations(scope: Scope, setReveal: (reveal: WebhookKeyReveal) => void) {
  const { organizationSlug, triggerName } = scope;
  const queryClient = useQueryClient();
  const createKey = useServerFn(createTriggerWebhookKey);
  const rotateKey = useServerFn(rotateTriggerWebhookKey);
  const revokeKey = useServerFn(revokeTriggerWebhookKey);
  const settled = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ["trigger-webhook-keys", organizationSlug, triggerName],
      }),
    [queryClient, organizationSlug, triggerName],
  );
  const create = useMutation({
    retry: false,
    mutationFn: async (actor: string | undefined) => {
      const result = await createKey({
        data: { organizationSlug, triggerName, ...(actor === undefined ? {} : { actor }) },
      });
      if (result.status === "error") return result.error.message;
      setReveal(revealOf(result.data, false));
      return undefined;
    },
    onSettled: settled,
  });
  const rotate = useMutation({
    retry: false,
    mutationFn: async (input: { id: string; overlapSeconds: number }) => {
      const result = await rotateKey({ data: { organizationSlug, ...input } });
      if (result.status === "error") return result.error.message;
      setReveal(revealOf(result.data, true));
      return undefined;
    },
    onSettled: settled,
  });
  const revoke = useMutation({
    retry: false,
    mutationFn: async (id: string) => {
      const result = await revokeKey({ data: { organizationSlug, triggerName, id } });
      return result.status === "error" ? result.error.message : undefined;
    },
    onSettled: settled,
  });
  return { create, rotate, revoke };
}

function revealOf(
  issued: { secret: string; summary: { actor: string | null }; actorAllowedByTrigger: boolean },
  rotated: boolean,
): WebhookKeyReveal {
  return {
    secret: issued.secret,
    actor: issued.summary.actor,
    actorAllowedByTrigger: issued.actorAllowedByTrigger,
    rotated,
  };
}
